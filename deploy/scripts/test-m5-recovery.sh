#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
deploy_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
project_dir=$(CDPATH= cd -- "$deploy_dir/.." && pwd)
compose_file="$deploy_dir/compose.production.yaml"
source_project=dev-toolbox-m5-recovery-source
restore_project=dev-toolbox-m5-recovery-restored
test_root=$(mktemp -d /tmp/dev-toolbox-m5-recovery.XXXXXX)
source_data_root="$test_root/source-data"
restore_root="$test_root/restored"
secrets_root="$test_root/secrets"
config_root="$test_root/config"
staging_root="$test_root/source-staging"
repository_root="$test_root/offsite-restic"
state_root="$test_root/state"
env_file="$test_root/production.env"
restic_password_missing="$test_root/restic_password.missing"
seed_container=dev-toolbox-m5-recovery-seed
verify_container=dev-toolbox-m5-recovery-verify
recovery_password='M5 recovery correct horse 电池 staple'
success=false

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

cleanup() {
  exit_code=$?
  trap - EXIT HUP INT TERM
  if [ -f "$restic_password_missing" ] && [ ! -f "$secrets_root/restic_password" ]; then
    mv "$restic_password_missing" "$secrets_root/restic_password"
  fi
  docker rm -f "$seed_container" "$verify_container" >/dev/null 2>&1 || true
  if [ -f "$env_file" ]; then
    DEPLOY_DATA_ROOT="$restore_root/data" DEPLOY_SECRETS_ROOT="$secrets_root" DEPLOY_CONFIG_ROOT="$config_root" \
      DEPLOY_STAGING_ROOT="$restore_root/backup-staging" \
      docker compose --project-name "$restore_project" --env-file "$env_file" -f "$compose_file" down --remove-orphans >/dev/null 2>&1 || true
    docker compose --project-name "$source_project" --env-file "$env_file" -f "$compose_file" down --remove-orphans >/dev/null 2>&1 || true
  fi
  if [ "$success" = true ]; then
    case "$test_root" in
      /tmp/dev-toolbox-m5-recovery.*) find "$test_root" -depth -delete ;;
      *) printf '%s\n' "拒绝清理非演练临时目录：$test_root" >&2 ;;
    esac
  else
    printf '%s\n' "空机恢复演练失败；隔离现场保留在：$test_root" >&2
  fi
  exit "$exit_code"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

for command_name in docker jq openssl awk grep curl; do
  command -v "$command_name" >/dev/null 2>&1 || fail "缺少空机恢复演练命令：$command_name"
done

mkdir -p "$source_data_root" "$secrets_root" "$config_root" "$staging_root" "$repository_root" "$state_root"
awk '
  /^\{\$APP_DOMAIN\} \{/ {
    print
    print "\ttls internal"
    next
  }
  { print }
' "$deploy_dir/Caddyfile" >"$config_root/Caddyfile"

{
  printf '%s\n' 'APP_DOMAIN=toolbox.127.0.0.1.nip.io'
  printf '%s\n' 'APP_VERSION=v1.0.1'
  printf '%s\n' 'APP_TIMEZONE=Asia/Shanghai'
  printf '%s\n' 'POSTGRES_DB=dev_toolbox_recovery_test'
  printf '%s\n' 'POSTGRES_USER=dev_toolbox_recovery'
  printf 'RESTIC_LOCAL_REPOSITORY_PATH=%s\n' "$repository_root"
  printf '%s\n' 'BACKUP_TARGET_LABEL=隔离恢复演练仓库'
  printf '%s\n' 'RESTIC_IMAGE=ghcr.io/restic/restic:0.19.1'
  printf 'DEPLOY_DATA_ROOT=%s\n' "$source_data_root"
  printf 'DEPLOY_SECRETS_ROOT=%s\n' "$secrets_root"
  printf 'DEPLOY_CONFIG_ROOT=%s\n' "$config_root"
  printf 'DEPLOY_STAGING_ROOT=%s\n' "$staging_root"
} >"$env_file"
chmod 600 "$env_file"

DEPLOY_ENV_FILE="$env_file" "$script_dir/init-production.sh"
DEPLOY_ENV_FILE="$env_file" "$script_dir/build-release.sh"
DEPLOY_ENV_FILE="$env_file" "$script_dir/check-deploy.sh"

docker compose --project-name "$source_project" --env-file "$env_file" -f "$compose_file" up -d --wait postgres api ai-worker

run_fixture() {
  mode=$1
  container_name=$2
  project_name=$3
  attachments=$4
  result_path=$5
  docker run -d --rm --name "$container_name" \
    -v "$project_dir:/repo:ro" \
    -v "$attachments:/attachments:rw" \
    -v "$secrets_root/app_master_key:/run/secrets/app_master_key:ro" \
    -v "$secrets_root/postgres_password:/run/secrets/postgres_password:ro" \
    -v "$state_root:/state:rw" \
    -w /repo/apps/api golang:1.27.0-alpine3.23 sleep infinity >/dev/null
  docker network connect "${project_name}_backend" "$container_name"
  docker exec \
    -e "RUN_M5_RECOVERY_FIXTURE=$mode" \
    -e M5_RECOVERY_ATTACHMENT_ROOT=/attachments \
    -e M5_RECOVERY_MASTER_KEY_FILE=/run/secrets/app_master_key \
    -e M5_RECOVERY_STATE_PATH=/state/fixture-state.json \
    -e "M5_RECOVERY_RESULT_PATH=$result_path" \
    "$container_name" sh -c '
      database_password=$(tr -d "\n" </run/secrets/postgres_password)
      export TEST_DATABASE_URL="host=postgres port=5432 dbname=dev_toolbox_recovery_test user=dev_toolbox_recovery password=$database_password sslmode=disable"
      unset database_password
      go test -tags=integration ./integration -run TestM5RecoveryFixture -count=1 -timeout 10m -v
    '
  docker rm -f "$container_name" >/dev/null
}

run_fixture seed "$seed_container" "$source_project" "$source_data_root/attachments" ""
docker run --rm --network none -v "$source_data_root/attachments:/target" alpine:3.23.3 \
  sh -c 'chown -R 10001:10001 /target && chmod 0700 /target'
DEPLOY_ENV_FILE="$env_file" COMPOSE_PROJECT_NAME="$source_project" "$script_dir/check-integrity.sh"

# Force a post-stop backup failure by withholding only the restic password.
# The backup trap must restart API/worker and preserve the previous repository.
mv "$secrets_root/restic_password" "$restic_password_missing"
if DEPLOY_ENV_FILE="$env_file" COMPOSE_PROJECT_NAME="$source_project" "$script_dir/backup.sh" >"$test_root/expected-backup-failure.log" 2>&1; then
  fail "缺少 restic 密码时备份错误地报告成功"
fi
mv "$restic_password_missing" "$secrets_root/restic_password"
running_services=$(docker compose --project-name "$source_project" --env-file "$env_file" -f "$compose_file" ps --status running -q api ai-worker | wc -l | tr -d ' ')
[ "$running_services" = 2 ] || fail "失败备份后 API/worker 未恢复运行"
jq -e '.state == "failed" and .errorCode == "RESTIC_BACKUP_FAILED"' "$source_data_root/operations/backup-status.json" >/dev/null \
  || fail "失败备份没有写入稳定状态"

DEPLOY_ENV_FILE="$env_file" COMPOSE_PROJECT_NAME="$source_project" "$script_dir/backup.sh"
DEPLOY_ENV_FILE="$env_file" COMPOSE_PROJECT_NAME="$source_project" "$script_dir/check-backup-repository.sh"
DEPLOY_ENV_FILE="$env_file" COMPOSE_PROJECT_NAME="$source_project" "$script_dir/prune-backups.sh" >"$test_root/retention-dry-run.log"
snapshot_id=$(jq -r 'select(.state == "succeeded") | .snapshotId' "$source_data_root/operations/backup-status.json")
[ -n "$snapshot_id" ] || fail "成功备份没有 snapshot ID"

docker compose --project-name "$source_project" --env-file "$env_file" -f "$compose_file" stop api ai-worker >/dev/null
RESTORE_ROOT="$restore_root" SNAPSHOT_ID="$snapshot_id" RESTORE_PROJECT_NAME="$restore_project" \
  DEPLOY_ENV_FILE="$env_file" "$script_dir/restore.sh"

DEPLOY_DATA_ROOT="$restore_root/data" DEPLOY_SECRETS_ROOT="$secrets_root" DEPLOY_CONFIG_ROOT="$config_root" \
  DEPLOY_STAGING_ROOT="$restore_root/backup-staging" \
  docker compose --project-name "$restore_project" --env-file "$env_file" -f "$compose_file" restart postgres api ai-worker gateway >/dev/null
DEPLOY_DATA_ROOT="$restore_root/data" DEPLOY_SECRETS_ROOT="$secrets_root" DEPLOY_CONFIG_ROOT="$config_root" \
  DEPLOY_STAGING_ROOT="$restore_root/backup-staging" \
  docker compose --project-name "$restore_project" --env-file "$env_file" -f "$compose_file" up -d --wait

run_fixture verify "$verify_container" "$restore_project" "$restore_root/data/attachments" /state/verification.json
jq -e '
  .state == "succeeded" and .textRecordsVerified == 20 and .originalImagesVerified == 5 and
  .ordinaryFilesVerified == 5 and .referencedAttachments == 10 and .verifiedAttachments == 10 and
  .authenticationVerified and .organizationVerified and .trashVerified and .aiVersionsVerified and
  (.containsUserContent | not)
' "$state_root/verification.json" >/dev/null || fail "恢复抽样验收结果无效"

gateway_body=$(curl --silent --show-error --fail --insecure --noproxy '*' \
  --resolve 'toolbox.127.0.0.1.nip.io:443:127.0.0.1' \
  https://toolbox.127.0.0.1.nip.io/health/live)
printf '%s' "$gateway_body" | jq -e '.status == "live" and .service == "api"' >/dev/null || fail "恢复后的生产网关不可用"

# Worker is deliberately unavailable; readiness and core API must stay healthy.
DEPLOY_DATA_ROOT="$restore_root/data" DEPLOY_SECRETS_ROOT="$secrets_root" DEPLOY_CONFIG_ROOT="$config_root" \
  DEPLOY_STAGING_ROOT="$restore_root/backup-staging" \
  docker compose --project-name "$restore_project" --env-file "$env_file" -f "$compose_file" stop ai-worker >/dev/null
docker compose --project-name "$restore_project" --env-file "$env_file" -f "$compose_file" exec -T gateway \
  wget -q -O - http://api:8080/health/ready | jq -e '.status == "ready"' >/dev/null || fail "worker 故障影响了 API readiness"
DEPLOY_DATA_ROOT="$restore_root/data" DEPLOY_SECRETS_ROOT="$secrets_root" DEPLOY_CONFIG_ROOT="$config_root" \
  DEPLOY_STAGING_ROOT="$restore_root/backup-staging" \
  docker compose --project-name "$restore_project" --env-file "$env_file" -f "$compose_file" up -d --wait ai-worker >/dev/null

# PostgreSQL is deliberately unavailable; API must return a sanitized 503 body.
DEPLOY_DATA_ROOT="$restore_root/data" DEPLOY_SECRETS_ROOT="$secrets_root" DEPLOY_CONFIG_ROOT="$config_root" \
  DEPLOY_STAGING_ROOT="$restore_root/backup-staging" \
  docker compose --project-name "$restore_project" --env-file "$env_file" -f "$compose_file" stop postgres >/dev/null
docker compose --project-name "$restore_project" --env-file "$env_file" -f "$compose_file" exec -T ai-worker node -e '
  fetch("http://api:8080/health/ready").then(async response => {
    const body = await response.text()
    const payload = JSON.parse(body)
    if (
      response.status !== 503 ||
      payload?.error?.code !== "INTERNAL_ERROR" ||
      payload?.error?.message !== "服务尚未就绪" ||
      body.includes("schema_version") ||
      body.includes("migration") ||
      body.includes("postgres")
    ) process.exit(1)
  }).catch(() => process.exit(1))
' || fail "数据库故障没有返回安全、可解释的 readiness"
DEPLOY_DATA_ROOT="$restore_root/data" DEPLOY_SECRETS_ROOT="$secrets_root" DEPLOY_CONFIG_ROOT="$config_root" \
  DEPLOY_STAGING_ROOT="$restore_root/backup-staging" \
  docker compose --project-name "$restore_project" --env-file "$env_file" -f "$compose_file" up -d --wait postgres api >/dev/null

runtime_log="$test_root/runtime.log"
docker compose --project-name "$source_project" --env-file "$env_file" -f "$compose_file" logs --no-color >"$runtime_log" 2>&1 || true
DEPLOY_DATA_ROOT="$restore_root/data" DEPLOY_SECRETS_ROOT="$secrets_root" DEPLOY_CONFIG_ROOT="$config_root" \
  DEPLOY_STAGING_ROOT="$restore_root/backup-staging" \
  docker compose --project-name "$restore_project" --env-file "$env_file" -f "$compose_file" logs --no-color >>"$runtime_log" 2>&1 || true
manual_totp=$(jq -r '.manualTotpKey' "$state_root/fixture-state.json")
if grep -Fq "$manual_totp" "$runtime_log" || grep -Fq "$recovery_password" "$runtime_log"; then
  fail "运行日志包含恢复演练认证 Secret"
fi
if grep -Eiq 'authorization[=:]|cookie[=:]|api[_ -]?key[=:]|M5 空机恢复合成文本' "$runtime_log"; then
  fail "运行日志包含认证头、Cookie、Key 或原始正文"
fi

restore_report="$source_data_root/operations/restore-report.json"
jq -e --arg snapshot "$snapshot_id" '
  .state == "succeeded" and .snapshotId == $snapshot and .failurePoint == null and
  (.durationSeconds | type == "number") and (.environment | length > 0) and (.containsUserContent | not)
' "$restore_report" >/dev/null || fail "恢复报告缺少 snapshot、环境、耗时或安全字段"

completed_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
report_tmp="$test_root/recovery-test-report.json"
jq -n --arg completedAt "$completed_at" --arg snapshot "$snapshot_id" \
  --slurpfile samples "$state_root/verification.json" --slurpfile restore "$restore_report" \
  '{reportVersion: 1, state: "succeeded", completedAt: $completedAt, snapshotId: $snapshot,
    productionShape: true, encryptedResticSnapshot: true, backupFailureRestartVerified: true,
    emptyRootAndDatabase: true, restartPersistenceVerified: true, workerIsolationVerified: true,
    databaseFailureSanitized: true, runtimeLogRedactionVerified: true, formalHttpsVerified: false,
    samples: $samples[0], restore: $restore[0], containsUserContent: false}' >"$report_tmp"
mkdir -p "$deploy_dir/data/operations"
cp "$report_tmp" "$deploy_dir/data/operations/recovery-test-report.json"
chmod 644 "$deploy_dir/data/operations/recovery-test-report.json"

success=true
printf '%s\n' "隔离生产形态空机恢复演练通过：snapshot ${snapshot_id}；20 条文本、5 张原图、5 个普通附件及认证/组织/AI 状态均一致"
