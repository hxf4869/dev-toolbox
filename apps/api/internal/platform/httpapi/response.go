package httpapi

import (
	"encoding/json"
	"net/http"
)

type ErrorEnvelope struct {
	Error ErrorBody `json:"error"`
}

type ErrorBody struct {
	Code        string       `json:"code"`
	Message     string       `json:"message"`
	RequestID   string       `json:"requestId"`
	FieldErrors []FieldError `json:"fieldErrors"`
}

type FieldError struct {
	Field  string `json:"field"`
	Reason string `json:"reason"`
}

func WriteJSON(response http.ResponseWriter, status int, value any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(value)
}

func WriteError(response http.ResponseWriter, request *http.Request, status int, code, message string) {
	WriteJSON(response, status, ErrorEnvelope{Error: ErrorBody{
		Code:        code,
		Message:     message,
		RequestID:   RequestIDFromContext(request.Context()),
		FieldErrors: []FieldError{},
	}})
}
