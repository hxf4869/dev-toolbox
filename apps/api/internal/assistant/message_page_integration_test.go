//go:build integration

package assistant

import (
	"context"
	"reflect"
	"testing"

	"github.com/google/uuid"
)

func TestMessagePageBatchMatchesSingleMessageDTOs(t *testing.T) {
	pool := openSummaryStorePool(t)
	ctx := context.Background()
	service := &Service{database: pool}
	messages := make([]messageRow, 0, 4)
	want := make([]AssistantMessageDTO, 0, 4)
	for _, status := range []string{"succeeded", "failed"} {
		fixture := newSummaryFixture(t, pool, status)
		run, err := service.loadRun(ctx, pool, fixture.runID)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `UPDATE assistant_messages SET current_run_id = $2 WHERE id = $1`, run.OutputMessageID, run.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `UPDATE assistant_runs SET reasoning_ms = 42 WHERE id = $1`, run.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `
			INSERT INTO assistant_run_sources (run_id, ordinal, cited_number, source_kind, title_snapshot, excerpt_snapshot, locator_snapshot, retrieval_rank, created_at)
			VALUES ($1, 1, 1, 'raw_text', 'fixture deleted source', '', '{}'::jsonb, 1, now()),
			       ($1, 2, NULL, 'raw_text', 'fixture uncited source', '', '{}'::jsonb, 2, now())
		`, run.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `
			INSERT INTO assistant_run_events (run_id, sequence, event_id, event_type, payload, created_at)
			VALUES ($1, 1, $2, 'answer.delta', '{"delta":"fixture"}'::jsonb, now())
		`, run.ID, uuid.New()); err != nil {
			t.Fatal(err)
		}
		for _, id := range []uuid.UUID{run.InputMessageID, run.OutputMessageID} {
			message, err := service.loadMessage(ctx, pool, id)
			if err != nil {
				t.Fatal(err)
			}
			dto, err := service.messageDTO(ctx, pool, message)
			if err != nil {
				t.Fatal(err)
			}
			messages = append(messages, message)
			want = append(want, dto)
		}
	}
	got, err := service.messageDTOs(ctx, pool, messages)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatal("batch loading changed the message, run, retry or citation DTO")
	}
	if !got[3].CurrentRun.CanRetry || got[1].CurrentRun.CanRetry {
		t.Fatal("retryability must still depend on the current terminal run")
	}
}
