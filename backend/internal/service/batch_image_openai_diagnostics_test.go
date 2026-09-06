//go:build unit

package service

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestOpenAIBatchHTTPDiagnostics(t *testing.T) {
	for _, tc := range []struct {
		name                 string
		status               int
		body, code, category string
	}{
		{"unauthorized", 401, `{"error":{"code":"invalid_api_key","message":"secret https://private.invalid/?token=secret"}}`, "invalid_api_key", "OPENAI_BATCH_UPSTREAM_UNAUTHORIZED"},
		{"forbidden", 403, `{"error":{"code":"insufficient_permissions","message":"secret"}}`, "insufficient_permissions", "OPENAI_BATCH_UPSTREAM_FORBIDDEN"},
		{"unknown", 403, `{"error":{"code":"secret","message":"secret"}}`, "", "OPENAI_BATCH_UPSTREAM_FORBIDDEN"},
		{"html", 502, `<html>secret</html>`, "", "OPENAI_BATCH_UPSTREAM_UNAVAILABLE"},
		{"numeric", 400, `{"error":{"code":123,"message":"secret"}}`, "", "OPENAI_BATCH_UPSTREAM_REJECTED"},
		{"oversized", 401, strings.Repeat("secret", 12000), "", "OPENAI_BATCH_UPSTREAM_UNAUTHORIZED"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := openAIBatchHTTPRejection(&http.Response{StatusCode: tc.status, Body: io.NopCloser(strings.NewReader(tc.body))})
			result := openAIBatchResultError(err)
			require.Equal(t, tc.status, result.HTTPStatus)
			require.Equal(t, tc.code, result.UpstreamCode)
			require.Equal(t, tc.category, result.Code)
			require.NotContains(t, err.Error(), "secret")
			line, marshalErr := json.Marshal(batchImageInternalResultLine{Format: batchImageInternalResultFormat, Provider: BatchImageProviderOpenAI, Key: "one", Error: result})
			require.NoError(t, marshalErr)
			require.NotContains(t, string(line), "secret")
			var obj map[string]any
			require.NoError(t, json.Unmarshal(line, &obj))
			code, message, failed := batchImageFailureFromProviderFields(obj)
			require.True(t, failed)
			require.Equal(t, tc.category, code)
			require.Contains(t, message, "HTTP ")
			require.Equal(t, message, sanitizeBatchImagePublicMessage(message))
		})
	}
}

type failingBatchImageRefreshLock struct{}

func (failingBatchImageRefreshLock) Release(context.Context) error { return nil }
func (failingBatchImageRefreshLock) Refresh(context.Context, time.Duration) error {
	return errors.New("lease lost")
}

func TestBatchImageWorker_LostLeaseCancelsProcessor(t *testing.T) {
	worker := NewBatchImageWorker(newFakeBatchImageQueue("lease"), &fakeBatchImageProcessor{}, BatchImageWorkerOptions{JobLockTTL: time.Second})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go worker.runJobHeartbeat(ctx, "lease", failingBatchImageRefreshLock{}, make(chan struct{}), done, cancel)
	select {
	case <-ctx.Done():
	case <-time.After(3 * time.Second):
		t.Fatal("lost lease did not cancel processor")
	}
	<-done
}
