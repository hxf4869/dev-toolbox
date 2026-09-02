package assistant

import (
	"context"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Frozen code constants from docs/16 §9.4, §9.2 and §5.4. These are contract
// values, not user configuration; changing them requires a contract revision.
const (
	ReconcileInterval     = 5 * time.Second
	assistantLeaseDuraton = 30 * time.Second
	heartbeatGrace        = 30 * time.Second

	LexicalCandidates   = 24
	VectorCandidates    = 24
	TrigramThreshold    = 0.30
	CosineThreshold     = 0.50
	RRFK                = 60
	MaximumRunSources   = 8
	RetrievalVersion    = "hybrid-rrf-v1"
	PromptVersion       = "assistant-answer-v2"
	IndexBatchSize      = 16
	MaximumIndexAttempt = 2

	MaximumUserMessageBytes      = 32 * 1024
	MaximumAssistantMessageBytes = 4 * 1024 * 1024
	MaximumTemporaryHistory      = 32
	MaximumTemporaryHistoryBytes = 256 * 1024
	MaximumSummaryEntries        = 64
	MaximumSummaryBytes          = 64 * 1024
	SummaryMessageTrigger        = 16
	MinimumRecentCompleteAnswers = 8
	MaximumRewriteOutputTokens   = 256
	// Conservative system prompt token estimate used for context budgeting; the
	// authoritative text lives in the worker's assistant prompt module.
	systemPromptTokenEstimate = 1200
	contextSafetyTokens       = 1024
)

type Service struct {
	database                  *pgxpool.Pool
	masterKey                 []byte
	workerURL                 string
	internalServiceToken      string
	allowInsecureProviderHTTP bool
	httpClient                *http.Client
	now                       func() time.Time
	broadcast                 *broadcaster
	temporaryMu               sync.Mutex
	temporarySequence         uint64
	temporaryRuns             map[uint64]temporaryRunRegistration
}

// NewService constructs the assistant module. The pgxpool must have pgvector
// types registered via pgvector-go's pgx connector hook (wired by the
// integrator in cmd/server/main.go; tests register it themselves).
func NewService(
	database *pgxpool.Pool,
	masterKey []byte,
	workerURL, internalServiceToken string,
	allowInsecureProviderHTTP bool,
) *Service {
	return &Service{
		database:                  database,
		masterKey:                 append([]byte(nil), masterKey...),
		workerURL:                 workerURL,
		internalServiceToken:      internalServiceToken,
		allowInsecureProviderHTTP: allowInsecureProviderHTTP,
		httpClient:                &http.Client{},
		now:                       time.Now,
		broadcast:                 newBroadcaster(),
		temporaryRuns:             make(map[uint64]temporaryRunRegistration),
	}
}

// RunOnce executes a single reconciler pass immediately; integration tests use
// it instead of the background loop.
func (service *Service) RunOnce(ctx context.Context) {
	service.reconcileIndex(ctx, service.now().UTC())
}

// Run blocks until ctx is done and periodically reconciles the embedding index.
// The integrator starts it in a goroutine after RegisterRoutes and cancels it
// via the server shutdown context.
func (service *Service) Run(ctx context.Context, logger *slog.Logger) {
	service.reconcileIndex(ctx, service.now().UTC())
	ticker := time.NewTicker(ReconcileInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			service.reconcileIndex(ctx, service.now().UTC())
		}
	}
}
