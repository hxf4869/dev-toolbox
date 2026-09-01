package assistant

import (
	"sync"

	"github.com/google/uuid"
)

// broadcaster wakes SSE readers when new events were committed for a run.
// It only signals; readers always re-read from the database, so reconnects
// and restarts stay consistent.
type broadcaster struct {
	mu          sync.Mutex
	subscribers map[uuid.UUID]map[chan struct{}]struct{}
}

func newBroadcaster() *broadcaster {
	return &broadcaster{subscribers: map[uuid.UUID]map[chan struct{}]struct{}{}}
}

func (b *broadcaster) subscribe(runID uuid.UUID) chan struct{} {
	channel := make(chan struct{}, 1)
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.subscribers[runID] == nil {
		b.subscribers[runID] = map[chan struct{}]struct{}{}
	}
	b.subscribers[runID][channel] = struct{}{}
	return channel
}

func (b *broadcaster) unsubscribe(runID uuid.UUID, channel chan struct{}) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if set, ok := b.subscribers[runID]; ok {
		delete(set, channel)
		if len(set) == 0 {
			delete(b.subscribers, runID)
		}
	}
}

func (b *broadcaster) notify(runID uuid.UUID) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for channel := range b.subscribers[runID] {
		select {
		case channel <- struct{}{}:
		default:
		}
	}
}
