package httpapi

import (
	"errors"
	"net/http"
	"testing"
	"time"
)

var errSyntheticFlushFailure = errors.New("synthetic socket flush failure")

// flushErrWriter mimics a transport that reports a real flush failure through
// the modern FlushError API (net/http responsecontroller prefers it over the
// no-return-value Flush and only unwraps when neither exists).
type flushErrWriter struct{}

func (writer *flushErrWriter) Header() http.Header              { return http.Header{} }
func (writer *flushErrWriter) Write(body []byte) (int, error)   { return len(body), nil }
func (writer *flushErrWriter) WriteHeader(int)                  {}
func (writer *flushErrWriter) FlushError() error                { return errSyntheticFlushFailure }
func (writer *flushErrWriter) SetWriteDeadline(time.Time) error { return nil }

// Reproduction of the SSE error-swallowing defect: a logging wrapper that only
// implements the no-return-value Flush turns every underlying flush failure
// into a nil error, so an SSE stream cannot observe a broken client. The
// production statusWriter must forward FlushError and reuse the same
// implementation for the no-return-value Flusher path.
func TestStatusWriterFlushErrorPropagatesUnderlyingFailure(t *testing.T) {
	underlying := &flushErrWriter{}
	writer := &statusWriter{ResponseWriter: underlying, status: http.StatusOK}

	if err := http.NewResponseController(writer).Flush(); !errors.Is(err, errSyntheticFlushFailure) {
		t.Fatalf("ResponseController.Flush through statusWriter = %v, want the underlying flush error", err)
	}
	writer.Flush() // no-return-value Flusher callers must stay compatible

	// Unwrap stays available for writers that support neither Flush form.
	if writer.Unwrap() != underlying {
		t.Fatal("statusWriter lost its Unwrap compatibility")
	}
}
