package assistant

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// SensitivePolicyChangeHook is wired by the integrator to
// (*Service).NotifySensitivePolicyChanged so a global sensitive_ai_policy
// change bumps the embedding generation. It lives on the ai package to avoid
// an import cycle while keeping the assistant module the only owner of the
// generation semantics.
type SensitivePolicyChangeHook = func(ctx context.Context, tx pgx.Tx, previous, current string) (afterCommit func(), err error)

// NotifySensitivePolicyChanged bumps the embedding generation whenever the
// global sensitive AI policy changes; tightening first clears derived vectors.
// It is registered by main.go after both services exist:
//
//	ai.SensitivePolicyChangeHook = assistantService.NotifySensitivePolicyChanged
func (service *Service) NotifySensitivePolicyChanged(ctx context.Context, tx pgx.Tx, previous, current string) (func(), error) {
	if previous == current {
		return nil, nil
	}
	now := service.now().UTC()
	if err := service.bumpGenerationForPolicyChangeTx(ctx, tx, previous, current, now); err != nil {
		return nil, err
	}
	if sensitivePolicyRank(current) <= sensitivePolicyRank(previous) {
		return nil, nil
	}
	runIDs, err := service.applySensitivePolicyTighteningTx(ctx, tx, current, now)
	if err != nil {
		return nil, err
	}
	return func() {
		for _, runID := range runIDs {
			service.broadcast.notify(runID)
		}
		service.cancelTemporaryRuns(current)
	}, nil
}

func (service *Service) applySensitivePolicyTighteningTx(
	ctx context.Context,
	tx pgx.Tx,
	current string,
	now time.Time,
) ([]uuid.UUID, error) {
	rank := sensitivePolicyRank(current)
	if _, err := tx.Exec(ctx, `
		UPDATE assistant_runs SET effective_sensitive_policy = $1
		WHERE status = 'queued'
		  AND CASE effective_sensitive_policy WHEN 'allow' THEN 0 WHEN 'redact' THEN 1 ELSE 2 END < $2
	`, current, rank); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
		UPDATE assistant_runs SET status = 'failed', phase = NULL,
		       effective_sensitive_policy = $1, finished_at = $3,
		       lease_owner = NULL, lease_version = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
		       error_code = 'ASSISTANT_SENSITIVE_POLICY_CHANGED',
		       error_detail = '全局敏感策略已收紧，回答已终止'
		WHERE status = 'running'
		  AND CASE effective_sensitive_policy WHEN 'allow' THEN 0 WHEN 'redact' THEN 1 ELSE 2 END < $2
		RETURNING id, output_message_id
	`, current, rank, now)
	if err != nil {
		return nil, err
	}
	runIDs := make([]uuid.UUID, 0)
	messageIDs := make([]uuid.UUID, 0)
	for rows.Next() {
		var runID, messageID uuid.UUID
		if err := rows.Scan(&runID, &messageID); err != nil {
			rows.Close()
			return nil, err
		}
		runIDs = append(runIDs, runID)
		messageIDs = append(messageIDs, messageID)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(messageIDs) > 0 {
		if _, err := tx.Exec(ctx, `
			UPDATE assistant_messages SET status = 'failed', completed_at = $2
			WHERE id = ANY($1)
		`, messageIDs, now); err != nil {
			return nil, err
		}
	}
	return runIDs, nil
}

func sensitivePolicyRank(policy string) int {
	switch policy {
	case "block":
		return 2
	case "redact":
		return 1
	default:
		return 0
	}
}
