package aliyun

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"sync"
	"time"

	"github.com/google/uuid"
)

// Queue semantics fixed by docs/10 §7 and docs/11 §9.
const (
	QueueWaitingCapacity   = 20
	waitingTicketTimeout   = 2 * time.Minute
	readyClaimWindow       = 15 * time.Second
	permitIdleTimeout      = 60 * time.Second
	permitAbsoluteTimeout  = 10 * time.Minute
	terminalRetention      = 2 * time.Minute
	terminalRetentionLimit = 20

	OperationTranslation = "translation"
	OperationOCR         = "ocr"

	maxPermitChunks = 191
	maxPermitUnits  = int64(950000)
)

// Ticket states exposed by the ticket API.
const (
	ticketWaiting   = "waiting"
	ticketReady     = "ready"
	ticketActive    = "active"
	ticketExpired   = "expired"
	ticketCancelled = "cancelled"
)

// Queue error codes returned to the HTTP layer.
const (
	errQueueFull       = "QUEUE_FULL"
	errTicketNotFound  = "QUEUE_TICKET_NOT_FOUND"
	errTicketNotReady  = "QUEUE_TICKET_NOT_READY"
	errTicketExpired   = "QUEUE_TICKET_EXPIRED"
	errTicketCancelled = "QUEUE_TICKET_CANCELLED"
	errPermitInvalid   = "CLOUD_PERMIT_INVALID"
	errPermitExpired   = "CLOUD_PERMIT_EXPIRED"
	errPermitMismatch  = "CLOUD_PERMIT_OPERATION_MISMATCH"
	errPermitBusy      = "CLOUD_PERMIT_BUSY"
	errCallInProgress  = "CALL_IN_PROGRESS"
)

type queueTicket struct {
	id          uuid.UUID
	ownerID     uuid.UUID
	operation   string
	createdAt   time.Time
	state       string
	readySince  time.Time
	terminalAt  time.Time
	cancelAsked bool
	permit      *queuePermit
	permitToken string
}

type queuePermit struct {
	token            string
	ticketID         uuid.UUID
	ownerID          uuid.UUID
	operation        string
	active           bool
	activatedAt      time.Time
	idleExpiresAt    time.Time
	absoluteDeadline time.Time
	cancelAsked      bool
	context          context.Context
	cancelFunc       context.CancelFunc
	inflightKey      uuid.UUID
	chunks           int
	units            int64
}

// queueManager is the process-local FIFO. It stores only ticket metadata,
// never text, images or results; an API restart drops it by design.
type queueManager struct {
	mutex       sync.Mutex
	ownerLimit  int
	globalLimit int
	tickets     map[uuid.UUID]*queueTicket
	waiting     []*queueTicket
	terminal    []*queueTicket
	permits     map[string]*queuePermit
	now         func() time.Time
}

func newQueueManager(ownerLimit, globalLimit int, now func() time.Time) *queueManager {
	return &queueManager{
		ownerLimit: ownerLimit, globalLimit: globalLimit,
		tickets: make(map[uuid.UUID]*queueTicket),
		permits: make(map[string]*queuePermit),
		now:     now,
	}
}

// UpdateLimits atomically replaces concurrency limits (docs/11 §8.2). Active
// permits are untouched; new grants respect the tighter values.
func (manager *queueManager) UpdateLimits(ownerLimit, globalLimit int) {
	manager.mutex.Lock()
	defer manager.mutex.Unlock()
	manager.ownerLimit = ownerLimit
	manager.globalLimit = globalLimit
	manager.sweepLocked()
}

type ticketView struct {
	TicketID          uuid.UUID  `json:"ticketId"`
	Operation         string     `json:"operation"`
	Status            string     `json:"status"`
	Position          *int       `json:"position"`
	ExpiresAt         *time.Time `json:"expiresAt"`
	ClaimBy           *time.Time `json:"claimBy"`
	IdleExpiresAt     *time.Time `json:"idleExpiresAt"`
	AbsoluteExpiresAt *time.Time `json:"absoluteExpiresAt"`
	CancelRequested   *bool      `json:"cancelRequested"`
}

// occupiedCountsLocked counts ready and active tickets: a ready ticket holds
// its slot until it claims or the 15s claim window lapses.
func (manager *queueManager) occupiedCountsLocked() (map[uuid.UUID]int, int) {
	ownerCounts := make(map[uuid.UUID]int)
	global := 0
	for _, ticket := range manager.tickets {
		if ticket.state == ticketReady || ticket.state == ticketActive {
			ownerCounts[ticket.ownerID]++
			global++
		}
	}
	return ownerCounts, global
}

func (manager *queueManager) capacityLocked(ownerID uuid.UUID) bool {
	ownerCounts, global := manager.occupiedCountsLocked()
	return global < manager.globalLimit && ownerCounts[ownerID] < manager.ownerLimit
}

// sweepLocked advances expiries, promotes waiters and trims terminal state.
func (manager *queueManager) sweepLocked() {
	now := manager.now()
	for _, ticket := range manager.tickets {
		switch ticket.state {
		case ticketWaiting:
			if now.Sub(ticket.createdAt) >= waitingTicketTimeout {
				manager.expireLocked(ticket, now)
			}
		case ticketReady:
			if now.Sub(ticket.readySince) >= readyClaimWindow {
				manager.expireLocked(ticket, now)
			}
		case ticketActive:
			permit := ticket.permit
			if permit == nil {
				manager.expireLocked(ticket, now)
				continue
			}
			idleOut := !now.Before(permit.idleExpiresAt)
			absoluteOut := !now.Before(permit.absoluteDeadline)
			if !idleOut && !absoluteOut {
				continue
			}
			if permit.inflightKey != uuid.Nil {
				// The slot stays occupied until the handler finishes settling.
				if !permit.cancelAsked {
					permit.cancelAsked = true
					ticket.cancelAsked = true
					permit.cancelFunc()
				}
				continue
			}
			manager.retirePermitLocked(ticket, ticketExpired, now)
		}
	}
	manager.promoteLocked()
	manager.trimTerminalLocked(now)
}

func (manager *queueManager) promoteLocked() {
	ownerCounts, global := manager.occupiedCountsLocked()
	for len(manager.waiting) > 0 {
		next := manager.waiting[0]
		if next.state != ticketWaiting {
			manager.waiting = manager.waiting[1:]
			continue
		}
		if global >= manager.globalLimit || ownerCounts[next.ownerID] >= manager.ownerLimit {
			break
		}
		manager.waiting = manager.waiting[1:]
		next.state = ticketReady
		next.readySince = manager.now()
		ownerCounts[next.ownerID]++
		global++
	}
}

func (manager *queueManager) expireLocked(ticket *queueTicket, now time.Time) {
	if ticket.permit != nil {
		manager.retirePermitLocked(ticket, ticketExpired, now)
		return
	}
	ticket.state = ticketExpired
	ticket.terminalAt = now
	manager.terminal = append(manager.terminal, ticket)
}

// retirePermitLocked deactivates a permit and marks its ticket terminal. The
// permit object stays in the token map so later calls classify as expired
// instead of invalid until terminal retention evicts it.
func (manager *queueManager) retirePermitLocked(ticket *queueTicket, state string, now time.Time) {
	permit := ticket.permit
	if permit != nil {
		permit.active = false
		permit.cancelFunc()
		ticket.permit = nil
	}
	ticket.state = state
	ticket.terminalAt = now
	manager.terminal = append(manager.terminal, ticket)
}

func (manager *queueManager) trimTerminalLocked(now time.Time) {
	kept := manager.terminal[:0]
	evicted := make([]*queueTicket, 0)
	for _, ticket := range manager.terminal {
		if now.Sub(ticket.terminalAt) < terminalRetention {
			kept = append(kept, ticket)
			continue
		}
		evicted = append(evicted, ticket)
	}
	for len(kept) > terminalRetentionLimit {
		evicted = append(evicted, kept[0])
		kept = kept[1:]
	}
	manager.terminal = kept
	for _, ticket := range evicted {
		if ticket.permitToken != "" {
			delete(manager.permits, ticket.permitToken)
		}
		delete(manager.tickets, ticket.id)
	}
}

// Create enqueues a ticket or readies it immediately when a slot is free.
func (manager *queueManager) Create(ownerID uuid.UUID, operation string) (ticketView, string) {
	manager.mutex.Lock()
	defer manager.mutex.Unlock()
	manager.sweepLocked()
	now := manager.now()
	ticket := &queueTicket{
		id: uuid.New(), ownerID: ownerID, operation: operation,
		createdAt: now, state: ticketWaiting,
	}
	manager.tickets[ticket.id] = ticket
	if manager.capacityLocked(ownerID) {
		ticket.state = ticketReady
		ticket.readySince = now
		return manager.viewLocked(ticket), ""
	}
	if len(manager.waiting) >= QueueWaitingCapacity {
		delete(manager.tickets, ticket.id)
		return ticketView{}, errQueueFull
	}
	manager.waiting = append(manager.waiting, ticket)
	return manager.viewLocked(ticket), ""
}

func (manager *queueManager) viewLocked(ticket *queueTicket) ticketView {
	view := ticketView{TicketID: ticket.id, Operation: ticket.operation, Status: ticket.state}
	switch ticket.state {
	case ticketWaiting:
		position := 1
		for _, candidate := range manager.waiting {
			if candidate.id == ticket.id {
				break
			}
			position++
		}
		expiresAt := ticket.createdAt.Add(waitingTicketTimeout).UTC()
		view.Position = &position
		view.ExpiresAt = &expiresAt
	case ticketReady:
		claimBy := ticket.readySince.Add(readyClaimWindow).UTC()
		view.ClaimBy = &claimBy
	case ticketActive:
		if ticket.permit != nil {
			idle := ticket.permit.idleExpiresAt.UTC()
			absolute := ticket.permit.absoluteDeadline.UTC()
			cancelled := ticket.cancelAsked
			view.IdleExpiresAt = &idle
			view.AbsoluteExpiresAt = &absolute
			view.CancelRequested = &cancelled
		}
	}
	return view
}

func (manager *queueManager) ticketFor(ownerID uuid.UUID, ticketID uuid.UUID) (*queueTicket, string) {
	ticket, ok := manager.tickets[ticketID]
	if !ok || ticket.ownerID != ownerID {
		return nil, errTicketNotFound
	}
	return ticket, ""
}

// Get returns the owner-scoped ticket snapshot; it never exposes the token.
func (manager *queueManager) Get(ownerID uuid.UUID, ticketID uuid.UUID) (ticketView, string) {
	manager.mutex.Lock()
	defer manager.mutex.Unlock()
	manager.sweepLocked()
	ticket, code := manager.ticketFor(ownerID, ticketID)
	if code != "" {
		return ticketView{}, code
	}
	return manager.viewLocked(ticket), ""
}

type claimResult struct {
	View   ticketView
	Permit *queuePermit
}

// Claim activates a ready ticket; repeated claims return the same permit.
func (manager *queueManager) Claim(ownerID uuid.UUID, ticketID uuid.UUID) (claimResult, string) {
	manager.mutex.Lock()
	defer manager.mutex.Unlock()
	manager.sweepLocked()
	ticket, code := manager.ticketFor(ownerID, ticketID)
	if code != "" {
		return claimResult{}, code
	}
	switch ticket.state {
	case ticketWaiting:
		return claimResult{}, errTicketNotReady
	case ticketExpired:
		return claimResult{}, errTicketExpired
	case ticketCancelled:
		return claimResult{}, errTicketCancelled
	case ticketActive:
		view := manager.viewLocked(ticket)
		return claimResult{View: view, Permit: ticket.permit}, ""
	}
	now := manager.now()
	token, err := newPermitToken()
	if err != nil {
		return claimResult{}, "INTERNAL_ERROR"
	}
	permitContext, cancel := context.WithCancel(context.Background())
	permit := &queuePermit{
		token: token, ticketID: ticket.id, ownerID: ownerID, operation: ticket.operation,
		active: true, activatedAt: now,
		idleExpiresAt:    now.Add(permitIdleTimeout),
		absoluteDeadline: now.Add(permitAbsoluteTimeout),
		context:          permitContext, cancelFunc: cancel,
	}
	ticket.state = ticketActive
	ticket.permit = permit
	ticket.permitToken = token
	manager.permits[token] = permit
	return claimResult{View: manager.viewLocked(ticket), Permit: permit}, ""
}

// Delete cancels a ticket. With an in-flight handler it only records the
// cancel request and propagates cancellation; the slot is released when the
// handler finishes settling. Repeated deletes stay no-op successes.
func (manager *queueManager) Delete(ownerID uuid.UUID, ticketID uuid.UUID) string {
	manager.mutex.Lock()
	defer manager.mutex.Unlock()
	manager.sweepLocked()
	ticket, code := manager.ticketFor(ownerID, ticketID)
	if code != "" {
		return code
	}
	now := manager.now()
	switch ticket.state {
	case ticketWaiting:
		manager.removeFromWaitingLocked(ticket)
		ticket.state = ticketCancelled
		ticket.terminalAt = now
		manager.terminal = append(manager.terminal, ticket)
	case ticketReady:
		ticket.state = ticketCancelled
		ticket.terminalAt = now
		manager.terminal = append(manager.terminal, ticket)
	case ticketActive:
		permit := ticket.permit
		if permit != nil && permit.inflightKey != uuid.Nil {
			if !permit.cancelAsked {
				permit.cancelAsked = true
				ticket.cancelAsked = true
				permit.cancelFunc()
			}
			return ""
		}
		manager.retirePermitLocked(ticket, ticketCancelled, now)
	}
	manager.sweepLocked()
	return ""
}

func (manager *queueManager) removeFromWaitingLocked(ticket *queueTicket) {
	for index, candidate := range manager.waiting {
		if candidate.id == ticket.id {
			manager.waiting = append(manager.waiting[:index], manager.waiting[index+1:]...)
			return
		}
	}
}

// ValidatePermit performs the fixed §9.5 checks that precede in-flight
// tracking: token known, owned by the caller, still active, and matching the
// endpoint operation. Errors never echo the token.
func (manager *queueManager) ValidatePermit(token string, ownerID uuid.UUID, operation string) (*queuePermit, string) {
	manager.mutex.Lock()
	defer manager.mutex.Unlock()
	manager.sweepLocked()
	if token == "" {
		return nil, errPermitInvalid
	}
	permit, ok := manager.permits[token]
	if !ok {
		return nil, errPermitInvalid
	}
	if permit.ownerID != ownerID {
		return nil, errPermitInvalid
	}
	if !permit.active {
		return nil, errPermitExpired
	}
	if permit.operation != operation {
		return nil, errPermitMismatch
	}
	if ticket := manager.tickets[permit.ticketID]; ticket == nil || ticket.state != ticketActive {
		return nil, errPermitExpired
	}
	return permit, ""
}

// BeginInflight occupies the permit's single handler slot for a request key.
// A duplicate key answered by the §6 idempotency contract wins over BUSY.
func (manager *queueManager) BeginInflight(permit *queuePermit, requestKey uuid.UUID) (func(), string) {
	manager.mutex.Lock()
	defer manager.mutex.Unlock()
	if !permit.active {
		return nil, errPermitExpired
	}
	if permit.inflightKey == requestKey {
		return nil, errCallInProgress
	}
	if permit.inflightKey != uuid.Nil {
		return nil, errPermitBusy
	}
	permit.inflightKey = requestKey
	released := false
	return func() {
		manager.mutex.Lock()
		defer manager.mutex.Unlock()
		if released {
			return
		}
		released = true
		if permit.inflightKey == requestKey {
			permit.inflightKey = uuid.Nil
		}
		manager.finishInflightLocked(permit)
	}, ""
}

// finishInflightLocked releases the slot after the handler has settled when a
// cancellation or expiry was requested while it was in-flight.
func (manager *queueManager) finishInflightLocked(permit *queuePermit) {
	if permit.inflightKey != uuid.Nil {
		return
	}
	ticket := manager.tickets[permit.ticketID]
	if ticket == nil || ticket.state != ticketActive {
		return
	}
	now := manager.now()
	if !permit.cancelAsked && now.Before(permit.idleExpiresAt) && now.Before(permit.absoluteDeadline) {
		return
	}
	manager.retirePermitLocked(ticket, ticketCancelled, now)
	manager.promoteLocked()
}

// ProjectedRun checks the single-run 191-chunk / 950,000-unit ceilings.
func (manager *queueManager) ProjectedRun(permit *queuePermit, units int64) bool {
	manager.mutex.Lock()
	defer manager.mutex.Unlock()
	return permit.active && permit.chunks+1 <= maxPermitChunks && permit.units+units <= maxPermitUnits
}

// RecordRun accounts one truly reserved chunk and renews the idle window.
func (manager *queueManager) RecordRun(permit *queuePermit, units int64) {
	manager.mutex.Lock()
	defer manager.mutex.Unlock()
	if !permit.active {
		return
	}
	permit.chunks++
	permit.units += units
	permit.idleExpiresAt = manager.now().Add(permitIdleTimeout)
	if ticket := manager.tickets[permit.ticketID]; ticket != nil {
		ticket.cancelAsked = permit.cancelAsked
	}
}

func newPermitToken() (string, error) {
	buffer := make([]byte, 24)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return hex.EncodeToString(buffer), nil
}
