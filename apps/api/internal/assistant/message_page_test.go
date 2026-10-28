package assistant

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type messagePageQuerier struct {
	runs, sources [][]any
	queries       []string
}

func (fake *messagePageQuerier) QueryRow(context.Context, string, ...any) pgx.Row {
	return &fakeRow{err: errors.New("message page must not query one run at a time")}
}

func (fake *messagePageQuerier) Query(_ context.Context, query string, _ ...any) (pgx.Rows, error) {
	fake.queries = append(fake.queries, query)
	if strings.Contains(query, "FROM assistant_runs run") {
		return &fakeRows{rows: fake.runs}, nil
	}
	if strings.Contains(query, "FROM assistant_run_sources s") {
		return &fakeRows{rows: fake.sources}, nil
	}
	return nil, errors.New("unexpected message page query")
}

func TestMessagePageBatchesRunMetadataAndPreservesCitationAvailability(t *testing.T) {
	for _, count := range []int{1, 30} {
		fake := &messagePageQuerier{}
		messages := make([]messageRow, 0, count+1)
		messages = append(messages, messageRow{ID: uuid.New(), Role: "user", Content: "fixture question"})
		for index := range count {
			values := fakeRunValues("succeeded", false)
			runID := values[0].(uuid.UUID)
			messages = append(messages, messageRow{
				ID: values[3].(uuid.UUID), Role: "assistant", Content: "fixture answer",
				Status: "complete", CurrentRunID: &runID,
			})
			fake.runs = append(fake.runs, append(values, 2, 1, int64(7), false))
			ordinal := 1
			itemID, fragmentID := uuid.New(), uuid.New()
			fake.sources = append(fake.sources, []any{
				runID, 2, &ordinal, &fragmentID, &itemID, nil,
				"ai_text", "fixture source", index%2 == 1,
			})
		}
		items, err := (&Service{}).messageDTOs(context.Background(), fake, messages)
		if err != nil {
			t.Fatal(err)
		}
		if len(fake.queries) != 2 {
			t.Fatalf("page with %d answers used %d queries", count, len(fake.queries))
		}
		if len(items) != len(messages) || items[0].Content != "fixture question" || items[0].CurrentRun != nil {
			t.Fatal("message order or user message changed")
		}
		for index, item := range items[1:] {
			if item.ID != messages[index+1].ID || item.CurrentRun == nil ||
				item.CurrentRun.ID != *messages[index+1].CurrentRunID ||
				item.CurrentRun.ProvidedSourceCount != 2 || item.CurrentRun.CitationCount != 1 ||
				item.CurrentRun.LastSequence != 7 || len(item.Citations) != 1 {
				t.Fatalf("message/run metadata changed: %+v", item)
			}
			citation := item.Citations[0]
			if citation.RunID != item.CurrentRun.ID || citation.SourceOrdinal != 2 ||
				citation.CitationNumber != 1 || citation.SourceClass != "ai_derived" {
				t.Fatalf("citation mapping changed: %+v", citation)
			}
			if index%2 == 1 {
				if citation.Availability != "unavailable" || citation.Title != "来源已删除" {
					t.Fatalf("deleted source leaked its snapshot: %+v", citation)
				}
			} else if citation.Availability != "available" || citation.Title != "fixture source" {
				t.Fatalf("available source changed: %+v", citation)
			}
		}
	}
}

func TestMessagePageWithoutRunsDoesNotQuery(t *testing.T) {
	fake := &messagePageQuerier{}
	items, err := (&Service{}).messageDTOs(context.Background(), fake, []messageRow{{Role: "user", Content: "fixture"}})
	if err != nil || len(items) != 1 || len(fake.queries) != 0 || items[0].Citations == nil {
		t.Fatalf("unexpected user-only page: items=%+v err=%v queries=%d", items, err, len(fake.queries))
	}
}
