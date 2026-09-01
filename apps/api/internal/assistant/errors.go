package assistant

import (
	"net/http"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/httpapi"
)

// Stable error codes and their HTTP status mapping are frozen by docs/16 §16.
func writeValidationError(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "请求参数无效")
}

func writeAssistantModelRequired(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "ASSISTANT_MODEL_REQUIRED", "请先选择知识助手模型")
}

func writeAssistantModelUnavailable(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(response, request, http.StatusConflict, "ASSISTANT_MODEL_UNAVAILABLE", "所选模型当前不可用，请重新选择")
}

func writeAssistantReasoningUnsupported(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "ASSISTANT_REASONING_UNSUPPORTED", "该思考档位无法发送到当前模型")
}

func writeAssistantIdempotencyConflict(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(response, request, http.StatusConflict, "ASSISTANT_IDEMPOTENCY_CONFLICT", "相同请求标识已被不同内容使用")
}

func writeAssistantRunAlreadyActive(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(response, request, http.StatusConflict, "ASSISTANT_RUN_ALREADY_ACTIVE", "会话已有进行中的回答")
}

func writeAssistantRunNotStoppable(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(response, request, http.StatusConflict, "ASSISTANT_RUN_NOT_STOPPABLE", "当前回答状态不可停止")
}

func writeAssistantRunNotRetryable(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(response, request, http.StatusConflict, "ASSISTANT_RUN_NOT_RETRYABLE", "当前回答不可重试")
}

func writeAssistantSensitiveInputBlocked(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "ASSISTANT_SENSITIVE_INPUT_BLOCKED", "全局敏感策略阻止了本次发送")
}

func writeAssistantContextTooLarge(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "ASSISTANT_CONTEXT_TOO_LARGE", "本轮内容超过模型容量限制")
}

func writeAssistantProviderCredentialsInvalid(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "ASSISTANT_PROVIDER_CREDENTIALS_INVALID", "Provider 凭据不可用")
}

func writeAssistantProviderUnavailable(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(response, request, http.StatusServiceUnavailable, "ASSISTANT_PROVIDER_UNAVAILABLE", "Provider 暂时不可用")
}

func writeAssistantProviderProtocolError(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(response, request, http.StatusBadGateway, "ASSISTANT_PROVIDER_PROTOCOL_ERROR", "Provider 返回了不符合协议的响应")
}

func writeAssistantCitationInvalid(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(response, request, http.StatusBadGateway, "ASSISTANT_CITATION_INVALID", "回答包含无效引用")
}

func writeAssistantEventConflict(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(response, request, http.StatusConflict, "ASSISTANT_EVENT_CONFLICT", "内部事件流校验失败")
}

func writeAssistantLeaseConflict(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(response, request, http.StatusConflict, "ASSISTANT_LEASE_CONFLICT", "工作租约已失效")
}

func writeEmbeddingConfigInvalid(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "EMBEDDING_CONFIG_INVALID", "Embedding 配置无效")
}

func writeEmbeddingReindexConfirmationRequired(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(response, request, http.StatusConflict, "EMBEDDING_REINDEX_CONFIRMATION_REQUIRED", "保存该配置将触发全库重建，需要确认")
}

func writeEmbeddingProviderUnavailable(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(response, request, http.StatusServiceUnavailable, "EMBEDDING_PROVIDER_UNAVAILABLE", "Embedding 服务暂时不可用")
}

func writeAssistantInternalFailure(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "知识助手服务暂时不可用")
}

func writeAssistantNotFound(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(response, request, http.StatusNotFound, "NOT_FOUND", "资源不存在")
}
