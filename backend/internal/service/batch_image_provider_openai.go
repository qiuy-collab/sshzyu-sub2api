package service

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/config"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/util/urlvalidator"
)

// OpenAI 兼容上游没有一个可依赖的图像 Batch API。该 provider 将提交输入持久化，
// 由已有 batch worker 在轮询时以受限并发执行普通 Images API，然后写出中立内部
// JSONL 结果格式，不模拟 Gemini 响应，共享索引、下载与结算基础设施。
const (
	defaultOpenAIBatchRequeueAfter = 5 * time.Second
	defaultOpenAIBatchConcurrency  = 3
	// A lease is held across the paid HTTP POST, so two workers sharing the same
	// data directory cannot each reserve the same item's two-request budget.
	// A stale lease is deliberately terminal rather than retried: after a process
	// crash we cannot know whether the upstream accepted the request.
	openAIBatchItemLeaseGrace = 30 * time.Second
)

var errOpenAIBatchItemExecutionInProgress = errors.New("openai batch image item execution is in progress")

type OpenAIBatchImageProviderOptions struct {
	DataDir      string
	URLAllowlist config.URLAllowlistConfig
}

type OpenAIBatchImageProvider struct {
	dataDir             string
	urlAllowlist        config.URLAllowlistConfig
	requestTimeout      time.Duration
	imageDownloadClient *http.Client // nil uses the SSRF-protected, credential-free client

	runningMu      sync.Mutex
	runningCancels map[string]context.CancelFunc
}

type openAIBatchStoredInput struct {
	Input BatchImageInput `json:"input"`
}

type openAIBatchImageResponse struct {
	Data []struct {
		B64JSON string `json:"b64_json"`
		URL     string `json:"url"`
	} `json:"data"`
	Error *struct {
		Code    any    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

type openAIBatchResultLine = batchImageInternalResultLine

func NewOpenAIBatchImageProvider(opts OpenAIBatchImageProviderOptions) *OpenAIBatchImageProvider {
	dataDir := strings.TrimSpace(opts.DataDir)
	if dataDir == "" {
		dataDir = "data"
	}
	return &OpenAIBatchImageProvider{
		dataDir:        filepath.Join(dataDir, "batch-image", "openai"),
		urlAllowlist:   opts.URLAllowlist,
		requestTimeout: 5 * time.Minute,
		runningCancels: make(map[string]context.CancelFunc),
	}
}

func NewOpenAIBatchImageProviderFromConfig(cfg *config.Config) *OpenAIBatchImageProvider {
	opts := OpenAIBatchImageProviderOptions{}
	if cfg != nil {
		opts.DataDir = cfg.Pricing.DataDir
		opts.URLAllowlist = cfg.Security.URLAllowlist
	}
	return NewOpenAIBatchImageProvider(opts)
}

func (p *OpenAIBatchImageProvider) Name() string { return BatchImageProviderOpenAI }

func (p *OpenAIBatchImageProvider) SupportsAccount(account *Account) bool {
	return account != nil && account.IsOpenAIApiKey() && batchImageProviderAPIKey(account) != ""
}

func (p *OpenAIBatchImageProvider) Submit(_ context.Context, job *BatchImageJob, account *Account, input BatchImageInput) (*BatchProviderJob, error) {
	if !p.SupportsAccount(account) {
		if account != nil && account.IsOpenAIApiKey() {
			return nil, ErrBatchImageProviderMissingAPIKey
		}
		return nil, ErrBatchImageProviderUnsupportedAccount
	}
	if input.BatchID == "" && job != nil {
		input.BatchID = job.BatchID
	}
	if input.Model == "" && job != nil {
		input.Model = job.Model
	}
	// Provider 层只保留通用安全底线：映射目标非空且不是 Gemini 系生图模型。
	// 「目标必须是分组内存在的模型」由 service 层（列表/选号）以分组模型全集
	// 校验，此处没有分组上下文。
	mappedModel := strings.TrimSpace(account.GetMappedModel(input.Model))
	if mappedModel == "" || isGeminiImageUpstreamModel(mappedModel) {
		return nil, batchImageProviderInputError("openai batch image requests must map onto a non-Gemini upstream model configured for this account")
	}
	if err := validateOpenAIBatchInput(input); err != nil {
		return nil, err
	}
	// Validate before balance is held and the worker is queued, so malformed
	// account configuration cannot create an all-failed batch.
	baseURL := strings.TrimSpace(account.GetOpenAIBaseURL())
	if baseURL == "" {
		baseURL = "https://api.openai.com"
	}
	if _, err := p.validateBaseURL(baseURL); err != nil {
		return nil, err
	}
	inputRef, err := p.writeInput(input)
	if err != nil {
		return nil, err
	}
	return &BatchProviderJob{
		ProviderJobName:  input.BatchID,
		ProviderInputRef: inputRef,
		RawState:         "queued",
	}, nil
}

func (p *OpenAIBatchImageProvider) Get(ctx context.Context, job *BatchImageJob, account *Account) (*BatchProviderStatus, error) {
	if !p.SupportsAccount(account) {
		if account != nil && account.IsOpenAIApiKey() {
			return nil, ErrBatchImageProviderMissingAPIKey
		}
		return nil, ErrBatchImageProviderUnsupportedAccount
	}
	batchID := batchImageProviderJobName(job)
	if batchID == "" {
		return nil, ErrBatchImageProviderMissingJobName
	}

	if p.markerExists(batchID, ".cancelled") {
		return &BatchProviderStatus{RawState: "cancelled", InternalState: BatchProviderStateCancelled, Done: true}, nil
	}
	outputRef := batchID + ".output.jsonl"
	if _, err := os.Stat(p.pathFor(outputRef)); err == nil {
		return &BatchProviderStatus{RawState: "completed", InternalState: BatchProviderStateSucceeded, Done: true, ProviderOutputRef: outputRef}, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, openAIBatchProviderError("OPENAI_BATCH_STORAGE_ERROR", "unable to inspect batch output", err)
	}

	inputRef := batchImageProviderInputRef(job)
	if inputRef == "" {
		inputRef = batchID + ".input.json"
	}
	input, err := p.readInput(inputRef)
	if err != nil {
		return nil, err
	}
	execCtx, stop := context.WithCancel(ctx)
	if !p.registerRunning(batchID, stop) {
		// This process is already executing the job. The worker lock should normally
		// prevent it, but returning queued keeps an accidental duplicate from issuing
		// a second set of Images API calls.
		stop()
		return &BatchProviderStatus{RawState: "running", InternalState: BatchProviderStateRunning, SuggestedRequeueAfter: defaultOpenAIBatchRequeueAfter}, nil
	}
	defer stop()
	defer p.unregisterRunning(batchID)
	if err := p.execute(execCtx, account, input, outputRef); err != nil {
		if errors.Is(err, context.Canceled) && p.markerExists(batchID, ".cancelled") {
			return &BatchProviderStatus{RawState: "cancelled", InternalState: BatchProviderStateCancelled, Done: true}, nil
		}
		return nil, err
	}
	return &BatchProviderStatus{RawState: "completed", InternalState: BatchProviderStateSucceeded, Done: true, ProviderOutputRef: outputRef}, nil
}

func (p *OpenAIBatchImageProvider) Cancel(_ context.Context, job *BatchImageJob, account *Account) error {
	if !p.SupportsAccount(account) {
		return ErrBatchImageProviderUnsupportedAccount
	}
	batchID := batchImageProviderJobName(job)
	if batchID == "" {
		return ErrBatchImageProviderMissingJobName
	}
	if err := p.writePrivateFile(batchID+".cancelled", []byte("cancelled\n")); err != nil {
		return err
	}
	p.cancelRunning(batchID)
	return nil
}

func (p *OpenAIBatchImageProvider) registerRunning(batchID string, cancel context.CancelFunc) bool {
	p.runningMu.Lock()
	defer p.runningMu.Unlock()
	if _, exists := p.runningCancels[batchID]; exists {
		return false
	}
	p.runningCancels[batchID] = cancel
	return true
}

func (p *OpenAIBatchImageProvider) unregisterRunning(batchID string) {
	p.runningMu.Lock()
	defer p.runningMu.Unlock()
	delete(p.runningCancels, batchID)
}

func (p *OpenAIBatchImageProvider) cancelRunning(batchID string) {
	p.runningMu.Lock()
	cancel := p.runningCancels[batchID]
	p.runningMu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (p *OpenAIBatchImageProvider) OpenResult(_ context.Context, job *BatchImageJob, account *Account) (io.ReadCloser, string, error) {
	if !p.SupportsAccount(account) {
		return nil, "", ErrBatchImageProviderUnsupportedAccount
	}
	ref := batchImageProviderOutputRef(job)
	if ref == "" {
		return nil, "", ErrBatchImageProviderMissingResultRef
	}
	f, err := os.Open(p.pathFor(ref))
	if errors.Is(err, os.ErrNotExist) {
		return nil, "", ErrBatchImageProviderMissingResultRef
	}
	if err != nil {
		return nil, "", openAIBatchProviderError("OPENAI_BATCH_STORAGE_ERROR", "unable to open batch output", err)
	}
	return f, "application/jsonl", nil
}

func (p *OpenAIBatchImageProvider) Cleanup(_ context.Context, job *BatchImageJob, account *Account, target CleanupTarget) error {
	if !p.SupportsAccount(account) {
		return ErrBatchImageProviderUnsupportedAccount
	}
	remove := func(ref string) error {
		if ref == "" {
			return nil
		}
		err := os.Remove(p.pathFor(ref))
		if err == nil || errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return openAIBatchProviderError("OPENAI_BATCH_STORAGE_ERROR", "unable to clean up batch file", err)
	}
	if target == CleanupTargetOutput || target == CleanupTargetAll {
		entries, err := os.ReadDir(p.dataDir)
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
		if err := remove(batchImageProviderInputRef(job)); err != nil {
			return err
		}
		if err := remove(batchImageProviderOutputRef(job)); err != nil {
			return err
		}
		if job != nil {
			return remove(batchImageProviderJobName(job) + ".cancelled")
		}
		return nil
	default:
		return ErrUnsupportedCleanupTarget
	}
}

func validateOpenAIBatchInput(input BatchImageInput) error {
	if strings.TrimSpace(input.BatchID) == "" || strings.TrimSpace(input.Model) == "" || len(input.Items) == 0 {
		return batchImageProviderInputError("batch_id, model and at least one item are required")
	}
	if _, _, err := resolveOpenAIBatchImageSpec(input.ImageSize, input.AspectRatio, input.ResponseMimeType); err != nil {
		return err
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
		for _, ref := range item.ReferenceImages {
			if len(ref.Data) == 0 || strings.TrimSpace(ref.FileURI) != "" || normalizeBatchImageReferenceMimeType(ref.MimeType) == "" {
				return batchImageProviderInputError("OpenAI reference images must use inline image data with a supported mime type")
			}
		}
	}
	return nil
}

func (p *OpenAIBatchImageProvider) execute(ctx context.Context, account *Account, input BatchImageInput, outputRef string) error {
	lines := make([][]byte, len(input.Items))
	errs := make(chan error, 1)
	jobs := make(chan int)
	workerCount := defaultOpenAIBatchConcurrency
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
				if p.markerExists(input.BatchID, ".cancelled") {
					select {
					case errs <- context.Canceled:
					default:
					}
					return
				}
				checkpoint := outputRef + "." + openAIBatchItemIdempotencyKey(input.BatchID, input.Items[index].CustomID)
				if cached, err := os.ReadFile(p.pathFor(checkpoint)); err == nil {
					lines[index] = cached
					continue
				} else if !errors.Is(err, os.ErrNotExist) {
					select {
					case errs <- openAIBatchProviderError("OPENAI_BATCH_STORAGE_ERROR", "unable to read item checkpoint", err):
					default:
					}
					return
				}
				line, err := p.executeItemWithRetry(ctx, &workerAccount, input, input.Items[index], checkpoint)
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
					case errs <- openAIBatchProviderError("OPENAI_BATCH_ENCODE_ERROR", "unable to encode image batch result", err):
					default:
					}
					return
				}
				lines[index] = append(encoded, '\n')
				if err := p.writePrivateFile(checkpoint, lines[index]); err != nil {
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
	if p.markerExists(input.BatchID, ".cancelled") {
		return context.Canceled
	}
	return p.writePrivateFile(outputRef, bytes.Join(lines, nil))
}

// executeItemWithRetry serializes the paid request budget across all processes
// sharing the provider data directory. A second worker must never infer a free
// retry from an attempt checkpoint that another worker has not committed yet.
func (p *OpenAIBatchImageProvider) executeItemWithRetry(ctx context.Context, account *Account, input BatchImageInput, item BatchImageInputItem, checkpoint string) (openAIBatchResultLine, error) {
	line := openAIBatchResultLine{Format: batchImageInternalResultFormat, Provider: BatchImageProviderOpenAI, Key: item.CustomID}
	release, stale, err := p.acquireItemLease(checkpoint)
	if err != nil {
		return line, err
	}
	if stale {
		line.Error = openAIBatchResultError(openAIBatchProviderError("OPENAI_BATCH_EXECUTION_INTERRUPTED", "item execution lease expired before completion; generation will not be repeated", nil))
		return p.writeItemCheckpoint(checkpoint, line)
	}
	defer release()

	line, err = p.executeItemWithRetryLocked(ctx, account, input, item, checkpoint)
	if err != nil {
		return line, err
	}
	// Commit the terminal item result before releasing the cross-process lease.
	// A crash after a 2xx is represented by .accepted; a later worker records a
	// terminal interrupted result rather than submitting another paid request.
	return p.writeItemCheckpoint(checkpoint, line)
}

func (p *OpenAIBatchImageProvider) writeItemCheckpoint(checkpoint string, line openAIBatchResultLine) (openAIBatchResultLine, error) {
	encoded, err := json.Marshal(line)
	if err != nil {
		return line, openAIBatchProviderError("OPENAI_BATCH_ENCODE_ERROR", "unable to encode image batch result", err)
	}
	if err := p.writePrivateFile(checkpoint, append(encoded, '\n')); err != nil {
		return line, err
	}
	return line, nil
}

// acquireItemLease creates the lease atomically with O_EXCL. A lease that outlives
// a request timeout is ambiguous: it may have reached the upstream, so it becomes
// a terminal failed item rather than a new request. This is intentionally biased
// toward preventing duplicate billed images after a process crash.
func (p *OpenAIBatchImageProvider) acquireItemLease(checkpoint string) (release func(), stale bool, err error) {
	if err := os.MkdirAll(p.dataDir, 0o700); err != nil {
		return nil, false, openAIBatchProviderError("OPENAI_BATCH_STORAGE_ERROR", "unable to create item execution storage", err)
	}
	path := p.pathFor(checkpoint + ".lease")
	lease, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err == nil {
		_, writeErr := lease.WriteString(time.Now().UTC().Format(time.RFC3339Nano))
		closeErr := lease.Close()
		if writeErr != nil || closeErr != nil {
			_ = os.Remove(path)
			return nil, false, openAIBatchProviderError("OPENAI_BATCH_STORAGE_ERROR", "unable to create item execution lease", firstOpenAIBatchError(writeErr, closeErr))
		}
		return func() { _ = os.Remove(path) }, false, nil
	}
	if !errors.Is(err, os.ErrExist) {
		return nil, false, openAIBatchProviderError("OPENAI_BATCH_STORAGE_ERROR", "unable to reserve item execution lease", err)
	}
	info, statErr := os.Stat(path)
	if statErr != nil {
		return nil, false, openAIBatchProviderError("OPENAI_BATCH_STORAGE_ERROR", "unable to inspect item execution lease", statErr)
	}
	leaseTTL := p.requestTimeout + openAIBatchItemLeaseGrace
	if leaseTTL < openAIBatchItemLeaseGrace {
		leaseTTL = openAIBatchItemLeaseGrace
	}
	if time.Since(info.ModTime()) >= leaseTTL {
		return nil, true, nil
	}
	return nil, false, errOpenAIBatchItemExecutionInProgress
}

func firstOpenAIBatchError(errs ...error) error {
	for _, err := range errs {
		if err != nil {
			return err
		}
	}
	return nil
}

// Attempts are reserved on disk BEFORE dispatch. A process restart or an ambiguous
// timeout must not reset the two-request budget. A crash can consume an attempt
// without producing an image; compatible upstream idempotency is only best effort.
func (p *OpenAIBatchImageProvider) executeItemWithRetryLocked(ctx context.Context, account *Account, input BatchImageInput, item BatchImageInputItem, checkpoint string) (openAIBatchResultLine, error) {
	line := openAIBatchResultLine{Format: batchImageInternalResultFormat, Provider: BatchImageProviderOpenAI, Key: item.CustomID}
	attempts := 0
	data, err := os.ReadFile(p.pathFor(checkpoint + ".attempts"))
	if err == nil {
		if err := json.Unmarshal(data, &attempts); err != nil || attempts < 0 || attempts > 2 {
			return line, openAIBatchProviderError("OPENAI_BATCH_STORAGE_ERROR", "invalid item attempt checkpoint", err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return line, openAIBatchProviderError("OPENAI_BATCH_STORAGE_ERROR", "unable to read item attempts", err)
	}
	if _, err := os.Stat(p.pathFor(checkpoint + ".accepted")); err == nil {
		line.Error = openAIBatchResultError(openAIBatchProviderError("OPENAI_BATCH_OUTPUT_INTERRUPTED", "generation was accepted but output processing was interrupted; generation will not be repeated", nil))
		return line, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return line, openAIBatchProviderError("OPENAI_BATCH_STORAGE_ERROR", "unable to inspect accepted checkpoint", err)
	}
	lastErr := openAIBatchProviderError("OPENAI_BATCH_ATTEMPTS_EXHAUSTED", "item attempt limit reached after interrupted execution", nil)
	for attempts < 2 {
		// Cancellation can be issued by another instance sharing the storage.
		// Its in-memory cancel function cannot reach this process.
		if p.markerExists(input.BatchID, ".cancelled") {
			return line, context.Canceled
		}
		if err := ctx.Err(); err != nil {
			return line, err
		}
		attempts++
		encoded, _ := json.Marshal(attempts)
		if err := p.writePrivateFile(checkpoint+".attempts", encoded); err != nil {
			return line, err
		}
		attemptCtx := context.WithValue(ctx, openAIBatchAcceptedKey{}, func() error {
			return p.writePrivateFile(checkpoint+".accepted", []byte("accepted\n"))
		})
		line, lastErr = p.executeItem(attemptCtx, account, input, item)
		if lastErr == nil {
			return line, nil
		}
		var terminal *openAIBatchOutputError
		if errors.As(lastErr, &terminal) {
			line.Error = openAIBatchResultError(lastErr)
			return line, nil
		}
		// A client timeout is an item failure; a cancelled worker context is not.
		if err := ctx.Err(); err != nil {
			return line, err
		}
	}
	line.Error = openAIBatchResultError(lastErr)
	return line, nil
}

func openAIBatchResultError(err error) *batchImageInternalError {
	code := "OPENAI_BATCH_ITEM_FAILED"
	message := "OpenAI image request failed"
	if err != nil {
		var providerErr *infraerrors.Error
		if errors.As(err, &providerErr) && strings.TrimSpace(providerErr.Reason) != "" {
			code = strings.TrimSpace(providerErr.Reason)
			message = providerErr.Message
		}
	}
	result := &batchImageInternalError{Code: code, Message: message}
	var rejection *openAIBatchHTTPRejectionError
	if errors.As(err, &rejection) {
		result.HTTPStatus = rejection.status
		result.UpstreamCode = rejection.upstreamCode
	}
	return result
}

func (p *OpenAIBatchImageProvider) executeItem(ctx context.Context, account *Account, input BatchImageInput, item BatchImageInputItem) (openAIBatchResultLine, error) {
	result := openAIBatchResultLine{Format: batchImageInternalResultFormat, Provider: BatchImageProviderOpenAI, Key: item.CustomID}
	images, err := p.requestImage(ctx, account, input, item)
	if err != nil {
		return result, err
	}
	result.Images = images

	return result, nil
}

func (p *OpenAIBatchImageProvider) requestImage(ctx context.Context, account *Account, input BatchImageInput, item BatchImageInputItem) ([]batchImageResultImage, error) {
	size, outputFormat, err := resolveOpenAIBatchImageSpec(input.ImageSize, input.AspectRatio, input.ResponseMimeType)
	if err != nil {
		return nil, err
	}
	endpoint := "/v1/images/generations"
	var body bytes.Buffer
	var contentType string
	if len(item.ReferenceImages) == 0 {
		payload := map[string]any{
			"model":  account.GetMappedModel(input.Model),
			"prompt": item.Prompt,
			"n":      1,
			// GPT image models always return base64; response_format is a DALL-E-only option.
			"output_format": outputFormat,
			"size":          size,
		}
		if err := json.NewEncoder(&body).Encode(payload); err != nil {
			return nil, err
		}
		contentType = "application/json"
	} else {
		endpoint = "/v1/images/edits"
		writer := multipart.NewWriter(&body)
		fields := map[string]string{
			"model": account.GetMappedModel(input.Model), "prompt": item.Prompt,
			"n": "1", "output_format": outputFormat, "size": size,
		}
		for key, value := range fields {
			if err := writer.WriteField(key, value); err != nil {
				return nil, err
			}
		}
		for index, ref := range item.ReferenceImages {
			mimeType := normalizeBatchImageReferenceMimeType(ref.MimeType)
			if mimeType == "" || len(ref.Data) == 0 || strings.TrimSpace(ref.FileURI) != "" {
				return nil, ErrBatchImageInvalidReferenceImage
			}
			name := fmt.Sprintf("reference_%d.%s", index+1, batchImageFileExtension(mimeType))
			header := make(textproto.MIMEHeader)
			header.Set("Content-Disposition", fmt.Sprintf(`form-data; name="image[]"; filename="%s"`, name))
			header.Set("Content-Type", mimeType)
			part, err := writer.CreatePart(header)
			if err != nil {
				return nil, err
			}
			if _, err := part.Write(ref.Data); err != nil {
				return nil, err
			}
		}
		if err := writer.Close(); err != nil {
			return nil, err
		}
		contentType = writer.FormDataContentType()
	}

	baseURL := strings.TrimSpace(account.GetOpenAIBaseURL())
	if baseURL == "" {
		baseURL = "https://api.openai.com"
	}
	validatedBaseURL, err := p.validateBaseURL(baseURL)
	if err != nil {
		return nil, err
	}
	targetURL := buildOpenAIEndpointURL(validatedBaseURL, endpoint)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, targetURL, &body)
	if err != nil {
		return nil, err
	}
	// Do not let net/http replay this paid POST outside the persisted budget.
	req.GetBody = nil
	req.Header.Set("Authorization", "Bearer "+batchImageProviderAPIKey(account))
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Idempotency-Key", openAIBatchItemIdempotencyKey(input.BatchID, item.CustomID))
	account.ApplyHeaderOverrides(req.Header)
	client, err := openAIBatchHTTPClient(resolveAccountProxyURL(account))
	if err != nil {
		return nil, err
	}
	if p.requestTimeout > 0 {
		client.Timeout = p.requestTimeout
	}
	defer client.CloseIdleConnections()
	resp, err := client.Do(req)
	if err != nil {
		// url.Error may include signed endpoints or proxy credentials.
		return nil, openAIBatchProviderError("OPENAI_BATCH_REQUEST_FAILED", "OpenAI image request could not be completed", nil)
	}
	defer resp.Body.Close()
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return nil, openAIBatchHTTPRejection(resp)
	}
	// Persist acceptance before reading/decoding/downloading. Never issue another
	// paid generation after a 2xx, including after worker restart.
	if accepted, ok := ctx.Value(openAIBatchAcceptedKey{}).(func() error); ok {
		if err := accepted(); err != nil {
			return nil, &openAIBatchOutputError{err}
		}
	}
	return p.decodeImageResponse(ctx, resp)
}

// resolveOpenAIBatchImageSpec follows the GPT Image 2 constraints documented at
// https://developers.openai.com/api/docs/guides/image-generation . Tier presets
// deliberately agree with the gateway's longest-edge billing classification.
// These 17 choices are local presets satisfying official custom-size constraints,
// NOT an official tier/aspect mapping or a guarantee of compatible upstream support.
// Outputs above 3,686,400 pixels are experimental per the official guide.
// auto is not accepted: a batch reserves a known per-image price before dispatch.
func resolveOpenAIBatchImageSpec(size, aspect, mimeType string) (string, string, error) {
	format := ""
	switch strings.ToLower(strings.TrimSpace(mimeType)) {
	case "", "image/png":
		format = "png"
	case "image/jpeg":
		format = "jpeg"
	case "image/webp":
		format = "webp"
	default:
		return "", "", batchImageProviderInputError("OpenAI output must be PNG, JPEG or WebP")
	}
	size = strings.ToUpper(strings.TrimSpace(size))
	if size == "" {
		size = "1K"
	}
	aspect = strings.TrimSpace(aspect)
	presets := map[string]map[string]string{
		"1K": {"1:1": "1024x1024", "3:2": "1008x672", "2:3": "672x1008"},
		"2K": {"1:1": "2048x2048", "3:2": "2016x1344", "2:3": "1344x2016", "16:9": "2048x1152", "9:16": "1152x2048", "3:1": "2016x672", "1:3": "672x2016"},
		"4K": {"1:1": "2880x2880", "3:2": "3456x2304", "2:3": "2304x3456", "16:9": "3840x2160", "9:16": "2160x3840", "3:1": "3840x1280", "1:3": "1280x3840"},
	}
	if choices, ok := presets[size]; ok {
		if aspect == "" {
			aspect = "1:1"
		}
		size = choices[aspect]
		if size == "" {
			return "", "", batchImageProviderInputError("unsupported aspect ratio for OpenAI resolution tier")
		}
	} else if aspect != "" {
		return "", "", batchImageProviderInputError("explicit OpenAI pixel dimensions cannot also specify aspect_ratio")
	}
	w, h, ok := parseImageBillingDimensions(size)
	if !ok || w > 3840 || h > 3840 || w%16 != 0 || h%16 != 0 || w*h < 655360 || w*h > 8294400 || w > 3*h || h > 3*w {
		return "", "", batchImageProviderInputError("OpenAI size requires edges divisible by 16, at most 3840, 655360..8294400 pixels and aspect ratio at most 3:1")
	}
	return fmt.Sprintf("%dx%d", w, h), format, nil
}

func openAIBatchItemIdempotencyKey(batchID, customID string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(batchID) + "\x00" + strings.TrimSpace(customID)))
	return "batch-image-" + fmt.Sprintf("%x", sum[:])
}

func openAIBatchHTTPErrorCode(status int) string {
	switch {
	case status == http.StatusTooManyRequests:
		return "OPENAI_BATCH_RATE_LIMITED"
	case status >= http.StatusInternalServerError:
		return "OPENAI_BATCH_UPSTREAM_UNAVAILABLE"
	case status == http.StatusUnauthorized:
		return "OPENAI_BATCH_UPSTREAM_UNAUTHORIZED"
	case status == http.StatusForbidden:
		return "OPENAI_BATCH_UPSTREAM_FORBIDDEN"
	default:
		return "OPENAI_BATCH_UPSTREAM_REJECTED"
	}
}

func openAIBatchHTTPClient(proxyURL string) (*http.Client, error) {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	if strings.TrimSpace(proxyURL) != "" {
		parsed, err := url.Parse(proxyURL)
		if err != nil {
			return nil, err
		}
		transport.Proxy = http.ProxyURL(parsed)
	}
	return &http.Client{Transport: transport, Timeout: 5 * time.Minute, CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
		return http.ErrUseLastResponse
	}}, nil
}

func (p *OpenAIBatchImageProvider) validateBaseURL(raw string) (string, error) {
	if !p.urlAllowlist.Enabled {
		normalized, err := urlvalidator.ValidateURLFormat(raw, p.urlAllowlist.AllowInsecureHTTP)
		if err != nil {
			return "", openAIBatchProviderError("OPENAI_BATCH_INVALID_BASE_URL", "OpenAI batch account has an invalid base URL", nil)
		}
		return normalized, nil
	}
	normalized, err := urlvalidator.ValidateHTTPSURL(raw, urlvalidator.ValidationOptions{
		AllowedHosts:     p.urlAllowlist.UpstreamHosts,
		RequireAllowlist: true,
		AllowPrivate:     p.urlAllowlist.AllowPrivateHosts,
	})
	if err != nil {
		return "", openAIBatchProviderError("OPENAI_BATCH_INVALID_BASE_URL", "OpenAI batch account base URL is not allowed", nil)
	}
	return normalized, nil
}

func (p *OpenAIBatchImageProvider) writeInput(input BatchImageInput) (string, error) {
	ref := input.BatchID + ".input.json"
	payload, err := json.Marshal(openAIBatchStoredInput{Input: input})
	if err != nil {
		return "", openAIBatchProviderError("OPENAI_BATCH_STORAGE_ERROR", "unable to persist batch input", err)
	}
	if err := p.writePrivateFile(ref, payload); err != nil {
		return "", err
	}
	return ref, nil
}

func (p *OpenAIBatchImageProvider) readInput(ref string) (BatchImageInput, error) {
	data, err := os.ReadFile(p.pathFor(ref))
	if errors.Is(err, os.ErrNotExist) {
		return BatchImageInput{}, openAIBatchProviderError("OPENAI_BATCH_INPUT_MISSING", "OpenAI batch input is missing", nil)
	}
	if err != nil {
		return BatchImageInput{}, openAIBatchProviderError("OPENAI_BATCH_STORAGE_ERROR", "unable to read batch input", err)
	}
	var stored openAIBatchStoredInput
	if err := json.Unmarshal(data, &stored); err != nil {
		return BatchImageInput{}, openAIBatchProviderError("OPENAI_BATCH_INPUT_INVALID", "OpenAI batch input is invalid", err)
	}
	if err := validateOpenAIBatchInput(stored.Input); err != nil {
		return BatchImageInput{}, err
	}
	return stored.Input, nil
}

func (p *OpenAIBatchImageProvider) writePrivateFile(ref string, data []byte) error {
	if err := os.MkdirAll(p.dataDir, 0o700); err != nil {
		return openAIBatchProviderError("OPENAI_BATCH_STORAGE_ERROR", "unable to create batch storage", err)
	}
	path := p.pathFor(ref)
	tmp, err := os.CreateTemp(p.dataDir, ".batch-*")
	if err != nil {
		return openAIBatchProviderError("OPENAI_BATCH_STORAGE_ERROR", "unable to create batch storage", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return openAIBatchProviderError("OPENAI_BATCH_STORAGE_ERROR", "unable to secure batch storage", err)
	}
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return openAIBatchProviderError("OPENAI_BATCH_STORAGE_ERROR", "unable to write batch storage", err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return openAIBatchProviderError("OPENAI_BATCH_STORAGE_ERROR", "unable to sync batch storage", err)
	}
	if err := tmp.Close(); err != nil {
		return openAIBatchProviderError("OPENAI_BATCH_STORAGE_ERROR", "unable to finalize batch storage", err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		return openAIBatchProviderError("OPENAI_BATCH_STORAGE_ERROR", "unable to finalize batch storage", err)
	}
	return nil
}

func (p *OpenAIBatchImageProvider) markerExists(batchID, suffix string) bool {
	_, err := os.Stat(p.pathFor(batchID + suffix))
	return err == nil
}

func (p *OpenAIBatchImageProvider) pathFor(ref string) string {
	// refs are generated internally and must remain single file names, preventing
	// a compromised DB row from escaping the provider's private data directory.
	ref = filepath.Base(strings.TrimSpace(ref))
	return filepath.Join(p.dataDir, ref)
}

func openAIBatchProviderError(reason, message string, cause error) error {
	err := infraerrors.New(http.StatusBadGateway, reason, message)
	if cause != nil {
		return err.WithCause(cause)
	}
	return err
}
