package aliyun

import (
	"net/http"
	"unicode/utf16"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/httpapi"
)

// HTTP status aliases used by the aliyun module.
const (
	statusOK                  = http.StatusOK
	statusCreated             = http.StatusCreated
	statusBadRequest          = http.StatusBadRequest
	statusUnprocessableEntity = http.StatusUnprocessableEntity
	statusConflict            = http.StatusConflict
	statusGone                = http.StatusGone
	statusTooManyRequests     = http.StatusTooManyRequests
	statusBadGateway          = http.StatusBadGateway
	statusServiceUnavailable  = http.StatusServiceUnavailable
	statusGatewayTimeout      = http.StatusGatewayTimeout
)

// Stable error codes, docs/11 §13.
const (
	codeInvalidInput       = "INVALID_INPUT"
	codeMutationNotAllowed = "MUTATION_NOT_ALLOWED"
	codeNotConfigured      = "ALIYUN_NOT_CONFIGURED"
)

// errorStatus maps the stable codes to their contract HTTP status.
var errorStatus = map[string]int{
	"QUEUE_FULL":                                statusTooManyRequests,
	"QUEUE_TICKET_NOT_FOUND":                    http.StatusNotFound,
	"QUEUE_TICKET_NOT_READY":                    statusConflict,
	"QUEUE_TICKET_EXPIRED":                      statusGone,
	"QUEUE_TICKET_CANCELLED":                    statusGone,
	"CLOUD_PERMIT_INVALID":                      statusConflict,
	"CLOUD_PERMIT_EXPIRED":                      statusGone,
	"CLOUD_PERMIT_OPERATION_MISMATCH":           statusConflict,
	"CLOUD_PERMIT_BUSY":                         statusConflict,
	"CALL_IN_PROGRESS":                          statusConflict,
	"CALL_SETTLED_WITHOUT_RESULT":               statusConflict,
	"IDEMPOTENCY_KEY_REUSED":                    statusConflict,
	"PREFLIGHT_CHANGED":                         statusConflict,
	"QUOTA_EXHAUSTED":                           statusTooManyRequests,
	"PROFESSIONAL_SCENE_REQUIRED":               statusUnprocessableEntity,
	"SOURCE_LANGUAGE_REQUIRED_FOR_PROFESSIONAL": statusUnprocessableEntity,
	"PROFESSIONAL_LANGUAGE_PAIR_UNSUPPORTED":    statusUnprocessableEntity,
	"ALIYUN_NOT_CONFIGURED":                     statusUnprocessableEntity,
	"INVALID_INPUT":                             statusBadRequest,
	"UPSTREAM_THROTTLED":                        statusTooManyRequests,
	"UPSTREAM_REJECTED":                         statusBadGateway,
	"UPSTREAM_UNAVAILABLE":                      statusServiceUnavailable,
	"UPSTREAM_RESULT_UNCERTAIN":                 statusGatewayTimeout,
}

// errorMessage keeps user-facing copy stable per code; upstream messages are
// never included.
var errorMessage = map[string]string{
	"QUEUE_FULL":                                "排队队列已满，请稍后重新排队",
	"QUEUE_TICKET_NOT_FOUND":                    "排队 ticket 不存在或已失效",
	"QUEUE_TICKET_NOT_READY":                    "ticket 仍在等待，请继续查询状态",
	"QUEUE_TICKET_EXPIRED":                      "ticket 已过期，请重新排队",
	"QUEUE_TICKET_CANCELLED":                    "ticket 已取消",
	"CLOUD_PERMIT_INVALID":                      "云调用 permit 无效，请重新排队",
	"CLOUD_PERMIT_EXPIRED":                      "云调用 permit 已失效，请重新排队",
	"CLOUD_PERMIT_OPERATION_MISMATCH":           "permit 与当前操作不匹配",
	"CLOUD_PERMIT_BUSY":                         "当前 permit 已有请求处理中，请等待完成",
	"CALL_IN_PROGRESS":                          "同一幂等键的调用正在处理中",
	"CALL_SETTLED_WITHOUT_RESULT":               "调用已结算但结果未保存，请手动发起一次新调用",
	"IDEMPOTENCY_KEY_REUSED":                    "幂等键已被不同参数的调用使用",
	"PREFLIGHT_CHANGED":                         "确认后可用引擎已变化，请重新预检并确认",
	"QUOTA_EXHAUSTED":                           "本月应用保护额度已用尽",
	"PROFESSIONAL_SCENE_REQUIRED":               "自动使用专业版需要先选择专业场景",
	"SOURCE_LANGUAGE_REQUIRED_FOR_PROFESSIONAL": "使用专业版前必须明确源语言",
	"PROFESSIONAL_LANGUAGE_PAIR_UNSUPPORTED":    "当前专业场景不支持该语言方向",
	"ALIYUN_NOT_CONFIGURED":                     "尚未配置阿里云凭据，请先完成设置",
	"INVALID_INPUT":                             "请求参数无效",
	"UPSTREAM_THROTTLED":                        "上游限流，可稍后手动重试",
	"UPSTREAM_REJECTED":                         "上游拒绝了本次调用",
	"UPSTREAM_UNAVAILABLE":                      "上游服务暂不可用，可手动重试",
	"UPSTREAM_RESULT_UNCERTAIN":                 "调用结果不确定，已按保守计量",
}

type errorEnvelope struct {
	Error errorBody `json:"error"`
}

type errorBody struct {
	Code      string         `json:"code"`
	Message   string         `json:"message"`
	Details   map[string]any `json:"details,omitempty"`
	RequestID string         `json:"requestId"`
}

// writeAliyunError extends the repository envelope with the docs/11 §7
// details object; standard codes keep using httpapi.WriteError.
func writeAliyunError(response http.ResponseWriter, request *http.Request, code string, details map[string]any) {
	if details == nil {
		httpapi.WriteError(response, request, errorStatus[code], code, errorMessage[code])
		return
	}
	httpapi.WriteJSON(response, errorStatus[code], errorEnvelope{Error: errorBody{
		Code:      code,
		Message:   errorMessage[code],
		Details:   details,
		RequestID: httpapi.RequestIDFromContext(request.Context()),
	}})
}

func writeCodeError(response http.ResponseWriter, request *http.Request, code string) {
	writeAliyunError(response, request, code, nil)
}

// writeDecisionError renders a pre-call stop with its fixed details shape.
func writeDecisionError(response http.ResponseWriter, request *http.Request, decision *decisionError) {
	writeAliyunError(response, request, decision.Code, decision.Details)
}

// prepareResponse applies the shared response headers (no-store, nosniff).
func prepareResponse(response http.ResponseWriter) {
	httpapi.NoStore(response)
	response.Header().Set("X-Content-Type-Options", "nosniff")
}

// utf16Length counts UTF-16 code units exactly like JavaScript string.length,
// the billing unit of docs/11 §2.1. Surrogate pairs count as two units.
func utf16Length(value string) int {
	length := 0
	for _, character := range value {
		units := utf16.RuneLen(character)
		if units < 0 {
			units = 1
		}
		length += units
	}
	return length
}
