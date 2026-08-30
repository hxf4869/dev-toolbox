#!/bin/sh
set -eu

. "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/lib.sh"

require_command docker
require_command jq

installed_env="$deploy_dir/.env.production"
target_env=${TARGET_ENV_FILE:-}
rehearsal_report=${REHEARSAL_REPORT_FILE:-}
[ -f "$installed_env" ] || fail "缺少当前生产配置：$installed_env"
[ -n "$target_env" ] && [ -f "$target_env" ] || fail "必须通过 TARGET_ENV_FILE 提供已审核的目标版本配置"
[ -n "$rehearsal_report" ] && [ -f "$rehearsal_report" ] || fail "必须通过 REHEARSAL_REPORT_FILE 提供目标版本空机恢复成功报告"
[ "$target_env" != "$installed_env" ] || fail "TARGET_ENV_FILE 必须与当前生产配置分开，便于审核"

DEPLOY_ENV_FILE="$installed_env"
production_data_root=$(deploy_path_value DEPLOY_DATA_ROOT "${DEPLOY_DATA_ROOT:-}" "$deploy_dir/data")
production_secrets_root=$(deploy_path_value DEPLOY_SECRETS_ROOT "${DEPLOY_SECRETS_ROOT:-}" "$deploy_dir/secrets")
production_config_root=$(deploy_path_value DEPLOY_CONFIG_ROOT "${DEPLOY_CONFIG_ROOT:-}" "$deploy_dir")
production_staging_root=$(deploy_path_value DEPLOY_STAGING_ROOT "${DEPLOY_STAGING_ROOT:-}" "$deploy_dir/backup-staging")
validate_basic_production_env
current_version=$(env_value APP_VERSION "$installed_env")
current_domain=$(env_value APP_DOMAIN "$installed_env")
current_database=$(env_value POSTGRES_DB "$installed_env")
current_database_user=$(env_value POSTGRES_USER "$installed_env")
DEPLOY_ENV_FILE="$target_env"
validate_basic_production_env
target_version=$(env_value APP_VERSION "$target_env")
[ "$target_version" != "$current_version" ] || fail "目标版本与当前版本相同"
[ "$(env_value APP_DOMAIN "$target_env")" = "$current_domain" ] || fail "升级不能同时变更正式域名"
[ "$(env_value POSTGRES_DB "$target_env")" = "$current_database" ] || fail "升级不能同时变更数据库名"
[ "$(env_value POSTGRES_USER "$target_env")" = "$current_database_user" ] || fail "升级不能同时变更数据库用户"
for repository_key in RESTIC_LOCAL_REPOSITORY_PATH RESTIC_REPOSITORY RESTIC_S3_REGION RESTIC_S3_CREDENTIALS_FILE RESTIC_REPOSITORY_MAX_BYTES RESTIC_REPOSITORY_RESERVE_BYTES; do
  current_repository_value=$(optional_env_value "$repository_key" "$installed_env" "")
  target_repository_value=$(optional_env_value "$repository_key" "$target_env" "")
  [ "$target_repository_value" = "$current_repository_value" ] || fail "升级不能同时变更 $repository_key"
done
for root_key in DEPLOY_DATA_ROOT DEPLOY_SECRETS_ROOT DEPLOY_CONFIG_ROOT DEPLOY_STAGING_ROOT; do
  current_root=$(optional_env_value "$root_key" "$installed_env" "")
  target_root=$(optional_env_value "$root_key" "$target_env" "")
  [ "$target_root" = "$current_root" ] || fail "升级不能同时变更 $root_key"
done

for image in "dev-toolbox-api:$target_version" "dev-toolbox-ai-worker:$target_version" "dev-toolbox-gateway:$target_version"; do
  docker image inspect "$image" >/dev/null 2>&1 || fail "目标镜像不存在：$image"
done

jq -e --arg version "$target_version" \
  '.state == "succeeded" and (.snapshotId | type == "string" and length > 0) and .appVersion == $version and .containsUserContent == false' \
  "$rehearsal_report" >/dev/null || fail "恢复演练报告不是目标版本的成功空机恢复证据"
rehearsal_snapshot=$(jq -r '.snapshotId' "$rehearsal_report")
DEPLOY_ENV_FILE="$installed_env" "$script_dir/restic-local.sh" snapshots --json "$rehearsal_snapshot" \
  | jq -e --arg snapshot "$rehearsal_snapshot" 'length == 1 and (.[0].id == $snapshot or .[0].short_id == $snapshot)' >/dev/null \
  || fail "恢复演练使用的 snapshot 在当前仓库中不可读取"

operations_dir="$production_data_root/operations"
mkdir -p "$operations_dir"
stage=UPGRADE_PRECHECK_FAILED
services_stopped=false
environment_swapped=false

write_failure_report() {
  completed_at=$(utc_now)
  temp_report=$(mktemp "$operations_dir/.upgrade-report.XXXXXX")
  jq -n --arg completedAt "$completed_at" --arg from "$current_version" --arg to "$target_version" \
    --arg snapshot "${snapshot_id:-}" --arg rehearsalSnapshot "$rehearsal_snapshot" --arg failure "$stage" \
    '{reportVersion: 1, state: "failed", completedAt: $completedAt, fromVersion: $from, toVersion: $to, backupSnapshotId: $snapshot, rehearsalSnapshotId: $rehearsalSnapshot, failurePoint: $failure, rollbackMode: "snapshot_restore_if_schema_incompatible", containsUserContent: false}' >"$temp_report"
  chmod 644 "$temp_report"
  mv "$temp_report" "$operations_dir/upgrade-report.json"
}

on_exit() {
  exit_code=$?
  trap - EXIT HUP INT TERM
  if [ "$exit_code" -ne 0 ]; then
    if [ "$services_stopped" = true ] && [ "$environment_swapped" = false ]; then
      DEPLOY_ENV_FILE="$installed_env"
      production_compose up -d --wait api ai-worker >/dev/null 2>&1 || stage=OLD_SERVICES_RESTART_FAILED
    elif [ "$environment_swapped" = true ]; then
      DEPLOY_ENV_FILE="$installed_env"
      production_compose stop gateway api ai-worker >/dev/null 2>&1 || true
    fi
    write_failure_report
    printf '%s\n' "升级停止在 ${stage}；未自动执行数据库回滚，请按升级前 snapshot 恢复" >&2
  fi
  exit "$exit_code"
}
trap on_exit EXIT
trap 'stage=UPGRADE_INTERRUPTED; exit 130' HUP INT TERM

stage=UPGRADE_BACKUP_FAILED
DEPLOY_ENV_FILE="$installed_env" "$script_dir/backup.sh"
backup_status="$operations_dir/backup-status.json"
snapshot_id=$(jq -r 'select(.state == "succeeded") | .snapshotId' "$backup_status")
[ -n "$snapshot_id" ] || fail "升级前备份未成功"

stage=MIGRATION_PREFLIGHT_FAILED
DEPLOY_ENV_FILE="$target_env"
production_compose run --rm --no-deps api /app/migrate --preflight >/dev/null

stage=SERVICE_STOP_FAILED
DEPLOY_ENV_FILE="$installed_env"
services_stopped=true
production_compose stop api ai-worker >/dev/null

stage=ENVIRONMENT_SWAP_FAILED
env_tmp=$(mktemp "$deploy_dir/.env.production.XXXXXX")
cp "$target_env" "$env_tmp"
chmod 600 "$env_tmp"
mv "$env_tmp" "$installed_env"
environment_swapped=true

stage=MIGRATION_FAILED
DEPLOY_ENV_FILE="$installed_env"
production_compose run --rm --no-deps api /app/migrate >/dev/null
stage=SERVICE_START_FAILED
production_compose up -d --wait api ai-worker gateway >/dev/null
stage=READINESS_FAILED
production_compose exec -T api wget -q -O - http://127.0.0.1:8080/health/ready | jq -e '.status == "ready"' >/dev/null
services_stopped=false

completed_at=$(utc_now)
report_tmp=$(mktemp "$operations_dir/.upgrade-report.XXXXXX")
jq -n --arg completedAt "$completed_at" --arg from "$current_version" --arg to "$target_version" --arg snapshot "$snapshot_id" \
  --arg rehearsalSnapshot "$rehearsal_snapshot" \
  '{reportVersion: 1, state: "succeeded", completedAt: $completedAt, fromVersion: $from, toVersion: $to, backupSnapshotId: $snapshot, rehearsalSnapshotId: $rehearsalSnapshot, rollbackMode: "snapshot_restore_if_schema_incompatible", containsUserContent: false}' >"$report_tmp"
chmod 644 "$report_tmp"
mv "$report_tmp" "$operations_dir/upgrade-report.json"

trap - EXIT HUP INT TERM
printf '%s\n' "升级完成：$current_version → ${target_version}；升级前 snapshot $snapshot_id"
