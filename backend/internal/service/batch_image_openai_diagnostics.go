package service

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

// Only fixed local categories, numeric status and exact allowlisted codes may be
// persisted. Never retain the response body, message, headers or request URL.
type batchImageInternalError struct {
	Code         string `json:"code"`
	Message      string `json:"message"`
	HTTPStatus   int    `json:"http_status,omitempty"`
	UpstreamCode string `json:"upstream_code,omitempty"`
}

type openAIBatchHTTPRejectionError struct {
	error
	status       int
	upstreamCode string
}

func (e *openAIBatchHTTPRejectionError) Unwrap() error { return e.error }

func openAIBatchAllowedUpstreamCode(code string) string {
	switch code {
	case "invalid_api_key", "invalid_authentication", "authentication_error", "permission_denied", "insufficient_permissions", "access_denied", "model_not_found", "model_not_allowed", "organization_restricted", "organization_deactivated", "account_deactivated", "insufficient_quota", "rate_limit_exceeded", "billing_hard_limit_reached", "content_policy_violation", "moderation_blocked", "invalid_request_error", "invalid_value", "unsupported_parameter", "server_error", "service_unavailable":
		return code
	default:
		return ""
	}
}

func openAIBatchHTTPRejection(resp *http.Response) error {
	const maxErrorBytes = 64 << 10
	data, readErr := io.ReadAll(io.LimitReader(resp.Body, maxErrorBytes+1))
	var payload struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	upstreamCode := ""
	if readErr == nil && len(data) <= maxErrorBytes && json.Unmarshal(data, &payload) == nil {
		upstreamCode = openAIBatchAllowedUpstreamCode(payload.Error.Code)
	}
	message := fmt.Sprintf("OpenAI image request was rejected (HTTP %d)", resp.StatusCode)
	if upstreamCode != "" {
		message += "; upstream_code=" + upstreamCode
	}
	// The fixed message also survives the existing database error-message columns,
	// without requiring a migration or exposing arbitrary upstream prose.
	return &openAIBatchHTTPRejectionError{
		error:  openAIBatchProviderError(openAIBatchHTTPErrorCode(resp.StatusCode), message, nil),
		status: resp.StatusCode, upstreamCode: upstreamCode,
	}
}
