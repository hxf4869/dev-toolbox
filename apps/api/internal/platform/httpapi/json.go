package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
)

var ErrInvalidJSON = errors.New("invalid JSON request")

func DecodeJSON(response http.ResponseWriter, request *http.Request, maxBytes int64, target any) error {
	mediaType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		return ErrInvalidJSON
	}
	request.Body = http.MaxBytesReader(response, request.Body, maxBytes)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return ErrInvalidJSON
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return ErrInvalidJSON
	}
	return nil
}

func NoStore(response http.ResponseWriter) {
	response.Header().Set("Cache-Control", "no-store")
}
