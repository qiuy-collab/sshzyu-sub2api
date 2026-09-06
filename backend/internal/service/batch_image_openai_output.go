package service

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/pkg/logger"
	"go.uber.org/zap"
	_ "golang.org/x/image/webp"
)

// Fits the shared 16 MiB JSONL scanner, including base64 expansion.
const openAIBatchMaxImageBytes = 10 << 20
const openAIBatchMaxResponseBytes = 15 << 20

type openAIBatchAcceptedKey struct{}
type openAIBatchOutputError struct{ error }

func (e *openAIBatchOutputError) Unwrap() error { return e.error }
func openAIBatchOutputFailure(code, message string) error {
	return &openAIBatchOutputError{openAIBatchProviderError(code, message, nil)}
}

func (p *OpenAIBatchImageProvider) decodeImageResponse(ctx context.Context, resp *http.Response) ([]batchImageResultImage, error) {
	body, err := io.ReadAll(io.LimitReader(resp.Body, openAIBatchMaxResponseBytes+1))
	if err != nil || len(body) > openAIBatchMaxResponseBytes {
		return nil, openAIBatchOutputFailure("OPENAI_BATCH_INVALID_RESPONSE", "image response could not be read within limits")
	}
	var obj map[string]json.RawMessage
	if json.Unmarshal(body, &obj) != nil || obj == nil {
		return nil, openAIBatchOutputFailure("OPENAI_BATCH_INVALID_RESPONSE", "image response is not a JSON object")
	}
	// Only fixed field names, booleans and counts. Never log upstream values or keys.
	has := func(key string) bool { v, ok := obj[key]; return ok && string(v) != "null" }
	async := has("task_id") || has("task") || has("job_id") || has("status") || has("id")
	var payload openAIBatchImageResponse
	parseErr := json.Unmarshal(body, &payload)
	b64Count, urlCount := 0, 0
	for _, entry := range payload.Data {
		if strings.TrimSpace(entry.B64JSON) != "" {
			b64Count++
		}
		if strings.TrimSpace(entry.URL) != "" {
			urlCount++
		}
	}
	logger.L().Info("batch_image.openai_response_shape", zap.Int("http_status", resp.StatusCode), zap.Int("bytes", len(body)), zap.Bool("has_data", has("data")), zap.Bool("has_error", has("error")), zap.Bool("has_async_fields", async), zap.Bool("schema_valid", parseErr == nil), zap.Int("data_count", len(payload.Data)), zap.Int("base64_count", b64Count), zap.Int("url_count", urlCount))
	if has("error") || has("errors") {
		return nil, openAIBatchOutputFailure("OPENAI_BATCH_UPSTREAM_ERROR", "image response reported an upstream error")
	}
	if parseErr != nil {
		return nil, openAIBatchOutputFailure("OPENAI_BATCH_INVALID_RESPONSE", "image response has an unsupported schema")
	}
	if len(payload.Data) == 0 {
		if async {
			return nil, openAIBatchOutputFailure("OPENAI_BATCH_ASYNC_UNSUPPORTED", "asynchronous image responses are unsupported; generation will not be repeated")
		}
		return nil, openAIBatchOutputFailure("OPENAI_BATCH_EMPTY_OUTPUT", "image response contained no image output; generation will not be repeated")
	}
	// Request n=1. Reject extra results rather than exceeding reserved billing or JSONL limits.
	if len(payload.Data) != 1 {
		return nil, openAIBatchOutputFailure("OPENAI_BATCH_INVALID_RESPONSE", "image response contained an unexpected image count")
	}
	entry := payload.Data[0]
	var data []byte
	declared := ""
	if encoded := strings.TrimSpace(entry.B64JSON); encoded != "" {
		if len(encoded) > base64.StdEncoding.EncodedLen(openAIBatchMaxImageBytes) {
			return nil, openAIBatchOutputFailure("OPENAI_BATCH_INVALID_IMAGE", "image exceeds size limit")
		}
		data, err = base64.StdEncoding.DecodeString(encoded)
	} else if strings.TrimSpace(entry.URL) != "" {
		data, declared, err = p.downloadOpenAIBatchImage(ctx, entry.URL)
	} else {
		return nil, openAIBatchOutputFailure("OPENAI_BATCH_EMPTY_OUTPUT", "image entry contains neither base64 nor URL")
	}
	if err != nil {
		var outputErr *openAIBatchOutputError
		if errors.As(err, &outputErr) {
			return nil, outputErr
		}
		return nil, openAIBatchOutputFailure("OPENAI_BATCH_IMAGE_DECODE_FAILED", "image base64 could not be decoded; generation will not be repeated")
	}
	imageResult, err := validateOpenAIBatchImage(data, declared)
	if err != nil {
		return nil, err
	}
	return []batchImageResultImage{imageResult}, nil
}

func validateOpenAIBatchImage(data []byte, declared string) (batchImageResultImage, error) {
	invalid := func() (batchImageResultImage, error) {
		return batchImageResultImage{}, openAIBatchOutputFailure("OPENAI_BATCH_INVALID_IMAGE", "image data or MIME type is invalid")
	}
	if len(data) == 0 || len(data) > openAIBatchMaxImageBytes {
		return invalid()
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || cfg.Width <= 0 || cfg.Height <= 0 || int64(cfg.Width)*int64(cfg.Height) > 16777216 {
		return invalid()
	}
	if format != "png" && format != "jpeg" && format != "webp" {
		return invalid()
	}
	actual := "image/" + format
	if declared != "" {
		mediaType, _, err := mime.ParseMediaType(declared)
		if err != nil || (mediaType != actual && mediaType != "application/octet-stream") {
			return invalid()
		}
	}
	if _, _, err := image.Decode(bytes.NewReader(data)); err != nil {
		return invalid()
	}
	return batchImageResultImage{MimeType: actual, Data: base64.StdEncoding.EncodeToString(data)}, nil
}

func openAIBatchDownloadClient() *http.Client {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	// Do not inherit account or environment proxies: they bypass IP pinning.
	tr.Proxy = nil
	tr.DialContext = safeDialContext
	tr.ResponseHeaderTimeout = 15 * time.Second
	return &http.Client{Transport: tr, Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

const openAIBatchMaxRedirects = 3

func validateOpenAIBatchImageURL(u *url.URL) error {
	if u == nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.Fragment != "" || u.Opaque != "" || (u.Port() != "" && u.Port() != "443") || isBlockedHostname(strings.TrimSuffix(u.Hostname(), ".")) {
		return openAIBatchDownloadFailure("URL_DENIED", "image URL is not allowed")
	}
	if ip := net.ParseIP(u.Hostname()); ip != nil && (isPrivateIP(ip) || !ip.IsGlobalUnicast()) {
		return openAIBatchDownloadFailure("URL_DENIED", "image URL is not allowed")
	}
	return nil
}

func openAIBatchDownloadFailure(reason, message string) error {
	// Only fixed categories and numeric HTTP status may reach logs or persisted errors.
	return openAIBatchOutputFailure("OPENAI_BATCH_IMAGE_"+reason, message+"; generation will not be repeated")
}

func classifyOpenAIBatchDownloadError(err error) error {
	var dns *net.DNSError
	var addr *net.AddrError
	var cert *tls.CertificateVerificationError
	var unknownCA x509.UnknownAuthorityError
	var netErr net.Error
	var escape url.EscapeError
	var invalidHost url.InvalidHostError
	var requestErr *url.Error
	// net/http formats malformed Location errors without preserving the parse cause.
	badLocation := errors.As(err, &requestErr) && strings.HasPrefix(requestErr.Err.Error(), "failed to parse Location header ")
	switch {
	case badLocation, errors.As(err, &escape), errors.As(err, &invalidHost):
		return openAIBatchDownloadFailure("REDIRECT_INVALID", "image redirect location is invalid")
	case errors.Is(err, context.Canceled):
		return openAIBatchDownloadFailure("CANCELLED", "image retrieval was cancelled")
	case errors.As(err, &netErr) && netErr.Timeout():
		return openAIBatchDownloadFailure("TIMEOUT", "image retrieval timed out")
	case errors.As(err, &dns):
		return openAIBatchDownloadFailure("DNS_FAILED", "image host DNS lookup failed")
	case errors.As(err, &addr) && addr.Err == "blocked by SSRF policy":
		return openAIBatchDownloadFailure("URL_DENIED", "image address was denied by security policy")
	case errors.As(err, &cert), errors.As(err, &unknownCA):
		return openAIBatchDownloadFailure("TLS_FAILED", "image TLS certificate verification failed")
	default:
		return openAIBatchDownloadFailure("NETWORK_FAILED", "image retrieval connection failed")
	}
}

func (p *OpenAIBatchImageProvider) downloadOpenAIBatchImage(ctx context.Context, raw string) ([]byte, string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return nil, "", openAIBatchDownloadFailure("URL_DENIED", "image URL is not allowed")
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	client := p.imageDownloadClient
	if client == nil {
		client = openAIBatchDownloadClient()
	}
	// Copy rather than mutate a shared client. Redirects are handled explicitly below.
	isolated := *client
	isolated.Jar = nil
	isolated.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	defer isolated.CloseIdleConnections()
	for hop := 0; ; hop++ {
		if err := validateOpenAIBatchImageURL(u); err != nil {
			return nil, "", err
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
		if err != nil {
			return nil, "", openAIBatchDownloadFailure("URL_DENIED", "image URL is not allowed")
		}
		// Fresh request on each hop: no Authorization, cookies, Referer or account headers.
		// Production transport pins each connection to an SSRF-checked resolved IP.
		resp, err := isolated.Do(req)
		if err != nil {
			return nil, "", classifyOpenAIBatchDownloadError(err)
		}
		switch resp.StatusCode {
		case 301, 302, 303, 307, 308:
			location := resp.Header.Get("Location")
			_ = resp.Body.Close()
			if hop >= openAIBatchMaxRedirects {
				return nil, "", openAIBatchDownloadFailure("REDIRECT_LIMIT", "image retrieval exceeded redirect limit")
			}
			next, parseErr := url.Parse(location)
			if parseErr != nil || strings.TrimSpace(location) == "" {
				return nil, "", openAIBatchDownloadFailure("REDIRECT_INVALID", "image redirect location is invalid")
			}
			u = u.ResolveReference(next)
			continue
		}
		if resp.StatusCode != http.StatusOK {
			_ = resp.Body.Close()
			return nil, "", openAIBatchDownloadFailure("HTTP_FAILED", fmt.Sprintf("image retrieval returned HTTP %d", resp.StatusCode))
		}
		if resp.ContentLength > openAIBatchMaxImageBytes {
			_ = resp.Body.Close()
			return nil, "", openAIBatchDownloadFailure("TOO_LARGE", "image exceeds size limit")
		}
		data, readErr := io.ReadAll(io.LimitReader(resp.Body, openAIBatchMaxImageBytes+1))
		_ = resp.Body.Close()
		if readErr != nil {
			if ctx.Err() != nil {
				return nil, "", classifyOpenAIBatchDownloadError(ctx.Err())
			}
			return nil, "", openAIBatchDownloadFailure("READ_FAILED", "image response body could not be read")
		}
		if len(data) > openAIBatchMaxImageBytes {
			return nil, "", openAIBatchDownloadFailure("TOO_LARGE", "image exceeds size limit")
		}
		return data, resp.Header.Get("Content-Type"), nil
	}
}
