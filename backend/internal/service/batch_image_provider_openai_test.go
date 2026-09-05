//go:build unit

package service

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/stretchr/testify/require"
)

func TestOpenAIBatchImageProvider_SubmitPersistsInputAndCompletes(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		require.Equal(t, "/v1/images/generations", r.URL.Path)
		require.Equal(t, "Bearer sk-test", r.Header.Get("Authorization"))
		var request map[string]any
		require.NoError(t, json.NewDecoder(r.Body).Decode(&request))
		require.Equal(t, "gpt-image-2", request["model"])
		require.Equal(t, "b64_json", request["response_format"])
		_, _ = w.Write([]byte(`{"data":[{"b64_json":"aGVsbG8="}]}`))
	}))
	defer server.Close()

	dir := t.TempDir()
	provider := NewOpenAIBatchImageProvider(openAIBatchTestOptions(dir))
	account := openAIBatchTestAccount("sk-test", server.URL)
	input := openAIBatchTestInput()
	job, err := provider.Submit(context.Background(), &BatchImageJob{BatchID: input.BatchID, Model: input.Model}, account, input)
	require.NoError(t, err)
	require.Equal(t, input.BatchID, job.ProviderJobName)
	require.FileExists(t, filepath.Join(dir, "batch-image", "openai", job.ProviderInputRef))

	status, err := provider.Get(context.Background(), &BatchImageJob{ProviderJobName: &job.ProviderJobName, ProviderInputRef: &job.ProviderInputRef}, account)
	require.NoError(t, err)
	require.Equal(t, BatchProviderStateSucceeded, status.InternalState)
	require.True(t, status.Done)
	require.Equal(t, int32(1), calls.Load())

	result, contentType, err := provider.OpenResult(context.Background(), &BatchImageJob{ProviderOutputRef: &status.ProviderOutputRef}, account)
	require.NoError(t, err)
	defer result.Close()
	require.Equal(t, "application/jsonl", contentType)
	line, err := io.ReadAll(result)
	require.NoError(t, err)
	parsed, err := ExtractBatchImagePartsFromResultLine(line)
	require.NoError(t, err)
	require.Len(t, parsed.Images, 1)
	require.Equal(t, "aGVsbG8=", parsed.Images[0].Base64Data)
}

func TestOpenAIBatchImageProvider_ReferenceImageUsesEdits(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/v1/images/edits", r.URL.Path)
		require.Contains(t, r.Header.Get("Content-Type"), "multipart/form-data")
		require.NoError(t, r.ParseMultipartForm(1<<20))
		require.Equal(t, "gpt-image-2", r.FormValue("model"))
		require.Equal(t, "b64_json", r.FormValue("response_format"))
		files := r.MultipartForm.File["image[]"]
		require.Len(t, files, 1)
		_, _ = w.Write([]byte(`{"data":[{"b64_json":"aGVsbG8="}]}`))
	}))
	defer server.Close()

	provider := NewOpenAIBatchImageProvider(openAIBatchTestOptions(t.TempDir()))
	input := openAIBatchTestInput()
	input.Items[0].ReferenceImages = []BatchImageReference{{MimeType: "image/png", Data: []byte("png")}}
	job, err := provider.Submit(context.Background(), nil, openAIBatchTestAccount("sk-test", server.URL), input)
	require.NoError(t, err)
	_, err = provider.Get(context.Background(), &BatchImageJob{ProviderJobName: &job.ProviderJobName, ProviderInputRef: &job.ProviderInputRef}, openAIBatchTestAccount("sk-test", server.URL))
	require.NoError(t, err)
}

func TestOpenAIBatchImageProvider_RejectsNonGPTImage2Mapping(t *testing.T) {
	provider := NewOpenAIBatchImageProvider(openAIBatchTestOptions(t.TempDir()))
	input := openAIBatchTestInput()
	account := openAIBatchTestAccount("sk-test", "https://api.openai.com")
	account.Credentials["model_mapping"] = map[string]any{"gpt-image-2": "gpt-image-3"}

	job, err := provider.Submit(context.Background(), nil, account, input)
	require.Error(t, err)
	require.Nil(t, job)
}
func TestOpenAIBatchImageProvider_CancelStopsExecution(t *testing.T) {
	provider := NewOpenAIBatchImageProvider(openAIBatchTestOptions(t.TempDir()))
	account := openAIBatchTestAccount("sk-test", "https://api.openai.com")
	input := openAIBatchTestInput()
	job, err := provider.Submit(context.Background(), nil, account, input)
	require.NoError(t, err)
	require.NoError(t, provider.Cancel(context.Background(), &BatchImageJob{ProviderJobName: &job.ProviderJobName}, account))
	status, err := provider.Get(context.Background(), &BatchImageJob{ProviderJobName: &job.ProviderJobName, ProviderInputRef: &job.ProviderInputRef}, account)
	require.NoError(t, err)
	require.Equal(t, BatchProviderStateCancelled, status.InternalState)
	require.True(t, status.Done)
}

func TestOpenAIBatchImageProvider_RejectsDisallowedBaseURL(t *testing.T) {
	provider := NewOpenAIBatchImageProvider(OpenAIBatchImageProviderOptions{DataDir: t.TempDir(), URLAllowlist: configURLAllowlist("api.openai.com")})
	input := openAIBatchTestInput()
	job, err := provider.Submit(context.Background(), nil, openAIBatchTestAccount("sk-test", "https://evil.example"), input)
	require.Error(t, err)
	require.Nil(t, job)
}

func TestOpenAIBatchImageProvider_CleanupDeletesPrivateFiles(t *testing.T) {
	provider := NewOpenAIBatchImageProvider(openAIBatchTestOptions(t.TempDir()))
	account := openAIBatchTestAccount("sk-test", "https://api.openai.com")
	input := openAIBatchTestInput()
	job, err := provider.Submit(context.Background(), nil, account, input)
	require.NoError(t, err)
	output := input.BatchID + ".output.jsonl"
	require.NoError(t, os.WriteFile(provider.pathFor(output), []byte("{}\n"), 0o600))
	require.NoError(t, provider.Cleanup(context.Background(), &BatchImageJob{ProviderJobName: &job.ProviderJobName, ProviderInputRef: &job.ProviderInputRef, ProviderOutputRef: &output}, account, CleanupTargetAll))
	_, err = os.Stat(provider.pathFor(job.ProviderInputRef))
	require.True(t, os.IsNotExist(err))
	_, err = os.Stat(provider.pathFor(output))
	require.True(t, os.IsNotExist(err))
}

func TestOpenAIBatchImageProvider_UpstreamItemFailureIsWrittenAsResultLine(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		var request map[string]any
		require.NoError(t, json.NewDecoder(r.Body).Decode(&request))
		if request["prompt"] == "rejected image" {
			http.Error(w, `{"error":{"message":"rejected"}}`, http.StatusBadRequest)
			return
		}
		_, _ = w.Write([]byte(`{"data":[{"b64_json":"aGVsbG8="}]}`))
	}))
	defer server.Close()

	provider := NewOpenAIBatchImageProvider(openAIBatchTestOptions(t.TempDir()))
	input := openAIBatchTestInput()
	input.Items = append(input.Items, BatchImageInputItem{CustomID: "rejected_002", Prompt: "rejected image"})
	account := openAIBatchTestAccount("sk-test", server.URL)
	job, err := provider.Submit(context.Background(), nil, account, input)
	require.NoError(t, err)

	status, err := provider.Get(context.Background(), &BatchImageJob{ProviderJobName: &job.ProviderJobName, ProviderInputRef: &job.ProviderInputRef}, account)
	require.NoError(t, err)
	require.Equal(t, BatchProviderStateSucceeded, status.InternalState)
	require.Equal(t, int32(2), calls.Load())

	result, _, err := provider.OpenResult(context.Background(), &BatchImageJob{ProviderOutputRef: &status.ProviderOutputRef}, account)
	require.NoError(t, err)
	defer result.Close()
	lines, err := io.ReadAll(result)
	require.NoError(t, err)
	require.Contains(t, string(lines), `"key":"cover_001"`)
	require.Contains(t, string(lines), `"key":"rejected_002"`)
	require.Contains(t, string(lines), `"code":"OPENAI_BATCH_UPSTREAM_REJECTED"`)
}

func TestOpenAIBatchImageProvider_UsesStableItemIdempotencyKey(t *testing.T) {
	var idempotencyKey string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		idempotencyKey = r.Header.Get("Idempotency-Key")
		_, _ = w.Write([]byte(`{"data":[{"b64_json":"aGVsbG8="}]}`))
	}))
	defer server.Close()

	provider := NewOpenAIBatchImageProvider(openAIBatchTestOptions(t.TempDir()))
	input := openAIBatchTestInput()
	account := openAIBatchTestAccount("sk-test", server.URL)
	job, err := provider.Submit(context.Background(), nil, account, input)
	require.NoError(t, err)
	_, err = provider.Get(context.Background(), &BatchImageJob{ProviderJobName: &job.ProviderJobName, ProviderInputRef: &job.ProviderInputRef}, account)
	require.NoError(t, err)
	require.Equal(t, openAIBatchItemIdempotencyKey(input.BatchID, input.Items[0].CustomID), idempotencyKey)
}

func TestOpenAIBatchImageProvider_CancelInterruptsInflightRequest(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-release
	}))
	defer server.Close()

	provider := NewOpenAIBatchImageProvider(openAIBatchTestOptions(t.TempDir()))
	input := openAIBatchTestInput()
	account := openAIBatchTestAccount("sk-test", server.URL)
	job, err := provider.Submit(context.Background(), nil, account, input)
	require.NoError(t, err)

	getDone := make(chan *BatchProviderStatus, 1)
	errDone := make(chan error, 1)
	go func() {
		status, getErr := provider.Get(context.Background(), &BatchImageJob{ProviderJobName: &job.ProviderJobName, ProviderInputRef: &job.ProviderInputRef}, account)
		getDone <- status
		errDone <- getErr
	}()
	<-started
	require.NoError(t, provider.Cancel(context.Background(), &BatchImageJob{ProviderJobName: &job.ProviderJobName}, account))
	close(release)
	require.NoError(t, <-errDone)
	status := <-getDone
	require.Equal(t, BatchProviderStateCancelled, status.InternalState)
}

func openAIBatchTestInput() BatchImageInput {
	return BatchImageInput{BatchID: "imgbatch_openai_test", Model: "gpt-image-2", ImageSize: "1K", Items: []BatchImageInputItem{{CustomID: "cover_001", Prompt: "test image"}}}
}

func openAIBatchTestAccount(apiKey, baseURL string) *Account {
	return &Account{Platform: PlatformOpenAI, Type: AccountTypeAPIKey, Credentials: map[string]any{"api_key": apiKey, "base_url": baseURL}}
}

func configURLAllowlist(host string) config.URLAllowlistConfig {
	return config.URLAllowlistConfig{Enabled: true, UpstreamHosts: []string{host}}
}

func openAIBatchTestOptions(dataDir string) OpenAIBatchImageProviderOptions {
	return OpenAIBatchImageProviderOptions{DataDir: dataDir, URLAllowlist: config.URLAllowlistConfig{AllowInsecureHTTP: true}}
}
