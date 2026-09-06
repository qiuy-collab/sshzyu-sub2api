//go:build unit

package service

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

const openAIBatchPNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC"

type openAIBatchRoundTrip func(*http.Request) (*http.Response, error)

func (f openAIBatchRoundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestOpenAIBatchOutputTerminalShapes(t *testing.T) {
	for _, tc := range []struct{ name, body, code string }{
		{"empty", `{"data":[]}`, "OPENAI_BATCH_EMPTY_OUTPUT"},
		{"missing", `{}`, "OPENAI_BATCH_EMPTY_OUTPUT"},
		{"async", `{"task_id":"secret","status":"pending"}`, "OPENAI_BATCH_ASYNC_UNSUPPORTED"},
		{"error", `{"error":{"message":"secret prompt"}}`, "OPENAI_BATCH_UPSTREAM_ERROR"},
		{"string error", `{"error":"secret"}`, "OPENAI_BATCH_UPSTREAM_ERROR"},
		{"wrong schema", `{"data":{}}`, "OPENAI_BATCH_INVALID_RESPONSE"},
		{"invalid JSON", `{`, "OPENAI_BATCH_INVALID_RESPONSE"},
		{"non image", `{"data":[{"b64_json":"aGVsbG8="}]}`, "OPENAI_BATCH_INVALID_IMAGE"},
		{"private URL", `{"data":[{"url":"https://127.0.0.1/secret"}]}`, "OPENAI_BATCH_IMAGE_URL_DENIED"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); _, _ = io.WriteString(w, tc.body) }))
			defer server.Close()
			dir := t.TempDir()
			p := NewOpenAIBatchImageProvider(openAIBatchTestOptions(dir))
			input := openAIBatchTestInput()
			account := openAIBatchTestAccount("secret", server.URL)
			line, err := p.executeItemWithRetry(context.Background(), account, input, input.Items[0], "checkpoint")
			require.NoError(t, err)
			require.NotNil(t, line.Error)
			require.Equal(t, tc.code, line.Error.Code)
			require.NotContains(t, line.Error.Message, "secret")
			// No final result checkpoint: simulate crash after accepted response.
			p = NewOpenAIBatchImageProvider(openAIBatchTestOptions(dir))
			line, err = p.executeItemWithRetry(context.Background(), account, input, input.Items[0], "checkpoint")
			require.NoError(t, err)
			require.Equal(t, "OPENAI_BATCH_OUTPUT_INTERRUPTED", line.Error.Code)
			require.Equal(t, int32(1), calls.Load())
		})
	}
}

func TestOpenAIBatchOutputURLAndMixedResults(t *testing.T) {
	var posts, gets atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		posts.Add(1)
		var v map[string]any
		_ = json.NewDecoder(r.Body).Decode(&v)
		if v["prompt"] == "base64" {
			_, _ = io.WriteString(w, `{"data":[{"b64_json":"`+openAIBatchPNG+`"}]}`)
			return
		}
		_, _ = io.WriteString(w, `{"data":[{"url":"https://cdn.example/`+v["prompt"].(string)+`?signed=secret"}]}`)
	}))
	defer server.Close()
	p := NewOpenAIBatchImageProvider(openAIBatchTestOptions(t.TempDir()))
	p.imageDownloadClient = &http.Client{Transport: openAIBatchRoundTrip(func(r *http.Request) (*http.Response, error) {
		gets.Add(1)
		require.Empty(t, r.Header.Get("Authorization"))
		require.Empty(t, r.Header.Get("Cookie"))
		require.Empty(t, r.Header.Get("Idempotency-Key"))
		status := 200
		if r.URL.Path == "/fail" {
			status = 503
		}
		data, _ := base64.StdEncoding.DecodeString(openAIBatchPNG)
		return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": []string{"image/png"}}, Body: io.NopCloser(strings.NewReader(string(data)))}, nil
	})}
	input := openAIBatchTestInput()
	input.Items = []BatchImageInputItem{{CustomID: "base64", Prompt: "base64"}, {CustomID: "url", Prompt: "url"}, {CustomID: "fail", Prompt: "fail"}}
	account := openAIBatchTestAccount("secret", server.URL)
	ref := input.BatchID + ".output.jsonl"
	require.NoError(t, p.execute(context.Background(), account, input, ref))
	require.NoError(t, p.execute(context.Background(), account, input, ref))
	require.Equal(t, int32(3), posts.Load())
	require.Equal(t, int32(2), gets.Load())
	body, err := os.ReadFile(p.pathFor(ref))
	require.NoError(t, err)
	require.NotContains(t, string(body), "secret")
	require.NotContains(t, string(body), "cdn.example")
	indexed, err := (&BatchImageResultIndexer{Repo: newFakeBatchImageRepository()}).Index(context.Background(), &BatchImageJob{ProviderOutputRef: &ref}, p, account)
	require.NoError(t, err)
	require.Equal(t, 2, indexed.SuccessCount)
	require.Equal(t, 1, indexed.FailCount)
}

func TestOpenAIBatchDownloadSecurity(t *testing.T) {
	p := NewOpenAIBatchImageProvider(openAIBatchTestOptions(t.TempDir()))
	for _, u := range []string{"http://example.com/a", "https://localhost/a", "https://127.0.0.1/a", "https://10.1.2.3/a", "https://169.254.169.254/a", "https://[::1]/a", "https://user:secret@example.com/a", "file:///a", "https://example.com:8443/a"} {
		_, _, err := p.downloadOpenAIBatchImage(context.Background(), u)
		require.Error(t, err, u)
	}
	client := openAIBatchDownloadClient()
	defer client.CloseIdleConnections()
	require.Equal(t, 30*time.Second, client.Timeout)
	require.Nil(t, client.Transport.(*http.Transport).Proxy)
	require.ErrorIs(t, client.CheckRedirect(&http.Request{}, nil), http.ErrUseLastResponse)
	_, err := client.Transport.(*http.Transport).DialContext(context.Background(), "tcp", "127.0.0.1:80")
	require.Error(t, err)
	for _, status := range []int{302, 503} {
		p.imageDownloadClient = &http.Client{Transport: openAIBatchRoundTrip(func(r *http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: status, Header: http.Header{"Location": []string{"https://127.0.0.1/secret"}}, Body: io.NopCloser(strings.NewReader(""))}, nil
		}), CheckRedirect: client.CheckRedirect}
		_, _, err := p.downloadOpenAIBatchImage(context.Background(), "https://cdn.example/a")
		require.Error(t, err)
	}
}

func TestOpenAIBatchDownloadRedirects(t *testing.T) {
	for _, tc := range []struct {
		name, location, code string
		calls                int
	}{
		{"relative", "/final", "", 2},
		{"cross host", "https://other.example/final", "", 2},
		{"private", "https://127.0.0.1/final", "URL_DENIED", 1},
		{"metadata", "https://169.254.169.254/final", "URL_DENIED", 1},
		{"downgrade", "http://other.example/final", "URL_DENIED", 1},
		{"userinfo", "https://user:secret@other.example/final", "URL_DENIED", 1},
		{"port", "https://other.example:8443/final", "URL_DENIED", 1},
		{"empty", "", "REDIRECT_INVALID", 1},
		{"malformed", "https://other.example/%zz", "REDIRECT_INVALID", 1},
		{"loop", "/loop", "REDIRECT_LIMIT", 4},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := NewOpenAIBatchImageProvider(openAIBatchTestOptions(t.TempDir()))
			calls := 0
			p.imageDownloadClient = &http.Client{Transport: openAIBatchRoundTrip(func(r *http.Request) (*http.Response, error) {
				calls++
				for _, key := range []string{"Authorization", "Cookie", "Referer", "Idempotency-Key"} {
					require.Empty(t, r.Header.Get(key))
				}
				require.Equal(t, http.MethodGet, r.Method)
				if calls == 1 || tc.name == "loop" {
					return &http.Response{StatusCode: 302, Header: http.Header{"Location": []string{tc.location}}, Body: io.NopCloser(strings.NewReader(""))}, nil
				}
				data, _ := base64.StdEncoding.DecodeString(openAIBatchPNG)
				return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"image/png"}}, Body: io.NopCloser(strings.NewReader(string(data)))}, nil
			})}
			data, mime, err := p.downloadOpenAIBatchImage(context.Background(), "https://cdn.example/start?signed=secret")
			if tc.code == "" {
				require.NoError(t, err)
				_, err = validateOpenAIBatchImage(data, mime)
				require.NoError(t, err)
			} else {
				require.ErrorContains(t, err, "OPENAI_BATCH_IMAGE_"+tc.code)
				require.NotContains(t, err.Error(), "secret")
			}
			require.Equal(t, tc.calls, calls)
		})
	}
}

func TestOpenAIBatchDownloadErrorCategories(t *testing.T) {
	for _, tc := range []struct {
		err  error
		code string
	}{
		{context.DeadlineExceeded, "TIMEOUT"}, {context.Canceled, "CANCELLED"},
		{&net.DNSError{Name: "secret.example", Err: "secret"}, "DNS_FAILED"},
		{&net.AddrError{Err: "blocked by SSRF policy", Addr: "secret"}, "URL_DENIED"},
		{&tls.CertificateVerificationError{Err: x509.UnknownAuthorityError{}}, "TLS_FAILED"},
		{errors.New("secret"), "NETWORK_FAILED"},
	} {
		err := classifyOpenAIBatchDownloadError(&url.Error{Op: "Get", URL: "https://secret.example/?token=secret", Err: tc.err})
		require.ErrorContains(t, err, "OPENAI_BATCH_IMAGE_"+tc.code)
		require.NotContains(t, err.Error(), "secret")
	}
}

// Opt-in retrieval only: the URL is read in-process, never printed or persisted.
// This test cannot call the generation endpoint or use account credentials.
func TestOpenAIBatchRetrieveExistingImage(t *testing.T) {
	path := os.Getenv("SUB2API_EXISTING_IMAGE_URL_FILE")
	if path == "" {
		t.Skip("existing image URL file not supplied")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal("existing URL input could not be read")
	}
	p := NewOpenAIBatchImageProvider(openAIBatchTestOptions(t.TempDir()))
	data, mime, err := p.downloadOpenAIBatchImage(context.Background(), string(raw))
	if err != nil {
		t.Fatal(err)
	}
	_, err = validateOpenAIBatchImage(data, mime)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("retrieved and decoded image: bytes=%d", len(data))
	if out := os.Getenv("SUB2API_EXISTING_IMAGE_OUTPUT_FILE"); out != "" {
		f, err := os.OpenFile(out, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			t.Fatal("image output could not be created (must not already exist)")
		}
		_, writeErr := f.Write(data)
		closeErr := f.Close()
		if writeErr != nil || closeErr != nil {
			t.Fatal("image output could not be saved")
		}
	}
}

func TestOpenAIBatchImageValidation(t *testing.T) {
	data, err := base64.StdEncoding.DecodeString(openAIBatchPNG)
	require.NoError(t, err)
	img, err := validateOpenAIBatchImage(data, "image/png; charset=binary")
	require.NoError(t, err)
	require.Equal(t, "image/png", img.MimeType)
	_, err = validateOpenAIBatchImage(data, "image/jpeg")
	require.Error(t, err)
	_, err = validateOpenAIBatchImage(data[:len(data)-10], "image/png")
	require.Error(t, err)
	_, err = validateOpenAIBatchImage(make([]byte, openAIBatchMaxImageBytes+1), "")
	require.Error(t, err)
	p := NewOpenAIBatchImageProvider(openAIBatchTestOptions(t.TempDir()))
	p.imageDownloadClient = &http.Client{Transport: openAIBatchRoundTrip(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, ContentLength: openAIBatchMaxImageBytes + 1, Body: io.NopCloser(strings.NewReader(""))}, nil
	})}
	_, _, err = p.downloadOpenAIBatchImage(context.Background(), "https://cdn.example/a")
	require.Error(t, err)
}
