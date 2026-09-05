package service

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
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
// 由已有 batch worker 在轮询时以受限并发执行普通 Images API，然后写出与 Gemini
// provider 相同的 JSONL 结果格式。这样不改变现有索引、下载与结算协议。
const (
	defaultOpenAIBatchRequeueAfter = 5 * time.Second
	defaultOpenAIBatchConcurrency  = 3
)

type OpenAIBatchImageProviderOptions struct {
	DataDir      string
	URLAllowlist config.URLAllowlistConfig
}

type OpenAIBatchImageProvider struct {
	dataDir      string
	urlAllowlist config.URLAllowlistConfig

	runningMu      sync.Mutex
	runningCancels map[string]context.CancelFunc
}

type openAIBatchStoredInput struct {
	Input BatchImageInput `json:"input"`
}

type openAIBatchImageResponse struct {
	Data []struct {
		B64JSON string `json:"b64_json"`
	} `json:"data"`
	Error *struct {
		Code    any    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

type openAIBatchResultLine struct {
	Key      string `json:"key"`
	Response *struct {
		Candidates []struct {
			Content struct {
				Parts []struct {
					InlineData *struct {
						MimeType string `json:"mimeType"`
						Data     string `json:"data"`
					} `json:"inlineData,omitempty"`
				} `json:"parts"`
			} `json:"content"`
		} `json:"candidates"`
	} `json:"response,omitempty"`
	Error *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

func NewOpenAIBatchImageProvider(opts OpenAIBatchImageProviderOptions) *OpenAIBatchImageProvider {
	dataDir := strings.TrimSpace(opts.DataDir)
	if dataDir == "" {
		dataDir = "data"
	}
	return &OpenAIBatchImageProvider{
		dataDir:        filepath.Join(dataDir, "batch-image", "openai"),
		urlAllowlist:   opts.URLAllowlist,
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
	if !isGPTImage2BatchModel(account.GetMappedModel(input.Model)) {
		return nil, batchImageProviderInputError("mapped model must be gpt-image-2 for OpenAI batch image generation")
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
				line, err := p.executeItem(ctx, account, input, input.Items[index])
				if err != nil {
					// Keep transient upstream and transport failures retryable. Idempotency
					// keys make a later worker attempt safe, while permanent item-level
					// rejections are represented in JSONL and do not discard siblings.
					if isOpenAIBatchRetryableItemError(err) {
						select {
						case errs <- err:
						default:
						}
						return
					}
					// An OpenAI-compatible Images API has no server-side batch endpoint: a
					// permanent request error belongs to this item, not to every other item
					// in the user batch. Persist a standard batch-result error line so the
					// indexer can reconcile and settle successful siblings normally.
					line.Error = openAIBatchResultError(err)
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

func isOpenAIBatchRetryableItemError(err error) bool {
	var providerErr *infraerrors.Error
	if !errors.As(err, &providerErr) {
		// Network / context errors may be transient and must not be converted
		// into a permanent item failure by the provider.
		return true
	}
	switch strings.TrimSpace(providerErr.Reason) {
	case "OPENAI_BATCH_RATE_LIMITED", "OPENAI_BATCH_UPSTREAM_UNAVAILABLE", "OPENAI_BATCH_STORAGE_ERROR":
		return true
	default:
		return false
	}
}

func openAIBatchResultError(err error) *struct {
	Code    string `json:"code"`
	Message string `json:"message"`
} {
	code := "OPENAI_BATCH_ITEM_FAILED"
	message := "OpenAI image request failed"
	if err != nil {
		message = strings.TrimSpace(err.Error())
		if message == "" {
			message = "OpenAI image request failed"
		}
		var providerErr *infraerrors.Error
		if errors.As(err, &providerErr) && strings.TrimSpace(providerErr.Reason) != "" {
			code = strings.TrimSpace(providerErr.Reason)
		}
	}
	return &struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}{Code: code, Message: message}
}

func (p *OpenAIBatchImageProvider) executeItem(ctx context.Context, account *Account, input BatchImageInput, item BatchImageInputItem) (openAIBatchResultLine, error) {
	result := openAIBatchResultLine{Key: item.CustomID}
	images, err := p.requestImage(ctx, account, input, item)
	if err != nil {
		return result, err
	}
	if len(images) == 0 {
		return result, openAIBatchProviderError("OPENAI_BATCH_EMPTY_OUTPUT", "OpenAI image response contained no base64 image", nil)
	}
	result.Response = &struct {
		Candidates []struct {
			Content struct {
				Parts []struct {
					InlineData *struct {
						MimeType string `json:"mimeType"`
						Data     string `json:"data"`
					} `json:"inlineData,omitempty"`
				} `json:"parts"`
			} `json:"content"`
		} `json:"candidates"`
	}{}
	candidate := struct {
		Content struct {
			Parts []struct {
				InlineData *struct {
					MimeType string `json:"mimeType"`
					Data     string `json:"data"`
				} `json:"inlineData,omitempty"`
			} `json:"parts"`
		} `json:"content"`
	}{}
	for _, image := range images {
		part := struct {
			InlineData *struct {
				MimeType string `json:"mimeType"`
				Data     string `json:"data"`
			} `json:"inlineData,omitempty"`
		}{InlineData: &struct {
			MimeType string `json:"mimeType"`
			Data     string `json:"data"`
		}{MimeType: "image/png", Data: image}}
		candidate.Content.Parts = append(candidate.Content.Parts, part)
	}
	result.Response.Candidates = append(result.Response.Candidates, candidate)
	return result, nil
}

func (p *OpenAIBatchImageProvider) requestImage(ctx context.Context, account *Account, input BatchImageInput, item BatchImageInputItem) ([]string, error) {
	endpoint := "/v1/images/generations"
	var body bytes.Buffer
	var contentType string
	if len(item.ReferenceImages) == 0 {
		payload := map[string]any{
			"model":           account.GetMappedModel(input.Model),
			"prompt":          item.Prompt,
			"n":               1,
			"response_format": "b64_json",
			"size":            openAIBatchImageSize(input.ImageSize),
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
			"n": "1", "response_format": "b64_json", "size": openAIBatchImageSize(input.ImageSize),
		}
		for key, value := range fields {
			if err := writer.WriteField(key, value); err != nil {
				return nil, err
			}
		}
		for index, ref := range item.ReferenceImages {
			name := fmt.Sprintf("reference_%d.%s", index+1, batchImageFileExtension(ref.MimeType))
			part, err := writer.CreateFormFile("image[]", name)
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
	req.Header.Set("Authorization", "Bearer "+batchImageProviderAPIKey(account))
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Idempotency-Key", openAIBatchItemIdempotencyKey(input.BatchID, item.CustomID))
	account.ApplyHeaderOverrides(req.Header)
	client, err := openAIBatchHTTPClient(resolveAccountProxyURL(account))
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return nil, openAIBatchProviderError(openAIBatchHTTPErrorCode(resp.StatusCode), "OpenAI image request was rejected", nil)
	}
	var payload openAIBatchImageResponse
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<20)).Decode(&payload); err != nil {
		return nil, openAIBatchProviderError("OPENAI_BATCH_INVALID_RESPONSE", "OpenAI image response is invalid", err)
	}
	if payload.Error != nil {
		return nil, openAIBatchProviderError("OPENAI_BATCH_UPSTREAM_ERROR", "OpenAI image request was rejected", nil)
	}
	images := make([]string, 0, len(payload.Data))
	for _, image := range payload.Data {
		encoded := strings.TrimSpace(image.B64JSON)
		if encoded == "" {
			continue
		}
		if _, err := base64.StdEncoding.DecodeString(encoded); err != nil {
			return nil, errors.New("upstream returned invalid image encoding")
		}
		images = append(images, encoded)
	}
	return images, nil
}

func openAIBatchImageSize(tier string) string {
	// Public batch validation currently accepts only 1K, but keep the conversion
	// explicit for direct provider callers and future tier support.
	switch strings.ToUpper(strings.TrimSpace(tier)) {
	case "2K":
		return "1536x1024"
	case "4K":
		return "1536x1024"
	default:
		return "1024x1024"
	}
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
	case status == http.StatusUnauthorized || status == http.StatusForbidden:
		return "OPENAI_BATCH_UPSTREAM_AUTH_FAILED"
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
	return &http.Client{Transport: transport, Timeout: 5 * time.Minute}, nil
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
