//go:build integration

package integration_test

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"syscall"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/knowledge"
)

const (
	m5PerformanceItems       = 50_000
	m5PerformanceFragments   = 500_000
	m5PerformanceAttachments = 1_024
	m5PerformanceFileBytes   = int64(20 * 1024 * 1024)
	m5PerformanceSamples     = 30
)

type m5Latency struct {
	P50MS float64 `json:"p50Ms"`
	P95MS float64 `json:"p95Ms"`
	MaxMS float64 `json:"maxMs"`
}

type m5PerformanceReport struct {
	ReportVersion int       `json:"reportVersion"`
	GeneratedAt   time.Time `json:"generatedAt"`
	Environment   struct {
		CPU               string `json:"cpu"`
		MemoryBytes       int64  `json:"memoryBytes"`
		Disk              string `json:"disk"`
		OS                string `json:"os"`
		Architecture      string `json:"architecture"`
		GoVersion         string `json:"goVersion"`
		PostgreSQLVersion string `json:"postgresqlVersion"`
	} `json:"environment"`
	Fixture struct {
		Items                    int    `json:"items"`
		RawRecords               int    `json:"rawRecords"`
		SearchFragments          int    `json:"searchFragments"`
		Attachments              int    `json:"attachments"`
		AttachmentApparentBytes  int64  `json:"attachmentApparentBytes"`
		AttachmentAllocatedBytes int64  `json:"attachmentAllocatedBytes"`
		AttachmentMethod         string `json:"attachmentMethod"`
	} `json:"fixture"`
	Measurements struct {
		Search               m5Latency `json:"search"`
		TextSave             m5Latency `json:"textSave"`
		RecentView           m5Latency `json:"recentView"`
		ItemDetail           m5Latency `json:"itemDetail"`
		AttachmentMetadata   m5Latency `json:"attachmentMetadata"`
		IndexRebuildSeconds  float64   `json:"indexRebuildSeconds"`
		DatabaseBeforeBytes  int64     `json:"databaseBeforeBytes"`
		DatabaseAfterBytes   int64     `json:"databaseAfterBytes"`
		DatabasePeakBytes    int64     `json:"databasePeakBytes"`
		WebBuildBytes        int64     `json:"webBuildBytes"`
		IndexRebuildExecuted bool      `json:"indexRebuildExecuted"`
	} `json:"measurements"`
	Thresholds struct {
		SearchP95MS   float64 `json:"searchP95Ms"`
		TextSaveP95MS float64 `json:"textSaveP95Ms"`
	} `json:"thresholds"`
	Passed              bool `json:"passed"`
	ContainsUserContent bool `json:"containsUserContent"`
}

func TestM5FixedScalePerformance(t *testing.T) {
	if os.Getenv("RUN_M5_PERFORMANCE") != "1" {
		t.Skip("RUN_M5_PERFORMANCE is not enabled")
	}
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Fatal("TEST_DATABASE_URL is required")
	}
	assertTestDatabase(t, databaseURL)
	ctx := context.Background()
	database, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	resetM3Database(t, database)
	if os.Getenv("KEEP_M5_PERFORMANCE_DATABASE") != "1" {
		defer resetM3Database(t, database)
	}

	attachmentRoot := t.TempDir()
	zeroDigest := m5CreateSparseAttachments(t, attachmentRoot)
	m5InsertPerformanceFixture(t, database, zeroDigest)

	server, client, csrf := newAuthenticatedM2Server(t, database, attachmentRoot)
	defer server.Close()
	var fixedItemID, fixedAttachmentID uuid.UUID
	if err := database.QueryRow(ctx, "SELECT item_id FROM raw_records WHERE source_external_id = 'm5-performance-000042'").Scan(&fixedItemID); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(ctx, "SELECT id FROM attachments WHERE original_name = 'fixture-0001.bin'").Scan(&fixedAttachmentID); err != nil {
		t.Fatal(err)
	}

	searchRequest := func(index int) {
		query := fmt.Sprintf("perf-token-%06d-7", 1+index%m5PerformanceItems)
		response := sendJSON(t, client, http.MethodPost, server.URL+"/api/v1/search", map[string]any{
			"q": query, "sort": "relevance", "limit": 30,
		}, csrf)
		assertStatus(t, response, http.StatusOK)
		var payload struct {
			Items []struct {
				ItemID uuid.UUID `json:"itemId"`
			} `json:"items"`
		}
		decodeInto(t, readResponse(t, response), &payload)
		if len(payload.Items) == 0 {
			t.Fatalf("performance search %q returned no fixture", query)
		}
	}
	saveIndex := 0
	saveRequest := func(_ int) {
		saveIndex++
		response := sendJSONWithKey(t, client, http.MethodPost, server.URL+"/api/v1/items", map[string]any{
			"body": fmt.Sprintf("M5 performance save %d", saveIndex), "contentFormat": "plain_text",
			"sensitivity": "normal", "folderId": nil, "tagIds": []string{},
		}, csrf, fmt.Sprintf("m5-performance-save-%04d", saveIndex))
		assertStatus(t, response, http.StatusCreated)
		_ = readResponse(t, response)
	}
	getRequest := func(endpoint string) func(int) {
		return func(_ int) {
			response := doRequest(t, client, newRequest(t, http.MethodGet, server.URL+endpoint, nil, "", ""))
			assertStatus(t, response, http.StatusOK)
			_, _ = io.Copy(io.Discard, response.Body)
			_ = response.Body.Close()
		}
	}

	for index := range 5 {
		searchRequest(index)
		getRequest("/api/v1/items?view=recent&limit=30")(index)
		getRequest("/api/v1/items/" + fixedItemID.String())(index)
		getRequest("/api/v1/attachments/" + fixedAttachmentID.String() + "/metadata")(index)
	}

	report := m5PerformanceReport{ReportVersion: 1, GeneratedAt: time.Now().UTC(), ContainsUserContent: false}
	report.Fixture.Items = m5PerformanceItems
	report.Fixture.RawRecords = m5PerformanceItems
	report.Fixture.SearchFragments = m5PerformanceFragments
	report.Fixture.Attachments = m5PerformanceAttachments
	report.Fixture.AttachmentApparentBytes = int64(m5PerformanceAttachments) * m5PerformanceFileBytes
	report.Fixture.AttachmentAllocatedBytes = m5AllocatedBytes(t, attachmentRoot)
	report.Fixture.AttachmentMethod = "1024 个可重复生成的 20 MiB 全零稀疏文件；apparent size 20 GiB"
	report.Measurements.Search = m5MeasureLatency(searchRequest)
	report.Measurements.TextSave = m5MeasureLatency(saveRequest)
	report.Measurements.RecentView = m5MeasureLatency(getRequest("/api/v1/items?view=recent&limit=30"))
	report.Measurements.ItemDetail = m5MeasureLatency(getRequest("/api/v1/items/" + fixedItemID.String()))
	report.Measurements.AttachmentMetadata = m5MeasureLatency(getRequest("/api/v1/attachments/" + fixedAttachmentID.String() + "/metadata"))
	report.Measurements.WebBuildBytes = m5EnvInt64("PERF_WEB_BUILD_BYTES")

	if err := database.QueryRow(ctx, "SELECT pg_database_size(current_database())").Scan(&report.Measurements.DatabaseBeforeBytes); err != nil {
		t.Fatal(err)
	}
	report.Measurements.DatabasePeakBytes = report.Measurements.DatabaseBeforeBytes
	profileOnly := os.Getenv("M5_PERF_SKIP_REBUILD") == "1"
	if !profileOnly {
		report.Measurements.IndexRebuildExecuted = true
		sampleContext, stopSampling := context.WithCancel(ctx)
		peakResult := make(chan int64, 1)
		go func() {
			peak := report.Measurements.DatabaseBeforeBytes
			ticker := time.NewTicker(250 * time.Millisecond)
			defer ticker.Stop()
			for {
				select {
				case <-sampleContext.Done():
					peakResult <- peak
					return
				case <-ticker.C:
					var size int64
					if database.QueryRow(context.Background(), "SELECT pg_database_size(current_database())").Scan(&size) == nil && size > peak {
						peak = size
					}
				}
			}
		}()
		rebuildStarted := time.Now()
		rebuild, rebuildErr := knowledge.RebuildSearch(ctx, database, time.Now())
		report.Measurements.IndexRebuildSeconds = time.Since(rebuildStarted).Seconds()
		stopSampling()
		report.Measurements.DatabasePeakBytes = <-peakResult
		if rebuildErr != nil {
			t.Fatal(rebuildErr)
		}
		if rebuild.Items < m5PerformanceItems || rebuild.RawRecords < m5PerformanceItems || rebuild.Fragments < m5PerformanceFragments {
			t.Fatalf("index rebuild omitted the fixed fixture: %+v", rebuild)
		}
	}
	if err := database.QueryRow(ctx, "SELECT pg_database_size(current_database())").Scan(&report.Measurements.DatabaseAfterBytes); err != nil {
		t.Fatal(err)
	}
	if report.Measurements.DatabaseAfterBytes > report.Measurements.DatabasePeakBytes {
		report.Measurements.DatabasePeakBytes = report.Measurements.DatabaseAfterBytes
	}

	report.Environment.CPU = m5EnvOr("PERF_HOST_CPU", "unknown")
	report.Environment.MemoryBytes = m5EnvInt64("PERF_HOST_MEMORY_BYTES")
	report.Environment.Disk = m5EnvOr("PERF_DISK_DESCRIPTION", "unknown")
	report.Environment.OS = m5EnvOr("PERF_HOST_OS", runtime.GOOS)
	report.Environment.Architecture = runtime.GOARCH
	report.Environment.GoVersion = runtime.Version()
	if err := database.QueryRow(ctx, "SHOW server_version").Scan(&report.Environment.PostgreSQLVersion); err != nil {
		t.Fatal(err)
	}
	report.Thresholds.SearchP95MS = 500
	report.Thresholds.TextSaveP95MS = 300
	thresholdsPassed := report.Measurements.Search.P95MS <= report.Thresholds.SearchP95MS &&
		report.Measurements.TextSave.P95MS <= report.Thresholds.TextSaveP95MS
	report.Passed = thresholdsPassed && report.Measurements.IndexRebuildExecuted
	m5WritePerformanceReport(t, report)
	if !thresholdsPassed {
		t.Fatalf("performance threshold failed: search P95 %.2f ms; save P95 %.2f ms", report.Measurements.Search.P95MS, report.Measurements.TextSave.P95MS)
	}
}

func m5InsertPerformanceFixture(t *testing.T, database *pgxpool.Pool, zeroDigest []byte) {
	t.Helper()
	ctx := context.Background()
	tx, err := database.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, "SET LOCAL synchronous_commit = off"); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
		WITH fixture AS (
			SELECT value, lpad(value::text, 6, '0') AS number,
			       gen_random_uuid() AS item_id
			FROM generate_series(1, $1) value
		)
		INSERT INTO knowledge_items (
			id, title, title_origin, note, sensitivity, favorite, created_at, updated_at, deleted_at, folder_id
		)
		SELECT item_id, '性能记录 ' || number, 'user', NULL,
		       CASE WHEN value % 20 = 0 THEN 'sensitive' ELSE 'normal' END,
		       value % 10 = 0,
		       timestamptz '2026-01-01 00:00:00+00' + value * interval '1 second',
		       timestamptz '2026-01-01 00:00:00+00' + value * interval '1 second', NULL, NULL
		FROM fixture
	`, m5PerformanceItems); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
		WITH fixture AS (
			SELECT id AS item_id, substring(title from '([0-9]{6})$') AS number,
			       substring(title from '([0-9]{6})$')::integer AS value,
			       gen_random_uuid() AS raw_id
			FROM knowledge_items WHERE title LIKE '性能记录 %'
		), bodies AS (
			SELECT *, concat(
				'# 章节 0 ', number, E'\nperf-token-', number, '-0 挂载与日志样例', E'\n\n',
				'# 章节 1 ', number, E'\nperf-token-', number, '-2 PostgreSQL 备份样例', E'\n\n',
				'# 章节 2 ', number, E'\nperf-token-', number, '-4 Docker 与 Nginx 样例', E'\n\n',
				'# 章节 3 ', number, E'\nperf-token-', number, '-6 Java 发布排查样例', E'\n\n',
				'# 章节 4 ', number, E'\nperf-token-', number, '-8 迁移与恢复样例', E'\n'
			) AS body
			FROM fixture
		)
		INSERT INTO raw_records (
			id, item_id, record_role, source_type, content_kind, content_format, body,
			declared_sensitivity, captured_at, effective_captured_at, source_external_id,
			source_path, source_created_at, source_updated_at, source_time_quality, source_metadata, created_at
		)
		SELECT raw_id, item_id, 'primary', 'system', CASE WHEN value <= $1 THEN 'mixed' ELSE 'text' END,
		       'markdown', body, CASE WHEN value % 20 = 0 THEN 'sensitive' ELSE 'normal' END,
		       timestamptz '2026-01-01 00:00:00+00' + value * interval '1 second',
		       timestamptz '2026-01-01 00:00:00+00' + value * interval '1 second',
		       'm5-performance-' || number, NULL, NULL, NULL, 'exact', '{"fixture":"m5-performance"}'::jsonb,
		       timestamptz '2026-01-01 00:00:00+00' + value * interval '1 second'
		FROM bodies
	`, m5PerformanceAttachments); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
		WITH fixture AS (
			SELECT id AS raw_id, item_id,
			       substring(source_external_id from '([0-9]{6})$') AS number,
			       substring(source_external_id from '([0-9]{6})$')::integer AS value
			FROM raw_records WHERE source_external_id LIKE 'm5-performance-%'
		)
		INSERT INTO search_fragments (
			id, item_id, raw_record_id, source_kind, ordinal, fragment_version,
			start_byte, end_byte, content, normalized_content, weight, active, created_at
		)
		SELECT gen_random_uuid(), item_id, raw_id,
		       'raw_text', ordinal, 1, 0, 1,
		       'perf-token-' || number || '-' || ordinal || ' synthetic searchable fragment',
		       'perf-token-' || number || '-' || ordinal || ' synthetic searchable fragment',
		       3, true, timestamptz '2026-01-01 00:00:00+00' + value * interval '1 second'
		FROM fixture CROSS JOIN generate_series(0, 9) ordinal
	`); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
		WITH fixture AS (
			SELECT id AS raw_id,
			       lpad(substring(source_external_id from '([0-9]{6})$')::integer::text, 4, '0') AS number,
			       substring(source_external_id from '([0-9]{6})$')::integer AS value,
			       gen_random_uuid() AS attachment_id
			FROM raw_records
			WHERE source_external_id LIKE 'm5-performance-%'
			  AND substring(source_external_id from '([0-9]{6})$')::integer <= $1
		)
		INSERT INTO attachments (
			id, raw_record_id, kind, original_name, display_name, storage_key,
			client_media_type, media_type, content_sha256, size_bytes, width, height, status, created_at
		)
		SELECT attachment_id, raw_id, 'file', 'fixture-' || number || '.bin', 'fixture-' || number || '.bin',
		       'blobs/performance/' || number, 'application/octet-stream', 'application/octet-stream',
		       $2, $3, NULL, NULL, 'ready', timestamptz '2026-01-01 00:00:00+00' + value * interval '1 second'
		FROM fixture
	`, m5PerformanceAttachments, zeroDigest, m5PerformanceFileBytes); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(ctx, "ANALYZE knowledge_items, raw_records, search_fragments, attachments"); err != nil {
		t.Fatal(err)
	}
	var items, rawRecords, fragments, attachments int
	if err := database.QueryRow(ctx, `
		SELECT (SELECT count(*) FROM knowledge_items), (SELECT count(*) FROM raw_records),
		       (SELECT count(*) FROM search_fragments), (SELECT count(*) FROM attachments)
	`).Scan(&items, &rawRecords, &fragments, &attachments); err != nil {
		t.Fatal(err)
	}
	if items != m5PerformanceItems || rawRecords != m5PerformanceItems || fragments != m5PerformanceFragments || attachments != m5PerformanceAttachments {
		t.Fatalf("fixed performance fixture counts are wrong: %d/%d/%d/%d", items, rawRecords, fragments, attachments)
	}
}

func m5CreateSparseAttachments(t *testing.T, root string) []byte {
	t.Helper()
	blobRoot := filepath.Join(root, "blobs", "performance")
	if err := os.MkdirAll(blobRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	for index := 1; index <= m5PerformanceAttachments; index++ {
		path := filepath.Join(blobRoot, fmt.Sprintf("%04d", index))
		file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err != nil {
			t.Fatal(err)
		}
		if err := file.Truncate(m5PerformanceFileBytes); err != nil {
			_ = file.Close()
			t.Fatal(err)
		}
		if err := file.Close(); err != nil {
			t.Fatal(err)
		}
	}
	hasher := sha256.New()
	zeroBlock := make([]byte, 1024*1024)
	for range m5PerformanceFileBytes / int64(len(zeroBlock)) {
		_, _ = hasher.Write(zeroBlock)
	}
	return hasher.Sum(nil)
}

func m5MeasureLatency(operation func(int)) m5Latency {
	samples := make([]time.Duration, 0, m5PerformanceSamples)
	for index := range m5PerformanceSamples {
		started := time.Now()
		operation(index)
		samples = append(samples, time.Since(started))
	}
	sort.Slice(samples, func(left, right int) bool { return samples[left] < samples[right] })
	return m5Latency{
		P50MS: m5DurationMilliseconds(samples[m5PercentileIndex(len(samples), 0.50)]),
		P95MS: m5DurationMilliseconds(samples[m5PercentileIndex(len(samples), 0.95)]),
		MaxMS: m5DurationMilliseconds(samples[len(samples)-1]),
	}
}

func m5PercentileIndex(length int, percentile float64) int {
	return max(0, min(length-1, int(math.Ceil(percentile*float64(length)))-1))
}

func m5DurationMilliseconds(value time.Duration) float64 {
	return float64(value.Microseconds()) / 1000
}

func m5AllocatedBytes(t *testing.T, root string) int64 {
	t.Helper()
	var total int64
	err := filepath.Walk(root, func(_ string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.Mode().IsRegular() {
			total += info.Sys().(*syscall.Stat_t).Blocks * 512
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return total
}

func m5EnvOr(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func m5EnvInt64(key string) int64 {
	value, _ := strconv.ParseInt(os.Getenv(key), 10, 64)
	return value
}

func m5WritePerformanceReport(t *testing.T, report m5PerformanceReport) {
	t.Helper()
	path := os.Getenv("PERFORMANCE_REPORT_PATH")
	if path == "" {
		return
	}
	content, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	content = append(content, '\n')
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".performance-report-*")
	if err != nil {
		t.Fatal(err)
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if _, err := temporary.Write(content); err != nil {
		_ = temporary.Close()
		t.Fatal(err)
	}
	if err := temporary.Chmod(0o644); err != nil {
		_ = temporary.Close()
		t.Fatal(err)
	}
	if err := temporary.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		t.Fatal(err)
	}
}
