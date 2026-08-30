package operations

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/auth"
	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/httpapi"
)

const maximumStatusFileBytes = 64 * 1024

var stableCodePattern = regexp.MustCompile(`^[A-Z][A-Z0-9_]{1,79}$`)

type StatusService struct {
	database       *pgxpool.Pool
	attachmentRoot string
	statusRoot     string
	workerURL      string
	appVersion     string
	httpClient     *http.Client
	now            func() time.Time
}

type componentStatus struct {
	ID      string `json:"id"`
	Label   string `json:"label"`
	Status  string `json:"status"`
	Summary string `json:"summary"`
}

type providerStatus struct {
	ID              string     `json:"id"`
	DisplayName     string     `json:"displayName"`
	Status          string     `json:"status"`
	LastTestedAt    *time.Time `json:"lastTestedAt"`
	LatencyMS       *int       `json:"latencyMs"`
	FailureCategory *string    `json:"failureCategory"`
}

type queueStatus struct {
	Queued          int64      `json:"queued"`
	Running         int64      `json:"running"`
	OldestQueuedAt  *time.Time `json:"oldestQueuedAt"`
	LastHeartbeatAt *time.Time `json:"lastHeartbeatAt"`
}

type storageStatus struct {
	AttachmentCount int64 `json:"attachmentCount"`
	AttachmentBytes int64 `json:"attachmentBytes"`
	CapacityBytes   int64 `json:"capacityBytes"`
	AvailableBytes  int64 `json:"availableBytes"`
	Writable        bool  `json:"writable"`
}

type backupStatus struct {
	State         string     `json:"state"`
	LastAttemptAt *time.Time `json:"lastAttemptAt"`
	LastSuccessAt *time.Time `json:"lastSuccessAt"`
	SnapshotID    string     `json:"snapshotId"`
	TargetLabel   string     `json:"targetLabel"`
	ResticCheckAt *time.Time `json:"resticCheckAt"`
	ErrorCode     string     `json:"errorCode"`
}

type restoreStatus struct {
	State                 string     `json:"state"`
	VerifiedAt            *time.Time `json:"verifiedAt"`
	SnapshotID            string     `json:"snapshotId"`
	ReferencedAttachments int64      `json:"referencedAttachments"`
	VerifiedAttachments   int64      `json:"verifiedAttachments"`
	OrphanAttachments     int64      `json:"orphanAttachments"`
	ErrorCode             string     `json:"errorCode"`
}

type releaseCheck struct {
	ID        string     `json:"id"`
	Label     string     `json:"label"`
	Status    string     `json:"status"`
	Summary   string     `json:"summary"`
	CheckedAt *time.Time `json:"checkedAt"`
}

type releaseStatus struct {
	CandidateVersion string         `json:"candidateVersion"`
	GeneratedAt      *time.Time     `json:"generatedAt"`
	Checks           []releaseCheck `json:"checks"`
}

type operationsStatus struct {
	CheckedAt     time.Time         `json:"checkedAt"`
	Version       string            `json:"version"`
	SchemaVersion int               `json:"schemaVersion"`
	Overall       string            `json:"overall"`
	CoreAvailable bool              `json:"coreAvailable"`
	Components    []componentStatus `json:"components"`
	Providers     []providerStatus  `json:"providers"`
	Queue         queueStatus       `json:"queue"`
	Storage       storageStatus     `json:"storage"`
	Backup        backupStatus      `json:"backup"`
	Restore       restoreStatus     `json:"restore"`
	Release       releaseStatus     `json:"release"`
}

func NewStatusService(database *pgxpool.Pool, attachmentRoot, statusRoot, workerURL, appVersion string) *StatusService {
	return &StatusService{
		database: database, attachmentRoot: filepath.Clean(attachmentRoot), statusRoot: filepath.Clean(statusRoot),
		workerURL: strings.TrimRight(workerURL, "/"), appVersion: appVersion,
		httpClient: &http.Client{Timeout: 1200 * time.Millisecond}, now: time.Now,
	}
}

func (service *StatusService) RegisterRoutes(router *http.ServeMux, authService *auth.Service) {
	router.Handle("GET /api/v1/operations/status", authService.Authenticate(http.HandlerFunc(service.getStatus)))
}

func (service *StatusService) getStatus(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	result := operationsStatus{
		CheckedAt: service.now().UTC(), Version: service.appVersion, Overall: "healthy", CoreAvailable: true,
		Components: []componentStatus{{ID: "api", Label: "API", Status: "healthy", Summary: "进程正在响应"}},
		Providers:  []providerStatus{}, Release: defaultReleaseStatus(service.appVersion),
		Backup: backupStatus{State: "not_run"}, Restore: restoreStatus{State: "not_run"},
	}

	databaseOK := service.readDatabaseStatus(request.Context(), &result)
	storageOK := service.readStorageStatus(&result)
	workerOK := service.readWorkerStatus(request.Context(), &result)
	result.Backup = service.readBackupStatus()
	result.Restore = service.readRestoreStatus()
	result.Release = service.readReleaseStatus()
	result.CoreAvailable = databaseOK && storageOK
	if !result.CoreAvailable {
		result.Overall = "unavailable"
	} else if !workerOK || hasDegradedComponent(result.Components) || hasDegradedProvider(result.Providers) ||
		result.Backup.State == "failed" || result.Restore.State == "failed" {
		result.Overall = "degraded"
	}
	httpapi.WriteJSON(response, http.StatusOK, result)
}

func (service *StatusService) readDatabaseStatus(ctx context.Context, result *operationsStatus) bool {
	probeContext, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	if err := service.database.Ping(probeContext); err != nil {
		result.Components = append(result.Components, componentStatus{ID: "postgres", Label: "PostgreSQL", Status: "unavailable", Summary: "数据库连接失败"})
		return false
	}
	if err := service.database.QueryRow(probeContext, `SELECT version FROM public.schema_version`).Scan(&result.SchemaVersion); err != nil || result.SchemaVersion != RequiredSchemaVersion {
		result.Components = append(result.Components, componentStatus{ID: "postgres", Label: "PostgreSQL", Status: "unavailable", Summary: "迁移状态不可用"})
		return false
	}
	if err := service.database.QueryRow(probeContext, `
		SELECT COUNT(*) FILTER (WHERE status = 'queued' AND task_type <> 'batch_organize'),
		       COUNT(*) FILTER (WHERE status = 'running'),
		       MIN(queued_at) FILTER (WHERE status = 'queued' AND task_type <> 'batch_organize'),
		       MAX(heartbeat_at)
		FROM ai_task_runs
	`).Scan(&result.Queue.Queued, &result.Queue.Running, &result.Queue.OldestQueuedAt, &result.Queue.LastHeartbeatAt); err != nil {
		result.Components = append(result.Components, componentStatus{ID: "postgres", Label: "PostgreSQL", Status: "unavailable", Summary: "任务状态查询失败"})
		return false
	}
	if err := service.database.QueryRow(probeContext, `
		SELECT COUNT(*), COALESCE(SUM(size_bytes), 0) FROM attachments WHERE status = 'ready'
	`).Scan(&result.Storage.AttachmentCount, &result.Storage.AttachmentBytes); err != nil {
		result.Components = append(result.Components, componentStatus{ID: "postgres", Label: "PostgreSQL", Status: "unavailable", Summary: "附件索引查询失败"})
		return false
	}
	if err := service.readProviderStatus(probeContext, result); err != nil {
		result.Components = append(result.Components, componentStatus{ID: "postgres", Label: "PostgreSQL", Status: "unavailable", Summary: "Provider 状态查询失败"})
		return false
	}
	result.Components = append(result.Components, componentStatus{ID: "postgres", Label: "PostgreSQL", Status: "healthy", Summary: "Schema 已应用"})
	return true
}

func (service *StatusService) readProviderStatus(ctx context.Context, result *operationsStatus) error {
	rows, err := service.database.Query(ctx, `
		SELECT id::text, display_name, enabled, last_tested_at, last_test_status,
		       last_test_latency_ms, last_test_failure_category
		FROM provider_configs WHERE deleted_at IS NULL ORDER BY display_name, id
	`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var entry providerStatus
		var enabled bool
		var lastStatus *string
		if rows.Scan(&entry.ID, &entry.DisplayName, &enabled, &entry.LastTestedAt, &lastStatus, &entry.LatencyMS, &entry.FailureCategory) != nil {
			return errors.New("scan provider status")
		}
		switch {
		case !enabled:
			entry.Status = "disabled"
		case lastStatus == nil:
			entry.Status = "not_tested"
		case *lastStatus == "ok":
			entry.Status = "healthy"
		default:
			entry.Status = "degraded"
		}
		result.Providers = append(result.Providers, entry)
	}
	return rows.Err()
}

func (service *StatusService) readStorageStatus(result *operationsStatus) bool {
	var stats syscall.Statfs_t
	if syscall.Statfs(service.attachmentRoot, &stats) != nil {
		result.Components = append(result.Components, componentStatus{ID: "attachments", Label: "附件存储", Status: "unavailable", Summary: "附件目录不可访问"})
		return false
	}
	result.Storage.CapacityBytes = int64(stats.Blocks) * int64(stats.Bsize)
	result.Storage.AvailableBytes = int64(stats.Bavail) * int64(stats.Bsize)
	probeRoot := filepath.Join(service.attachmentRoot, "tmp")
	probe, err := os.CreateTemp(probeRoot, ".write-probe-")
	if err == nil {
		name := probe.Name()
		err = probe.Close()
		if removeErr := os.Remove(name); err == nil {
			err = removeErr
		}
	}
	result.Storage.Writable = err == nil
	status := "healthy"
	summary := "原始附件卷可读写"
	if err != nil {
		status = "unavailable"
		summary = "附件目录不可写"
	} else if result.Storage.CapacityBytes > 0 && result.Storage.AvailableBytes*100/result.Storage.CapacityBytes < 10 {
		status = "degraded"
		summary = "可用空间低于 10%"
	}
	result.Components = append(result.Components, componentStatus{ID: "attachments", Label: "附件存储", Status: status, Summary: summary})
	return err == nil
}

func (service *StatusService) readWorkerStatus(ctx context.Context, result *operationsStatus) bool {
	workerRequest, err := http.NewRequestWithContext(ctx, http.MethodGet, service.workerURL+"/health/live", nil)
	if err == nil {
		var workerResponse *http.Response
		workerResponse, err = service.httpClient.Do(workerRequest)
		if err == nil {
			defer workerResponse.Body.Close()
			_, _ = io.Copy(io.Discard, io.LimitReader(workerResponse.Body, 4096))
			if workerResponse.StatusCode != http.StatusOK {
				err = errors.New("worker health status")
			}
		}
	}
	if err != nil {
		result.Components = append(result.Components, componentStatus{ID: "ai-worker", Label: "AI Worker", Status: "degraded", Summary: "不可达；核心记录功能仍可用"})
		return false
	}
	result.Components = append(result.Components, componentStatus{ID: "ai-worker", Label: "AI Worker", Status: "healthy", Summary: "进程正在响应"})
	return true
}

func (service *StatusService) readBackupStatus() backupStatus {
	result := backupStatus{State: "not_run"}
	if !readStrictJSON(filepath.Join(service.statusRoot, "backup-status.json"), &result) || !validBackupStatus(result) {
		if _, err := os.Stat(filepath.Join(service.statusRoot, "backup-status.json")); err == nil {
			return backupStatus{State: "failed", ErrorCode: "STATUS_FILE_INVALID"}
		}
		return backupStatus{State: "not_run"}
	}
	return result
}

func (service *StatusService) readRestoreStatus() restoreStatus {
	result := restoreStatus{State: "not_run"}
	if !readStrictJSON(filepath.Join(service.statusRoot, "restore-status.json"), &result) || !validRestoreStatus(result) {
		if _, err := os.Stat(filepath.Join(service.statusRoot, "restore-status.json")); err == nil {
			return restoreStatus{State: "failed", ErrorCode: "STATUS_FILE_INVALID"}
		}
		return restoreStatus{State: "not_run"}
	}
	return result
}

func (service *StatusService) readReleaseStatus() releaseStatus {
	result := defaultReleaseStatus(service.appVersion)
	var stored releaseStatus
	if !readStrictJSON(filepath.Join(service.statusRoot, "release-status.json"), &stored) || !validReleaseStatus(stored) {
		return result
	}
	byID := make(map[string]releaseCheck, len(stored.Checks))
	for _, check := range stored.Checks {
		byID[check.ID] = check
	}
	for index, check := range result.Checks {
		if replacement, exists := byID[check.ID]; exists {
			result.Checks[index] = replacement
		}
	}
	result.GeneratedAt = stored.GeneratedAt
	result.CandidateVersion = stored.CandidateVersion
	return result
}

func readStrictJSON(path string, target any) bool {
	file, err := os.Open(path)
	if err != nil {
		return false
	}
	defer file.Close()
	content, err := io.ReadAll(io.LimitReader(file, maximumStatusFileBytes+1))
	if err != nil || len(content) > maximumStatusFileBytes {
		return false
	}
	decoder := json.NewDecoder(bytes.NewReader(content))
	decoder.DisallowUnknownFields()
	return decoder.Decode(target) == nil && decoder.Decode(&struct{}{}) == io.EOF
}

func validBackupStatus(value backupStatus) bool {
	return oneOf(value.State, "not_run", "running", "succeeded", "failed") && safeText(value.SnapshotID, 120) &&
		safeText(value.TargetLabel, 120) && validOptionalCode(value.ErrorCode)
}

func validRestoreStatus(value restoreStatus) bool {
	return oneOf(value.State, "not_run", "running", "succeeded", "failed") && safeText(value.SnapshotID, 120) &&
		value.ReferencedAttachments >= 0 && value.VerifiedAttachments >= 0 && value.OrphanAttachments >= 0 && validOptionalCode(value.ErrorCode)
}

func validReleaseStatus(value releaseStatus) bool {
	if !safeText(value.CandidateVersion, 80) || len(value.Checks) > 20 {
		return false
	}
	seen := map[string]struct{}{}
	for _, check := range value.Checks {
		if !expectedReleaseCheck(check.ID) || !oneOf(check.Status, "not_run", "passed", "review", "blocked") ||
			!safeText(check.Label, 80) || !safeText(check.Summary, 240) {
			return false
		}
		if _, duplicate := seen[check.ID]; duplicate {
			return false
		}
		seen[check.ID] = struct{}{}
	}
	return true
}

func defaultReleaseStatus(version string) releaseStatus {
	labels := []releaseCheck{
		{ID: "data_integrity", Label: "原始数据与附件", Status: "not_run", Summary: "等待完整性与故障注入验收"},
		{ID: "auth_security", Label: "认证与安全会话", Status: "not_run", Summary: "等待认证与凭据存储门禁"},
		{ID: "search_privacy", Label: "搜索与隐私脱敏", Status: "not_run", Summary: "等待搜索隐私与日志门禁"},
		{ID: "ai_policy", Label: "AI 策略与版本", Status: "not_run", Summary: "等待受控任务与敏感外发门禁"},
		{ID: "backup_restore", Label: "备份与灾难恢复", Status: "not_run", Summary: "等待独立 snapshot 空机恢复"},
		{ID: "browser_accessibility", Label: "浏览器与可访问性", Status: "not_run", Summary: "等待浏览器、视口和键盘矩阵"},
		{ID: "performance", Label: "目标主机性能", Status: "not_run", Summary: "等待固定规模数据实测"},
		{ID: "deployment_security", Label: "生产部署与依赖", Status: "not_run", Summary: "等待 HTTPS、端口、漏洞与许可证门禁"},
	}
	return releaseStatus{CandidateVersion: version, Checks: labels}
}

func expectedReleaseCheck(value string) bool {
	for _, check := range defaultReleaseStatus("").Checks {
		if check.ID == value {
			return true
		}
	}
	return false
}

func safeText(value string, maximumRunes int) bool {
	if !utf8.ValidString(value) || utf8.RuneCountInString(value) > maximumRunes {
		return false
	}
	for _, character := range value {
		if character < 0x20 || character == 0x7f {
			return false
		}
	}
	return true
}

func validOptionalCode(value string) bool {
	return value == "" || stableCodePattern.MatchString(value)
}

func oneOf(value string, options ...string) bool {
	for _, option := range options {
		if value == option {
			return true
		}
	}
	return false
}

func hasDegradedComponent(components []componentStatus) bool {
	for _, component := range components {
		if component.Status == "degraded" {
			return true
		}
	}
	return false
}

func hasDegradedProvider(providers []providerStatus) bool {
	for _, provider := range providers {
		if provider.Status == "degraded" {
			return true
		}
	}
	return false
}
