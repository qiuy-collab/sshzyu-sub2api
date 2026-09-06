package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
)

// geminiLocalBatchExecutor implements the degraded local-execution mode of the
// Gemini batch image provider. Gemini-compatible relays (new-api style) proxy
// single :generateContent calls but do not implement the Gemini Files API
// (/upload/v1beta/files) nor true batchGenerateContent semantics, so batch
// submissions whose Files upload fails fall back to executing each item
// through :generateContent with the account's own base_url.
//
// The execution framework mirrors OpenAIBatchImageProvider: persisted inputs,
// pull-based Get, per-item cross-process leases, a durable two-attempt budget
// and neutral result lines. It is deliberately a separate implementation from
// the OpenAI provider because request shape, error taxonomy and provider
// identity differ; the two are kept structurally aligned instead of sharing a
// partially fitting abstraction.

const (
	defaultGeminiLocalBatchRequeueAfter = 5 * time.Second
	defaultGeminiLocalBatchConcurrency  = 3
	// Per-request timeout for locally executed :generateContent calls; also the
	// cross-process lease TTL base.
	defaultGeminiLocalBatchRequestTimeout = 5 * time.Minute
	// Same trade-off as the OpenAI provider: a stale lease is terminal because
	// we cannot know whether the upstream accepted the paid request.
	geminiLocalBatchItemLeaseGrace = 30 * time.Second
	// Local jobs persist their input under this suffix; real Gemini batch jobs
	// reference an uploaded Files API resource ("files/...") instead.
	geminiLocalInputRefSuffix = ".input.json"
)

var errGeminiLocalItemExecutionInProgress = errors.New("gemini batch image item execution is in progress")

type geminiLocalAcceptedKey struct{}

type geminiLocalStoredInput struct {
	Input BatchImageInput `json:"input"`
}

type geminiLocalResultLine = batchImageInternalResultLine

type geminiLocalBatchExecutor struct {
	dataDir        string
	requestTimeout time.Duration

	runningMu      sync.Mutex
	runningCancels map[string]context.CancelFunc
}

func newGeminiLocalBatchExecutor(dataDir string, requestTimeout time.Duration) *geminiLocalBatchExecutor {
	dataDir = strings.TrimSpace(dataDir)
	if dataDir == "" {
		dataDir = "data"
	}
	return &geminiLocalBatchExecutor{
		dataDir:        filepath.Join(dataDir, "batch-image", "gemini"),
		requestTimeout: requestTimeout,
		runningCancels: make(map[string]context.CancelFunc),
	}
}

// isGeminiLocalInputRef reports whether a persisted provider input reference
// belongs to a locally executed job rather than an uploaded Files resource.
func isGeminiLocalInputRef(inputRef string) bool {
	ref := strings.TrimSpace(inputRef)
	return ref != "" && strings.HasSuffix(ref, geminiLocalInputRefSuffix)
}

func (e *geminiLocalBatchExecutor) Submit(_ context.Context, input BatchImageInput) (*BatchProviderJob, error) {
	if err := validateGeminiLocalInput(input); err != nil {
		return nil, err
	}
	inputRef, err := e.writeInput(input)
	if err != nil {
		return nil, err
	}
	return &BatchProviderJob{
		ProviderJobName:  input.BatchID,
		ProviderInputRef: inputRef,
		RawState:         "local-queued",
	}, nil
}

func (e *geminiLocalBatchExecutor) Get(ctx context.Context, job *BatchImageJob, account *Account, client GeminiBatchClient) (*BatchProviderStatus, error) {
	batchID := batchImageProviderJobName(job)
	if batchID == "" {
		return nil, ErrBatchImageProviderMissingJobName
	}

	if e.markerExists(batchID, ".cancelled") {
		return &BatchProviderStatus{RawState: "cancelled", InternalState: BatchProviderStateCancelled, Done: true}, nil
	}
	outputRef := batchID + ".output.jsonl"
	if _, err := os.Stat(e.pathFor(outputRef)); err == nil {
		return &BatchProviderStatus{RawState: "completed", InternalState: BatchProviderStateSucceeded, Done: true, ProviderOutputRef: outputRef}, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, geminiLocalProviderError("GEMINI_BATCH_STORAGE_ERROR", "unable to inspect batch output", err)
	}

	inputRef := batchImageProviderInputRef(job)
	if inputRef == "" {
		inputRef = batchID + geminiLocalInputRefSuffix
	}
	input, err := e.readInput(inputRef)
	if err != nil {
		return nil, err
	}
	execCtx, stop := context.WithCancel(ctx)
	if !e.registerRunning(batchID, stop) {
		// This process is already executing the job. Returning queued keeps an
		// accidental duplicate from issuing a second set of paid requests.
		stop()
		return &BatchProviderStatus{RawState: "running", InternalState: BatchProviderStateRunning, SuggestedRequeueAfter: defaultGeminiLocalBatchRequeueAfter}, nil
	}
	defer stop()
	defer e.unregisterRunning(batchID)
	if err := e.execute(execCtx, client, account, input, outputRef); err != nil {
		if errors.Is(err, context.Canceled) && e.markerExists(batchID, ".cancelled") {
			return &BatchProviderStatus{RawState: "cancelled", InternalState: BatchProviderStateCancelled, Done: true}, nil
		}
		return nil, err
	}
	return &BatchProviderStatus{RawState: "completed", InternalState: BatchProviderStateSucceeded, Done: true, ProviderOutputRef: outputRef}, nil
}

func (e *geminiLocalBatchExecutor) Cancel(_ context.Context, job *BatchImageJob) error {
	batchID := batchImageProviderJobName(job)
	if batchID == "" {
		return ErrBatchImageProviderMissingJobName
	}
	if err := e.writePrivateFile(batchID+".cancelled", []byte("cancelled\n")); err != nil {
		return err
	}
	e.cancelRunning(batchID)
	return nil
}

func (e *geminiLocalBatchExecutor) OpenResult(_ context.Context, job *BatchImageJob) (io.ReadCloser, string, error) {
	ref := batchImageProviderOutputRef(job)
	if ref == "" {
		return nil, "", ErrBatchImageProviderMissingResultRef
	}
	f, err := os.Open(e.pathFor(ref))
	if errors.Is(err, os.ErrNotExist) {
		return nil, "", ErrBatchImageProviderMissingResultRef
	}
	if err != nil {
		return nil, "", geminiLocalProviderError("GEMINI_BATCH_STORAGE_ERROR", "unable to open batch output", err)
	}
	return f, "application/jsonl", nil
}

func (e *geminiLocalBatchExecutor) Cleanup(_ context.Context, job *BatchImageJob, target CleanupTarget) error {
	remove := func(ref string) error {
		if ref == "" {
			return nil
		}
		err := os.Remove(e.pathFor(ref))
		if err == nil || errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return geminiLocalProviderError("GEMINI_BATCH_STORAGE_ERROR", "unable to clean up batch file", err)
	}
	if target == CleanupTargetOutput || target == CleanupTargetAll {
		entries, err := os.ReadDir(e.dataDir)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		prefix := filepath.Base(batchImageProviderJobName(job)) + ".output.jsonl.batch-image-"
		for _, entry := range entries {
			if !entry.IsDir() && strings.HasPrefix(entry.Name(), prefix) {
				if err := remove(entry.Name()); err != nil {
					return err
				}
			}
		}
	}
	switch target {
	case CleanupTargetInput:
		return remove(batchImageProviderInputRef(job))
	case CleanupTargetOutput:
		return remove(batchImageProviderOutputRef(job))
	case CleanupTargetAll:
		batchID := batchImageProviderJobName(job)
		if err := remove(batchImageProviderInputRef(job)); err != nil {
			return err
		}
		if err := remove(batchImageProviderOutputRef(job)); err != nil {
			return err
		}
		if job != nil {
			return remove(batchID + ".cancelled")
		}
		return nil
	default:
		return ErrUnsupportedCleanupTarget
	}
}

func (e *geminiLocalBatchExecutor) execute(ctx context.Context, client GeminiBatchClient, account *Account, input BatchImageInput, outputRef string) error {
	lines := make([][]byte, len(input.Items))
	errs := make(chan error, 1)
	jobs := make(chan int)
	workerCount := defaultGeminiLocalBatchConcurrency
	if workerCount > len(input.Items) {
		workerCount = len(input.Items)
	}
	var workers sync.WaitGroup
	for range workerCount {
		// Account lazily writes model/header caches. Each worker owns its copy;
		// credentials and proxy configuration remain read-only shared inputs.
		workerAccount := *account
		workers.Add(1)
		go func() {
			defer workers.Done()
			for index := range jobs {
				if e.markerExists(input.BatchID, ".cancelled") {
					select {
					case errs <- context.Canceled:
					default:
					}
					return
				}
				checkpoint := outputRef + "." + geminiLocalItemIdempotencyKey(input.BatchID, input.Items[index].CustomID)
				if cached, err := os.ReadFile(e.pathFor(checkpoint)); err == nil {
					lines[index] = cached
					continue
				} else if !errors.Is(err, os.ErrNotExist) {
					select {
					case errs <- geminiLocalProviderError("GEMINI_BATCH_STORAGE_ERROR", "unable to read item checkpoint", err):
					default:
					}
					return
				}
				line, err := e.executeItemWithRetry(ctx, client, &workerAccount, input, input.Items[index], checkpoint)
				if err != nil {
					// Only cancellation or checkpoint storage failures reach the worker.
					// Request failures are terminal per-item results, never batch retries.
					select {
					case errs <- err:
					default:
					}
					return
				}
				encoded, err := json.Marshal(line)
				if err != nil {
					select {
					case errs <- geminiLocalProviderError("GEMINI_BATCH_ENCODE_ERROR", "unable to encode image batch result", err):
					default:
					}
					return
				}
				lines[index] = append(encoded, '\n')
				if err := e.writePrivateFile(checkpoint, lines[index]); err != nil {
					select {
					case errs <- err:
					default:
					}
					return
				}
			}
		}()
	}
	for index := range input.Items {
		select {
		case err := <-errs:
			close(jobs)
			workers.Wait()
			return err
		case jobs <- index:
		}
	}
	close(jobs)
	workers.Wait()
	select {
	case err := <-errs:
		return err
	default:
	}
	if e.markerExists(input.BatchID, ".cancelled") {
		return context.Canceled
	}
	return e.writePrivateFile(outputRef, bytes.Join(lines, nil))
}

// executeItemWithRetry serializes the paid request budget across all processes
// sharing the provider data directory. A second worker must never infer a free
// retry from an attempt checkpoint that another worker has not committed yet.
func (e *geminiLocalBatchExecutor) executeItemWithRetry(ctx context.Context, client GeminiBatchClient, account *Account, input BatchImageInput, item BatchImageInputItem, checkpoint string) (geminiLocalResultLine, error) {
	line := geminiLocalResultLine{Format: batchImageInternalResultFormat, Provider: BatchImageProviderGeminiAPI, Key: item.CustomID}
	release, stale, err := e.acquireItemLease(checkpoint)
	if err != nil {
		return line, err
	}
	if stale {
		line.Error = geminiLocalItemError(geminiLocalProviderError("GEMINI_BATCH_EXECUTION_INTERRUPTED", "item execution lease expired before completion; generation will not be repeated", nil))
		return e.writeItemCheckpoint(checkpoint, line)
	}
	defer release()

	line, err = e.executeItemWithRetryLocked(ctx, client, account, input, item, checkpoint)
	if err != nil {
		return line, err
	}
	// Commit the terminal item result before releasing the cross-process lease.
	// A crash after a 2xx is represented by .accepted; a later worker records a
	// terminal interrupted result rather than submitting another paid request.
	return e.writeItemCheckpoint(checkpoint, line)
}

func (e *geminiLocalBatchExecutor) writeItemCheckpoint(checkpoint string, line geminiLocalResultLine) (geminiLocalResultLine, error) {
	encoded, err := json.Marshal(line)
	if err != nil {
		return line, geminiLocalProviderError("GEMINI_BATCH_ENCODE_ERROR", "unable to encode image batch result", err)
	}
	if err := e.writePrivateFile(checkpoint, append(encoded, '\n')); err != nil {
		return line, err
	}
	return line, nil
}

// acquireItemLease creates the lease atomically with O_EXCL. A lease that
// outlives a request timeout is ambiguous: it may have reached the upstream, so
// it becomes a terminal failed item rather than a new request. This is
// intentionally biased toward preventing duplicate billed images after a
// process crash.
func (e *geminiLocalBatchExecutor) acquireItemLease(checkpoint string) (release func(), stale bool, err error) {
	if err := os.MkdirAll(e.dataDir, 0o700); err != nil {
		return nil, false, geminiLocalProviderError("GEMINI_BATCH_STORAGE_ERROR", "unable to create item execution storage", err)
	}
	path := e.pathFor(checkpoint + ".lease")
	lease, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err == nil {
		_, writeErr := lease.WriteString(time.Now().UTC().Format(time.RFC3339Nano))
		closeErr := lease.Close()
		if writeErr != nil || closeErr != nil {
			_ = os.Remove(path)
			return nil, false, geminiLocalProviderError("GEMINI_BATCH_STORAGE_ERROR", "unable to create item execution lease", firstOpenAIBatchError(writeErr, closeErr))
		}
		return func() { _ = os.Remove(path) }, false, nil
	}
	if !errors.Is(err, os.ErrExist) {
		return nil, false, geminiLocalProviderError("GEMINI_BATCH_STORAGE_ERROR", "unable to reserve item execution lease", err)
	}
	info, statErr := os.Stat(path)
	if statErr != nil {
		return nil, false, geminiLocalProviderError("GEMINI_BATCH_STORAGE_ERROR", "unable to inspect item execution lease", statErr)
	}
	leaseTTL := e.requestTimeout + geminiLocalBatchItemLeaseGrace
	if leaseTTL < geminiLocalBatchItemLeaseGrace {
		leaseTTL = geminiLocalBatchItemLeaseGrace
	}
	if time.Since(info.ModTime()) >= leaseTTL {
		return nil, true, nil
	}
	return nil, false, errGeminiLocalItemExecutionInProgress
}

// Attempts are reserved on disk BEFORE dispatch. A process restart or an
// ambiguous timeout must not reset the two-request budget. A crash can consume
// an attempt without producing an image; compatible upstream idempotency is
// only best effort.
func (e *geminiLocalBatchExecutor) executeItemWithRetryLocked(ctx context.Context, client GeminiBatchClient, account *Account, input BatchImageInput, item BatchImageInputItem, checkpoint string) (geminiLocalResultLine, error) {
	line := geminiLocalResultLine{Format: batchImageInternalResultFormat, Provider: BatchImageProviderGeminiAPI, Key: item.CustomID}
	attempts := 0
	data, err := os.ReadFile(e.pathFor(checkpoint + ".attempts"))
	if err == nil {
		if err := json.Unmarshal(data, &attempts); err != nil || attempts < 0 || attempts > 2 {
			return line, geminiLocalProviderError("GEMINI_BATCH_STORAGE_ERROR", "invalid item attempt checkpoint", err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return line, geminiLocalProviderError("GEMINI_BATCH_STORAGE_ERROR", "unable to read item attempts", err)
	}
	if _, err := os.Stat(e.pathFor(checkpoint + ".accepted")); err == nil {
		line.Error = geminiLocalItemError(geminiLocalProviderError("GEMINI_BATCH_OUTPUT_INTERRUPTED", "generation was accepted but output processing was interrupted; generation will not be repeated", nil))
		return line, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return line, geminiLocalProviderError("GEMINI_BATCH_STORAGE_ERROR", "unable to inspect accepted checkpoint", err)
	}
	lastErr := geminiLocalProviderError("GEMINI_BATCH_ATTEMPTS_EXHAUSTED", "item attempt limit reached after interrupted execution", nil)
	for attempts < 2 {
		// Cancellation can be issued by another instance sharing the storage.
		// Its in-memory cancel function cannot reach this process.
		if e.markerExists(input.BatchID, ".cancelled") {
			return line, context.Canceled
		}
		if err := ctx.Err(); err != nil {
			return line, err
		}
		attempts++
		encoded, _ := json.Marshal(attempts)
		if err := e.writePrivateFile(checkpoint+".attempts", encoded); err != nil {
			return line, err
		}
		attemptCtx := context.WithValue(ctx, geminiLocalAcceptedKey{}, func() error {
			return e.writePrivateFile(checkpoint+".accepted", []byte("accepted\n"))
		})
		line, lastErr = e.executeItem(attemptCtx, client, account, input, item)
		if lastErr == nil {
			return line, nil
		}
		var terminal *geminiLocalOutputError
		if errors.As(lastErr, &terminal) {
			line.Error = geminiLocalItemError(lastErr)
			return line, nil
		}
		// A client timeout is an item failure; a cancelled worker context is not.
		if err := ctx.Err(); err != nil {
			return line, err
		}
	}
	line.Error = geminiLocalItemError(lastErr)
	return line, nil
}

func (e *geminiLocalBatchExecutor) executeItem(ctx context.Context, client GeminiBatchClient, account *Account, input BatchImageInput, item BatchImageInputItem) (geminiLocalResultLine, error) {
	result := geminiLocalResultLine{Format: batchImageInternalResultFormat, Provider: BatchImageProviderGeminiAPI, Key: item.CustomID}
	images, err := e.requestItem(ctx, client, account, input, item)
	if err != nil {
		return result, err
	}
	result.Images = images

	return result, nil
}

func (e *geminiLocalBatchExecutor) requestItem(ctx context.Context, client GeminiBatchClient, account *Account, input BatchImageInput, item BatchImageInputItem) ([]batchImageResultImage, error) {
	if client == nil {
		return nil, geminiLocalProviderError("GEMINI_BATCH_REQUEST_FAILED", "Gemini batch client is unavailable", nil)
	}
	mappedModel := strings.TrimSpace(account.GetMappedModel(input.Model))
	if mappedModel == "" {
		return nil, geminiLocalProviderError("GEMINI_BATCH_MODEL_MISSING", "Gemini batch request has no upstream model", nil)
	}
	parts, err := batchImageGeminiParts(strings.TrimSpace(item.Prompt), item.ReferenceImages)
	if err != nil {
		return nil, err
	}
	request := &geminiGenerateRequest{
		Contents: []geminiContent{{Parts: parts}},
		GenerationConfig: geminiGenerationConfig{
			ResponseModalities: []string{"TEXT", "IMAGE"},
		},
	}
	resp, err := client.GenerateContent(ctx, batchImageProviderAPIKey(account), mappedModel, request)
	if err != nil {
		var apiErr *GeminiAPIError
		if errors.As(err, &apiErr) {
			switch apiErr.StatusCode {
			case http.StatusUnauthorized, http.StatusForbidden:
				return nil, geminiLocalProviderError("GEMINI_AUTH_FAILED", "Gemini authentication failed", nil)
			case http.StatusTooManyRequests:
				return nil, geminiLocalProviderError("GEMINI_RATE_LIMITED", "Gemini rate limit exceeded", nil)
			case http.StatusNotFound:
				return nil, geminiLocalProviderError("GEMINI_BATCH_MODEL_NOT_FOUND", "Gemini model or resource was not found on the upstream", nil)
			default:
				return nil, &geminiLocalHTTPRejectionError{
					error:  geminiLocalProviderError("GEMINI_BATCH_UPSTREAM_REJECTED", fmt.Sprintf("Gemini image request was rejected (HTTP %d)", apiErr.StatusCode), nil),
					status: apiErr.StatusCode,
				}
			}
		}
		// url.Error may include signed endpoints or proxy credentials; keep the
		// fixed local message only.
		return nil, geminiLocalProviderError("GEMINI_BATCH_REQUEST_FAILED", "Gemini image request could not be completed", nil)
	}
	// Persist acceptance before decoding. Never issue another paid generation
	// after a 2xx, including after worker restart.
	if accepted, ok := ctx.Value(geminiLocalAcceptedKey{}).(func() error); ok {
		if err := accepted(); err != nil {
			return nil, &geminiLocalOutputError{err}
		}
	}
	return geminiExtractInlineImages(resp)
}

// geminiExtractInlineImages converts generateContent candidates into neutral
// result images. A 2xx without usable inline image data is terminal: the
// upstream may already have billed the request.
func geminiExtractInlineImages(resp *GeminiGenerateContentResponse) ([]batchImageResultImage, error) {
	if resp == nil {
		return nil, &geminiLocalOutputError{geminiLocalProviderError("GEMINI_BATCH_NO_IMAGE_OUTPUT", "Gemini response contained no candidates", nil)}
	}
	blockReason := ""
	if resp.PromptFeedback != nil {
		blockReason = strings.TrimSpace(resp.PromptFeedback.BlockReason)
	}
	images := make([]batchImageResultImage, 0, 1)
	finishReason := ""
	for _, candidate := range resp.Candidates {
		if candidate.FinishReason != "" {
			finishReason = strings.TrimSpace(candidate.FinishReason)
		}
		if candidate.Content == nil {
			continue
		}
		for _, part := range candidate.Content.Parts {
			if part.InlineData == nil {
				continue
			}
			mimeType := strings.TrimSpace(part.InlineData.MimeType)
			data := strings.TrimSpace(part.InlineData.Data)
			if mimeType == "" || data == "" {
				return nil, &geminiLocalOutputError{geminiLocalProviderError("GEMINI_BATCH_NO_IMAGE_OUTPUT", "Gemini response contained an incomplete inline image", nil)}
			}
			images = append(images, batchImageResultImage{MimeType: mimeType, Data: data})
		}
	}
	if len(images) == 0 {
		message := "Gemini response contained no inline image data"
		if blockReason != "" {
			message += "; block_reason=" + blockReason
		} else if finishReason != "" {
			message += "; finish_reason=" + finishReason
		}
		return nil, &geminiLocalOutputError{geminiLocalProviderError("GEMINI_BATCH_NO_IMAGE_OUTPUT", message, nil)}
	}
	return images, nil
}

func (e *geminiLocalBatchExecutor) registerRunning(batchID string, cancel context.CancelFunc) bool {
	e.runningMu.Lock()
	defer e.runningMu.Unlock()
	if _, exists := e.runningCancels[batchID]; exists {
		return false
	}
	e.runningCancels[batchID] = cancel
	return true
}

func (e *geminiLocalBatchExecutor) unregisterRunning(batchID string) {
	e.runningMu.Lock()
	defer e.runningMu.Unlock()
	delete(e.runningCancels, batchID)
}

func (e *geminiLocalBatchExecutor) cancelRunning(batchID string) {
	e.runningMu.Lock()
	cancel := e.runningCancels[batchID]
	e.runningMu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (e *geminiLocalBatchExecutor) writeInput(input BatchImageInput) (string, error) {
	ref := input.BatchID + geminiLocalInputRefSuffix
	payload, err := json.Marshal(geminiLocalStoredInput{Input: input})
	if err != nil {
		return "", geminiLocalProviderError("GEMINI_BATCH_STORAGE_ERROR", "unable to persist batch input", err)
	}
	if err := e.writePrivateFile(ref, payload); err != nil {
		return "", err
	}
	return ref, nil
}

func (e *geminiLocalBatchExecutor) readInput(ref string) (BatchImageInput, error) {
	data, err := os.ReadFile(e.pathFor(ref))
	if errors.Is(err, os.ErrNotExist) {
		return BatchImageInput{}, geminiLocalProviderError("GEMINI_BATCH_INPUT_MISSING", "Gemini batch input is missing", nil)
	}
	if err != nil {
		return BatchImageInput{}, geminiLocalProviderError("GEMINI_BATCH_STORAGE_ERROR", "unable to read batch input", err)
	}
	var stored geminiLocalStoredInput
	if err := json.Unmarshal(data, &stored); err != nil {
		return BatchImageInput{}, geminiLocalProviderError("GEMINI_BATCH_INPUT_INVALID", "Gemini batch input is invalid", err)
	}
	if err := validateGeminiLocalInput(stored.Input); err != nil {
		return BatchImageInput{}, err
	}
	return stored.Input, nil
}

func (e *geminiLocalBatchExecutor) writePrivateFile(ref string, data []byte) error {
	if err := os.MkdirAll(e.dataDir, 0o700); err != nil {
		return geminiLocalProviderError("GEMINI_BATCH_STORAGE_ERROR", "unable to create batch storage", err)
	}
	path := e.pathFor(ref)
	tmp, err := os.CreateTemp(e.dataDir, ".batch-*")
	if err != nil {
		return geminiLocalProviderError("GEMINI_BATCH_STORAGE_ERROR", "unable to create batch storage", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return geminiLocalProviderError("GEMINI_BATCH_STORAGE_ERROR", "unable to secure batch storage", err)
	}
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return geminiLocalProviderError("GEMINI_BATCH_STORAGE_ERROR", "unable to write batch storage", err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return geminiLocalProviderError("GEMINI_BATCH_STORAGE_ERROR", "unable to sync batch storage", err)
	}
	if err := tmp.Close(); err != nil {
		return geminiLocalProviderError("GEMINI_BATCH_STORAGE_ERROR", "unable to finalize batch storage", err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		return geminiLocalProviderError("GEMINI_BATCH_STORAGE_ERROR", "unable to finalize batch storage", err)
	}
	return nil
}

func (e *geminiLocalBatchExecutor) markerExists(batchID, suffix string) bool {
	_, err := os.Stat(e.pathFor(batchID + suffix))
	return err == nil
}

func (e *geminiLocalBatchExecutor) pathFor(ref string) string {
	// refs are generated internally and must remain single file names, preventing
	// a compromised DB row from escaping the provider's private data directory.
	ref = filepath.Base(strings.TrimSpace(ref))
	return filepath.Join(e.dataDir, ref)
}

func validateGeminiLocalInput(input BatchImageInput) error {
	if strings.TrimSpace(input.BatchID) == "" || strings.TrimSpace(input.Model) == "" || len(input.Items) == 0 {
		return batchImageProviderInputError("batch_id, model and at least one item are required")
	}
	seen := make(map[string]struct{}, len(input.Items))
	for _, item := range input.Items {
		customID := strings.TrimSpace(item.CustomID)
		if customID == "" || strings.TrimSpace(item.Prompt) == "" {
			return batchImageProviderInputError("custom_id and prompt are required")
		}
		if _, exists := seen[customID]; exists {
			return batchImageProviderInputError("duplicate custom_id %q", customID)
		}
		seen[customID] = struct{}{}
	}
	return nil
}

func geminiLocalItemIdempotencyKey(batchID, customID string) string {
	return fmt.Sprintf("%s_%s", batchID, customID)
}

func geminiLocalProviderError(reason, message string, cause error) error {
	err := infraerrors.New(http.StatusBadGateway, reason, message)
	if cause != nil {
		return err.WithCause(cause)
	}
	return err
}

// geminiLocalHTTPRejectionError carries the upstream HTTP status into the
// persisted item error without retaining the response body or request URL.
type geminiLocalHTTPRejectionError struct {
	error
	status int
}

func (e *geminiLocalHTTPRejectionError) Unwrap() error { return e.error }

// geminiLocalOutputError marks terminal failures that must never trigger a
// second paid request (decoding failures after a 2xx, etc.).
type geminiLocalOutputError struct{ error }

func (e *geminiLocalOutputError) Unwrap() error { return e.error }

func geminiLocalItemError(err error) *batchImageInternalError {
	code := "GEMINI_BATCH_ITEM_FAILED"
	message := "Gemini image request failed"
	if err != nil {
		var providerErr *infraerrors.Error
		if errors.As(err, &providerErr) && strings.TrimSpace(providerErr.Reason) != "" {
			code = strings.TrimSpace(providerErr.Reason)
			message = providerErr.Message
		}
	}
	result := &batchImageInternalError{Code: code, Message: message}
	var rejection *geminiLocalHTTPRejectionError
	if errors.As(err, &rejection) {
		result.HTTPStatus = rejection.status
	}
	return result
}
