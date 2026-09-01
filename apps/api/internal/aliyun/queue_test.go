package aliyun

import (
	"testing"
	"time"

	"github.com/google/uuid"
)

type fakeClock struct{ current time.Time }

func (clock *fakeClock) Now() time.Time { return clock.current }
func (clock *fakeClock) Advance(duration time.Duration) time.Time {
	clock.current = clock.current.Add(duration)
	return clock.current
}

func newTestQueue() (*queueManager, *fakeClock) {
	clock := &fakeClock{current: time.Date(2026, 8, 31, 10, 0, 0, 0, time.UTC)}
	return newQueueManager(1, 3, clock.Now), clock
}

func mustCreateTicket(t *testing.T, manager *queueManager, owner uuid.UUID, operation string) ticketView {
	t.Helper()
	view, code := manager.Create(owner, operation)
	if code != "" {
		t.Fatalf("create ticket failed: %s", code)
	}
	return view
}

func mustClaim(t *testing.T, manager *queueManager, owner uuid.UUID, ticketID uuid.UUID) *queuePermit {
	t.Helper()
	result, code := manager.Claim(owner, ticketID)
	if code != "" {
		t.Fatalf("claim failed: %s", code)
	}
	if result.Permit == nil || result.Permit.token == "" {
		t.Fatal("claim returned no permit token")
	}
	return result.Permit
}

func TestQueueImmediateReadyAndRepeatClaimReturnsSamePermit(t *testing.T) {
	manager, _ := newTestQueue()
	owner := uuid.New()
	view := mustCreateTicket(t, manager, owner, OperationTranslation)
	if view.Status != ticketReady || view.ClaimBy == nil {
		t.Fatalf("expected immediate ready, got %+v", view)
	}
	first := mustClaim(t, manager, owner, view.TicketID)
	second := mustClaim(t, manager, owner, view.TicketID)
	if first != second {
		t.Fatal("repeated claim must return the same permit")
	}
	got, code := manager.Get(owner, view.TicketID)
	if code != "" || got.Status != ticketActive || got.CancelRequested == nil || *got.CancelRequested {
		t.Fatalf("active snapshot wrong: %+v code=%s", got, code)
	}
}

func TestQueueFifoPositionsAndWaitingExpiry(t *testing.T) {
	manager, clock := newTestQueue()
	owner := uuid.New()
	first := mustCreateTicket(t, manager, owner, OperationTranslation)
	firstPermit := mustClaim(t, manager, owner, first.TicketID) // fills the owner slot

	second := mustCreateTicket(t, manager, owner, OperationTranslation)
	clock.Advance(30 * time.Second)
	third := mustCreateTicket(t, manager, owner, OperationOCR)
	if second.Status != ticketWaiting || second.Position == nil || *second.Position != 1 {
		t.Fatalf("second ticket should wait at position 1: %+v", second)
	}
	if third.Position == nil || *third.Position != 2 {
		t.Fatalf("third ticket should wait at position 2: %+v", third)
	}

	clock.Advance(60 * time.Second)
	manager.RecordRun(firstPermit, 10) // keep the occupied slot alive
	clock.Advance(31 * time.Second)
	view, code := manager.Get(owner, second.TicketID)
	if code != "" || view.Status != ticketExpired {
		t.Fatalf("waiting ticket must expire after 2 minutes: %+v code=%s", view, code)
	}
	// third moves up but the owner slot is still occupied.
	view, code = manager.Get(owner, third.TicketID)
	if code != "" || view.Status != ticketWaiting || *view.Position != 1 {
		t.Fatalf("remaining waiter must keep FIFO slot: %+v", view)
	}
	if _, code = manager.Claim(owner, third.TicketID); code != errTicketNotReady {
		t.Fatalf("claim while waiting must be NOT_READY, got %s", code)
	}
	if _, code = manager.Claim(owner, second.TicketID); code != errTicketExpired {
		t.Fatalf("claim on expired must be EXPIRED, got %s", code)
	}
}

func TestQueueWaitingCapacityTwenty(t *testing.T) {
	manager, _ := newTestQueue()
	owner := uuid.New()
	active := mustCreateTicket(t, manager, owner, OperationTranslation)
	_ = mustClaim(t, manager, owner, active.TicketID)
	for index := 0; index < QueueWaitingCapacity; index++ {
		if _, code := manager.Create(owner, OperationOCR); code != "" {
			t.Fatalf("ticket %d rejected: %s", index, code)
		}
	}
	if _, code := manager.Create(owner, OperationOCR); code != errQueueFull {
		t.Fatalf("21st waiting ticket must be QUEUE_FULL, got %s", code)
	}
}

func TestQueueReadyWindowReleasesToNextWaiter(t *testing.T) {
	manager, clock := newTestQueue()
	owner := uuid.New()
	ready := mustCreateTicket(t, manager, owner, OperationTranslation)
	waiter := mustCreateTicket(t, manager, owner, OperationTranslation)
	if ready.Status != ticketReady || waiter.Status != ticketWaiting {
		t.Fatalf("first ticket should be ready, second waiting: %+v %+v", ready, waiter)
	}
	clock.Advance(16 * time.Second)
	view, code := manager.Get(owner, ready.TicketID)
	if code != "" || view.Status != ticketExpired {
		t.Fatalf("unclaimed ready ticket must expire after 15s: %+v", view)
	}
	view, code = manager.Get(owner, waiter.TicketID)
	if code != "" || view.Status != ticketReady {
		t.Fatalf("next waiter must be promoted: %+v", view)
	}
}

func TestQueueIdleExpiryRetiresPermitWithoutInflight(t *testing.T) {
	manager, clock := newTestQueue()
	owner := uuid.New()
	view := mustCreateTicket(t, manager, owner, OperationTranslation)
	permit := mustClaim(t, manager, owner, view.TicketID)
	clock.Advance(61 * time.Second)
	if _, code := manager.ValidatePermit(permit.token, owner, OperationTranslation); code != errPermitExpired {
		t.Fatalf("idle-expired permit must be CLOUD_PERMIT_EXPIRED, got %s", code)
	}
	got, code := manager.Get(owner, view.TicketID)
	if code != "" || got.Status != ticketExpired {
		t.Fatalf("idle-expired ticket snapshot: %+v code=%s", got, code)
	}
}

func TestQueueAbsoluteDeadlineCancelsInflightButKeepsSlot(t *testing.T) {
	manager, clock := newTestQueue()
	owner := uuid.New()
	view := mustCreateTicket(t, manager, owner, OperationTranslation)
	permit := mustClaim(t, manager, owner, view.TicketID)

	key := uuid.New()
	release, code := manager.BeginInflight(permit, key)
	if code != "" {
		t.Fatalf("inflight begin failed: %s", code)
	}
	// Renewing chunks keeps idle alive; the absolute deadline still fires.
	for index := 0; index < 12; index++ {
		clock.Advance(50 * time.Second)
		manager.RecordRun(permit, 100)
	}
	clock.Advance(time.Minute)
	got, code := manager.Get(owner, view.TicketID)
	if code != "" || got.Status != ticketActive || !*got.CancelRequested {
		t.Fatalf("in-flight permit must stay active with cancel requested: %+v", got)
	}
	select {
	case <-permit.context.Done():
	default:
		t.Fatal("absolute expiry must propagate cancellation")
	}
	release()
	got, code = manager.Get(owner, view.TicketID)
	if code != "" || got.Status != ticketCancelled {
		t.Fatalf("slot must release after handler exits: %+v code=%s", got, code)
	}
}

func TestQueueDeletePropagatesCancelOnlyWhenInflight(t *testing.T) {
	manager, _ := newTestQueue()
	owner := uuid.New()

	waiting := mustCreateTicket(t, manager, owner, OperationTranslation)
	permit := mustClaim(t, manager, owner, waiting.TicketID)

	// DELETE with an in-flight handler keeps the slot.
	key := uuid.New()
	release, code := manager.BeginInflight(permit, key)
	if code != "" {
		t.Fatalf("inflight begin failed: %s", code)
	}
	if code := manager.Delete(owner, waiting.TicketID); code != "" {
		t.Fatalf("delete failed: %s", code)
	}
	select {
	case <-permit.context.Done():
	default:
		t.Fatal("delete must propagate cancellation")
	}
	got, _ := manager.Get(owner, waiting.TicketID)
	if got.Status != ticketActive || !*got.CancelRequested {
		t.Fatalf("in-flight delete must only mark cancel: %+v", got)
	}
	// Repeated delete stays a no-op success.
	if code := manager.Delete(owner, waiting.TicketID); code != "" {
		t.Fatalf("repeated delete failed: %s", code)
	}
	release()
	got, _ = manager.Get(owner, waiting.TicketID)
	if got.Status != ticketCancelled {
		t.Fatalf("ticket must be cancelled after handler exits: %+v", got)
	}
}

func TestQueueDeleteWithoutInflightReleasesImmediately(t *testing.T) {
	manager, clock := newTestQueue()
	owner := uuid.New()
	first := mustCreateTicket(t, manager, owner, OperationTranslation)
	second := mustCreateTicket(t, manager, owner, OperationTranslation) // waiting

	permit := mustClaim(t, manager, owner, first.TicketID)
	if code := manager.Delete(owner, first.TicketID); code != "" {
		t.Fatalf("delete failed: %s", code)
	}
	if _, code := manager.ValidatePermit(permit.token, owner, OperationTranslation); code != errPermitExpired {
		t.Fatalf("released permit must be expired, got %s", code)
	}
	view, code := manager.Get(owner, second.TicketID)
	if code != "" || view.Status != ticketReady {
		t.Fatalf("freed slot must promote the waiter: %+v", view)
	}
	clock.Advance(0)
	if code := manager.Delete(owner, second.TicketID); code != "" {
		t.Fatalf("delete on ready failed: %s", code)
	}
	view, code = manager.Get(owner, second.TicketID)
	if code != "" || view.Status != ticketCancelled {
		t.Fatalf("ready delete must cancel: %+v", view)
	}
	if _, code := manager.Claim(owner, second.TicketID); code != errTicketCancelled {
		t.Fatalf("claim on cancelled must be CANCELLED, got %s", code)
	}
}

func TestQueuePermitValidationOrder(t *testing.T) {
	manager, _ := newTestQueue()
	owner := uuid.New()
	other := uuid.New()
	view := mustCreateTicket(t, manager, owner, OperationTranslation)
	permit := mustClaim(t, manager, owner, view.TicketID)

	if _, code := manager.ValidatePermit("", owner, OperationTranslation); code != errPermitInvalid {
		t.Fatalf("missing token must be INVALID, got %s", code)
	}
	if _, code := manager.ValidatePermit("unknown-token", owner, OperationTranslation); code != errPermitInvalid {
		t.Fatalf("unknown token must be INVALID, got %s", code)
	}
	if _, code := manager.ValidatePermit(permit.token, other, OperationTranslation); code != errPermitInvalid {
		t.Fatalf("foreign owner token must be INVALID, got %s", code)
	}
	if _, code := manager.ValidatePermit(permit.token, owner, OperationOCR); code != errPermitMismatch {
		t.Fatalf("operation mismatch must be OPERATION_MISMATCH, got %s", code)
	}
	if _, code := manager.ValidatePermit(permit.token, owner, OperationTranslation); code != "" {
		t.Fatalf("valid permit rejected: %s", code)
	}
}

func TestQueueInflightSingleHandlerWithIdempotencyPriority(t *testing.T) {
	manager, _ := newTestQueue()
	owner := uuid.New()
	view := mustCreateTicket(t, manager, owner, OperationTranslation)
	permit := mustClaim(t, manager, owner, view.TicketID)

	first := uuid.New()
	release, code := manager.BeginInflight(permit, first)
	if code != "" {
		t.Fatalf("first handler rejected: %s", code)
	}
	if _, code := manager.BeginInflight(permit, first); code != errCallInProgress {
		t.Fatalf("same key must surface CALL_IN_PROGRESS first, got %s", code)
	}
	if _, code := manager.BeginInflight(permit, uuid.New()); code != errPermitBusy {
		t.Fatalf("different key must be CLOUD_PERMIT_BUSY, got %s", code)
	}
	release()
	again, code := manager.BeginInflight(permit, first)
	if code != "" {
		t.Fatalf("released permit must accept a new handler: %s", code)
	}
	again()
}

func TestQueueRunCeilings(t *testing.T) {
	manager, _ := newTestQueue()
	owner := uuid.New()
	view := mustCreateTicket(t, manager, owner, OperationTranslation)
	permit := mustClaim(t, manager, owner, view.TicketID)

	for index := 0; index < maxPermitChunks; index++ {
		if !manager.ProjectedRun(permit, 1) {
			t.Fatalf("chunk %d must fit", index+1)
		}
		manager.RecordRun(permit, 1)
	}
	if manager.ProjectedRun(permit, 1) {
		t.Fatal("191st chunk must be rejected")
	}
	if manager.ProjectedRun(permit, 0) {
		t.Fatal("zero-unit chunk must be rejected")
	}

	otherOwner := uuid.New()
	other := mustCreateTicket(t, manager, otherOwner, OperationTranslation)
	secondPermit := mustClaim(t, manager, otherOwner, other.TicketID)
	if !manager.ProjectedRun(secondPermit, maxPermitUnits) {
		t.Fatal("full single-run budget must fit")
	}
	manager.RecordRun(secondPermit, maxPermitUnits)
	if manager.ProjectedRun(secondPermit, 1) {
		t.Fatal("950001st unit must be rejected")
	}
}

func TestQueueUpdateLimitsStopsNewGrants(t *testing.T) {
	manager, _ := newTestQueue()
	owner := uuid.New()
	first := mustCreateTicket(t, manager, owner, OperationTranslation)
	_ = mustClaim(t, manager, owner, first.TicketID)

	manager.UpdateLimits(3, 10)
	second := mustCreateTicket(t, manager, owner, OperationTranslation)
	if second.Status != ticketReady {
		t.Fatalf("higher limits must grant immediately: %+v", second)
	}
	_ = mustClaim(t, manager, owner, second.TicketID)

	manager.UpdateLimits(1, 10)
	third := mustCreateTicket(t, manager, owner, OperationTranslation)
	if third.Status != ticketWaiting {
		t.Fatalf("lower owner limit must stop new grants: %+v", third)
	}
}

func TestQueueTerminalRetention(t *testing.T) {
	manager, clock := newTestQueue()
	owner := uuid.New()
	for index := 0; index < terminalRetentionLimit+2; index++ {
		view := mustCreateTicket(t, manager, owner, OperationOCR)
		if code := manager.Delete(owner, view.TicketID); code != "" {
			t.Fatalf("delete failed: %s", code)
		}
	}
	// The oldest tickets beyond 20 are evicted immediately.
	if len(manager.terminal) > terminalRetentionLimit {
		t.Fatalf("terminal retained %d tickets", len(manager.terminal))
	}
	clock.Advance(terminalRetention + time.Second)
	manager.Create(owner, OperationOCR) // triggers a sweep
	if len(manager.terminal) != 0 {
		t.Fatalf("terminal tickets must be evicted after 2 minutes, got %d", len(manager.terminal))
	}
}

func TestQueueCrossOwnerIsNotFound(t *testing.T) {
	manager, _ := newTestQueue()
	owner := uuid.New()
	intruder := uuid.New()
	view := mustCreateTicket(t, manager, owner, OperationTranslation)

	if _, code := manager.Get(intruder, view.TicketID); code != errTicketNotFound {
		t.Fatalf("cross-owner get must be NOT_FOUND, got %s", code)
	}
	if _, code := manager.Claim(intruder, view.TicketID); code != errTicketNotFound {
		t.Fatalf("cross-owner claim must be NOT_FOUND, got %s", code)
	}
	if code := manager.Delete(intruder, view.TicketID); code != errTicketNotFound {
		t.Fatalf("cross-owner delete must be NOT_FOUND, got %s", code)
	}
	if _, code := manager.Get(owner, uuid.New()); code != errTicketNotFound {
		t.Fatalf("unknown ticket must be NOT_FOUND, got %s", code)
	}
}
