package knowledge

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// T33: the shared decode limiter caps how many heavy decodes run at once.
func TestDecodeLimiterBoundsConcurrency(t *testing.T) {
	const size = 1
	limiter := newDecodeLimiter(size)
	var inFlight, peak atomic.Int64
	var wg sync.WaitGroup
	for worker := 0; worker < 10; worker++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			release, err := limiter.acquire(context.Background())
			if err != nil {
				t.Error(err)
				return
			}
			defer release()
			current := inFlight.Add(1)
			for {
				previous := peak.Load()
				if current <= previous || peak.CompareAndSwap(previous, current) {
					break
				}
			}
			inFlight.Add(-1)
		}()
	}
	wg.Wait()
	if peak.Load() != size {
		t.Fatalf("peak concurrent decodes = %d, want %d", peak.Load(), size)
	}
	// Every permit came back; another acquire succeeds immediately.
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	release, err := limiter.acquire(ctx)
	if err != nil {
		t.Fatalf("permits leaked: %v", err)
	}
	release()
}

// T36: cancelling while waiting for a permit must not consume one.
func TestDecodeLimiterAcquireCancelLeavesNoLeak(t *testing.T) {
	limiter := newDecodeLimiter(1)
	release, err := limiter.acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		waitRelease, waitErr := limiter.acquire(ctx)
		if waitErr == nil {
			waitRelease()
		}
		done <- waitErr
	}()
	time.Sleep(50 * time.Millisecond)
	cancel()
	if waitErr := <-done; !errors.Is(waitErr, context.Canceled) {
		t.Fatalf("cancelled waiter returned %v, want context.Canceled", waitErr)
	}
	release()
	ctx2, cancel2 := context.WithTimeout(context.Background(), time.Second)
	defer cancel2()
	second, err := limiter.acquire(ctx2)
	if err != nil {
		t.Fatalf("permit was lost by a cancelled waiter: %v", err)
	}
	second()
}

// T34: generation of one attachment is coalesced; a different attachment is
// never blocked by it.
func TestThumbnailFlightsSerializeSameAttachment(t *testing.T) {
	flights := newThumbnailFlights()
	attachmentID := uuid.New()
	leave, err := flights.enter(context.Background(), attachmentID)
	if err != nil {
		t.Fatal(err)
	}
	entered := make(chan func(), 1)
	go func() {
		nextLeave, err := flights.enter(context.Background(), attachmentID)
		if err != nil {
			t.Error(err)
			return
		}
		entered <- nextLeave
	}()
	select {
	case <-entered:
		t.Fatal("a second generation of the same attachment must wait")
	case <-time.After(100 * time.Millisecond):
	}
	leave()
	var secondLeave func()
	select {
	case secondLeave = <-entered:
	case <-time.After(time.Second):
		t.Fatal("waiter must be admitted once the winner finishes")
	}
	otherLeave, err := flights.enter(context.Background(), uuid.New())
	if err != nil {
		t.Fatal(err)
	}
	otherLeave()
	secondLeave()
}

func TestThumbnailFlightsEnterCancelledWhileWaiting(t *testing.T) {
	flights := newThumbnailFlights()
	attachmentID := uuid.New()
	leave, err := flights.enter(context.Background(), attachmentID)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		waitLeave, waitErr := flights.enter(ctx, attachmentID)
		if waitErr == nil {
			waitLeave()
		}
		done <- waitErr
	}()
	time.Sleep(50 * time.Millisecond)
	cancel()
	if waitErr := <-done; !errors.Is(waitErr, context.Canceled) {
		t.Fatalf("cancelled waiter returned %v, want context.Canceled", waitErr)
	}
	leave()
	if retry, err := flights.enter(context.Background(), attachmentID); err != nil {
		t.Fatalf("flight table leaked after cancellation: %v", err)
	} else {
		retry()
	}
}

type fakeDerivativeQuerier struct {
	values  []any
	rowErr  error
	execErr error
	execSQL string
}

func (fake *fakeDerivativeQuerier) QueryRow(_ context.Context, _ string, _ ...any) pgx.Row {
	return &fakeAttachmentRow{values: fake.values, err: fake.rowErr}
}

func (fake *fakeDerivativeQuerier) Exec(_ context.Context, query string, _ ...any) (pgconn.CommandTag, error) {
	fake.execSQL = query
	return pgconn.CommandTag{}, fake.execErr
}

type fakeAttachmentRow struct {
	values []any
	err    error
}

func (row *fakeAttachmentRow) Scan(dest ...any) error {
	if row.err != nil {
		return row.err
	}
	if len(dest) != len(row.values) {
		return errors.New("arity mismatch")
	}
	for index, target := range dest {
		switch typed := target.(type) {
		case *string:
			*typed = row.values[index].(string)
		case *int64:
			*typed = row.values[index].(int64)
		case **int:
			value, _ := row.values[index].(*int)
			*typed = value
		case *[]byte:
			value, _ := row.values[index].([]byte)
			*typed = value
		default:
			return errors.New("unsupported scan target")
		}
	}
	return nil
}

func thumbnailTestLookup() *thumbnailLookup {
	width, height := 640, 480
	return &thumbnailLookup{
		attachmentID:  uuid.New(),
		originalKey:   "blobs/aa/origin",
		contentSHA:    []byte("sha"),
		originalSize:  1234,
		width:         &width,
		height:        &height,
		sensitivity:   "normal",
		derivativeID:  uuid.New(),
		derivativeKey: "derivatives/aa/thumb.png",
	}
}

// T35: an attachment deleted while the thumbnail was generated is never
// registered or exposed.
func TestVerifyAndRegisterDerivativeRejectsDeletedAttachment(t *testing.T) {
	querier := &fakeDerivativeQuerier{rowErr: pgx.ErrNoRows}
	request := httptest.NewRequest(http.MethodGet, "/thumbnail", nil)
	err := verifyAndRegisterDerivative(context.Background(), querier, request, thumbnailTestLookup(), 999, time.Now())
	if !errors.Is(err, errThumbnailGone) {
		t.Fatalf("deleted attachment must surface as gone, got %v", err)
	}
	if querier.execSQL != "" {
		t.Fatal("a deleted attachment must not register a derivative")
	}
}

func TestVerifyAndRegisterDerivativeRejectsReplacedOriginal(t *testing.T) {
	lookup := thumbnailTestLookup()
	request := httptest.NewRequest(http.MethodGet, "/thumbnail", nil)
	querier := &fakeDerivativeQuerier{values: []any{
		"blobs/aa/other", lookup.contentSHA, lookup.originalSize, lookup.width, lookup.height, lookup.sensitivity,
	}}
	if err := verifyAndRegisterDerivative(context.Background(), querier, request, lookup, 999, time.Now()); !errors.Is(err, errThumbnailChanged) {
		t.Fatalf("a replaced original must fail verification, got %v", err)
	}
	if querier.execSQL != "" {
		t.Fatal("a changed original must not register a derivative")
	}
	// The same identity passes and registers the derivative.
	querier = &fakeDerivativeQuerier{values: []any{
		lookup.originalKey, lookup.contentSHA, lookup.originalSize, lookup.width, lookup.height, lookup.sensitivity,
	}}
	if err := verifyAndRegisterDerivative(context.Background(), querier, request, lookup, 999, time.Now()); err != nil {
		t.Fatalf("unchanged original must register: %v", err)
	}
	if !strings.Contains(querier.execSQL, "attachment_derivatives") {
		t.Fatal("verification success must write the derivative row")
	}
}
