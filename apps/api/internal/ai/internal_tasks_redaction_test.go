//go:build integration

// Database-backed regression for the redact policy on related-record titles:
// buildClaimInput must pass the related record Title through the same redactor
// as its Summary, so credential-style text in a sensitive item's title cannot
// reach the model input. Requires a migrated PostgreSQL database via
// TEST_DATABASE_URL, exactly like the integration suite under
// apps/api/integration.
package ai

import (
	"context"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/tern/v2/migrate"
)

var (
	claimInputPool     *pgxpool.Pool
	claimInputPoolOnce sync.Once
	claimInputPoolErr  error
)

func openClaimInputPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is required for the claim input redaction test")
	}
	// 与 integration 套件同一身份校验：只接受 *_test 库，拒绝业务数据库。
	// 错误信息只携带库名，不输出连接串或凭据。
	config, err := pgx.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal("TEST_DATABASE_URL 解析失败，已拒绝执行数据库测试")
	}
	if !strings.HasSuffix(config.Database, "_test") {
		t.Fatalf("refusing to run against non-test database %q", config.Database)
	}
	claimInputPoolOnce.Do(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		conn, err := pgx.Connect(ctx, databaseURL)
		if err != nil {
			claimInputPoolErr = err
			return
		}
		defer conn.Close(ctx)
		migrator, err := migrate.NewMigrator(ctx, conn, "public.schema_version")
		if err != nil {
			claimInputPoolErr = err
			return
		}
		if err := migrator.LoadMigrations(os.DirFS("../../migrations")); err != nil {
			claimInputPoolErr = err
			return
		}
		if err := migrator.Migrate(ctx); err != nil {
			claimInputPoolErr = err
			return
		}
		claimInputPool, claimInputPoolErr = pgxpool.New(ctx, databaseURL)
	})
	// TEST_DATABASE_URL 一旦设置，连接、迁移加载、迁移执行或池初始化的任何
	// 失败都是测试失败，不是可跳过的环境缺失。
	if claimInputPoolErr != nil {
		t.Fatalf("test database initialization failed: %v", claimInputPoolErr)
	}
	return claimInputPool
}

func seedClaimInputItem(t *testing.T, tx pgx.Tx, title, content, sensitivity string) (uuid.UUID, uuid.UUID, uuid.UUID) {
	t.Helper()
	ctx := context.Background()
	itemID := uuid.New()
	recordID := uuid.New()
	fragmentID := uuid.New()
	now := time.Now().UTC()
	if _, err := tx.Exec(ctx, `
		INSERT INTO knowledge_items (id, title, title_origin, sensitivity, created_at, updated_at)
		VALUES ($1, $2, 'user', $3, $4, $4)
	`, itemID, title, sensitivity, now); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO raw_records (id, item_id, record_role, source_type, content_kind, content_format,
		       body, declared_sensitivity, captured_at, effective_captured_at, source_time_quality, created_at)
		VALUES ($1, $2, 'primary', 'api', 'text', 'plain_text', $3, $4, $5, $5, 'exact', $5)
	`, recordID, itemID, content, sensitivity, now); err != nil {
		t.Fatal(err)
	}
	normalized := strings.ToLower(strings.Join(strings.Fields(content), " "))
	if _, err := tx.Exec(ctx, `
		INSERT INTO search_fragments (id, item_id, raw_record_id, source_kind, ordinal, fragment_version,
		       start_byte, end_byte, content, normalized_content, weight, active, created_at)
		VALUES ($1, $2, $3, 'raw_text', 0, 1, 0, $4, $5, $6, 3, true, $7)
	`, fragmentID, itemID, recordID, len(content), content, normalized, now); err != nil {
		t.Fatal(err)
	}
	return itemID, recordID, fragmentID
}

func TestBuildClaimInputRedactsRelatedRecordTitles(t *testing.T) {
	pool := openClaimInputPool(t)
	ctx := context.Background()

	const secretInTitle = "password=db-synthetic-secret-9"
	const secretInBody = "api_key=sk-rel-synthetic-7"

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)

	mainItem, mainRecord, mainFragment := seedClaimInputItem(t, tx, "主记录合成条目", "主记录合成正文内容", "normal")
	seedClaimInputItem(t, tx, "备份手册 "+secretInTitle, "相关正文 "+secretInBody, "sensitive")

	snapshot := taskInputSnapshot{
		RawRecordIDs:          []uuid.UUID{mainRecord},
		FragmentIDs:           []uuid.UUID{mainFragment},
		AttachmentIDs:         []uuid.UUID{},
		IncludeRelatedRecords: true,
	}

	// redact 政策下，敏感相关记录的标题与摘要都必须经过脱敏。
	input, _, err := (&Service{}).buildClaimInput(httptest.NewRequest("POST", "/internal/ai/tasks/claim", nil), tx, mainItem, "normal", "redact", snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if len(input.RelatedRecords) != 1 {
		t.Fatalf("fixture: expected one related record, got %d", len(input.RelatedRecords))
	}
	related := input.RelatedRecords[0]
	if strings.Contains(related.Title, "db-synthetic-secret-9") {
		t.Fatalf("redact policy leaked the credential-style title: %q", related.Title)
	}
	if !strings.Contains(related.Title, "<PASSWORD_") {
		t.Fatalf("redact policy did not placeholder the title: %q", related.Title)
	}
	if strings.Contains(related.Summary, "sk-rel-synthetic-7") {
		t.Fatalf("redact policy leaked the credential-style summary: %q", related.Summary)
	}
	if !strings.Contains(related.Summary, "<API_KEY_") {
		t.Fatalf("redact policy did not placeholder the summary: %q", related.Summary)
	}

	// allow 政策保持原文。
	allowInput, _, err := (&Service{}).buildClaimInput(httptest.NewRequest("POST", "/internal/ai/tasks/claim", nil), tx, mainItem, "normal", "allow", snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if allowInput.RelatedRecords[0].Title != "备份手册 "+secretInTitle {
		t.Fatalf("allow policy must keep the original title: %q", allowInput.RelatedRecords[0].Title)
	}

	// block 政策下敏感相关记录根本不进入候选。
	blockInput, _, err := (&Service{}).buildClaimInput(httptest.NewRequest("POST", "/internal/ai/tasks/claim", nil), tx, mainItem, "normal", "block", snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if len(blockInput.RelatedRecords) != 0 {
		t.Fatalf("block policy must exclude sensitive related records: %+v", blockInput.RelatedRecords)
	}
}
