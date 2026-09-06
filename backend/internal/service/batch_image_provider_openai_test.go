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
	"time"

	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/stretchr/testify/require"
)

func TestOpenAIBatchImageProvider_RetryKeepsCompletedSiblings(t *testing.T) {
	var goodCalls, badCalls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload map[string]any
		_ = json.NewDecoder(r.Body).Decode(&payload)
		if payload["prompt"] == "retry" && badCalls.Add(1) == 1 {
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		if payload["prompt"] == "good" {
			goodCalls.Add(1)
		}
		_, _ = w.Write([]byte(`{"data":[{"b64_json":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC"}]}`))
	}))
	defer server.Close()
	p := NewOpenAIBatchImageProvider(openAIBatchTestOptions(t.TempDir()))
	input := openAIBatchTestInput()
	input.Items = []BatchImageInputItem{{CustomID: "a", Prompt: "good"}, {CustomID: "b", Prompt: "retry"}}
	account := openAIBatchTestAccount("test", server.URL)
	ref := input.BatchID + ".output.jsonl"
	require.NoError(t, p.execute(context.Background(), account, input, ref))
	require.NoError(t, p.execute(context.Background(), account, input, ref))
	require.Equal(t, int32(1), goodCalls.Load())
	require.Equal(t, int32(2), badCalls.Load())
	require.NoError(t, p.Cleanup(context.Background(), &BatchImageJob{BatchID: input.BatchID, ProviderJobName: &input.BatchID, ProviderOutputRef: &ref}, account, CleanupTargetAll))
	entries, err := os.ReadDir(p.dataDir)
	require.NoError(t, err)
	require.Empty(t, entries)
}

func TestOpenAIBatchImageProvider_MixedFailureBudgetSurvivesRestart(t *testing.T) {
	for _, statusCode := range []int{400, 429, 503, 408} {
		t.Run(http.StatusText(statusCode), func(t *testing.T) {
			var goodCalls, badCalls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var payload map[string]any
				_ = json.NewDecoder(r.Body).Decode(&payload)
				if payload["prompt"] == "bad" {
					badCalls.Add(1)
					if statusCode == 408 {
						<-r.Context().Done()
						return
					}
					w.WriteHeader(statusCode)
					return
				}
				goodCalls.Add(1)
				_, _ = w.Write([]byte(`{"data":[{"b64_json":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC"}]}`))
			}))
			defer server.Close()
			dir := t.TempDir()
			p := NewOpenAIBatchImageProvider(openAIBatchTestOptions(dir))
			p.requestTimeout = 100 * time.Millisecond
			input := openAIBatchTestInput()
			input.Items = []BatchImageInputItem{{CustomID: "good", Prompt: "good"}, {CustomID: "bad", Prompt: "bad"}}
			account := openAIBatchTestAccount("test", server.URL)
			ref := input.BatchID + ".output.jsonl"
			require.NoError(t, p.execute(context.Background(), account, input, ref))
			// Simulate lost result writes after both requests were dispatched. The
			// durable attempt budget must still prevent any third request.
			badCheckpoint := ref + "." + openAIBatchItemIdempotencyKey(input.BatchID, "bad")
			require.NoError(t, os.Remove(p.pathFor(badCheckpoint)))
			p = NewOpenAIBatchImageProvider(openAIBatchTestOptions(dir))
			require.NoError(t, p.execute(context.Background(), account, input, ref))
			require.Equal(t, int32(1), goodCalls.Load())
			require.Equal(t, int32(2), badCalls.Load())
			indexed, err := (&BatchImageResultIndexer{Repo: newFakeBatchImageRepository()}).Index(context.Background(), &BatchImageJob{BatchID: input.BatchID, Provider: BatchImageProviderOpenAI, ProviderOutputRef: &ref}, p, account)
			require.NoError(t, err)
			require.Equal(t, 1, indexed.SuccessCount)
			require.Equal(t, 1, indexed.FailCount)
		})
	}
}
func TestOpenAIBatchImageSpecs(t *testing.T) {
	for _, tc := range []struct{ size, ratio, mime, dimensions, format string }{
		{"1K", "3:2", "image/png", "1008x672", "png"},
		{"2K", "16:9", "image/jpeg", "2048x1152", "jpeg"},
		{"4K", "9:16", "image/webp", "2160x3840", "webp"},
		{"4K", "1:1", "image/png", "2880x2880", "png"},
		{"1536x1024", "", "image/png", "1536x1024", "png"},
	} {
		dimensions, format, err := resolveOpenAIBatchImageSpec(tc.size, tc.ratio, tc.mime)
		require.NoError(t, err)
		require.Equal(t, tc.dimensions, dimensions)
		require.Equal(t, tc.format, format)
	}
	// Lock frontend/backend presets together without treating local tiers as an
	// official mapping. Also verify each preset remains in its reserved price tier.
	frontend, err := os.ReadFile("../../../frontend/src/utils/batchImage.ts")
	require.NoError(t, err)
	count := 0
	for _, tier := range []string{"1K", "2K", "4K"} {
		for _, ratio := range []string{"1:1", "3:2", "2:3", "16:9", "9:16", "3:1", "1:3"} {
			dimensions, _, err := resolveOpenAIBatchImageSpec(tier, ratio, "image/png")
			if err != nil {
				require.Equal(t, "1K", tier)
				continue
			}
			count++
			require.Contains(t, string(frontend), "'"+ratio+"': '"+dimensions+"'")
			w, h, ok := parseImageBillingDimensions(dimensions)
			require.True(t, ok)
			actualTier := "4K"
			if max(w, h) <= 1024 {
				actualTier = "1K"
			} else if max(w, h) <= 2048 {
				actualTier = "2K"
			}
			require.Equal(t, tier, actualTier)
		}
	}
	require.Equal(t, 17, count)
	for _, size := range []string{"auto", "4096x4096", "1025x1024", "256x256", "3840x1024", "3840x3840"} {
		_, _, err := resolveOpenAIBatchImageSpec(size, "", "image/png")
		require.Error(t, err, size)
	}
	_, _, err = resolveOpenAIBatchImageSpec("1K", "16:9", "image/png")
	require.Error(t, err)
}

func TestOpenAIBatchImageProvider_OutputSpecs(t *testing.T) {
	for _, mimeType := range []string{"image/png", "image/jpeg", "image/webp"} {
		t.Run(mimeType, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var payload map[string]any
				require.NoError(t, json.NewDecoder(r.Body).Decode(&payload))
				require.Equal(t, "3840x2160", payload["size"])
				require.Equal(t, mimeType[6:], payload["output_format"])
				_, _ = w.Write([]byte(`{"data":[{"b64_json":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC"}]}`))
			}))
			defer server.Close()
			p := NewOpenAIBatchImageProvider(openAIBatchTestOptions(t.TempDir()))
			input := openAIBatchTestInput()
			input.ImageSize, input.AspectRatio, input.ResponseMimeType = "4K", "16:9", mimeType
			line, err := p.executeItem(context.Background(), openAIBatchTestAccount("test", server.URL), input, input.Items[0])
			require.NoError(t, err)
			require.Equal(t, "image/png", line.Images[0].MimeType) // actual bytes, not the requested format
		})
	}
}

func TestOpenAIBatchImageProvider_SubmitPersistsInputAndCompletes(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		require.Equal(t, "/v1/images/generations", r.URL.Path)
		require.Equal(t, "Bearer sk-test", r.Header.Get("Authorization"))
		var request map[string]any
		require.NoError(t, json.NewDecoder(r.Body).Decode(&request))
		require.Equal(t, "gpt-image-2", request["model"])
		require.NotContains(t, request, "response_format")
		require.NotContains(t, request, "aspectRatio")
		require.NotContains(t, request, "aspect_ratio")
		require.NotContains(t, request, "imageConfig")
		require.Equal(t, "png", request["output_format"])
		_, _ = w.Write([]byte(`{"data":[{"b64_json":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC"}]}`))
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
	require.Contains(t, string(line), `"format":"batch-image/v1"`)
	for _, forbidden := range []string{`"candidates"`, `"inlineData"`, `"response"`} {
		require.NotContains(t, string(line), forbidden)
	}
	parsed, err := ExtractBatchImagePartsFromResultLine(line)
	require.NoError(t, err)
	require.Len(t, parsed.Images, 1)
	require.Equal(t, "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", parsed.Images[0].Base64Data)
	indexed, err := (&BatchImageResultIndexer{Repo: newFakeBatchImageRepository()}).Index(context.Background(), &BatchImageJob{
		BatchID: input.BatchID, Provider: BatchImageProviderOpenAI, ProviderOutputRef: &status.ProviderOutputRef,
	}, provider, account)
	require.NoError(t, err)
	require.Equal(t, 1, indexed.SuccessCount)
	require.Zero(t, indexed.FailCount)
}

func TestOpenAIBatchImageProvider_ReferenceImageUsesEdits(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/v1/images/edits", r.URL.Path)
		require.Contains(t, r.Header.Get("Content-Type"), "multipart/form-data")
		require.NoError(t, r.ParseMultipartForm(1<<20))
		require.Equal(t, "gpt-image-2", r.FormValue("model"))
		require.Empty(t, r.FormValue("response_format"))
		require.NotContains(t, r.MultipartForm.Value, "aspectRatio")
		require.NotContains(t, r.MultipartForm.Value, "aspect_ratio")
		require.NotContains(t, r.MultipartForm.Value, "imageConfig")
		require.Equal(t, "png", r.FormValue("output_format"))
		require.Equal(t, "1", r.FormValue("n"))
		require.Equal(t, "1024x1024", r.FormValue("size"))
		files := r.MultipartForm.File["image[]"]
		require.Len(t, files, 1)
		require.Equal(t, "image/png", files[0].Header.Get("Content-Type"))
		file, err := files[0].Open()
		require.NoError(t, err)
		defer file.Close()
		data, err := io.ReadAll(file)
		require.NoError(t, err)
		require.Equal(t, []byte("png"), data)
		_, _ = w.Write([]byte(`{"data":[{"b64_json":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC"}]}`))
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

func TestOpenAIBatchImageProvider_RequestImageRejectsInvalidReferences(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusBadRequest)
	}))
	defer server.Close()
	provider := NewOpenAIBatchImageProvider(openAIBatchTestOptions(t.TempDir()))
	for _, ref := range []BatchImageReference{
		{MimeType: "image/png", FileURI: "gs://bucket/reference.png"},
		{MimeType: "image/png"},
		{MimeType: "text/plain", Data: []byte("invalid")},
	} {
		input := openAIBatchTestInput()
		input.Items[0].ReferenceImages = []BatchImageReference{ref}
		_, err := provider.requestImage(context.Background(), openAIBatchTestAccount("sk-test", server.URL), input, input.Items[0])
		require.ErrorIs(t, err, ErrBatchImageInvalidReferenceImage)
	}
	require.Zero(t, calls.Load())
}

func TestOpenAIBatchImageProvider_MappingGuardrails(t *testing.T) {
	provider := NewOpenAIBatchImageProvider(openAIBatchTestOptions(t.TempDir()))
	input := openAIBatchTestInput()

	// Provider 底线：映射目标是 Gemini 系生图模型时拒绝提交，openai 批量
	// 永不路由到 Gemini 上游。
	gemini := openAIBatchTestAccount("sk-test", "https://api.openai.com")
	gemini.Credentials["model_mapping"] = map[string]any{"gpt-image-2": "nano-banana-1k"}
	job, err := provider.Submit(context.Background(), nil, gemini, input)
	require.Error(t, err)
	require.Nil(t, job)

	// 分组内配置的上游别名（如 image-2-web）不再被字面量拦截；
	// 「目标必须属于分组模型全集」由 service 层的分组校验负责。
	alias := openAIBatchTestAccount("sk-test", "https://api.openai.com")
	alias.Credentials["model_mapping"] = map[string]any{"gpt-image-2": "image-2-web"}
	job, err = provider.Submit(context.Background(), nil, alias, input)
	require.NoError(t, err)
	require.NotNil(t, job)
	require.NotEmpty(t, job.ProviderJobName)
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
		_, _ = w.Write([]byte(`{"data":[{"b64_json":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC"}]}`))
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
	require.Equal(t, int32(3), calls.Load())

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
		_, _ = w.Write([]byte(`{"data":[{"b64_json":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC"}]}`))
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

func TestOpenAIBatchImageProvider_SharedDirectorySerializesItemExecution(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		close(started)
		<-release
		_, _ = w.Write([]byte(`{"data":[{"b64_json":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC"}]}`))
	}))
	defer server.Close()

	dir := t.TempDir()
	first := NewOpenAIBatchImageProvider(openAIBatchTestOptions(dir))
	second := NewOpenAIBatchImageProvider(openAIBatchTestOptions(dir))
	input := openAIBatchTestInput()
	account := openAIBatchTestAccount("test", server.URL)
	outputRef := input.BatchID + ".output.jsonl"

	firstDone := make(chan error, 1)
	go func() { firstDone <- first.execute(context.Background(), account, input, outputRef) }()
	<-started
	require.ErrorIs(t, second.execute(context.Background(), account, input, outputRef), errOpenAIBatchItemExecutionInProgress)
	close(release)
	require.NoError(t, <-firstDone)
	// Once the owner committed its checkpoint, a later worker can rebuild the
	// aggregate output without issuing another paid request.
	require.NoError(t, second.execute(context.Background(), account, input, outputRef))
	require.Equal(t, int32(1), calls.Load())
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
