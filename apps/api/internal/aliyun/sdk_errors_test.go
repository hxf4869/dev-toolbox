package aliyun

import (
	"context"
	"errors"
	"fmt"
	"net"
	"testing"
	"time"

	"github.com/alibabacloud-go/tea/dara"
)

func stringPointer(value string) *string { return &value }

func intPointer(value int) *int { return &value }

func TestSDKErrorClassificationCoversAllCategories(t *testing.T) {
	cases := []struct {
		name     string
		err      error
		category string
	}{
		{"invalid access key id", &dara.SDKError{Code: stringPointer("InvalidAccessKeyId.NotFound"), StatusCode: intPointer(400)}, failureCredentialInvalid},
		{"signature mismatch", &dara.SDKError{Code: stringPointer("SignatureDoesNotMatch"), StatusCode: intPointer(400)}, failureCredentialInvalid},
		{"forbidden ram", &dara.SDKError{Code: stringPointer("Forbidden.RAM"), Message: stringPointer("User not authorized"), StatusCode: intPointer(403)}, failurePermissionDenied},
		{"service not open", &dara.SDKError{Code: stringPointer("Isv.SERVICE_NOT_OPEN"), StatusCode: intPointer(400)}, failureServiceNotOpen},
		{"arrears", &dara.SDKError{Code: stringPointer("AccountArrears"), StatusCode: intPointer(400)}, failureAccountArrears},
		{"unsupported language", &dara.SDKError{Code: stringPointer("InvalidParameterValue"), Message: stringPointer("SourceLanguage is not supported"), StatusCode: intPointer(400)}, failureUnsupportedLang},
		{"input too long", &dara.SDKError{Code: stringPointer("TranslateApi.TextTooLong"), Message: stringPointer("text exceeds the maximum limit"), StatusCode: intPointer(400)}, failureInputTooLong},
		{"throttled", &dara.SDKError{Code: stringPointer("Throttling"), Message: stringPointer("Requests too frequently"), StatusCode: intPointer(400)}, failureThrottled},
		{"throttled via status", &dara.SDKError{Code: stringPointer(""), StatusCode: intPointer(429)}, failureThrottled},
	}
	for _, test := range cases {
		gatewayErr := mapSDKError(test.err)
		if gatewayErr.Category != test.category {
			t.Fatalf("%s: category = %q, want %q", test.name, gatewayErr.Category, test.category)
		}
		if gatewayErr.Uncertain {
			t.Fatalf("%s: definite 4xx must not be uncertain", test.name)
		}
	}
}

func TestSDKErrorUncertainOutcomes(t *testing.T) {
	serverError := &dara.SDKError{Code: stringPointer("InternalFailure"), StatusCode: intPointer(500)}
	gatewayErr := mapSDKError(serverError)
	if gatewayErr.Category != failureUnavailable || !gatewayErr.Uncertain {
		t.Fatalf("5xx must be unavailable/uncertain: %+v", gatewayErr)
	}

	timeoutError := &net.OpError{Op: "read", Err: osTimeout{}}
	gatewayErr = mapSDKError(timeoutError)
	if gatewayErr.Category != failureTimeout || !gatewayErr.Uncertain {
		t.Fatalf("network timeout must be timeout/uncertain: %+v", gatewayErr)
	}

	gatewayErr = mapSDKError(context.DeadlineExceeded)
	if gatewayErr.Category != failureTimeout || !gatewayErr.Uncertain {
		t.Fatalf("deadline must be timeout/uncertain: %+v", gatewayErr)
	}

	gatewayErr = mapSDKError(context.Canceled)
	if gatewayErr.Category != failureTimeout || !gatewayErr.Uncertain {
		t.Fatalf("cancellation after issue must be timeout/uncertain: %+v", gatewayErr)
	}

	gatewayErr = mapSDKError(errors.New("something odd"))
	if gatewayErr.Category != failureUnknown || !gatewayErr.Uncertain {
		t.Fatalf("unknown errors stay uncertain: %+v", gatewayErr)
	}
}

type osTimeout struct{}

func (osTimeout) Error() string   { return "timeout" }
func (osTimeout) Timeout() bool   { return true }
func (osTimeout) Temporary() bool { return true }

func TestGatewayErrorNeverLeaksUpstreamMessage(t *testing.T) {
	gatewayErr := mapSDKError(&dara.SDKError{
		Code:       stringPointer("InvalidAccessKeyId.NotFound"),
		Message:    stringPointer("secret-hint-do-not-leak"),
		StatusCode: intPointer(400),
	})
	if fmt.Sprint(gatewayErr) == "" || containsSubstring(fmt.Sprint(gatewayErr), "secret-hint") {
		t.Fatalf("gateway error string leaked upstream message: %s", gatewayErr)
	}
}

func containsSubstring(haystack, needle string) bool {
	return len(needle) > 0 && len(haystack) >= len(needle) && (func() bool {
		for index := 0; index+len(needle) <= len(haystack); index++ {
			if haystack[index:index+len(needle)] == needle {
				return true
			}
		}
		return false
	})()
}

func TestUpstreamStatusMapping(t *testing.T) {
	cases := []struct {
		err    *GatewayError
		status int
		code   string
	}{
		{&GatewayError{Category: failureThrottled}, statusTooManyRequests, "UPSTREAM_THROTTLED"},
		{&GatewayError{Category: failureCredentialInvalid}, statusBadGateway, "UPSTREAM_REJECTED"},
		{&GatewayError{Category: failureTimeout, Uncertain: true}, statusGatewayTimeout, "UPSTREAM_RESULT_UNCERTAIN"},
		{&GatewayError{Category: failureUnavailable, Uncertain: true}, statusServiceUnavailable, "UPSTREAM_UNAVAILABLE"},
		{&GatewayError{Category: failureUnknown, Uncertain: true}, statusGatewayTimeout, "UPSTREAM_RESULT_UNCERTAIN"},
		{&GatewayError{Category: failureTimeout, NotIssued: true}, statusServiceUnavailable, "UPSTREAM_UNAVAILABLE"},
	}
	for _, test := range cases {
		status, code := upstreamStatusOf(test.err)
		if status != test.status || code != test.code {
			t.Fatalf("got %d/%s, want %d/%s", status, code, test.status, test.code)
		}
	}
}

func TestValidFailureCategoriesAreTheStableEleven(t *testing.T) {
	if len(validFailureCategories) != 11 {
		t.Fatalf("expected 11 failure categories, got %d", len(validFailureCategories))
	}
	for _, category := range []string{
		failureCredentialInvalid, failurePermissionDenied, failureServiceNotOpen, failureAccountArrears,
		failureUnsupportedLang, failureInputTooLong, failureInvalidImage, failureThrottled,
		failureTimeout, failureUnavailable, failureUnknown,
	} {
		if _, ok := validFailureCategories[category]; !ok {
			t.Fatalf("missing category %q", category)
		}
	}
}

func TestSDKDeadlineIsFixed(t *testing.T) {
	if sdkCallDeadline != 45*time.Second {
		t.Fatalf("SDK deadline must stay 45s, got %s", sdkCallDeadline)
	}
	if translationEndpoint != "mt.cn-hangzhou.aliyuncs.com" {
		t.Fatalf("endpoint must stay fixed, got %s", translationEndpoint)
	}
}
