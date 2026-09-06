//go:build unit

package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/stretchr/testify/require"
)

func TestBatchImageProviderRegistry_ReturnsGeminiAPI(t *testing.T) {
	registry := NewDefaultBatchImageProviderRegistry()
	provider, ok := registry.Get(BatchImageProviderGeminiAPI)
	require.True(t, ok)
	require.Equal(t, BatchImageProviderGeminiAPI, provider.Name())

	must, err := registry.MustGet(BatchImageProviderGeminiAPI)
	require.NoError(t, err)
	require.Same(t, provider, must)

	_, err = registry.MustGet("unknown_provider")
	require.ErrorIs(t, err, ErrBatchImageInvalidProvider)
}

func TestGeminiProvider_SupportsOnlyGeminiAPIKeyWithSecret(t *testing.T) {
	provider := NewGeminiAPIBatchImageProvider(&fakeGeminiBatchClient{})

	require.True(t, provider.SupportsAccount(geminiAPIKeyAccount("sk-gemini")))
	require.False(t, provider.SupportsAccount(&Account{Platform: PlatformGemini, Type: AccountTypeAPIKey, Credentials: map[string]any{}}))
	require.False(t, provider.SupportsAccount(&Account{Platform: PlatformGemini, Type: AccountTypeOAuth, Credentials: map[string]any{"api_key": "sk"}}))
	require.False(t, provider.SupportsAccount(&Account{Platform: PlatformOpenAI, Type: AccountTypeAPIKey, Credentials: map[string]any{"api_key": "sk"}}))
	require.False(t, provider.SupportsAccount(nil))
}

func TestGeminiProvider_MissingAPIKeyRejected(t *testing.T) {
	provider := NewGeminiAPIBatchImageProvider(&fakeGeminiBatchClient{})
	_, err := provider.Submit(context.Background(), nil, &Account{Platform: PlatformGemini, Type: AccountTypeAPIKey}, validGeminiBatchInput())
	require.ErrorIs(t, err, ErrBatchImageProviderMissingAPIKey)
}

func TestBuildGeminiBatchJSONL_WritesValidLinesAndPreservesCustomID(t *testing.T) {
	input := validGeminiBatchInput()
	input.Items = append(input.Items, BatchImageInputItem{CustomID: "cover_002", Prompt: "Second prompt"})

	jsonl, err := BuildGeminiBatchJSONL(input)
	require.NoError(t, err)

	lines := strings.Split(strings.TrimSpace(string(jsonl)), "\n")
	require.Len(t, lines, 2)
	requireJSONLLine(t, lines[0], "cover_001", "A clean product hero image")
	requireJSONLLine(t, lines[1], "cover_002", "Second prompt")
}

func TestBuildGeminiBatchJSONL_RejectsDuplicateCustomIDs(t *testing.T) {
	input := validGeminiBatchInput()
	input.Items = append(input.Items, BatchImageInputItem{CustomID: "cover_001", Prompt: "Duplicate"})

	_, err := BuildGeminiBatchJSONL(input)
	require.ErrorIs(t, err, ErrBatchImageProviderInvalidInput)
}

func TestBuildGeminiBatchJSONL_RejectsEmptyPrompt(t *testing.T) {
	input := validGeminiBatchInput()
	input.Items[0].Prompt = " "

	_, err := BuildGeminiBatchJSONL(input)
	require.ErrorIs(t, err, ErrBatchImageProviderInvalidInput)
}

func TestBuildGeminiBatchJSONL_WritesReferenceImages(t *testing.T) {
	input := validGeminiBatchInput()
	input.Items[0].ReferenceImages = []BatchImageReference{
		{MimeType: "image/webp", Data: []byte("webp-bytes")},
		{MimeType: "image/jpeg", FileURI: "gs://bucket/refs/style.jpg"},
	}

	jsonl, err := BuildGeminiBatchJSONL(input)
	require.NoError(t, err)
	lines := strings.Split(strings.TrimSpace(string(jsonl)), "\n")
	require.Len(t, lines, 1)

	var got map[string]any
	require.NoError(t, json.Unmarshal([]byte(lines[0]), &got))
	request := got["request"].(map[string]any)
	contents := request["contents"].([]any)
	parts := contents[0].(map[string]any)["parts"].([]any)
	require.Len(t, parts, 3)
	require.Equal(t, "A clean product hero image", parts[0].(map[string]any)["text"])
	inlineData := parts[1].(map[string]any)["inlineData"].(map[string]any)
	require.Equal(t, "image/webp", inlineData["mimeType"])
	require.Equal(t, "d2VicC1ieXRlcw==", inlineData["data"])
	fileData := parts[2].(map[string]any)["fileData"].(map[string]any)
	require.Equal(t, "image/jpeg", fileData["mimeType"])
	require.Equal(t, "gs://bucket/refs/style.jpg", fileData["fileUri"])
}

func TestGeminiProvider_SubmitUploadsJSONLThenCreatesBatch(t *testing.T) {
	client := &fakeGeminiBatchClient{
		uploaded: &GeminiUploadedFile{Name: "files/input-jsonl"},
		created:  &GeminiBatchJob{Name: "batches/job-123", State: "JOB_STATE_PENDING"},
	}
	provider := NewGeminiAPIBatchImageProvider(client)

	got, err := provider.Submit(context.Background(), &BatchImageJob{BatchID: "imgbatch_123", Model: "gemini-3.1-flash-image"}, geminiAPIKeyAccount("sk-secret"), validGeminiBatchInput())
	require.NoError(t, err)
	require.Equal(t, []string{"upload", "create"}, client.calls)
	require.Equal(t, "files/input-jsonl", got.ProviderInputRef)
	require.Equal(t, "batches/job-123", got.ProviderJobName)
	require.Empty(t, got.ProviderOutputRef)
	require.NotContains(t, got.ProviderInputRef, "A clean product hero image")
	require.NotContains(t, string(client.uploadedJSONL), "sk-secret")
}

func TestGeminiProvider_GetMapsStates(t *testing.T) {
	tests := []struct {
		name      string
		job       *GeminiBatchJob
		wantState BatchProviderInternalState
		wantDone  bool
		wantRef   string
		wantCode  string
	}{
		{name: "running", job: &GeminiBatchJob{Name: "batches/1", State: "JOB_STATE_RUNNING"}, wantState: BatchProviderStateRunning},
		{name: "succeeded_dest_fileName", job: &GeminiBatchJob{Name: "batches/1", State: "JOB_STATE_SUCCEEDED", Dest: &GeminiBatchDest{FileName: "files/out"}}, wantState: BatchProviderStateSucceeded, wantDone: true, wantRef: "files/out"},
		{name: "failed", job: &GeminiBatchJob{Name: "batches/1", State: "JOB_STATE_FAILED", Error: &GeminiBatchError{Code: "BAD_PROMPT", Message: "bad prompt"}}, wantState: BatchProviderStateFailed, wantDone: true, wantCode: "BAD_PROMPT"},
		{name: "cancelled", job: &GeminiBatchJob{Name: "batches/1", State: "JOB_STATE_CANCELLED"}, wantState: BatchProviderStateCancelled, wantDone: true, wantCode: "GEMINI_BATCH_CANCELLED"},
		{name: "expired", job: &GeminiBatchJob{Name: "batches/1", State: "JOB_STATE_EXPIRED"}, wantState: BatchProviderStateExpired, wantDone: true, wantCode: "GEMINI_BATCH_EXPIRED"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			provider := NewGeminiAPIBatchImageProvider(&fakeGeminiBatchClient{got: tt.job})
			got, err := provider.Get(context.Background(), jobWithProviderName("batches/1"), geminiAPIKeyAccount("sk-secret"))
			require.NoError(t, err)
			require.Equal(t, tt.wantState, got.InternalState)
			require.Equal(t, tt.wantDone, got.Done)
			require.Equal(t, tt.wantRef, got.ProviderOutputRef)
			require.Equal(t, tt.wantCode, got.ErrorCode)
			require.NotContains(t, got.ErrorMessage, "sk-secret")
		})
	}
}

func TestGeminiProvider_GetExtractsResponsesFileReference(t *testing.T) {
	provider := NewGeminiAPIBatchImageProvider(&fakeGeminiBatchClient{
		got: &GeminiBatchJob{
			Name:     "batches/1",
			State:    "JOB_STATE_SUCCEEDED",
			Response: &GeminiBatchResponse{ResponsesFile: "files/responses-jsonl"},
		},
	})

	got, err := provider.Get(context.Background(), jobWithProviderName("batches/1"), geminiAPIKeyAccount("sk-secret"))
	require.NoError(t, err)
	require.Equal(t, BatchProviderStateSucceeded, got.InternalState)
	require.Equal(t, "files/responses-jsonl", got.ProviderOutputRef)
}

func TestGeminiProvider_GetRejectsInlineResultShape(t *testing.T) {
	provider := NewGeminiAPIBatchImageProvider(&fakeGeminiBatchClient{
		got: &GeminiBatchJob{
			Name:     "batches/1",
			State:    "JOB_STATE_SUCCEEDED",
			Response: &GeminiBatchResponse{InlinedResponses: []any{map[string]any{"response": "large"}}},
		},
	})

	_, err := provider.Get(context.Background(), jobWithProviderName("batches/1"), geminiAPIKeyAccount("sk-secret"))
	require.ErrorIs(t, err, ErrBatchImageProviderInlineResultUnsupported)
}

func TestGeminiProvider_OpenResultStreamsResultFile(t *testing.T) {
	client := &fakeGeminiBatchClient{downloadBody: "line1\n", downloadContentType: "application/jsonl"}
	provider := NewGeminiAPIBatchImageProvider(client)

	outputRef := "files/output-jsonl"
	r, contentType, err := provider.OpenResult(context.Background(), &BatchImageJob{ProviderOutputRef: &outputRef}, geminiAPIKeyAccount("sk-secret"))
	require.NoError(t, err)
	defer r.Close()

	body, err := io.ReadAll(r)
	require.NoError(t, err)
	require.Equal(t, "line1\n", string(body))
	require.Equal(t, "application/jsonl", contentType)
	require.Equal(t, "files/output-jsonl", client.downloadedFile)
}

func TestGeminiProvider_CancelCallsClient(t *testing.T) {
	client := &fakeGeminiBatchClient{}
	provider := NewGeminiAPIBatchImageProvider(client)

	require.NoError(t, provider.Cancel(context.Background(), jobWithProviderName("batches/1"), geminiAPIKeyAccount("sk-secret")))
	require.Equal(t, "batches/1", client.cancelledBatch)
}

func TestGeminiProvider_CleanupDeletesRefsOnlyWhenPresent(t *testing.T) {
	inputRef := "files/input"
	outputRef := "files/output"
	client := &fakeGeminiBatchClient{}
	provider := NewGeminiAPIBatchImageProvider(client)

	err := provider.Cleanup(context.Background(), &BatchImageJob{ProviderInputRef: &inputRef, ProviderOutputRef: &outputRef}, geminiAPIKeyAccount("sk-secret"), CleanupTargetAll)
	require.NoError(t, err)
	require.Equal(t, []string{"files/input", "files/output"}, client.deletedFiles)

	err = provider.Cleanup(context.Background(), &BatchImageJob{}, geminiAPIKeyAccount("sk-secret"), CleanupTargetAll)
	require.NoError(t, err)
	require.Equal(t, []string{"files/input", "files/output"}, client.deletedFiles)
}

func TestGeminiProvider_ErrorsDoNotExposeAPIKey(t *testing.T) {
	apiKey := "sk-top-secret"
	client := &fakeGeminiBatchClient{uploadErr: &GeminiAPIError{StatusCode: 401, Message: "upstream body should be hidden " + apiKey}}
	provider := NewGeminiAPIBatchImageProvider(client)

	_, err := provider.Submit(context.Background(), nil, geminiAPIKeyAccount(apiKey), validGeminiBatchInput())
	require.Error(t, err)
	require.Equal(t, "GEMINI_AUTH_FAILED", infraerrors.Reason(err))
	require.NotContains(t, err.Error(), apiKey)
}

func TestGeminiProvider_MetadataDoesNotStoreImageBytesOrBase64(t *testing.T) {
	client := &fakeGeminiBatchClient{
		uploaded: &GeminiUploadedFile{Name: "files/input-jsonl"},
		created:  &GeminiBatchJob{Name: "batches/job-123", State: "JOB_STATE_PENDING"},
	}
	provider := NewGeminiAPIBatchImageProvider(client)

	got, err := provider.Submit(context.Background(), nil, geminiAPIKeyAccount("sk-secret"), validGeminiBatchInput())
	require.NoError(t, err)
	require.NotContains(t, got.ProviderJobName, "base64")
	require.NotContains(t, got.ProviderInputRef, "base64")
	require.NotContains(t, got.ProviderOutputRef, "base64")
	require.NotContains(t, got.ProviderJobName+got.ProviderInputRef+got.ProviderOutputRef, "iVBOR")
	require.NotContains(t, got.ProviderJobName+got.ProviderInputRef+got.ProviderOutputRef, "A clean product hero image")
}

func requireJSONLLine(t *testing.T, line, wantKey, wantPrompt string) {
	t.Helper()
	var got map[string]any
	require.NoError(t, json.Unmarshal([]byte(line), &got))
	require.Equal(t, wantKey, got["key"])
	request := got["request"].(map[string]any)
	config := request["generationConfig"].(map[string]any)
	require.Equal(t, []any{"TEXT", "IMAGE"}, config["responseModalities"])
	contents := request["contents"].([]any)
	parts := contents[0].(map[string]any)["parts"].([]any)
	require.Equal(t, wantPrompt, parts[0].(map[string]any)["text"])
}

func validGeminiBatchInput() BatchImageInput {
	return BatchImageInput{
		BatchID:     "imgbatch_123",
		Model:       "gemini-3.1-flash-image",
		DisplayName: "test batch",
		Items: []BatchImageInputItem{{
			CustomID: "cover_001",
			Prompt:   "A clean product hero image",
		}},
	}
}

func geminiAPIKeyAccount(apiKey string) *Account {
	return &Account{
		Platform:    PlatformGemini,
		Type:        AccountTypeAPIKey,
		Credentials: map[string]any{"api_key": apiKey},
	}
}

func jobWithProviderName(name string) *BatchImageJob {
	return &BatchImageJob{ProviderJobName: &name}
}

type fakeGeminiBatchClient struct {
	mu                  sync.Mutex
	calls               []string
	uploaded            *GeminiUploadedFile
	created             *GeminiBatchJob
	got                 *GeminiBatchJob
	uploadErr           error
	createErr           error
	getErr              error
	cancelErr           error
	downloadErr         error
	deleteErr           error
	uploadedJSONL       []byte
	createdFile         string
	cancelledBatch      string
	downloadedFile      string
	downloadBody        string
	downloadContentType string
	deletedFiles        []string

	generatedModels   []string
	generatedRequests []*geminiGenerateRequest
	generateResponse  *GeminiGenerateContentResponse
	generateErr       error
}

func (f *fakeGeminiBatchClient) UploadJSONL(_ context.Context, apiKey string, _ string, r io.Reader) (*GeminiUploadedFile, error) {
	if strings.TrimSpace(apiKey) == "" {
		return nil, errors.New("missing api key")
	}
	f.calls = append(f.calls, "upload")
	f.uploadedJSONL, _ = io.ReadAll(r)
	if f.uploadErr != nil {
		return nil, f.uploadErr
	}
	if f.uploaded != nil {
		return f.uploaded, nil
	}
	return &GeminiUploadedFile{Name: "files/input-jsonl"}, nil
}

func (f *fakeGeminiBatchClient) CreateBatch(_ context.Context, _ string, _ string, fileName string, _ string) (*GeminiBatchJob, error) {
	f.calls = append(f.calls, "create")
	f.createdFile = fileName
	if f.createErr != nil {
		return nil, f.createErr
	}
	if f.created != nil {
		return f.created, nil
	}
	return &GeminiBatchJob{Name: "batches/job-123", State: "JOB_STATE_PENDING"}, nil
}

func (f *fakeGeminiBatchClient) GetBatch(_ context.Context, _ string, _ string) (*GeminiBatchJob, error) {
	f.calls = append(f.calls, "get")
	if f.getErr != nil {
		return nil, f.getErr
	}
	return f.got, nil
}

func (f *fakeGeminiBatchClient) CancelBatch(_ context.Context, _ string, batchName string) error {
	f.calls = append(f.calls, "cancel")
	f.cancelledBatch = batchName
	return f.cancelErr
}

func (f *fakeGeminiBatchClient) DownloadFile(_ context.Context, _ string, fileName string) (io.ReadCloser, string, error) {
	f.calls = append(f.calls, "download")
	f.downloadedFile = fileName
	if f.downloadErr != nil {
		return nil, "", f.downloadErr
	}
	contentType := f.downloadContentType
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	return io.NopCloser(bytes.NewBufferString(f.downloadBody)), contentType, nil
}

func (f *fakeGeminiBatchClient) DeleteFile(_ context.Context, _ string, fileName string) error {
	f.calls = append(f.calls, "delete")
	f.deletedFiles = append(f.deletedFiles, fileName)
	return f.deleteErr
}

// TestGeminiProvider_SubmitFallsBackToLocalOnHTMLUpload proves that a relay
// answering the Files endpoint with an HTML page (new-api style catch-all)
// degrades to the local executor instead of failing the whole submission.
func TestGeminiProvider_SubmitFallsBackToLocalOnHTMLUpload(t *testing.T) {
	client := &fakeGeminiBatchClient{uploadErr: &GeminiUnsupportedEndpointError{StatusCode: 200, Endpoint: "/upload/v1beta/files"}}
	provider := NewGeminiAPIBatchImageProviderWithOptions(client, t.TempDir(), time.Minute)

	got, err := provider.Submit(context.Background(), nil, geminiAPIKeyAccount("sk-secret"), validGeminiBatchInput())
	require.NoError(t, err)
	require.Equal(t, []string{"upload"}, client.calls) // no CreateBatch attempt
	require.Equal(t, "imgbatch_123", got.ProviderJobName)
	require.Equal(t, "imgbatch_123.input.json", got.ProviderInputRef)
	require.Empty(t, got.ProviderOutputRef)
}

func TestGeminiProvider_SubmitFallsBackToLocalOnUpload404(t *testing.T) {
	client := &fakeGeminiBatchClient{uploadErr: &GeminiAPIError{StatusCode: 404, Message: "invalid url"}}
	provider := NewGeminiAPIBatchImageProviderWithOptions(client, t.TempDir(), time.Minute)

	got, err := provider.Submit(context.Background(), nil, geminiAPIKeyAccount("sk-secret"), validGeminiBatchInput())
	require.NoError(t, err)
	require.Equal(t, "imgbatch_123.input.json", got.ProviderInputRef)
	require.Equal(t, []string{"upload"}, client.calls)
}

func TestGeminiProvider_SubmitDoesNotFallbackOnServerError(t *testing.T) {
	client := &fakeGeminiBatchClient{uploadErr: &GeminiAPIError{StatusCode: 500, Message: "boom"}}
	provider := NewGeminiAPIBatchImageProviderWithOptions(client, t.TempDir(), time.Minute)

	_, err := provider.Submit(context.Background(), nil, geminiAPIKeyAccount("sk-secret"), validGeminiBatchInput())
	require.Error(t, err)
	require.Equal(t, "GEMINI_INVALID_RESPONSE", infraerrors.Reason(err))
	require.Equal(t, []string{"upload"}, client.calls)
}

func TestGeminiProvider_LocalGetExecutesItemsAndWritesNeutralOutput(t *testing.T) {
	client := &fakeGeminiBatchClient{uploadErr: &GeminiUnsupportedEndpointError{StatusCode: 200, Endpoint: "/upload/v1beta/files"}}
	provider := NewGeminiAPIBatchImageProviderWithOptions(client, t.TempDir(), time.Minute)
	ctx := context.Background()

	providerJob, err := provider.Submit(ctx, nil, geminiAPIKeyAccount("sk-secret"), twoItemGeminiBatchInput())
	require.NoError(t, err)
	job := jobWithProviderRefs(providerJob)

	status, err := provider.Get(ctx, job, geminiAPIKeyAccount("sk-secret"))
	require.NoError(t, err)
	require.Equal(t, BatchProviderStateSucceeded, status.InternalState)
	require.True(t, status.Done)
	require.Equal(t, "imgbatch_123.output.jsonl", status.ProviderOutputRef)
	// The upstream model name is what reaches the relay (mapped identity here).
	require.Equal(t, []string{"gemini-3.1-flash-image", "gemini-3.1-flash-image"}, client.generatedModels)

	lines := readGeminiLocalOutputLines(t, provider, status.ProviderOutputRef)
	require.Len(t, lines, 2)
	require.Equal(t, "cover_001", lines[0]["key"])
	require.Equal(t, BatchImageProviderGeminiAPI, lines[0]["provider"])
	require.Equal(t, batchImageInternalResultFormat, lines[0]["format"])
	images := lines[0]["images"].([]any)
	require.Len(t, images, 1)
	require.Equal(t, "image/png", images[0].(map[string]any)["mime_type"])
	require.Equal(t, "cG5nLWJ5dGVz", images[0].(map[string]any)["base64_data"])

	// A completed local job is terminal: a repeated Get must not re-execute.
	client.calls = nil
	status, err = provider.Get(ctx, job, geminiAPIKeyAccount("sk-secret"))
	require.NoError(t, err)
	require.True(t, status.Done)
	require.Empty(t, client.calls)
}

func TestGeminiProvider_LocalGetIsolatesFailuresWithRetryBudget(t *testing.T) {
	client := &fakeGeminiBatchClient{
		uploadErr:   &GeminiUnsupportedEndpointError{StatusCode: 200, Endpoint: "/upload/v1beta/files"},
		generateErr: &GeminiAPIError{StatusCode: 429, Message: "rate limited"},
	}
	provider := NewGeminiAPIBatchImageProviderWithOptions(client, t.TempDir(), time.Minute)
	ctx := context.Background()

	providerJob, err := provider.Submit(ctx, nil, geminiAPIKeyAccount("sk-secret"), twoItemGeminiBatchInput())
	require.NoError(t, err)
	job := jobWithProviderRefs(providerJob)

	status, err := provider.Get(ctx, job, geminiAPIKeyAccount("sk-secret"))
	require.NoError(t, err)
	require.Equal(t, BatchProviderStateSucceeded, status.InternalState)

	// Each item must stop after exactly two paid attempts; no whole-batch retry.
	require.Len(t, client.generatedModels, 4)

	lines := readGeminiLocalOutputLines(t, provider, status.ProviderOutputRef)
	require.Len(t, lines, 2)
	for _, line := range lines {
		errObj := line["error"].(map[string]any)
		require.Equal(t, "GEMINI_RATE_LIMITED", errObj["code"])
	}
}

func TestGeminiProvider_LocalGetExtractsNoImageOutputAsTerminalError(t *testing.T) {
	client := &fakeGeminiBatchClient{
		uploadErr: &GeminiUnsupportedEndpointError{StatusCode: 200, Endpoint: "/upload/v1beta/files"},
		generateResponse: &GeminiGenerateContentResponse{
			Candidates: []GeminiGenerateCandidate{{FinishReason: "IMAGE_SAFETY"}},
		},
	}
	provider := NewGeminiAPIBatchImageProviderWithOptions(client, t.TempDir(), time.Minute)
	ctx := context.Background()

	providerJob, err := provider.Submit(ctx, nil, geminiAPIKeyAccount("sk-secret"), validGeminiBatchInput())
	require.NoError(t, err)
	job := jobWithProviderRefs(providerJob)

	status, err := provider.Get(ctx, job, geminiAPIKeyAccount("sk-secret"))
	require.NoError(t, err)
	require.True(t, status.Done)

	lines := readGeminiLocalOutputLines(t, provider, status.ProviderOutputRef)
	require.Len(t, lines, 1)
	errObj := lines[0]["error"].(map[string]any)
	require.Equal(t, "GEMINI_BATCH_NO_IMAGE_OUTPUT", errObj["code"])
	// The fixed local message may include the finish reason, never the key.
	require.NotContains(t, errObj["message"], "sk-secret")
	// A 2xx without images is terminal: exactly one paid attempt.
	require.Len(t, client.generatedModels, 1)
}

// TestGeminiProvider_SubmitUsesAccountBaseURL is the regression test for the
// root cause of GEMINI_INVALID_RESPONSE on relays: the batch client must hit
// the account's own base_url instead of AI Studio.
func TestGeminiProvider_SubmitUsesAccountBaseURL(t *testing.T) {
	var gotPaths, gotKeys []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPaths = append(gotPaths, r.URL.Path)
		gotKeys = append(gotKeys, r.Header.Get("x-goog-api-key"))
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/upload/v1beta/files" {
			_, _ = w.Write([]byte(`{"file":{"name":"files/probe"}}`))
			return
		}
		_, _ = w.Write([]byte(`{"name":"batches/probe","state":"JOB_STATE_PENDING"}`))
	}))
	defer server.Close()

	account := geminiAPIKeyAccount("sk-relay-key")
	account.Credentials["base_url"] = server.URL
	provider := NewGeminiAPIBatchImageProviderWithOptions(nil, t.TempDir(), time.Minute)

	got, err := provider.Submit(context.Background(), nil, account, validGeminiBatchInput())
	require.NoError(t, err)
	// Both the Files upload and the batch creation must hit the account's own
	// base_url — never AI Studio.
	require.Equal(t, []string{"/upload/v1beta/files", "/v1beta/models/gemini-3.1-flash-image:batchGenerateContent"}, gotPaths)
	require.Equal(t, []string{"sk-relay-key", "sk-relay-key"}, gotKeys)
	require.Equal(t, "files/probe", got.ProviderInputRef)
}

// TestGeminiProvider_LocalGenerateContentUsesAccountBaseURL proves the degraded
// executor posts to the relay's own :generateContent endpoint.
func TestGeminiProvider_LocalGenerateContentUsesAccountBaseURL(t *testing.T) {
	var gotPath, gotKey string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotKey = r.Header.Get("x-goog-api-key")
		if r.URL.Path == "/upload/v1beta/files" {
			// Relay fallback page: no Files API → degrade to local execution.
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = w.Write([]byte("<!doctype html><html><body>fallback</body></html>"))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"candidates":[{"content":{"parts":[{"inlineData":{"mimeType":"image/png","data":"cG5n"}}]}}]}`))
	}))
	defer server.Close()

	account := geminiAPIKeyAccount("sk-relay-key")
	account.Credentials["base_url"] = server.URL
	provider := NewGeminiAPIBatchImageProviderWithOptions(nil, t.TempDir(), time.Minute)
	ctx := context.Background()

	providerJob, err := provider.Submit(ctx, nil, account, validGeminiBatchInput())
	require.NoError(t, err)
	job := jobWithProviderRefs(providerJob)

	status, err := provider.Get(ctx, job, account)
	require.NoError(t, err)
	require.True(t, status.Done)
	require.Equal(t, "/v1beta/models/gemini-3.1-flash-image:generateContent", gotPath)
	require.Equal(t, "sk-relay-key", gotKey)
}

func twoItemGeminiBatchInput() BatchImageInput {
	input := validGeminiBatchInput()
	input.Items = append(input.Items, BatchImageInputItem{CustomID: "cover_002", Prompt: "Second prompt"})
	return input
}

func jobWithProviderRefs(providerJob *BatchProviderJob) *BatchImageJob {
	inputRef := providerJob.ProviderInputRef
	jobName := providerJob.ProviderJobName
	return &BatchImageJob{BatchID: "imgbatch_123", ProviderJobName: &jobName, ProviderInputRef: &inputRef}
}

func readGeminiLocalOutputLines(t *testing.T, provider *GeminiAPIBatchImageProvider, outputRef string) []map[string]any {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(provider.local.dataDir, filepath.Base(outputRef)))
	require.NoError(t, err)
	var lines []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		var obj map[string]any
		require.NoError(t, json.Unmarshal([]byte(line), &obj))
		lines = append(lines, obj)
	}
	return lines
}

func (f *fakeGeminiBatchClient) GenerateContent(_ context.Context, apiKey string, model string, request *geminiGenerateRequest) (*GeminiGenerateContentResponse, error) {
	if strings.TrimSpace(apiKey) == "" {
		return nil, errors.New("missing api key")
	}
	f.mu.Lock()
	f.calls = append(f.calls, "generate")
	f.generatedModels = append(f.generatedModels, model)
	f.generatedRequests = append(f.generatedRequests, request)
	f.mu.Unlock()
	if f.generateErr != nil {
		return nil, f.generateErr
	}
	if f.generateResponse != nil {
		return f.generateResponse, nil
	}
	return &GeminiGenerateContentResponse{
		Candidates: []GeminiGenerateCandidate{{
			Content: &GeminiGenerateContent{Parts: []geminiPart{{InlineData: &geminiInlineData{MimeType: "image/png", Data: "cG5nLWJ5dGVz"}}}},
		}},
	}, nil
}
