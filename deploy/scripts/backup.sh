#!/bin/sh
set -eu

. "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/lib.sh"

require_command docker
require_command jq
validate_basic_production_env
validate_backup_repository

version=$(env_value APP_VERSION "$DEPLOY_ENV_FILE")
edge_mode=$(production_edge_mode)
target_label=$(env_value BACKUP_TARGET_LABEL "$DEPLOY_ENV_FILE")
[ "$(printf '%s' "$target_label" | wc -m | tr -d ' ')" -le 120 ] || fail "BACKUP_TARGET_LABEL 最多 120 个字符"

operations_dir="$production_data_root/operations"
staging_root="$production_staging_root/current"
status_file="$operations_dir/backup-status.json"
mkdir -p "$operations_dir" "$staging_root/config"
[ ! -L "$staging_root" ] || fail "backup-staging/current 不能是符号链接"
find "$staging_root" -mindepth 1 -delete
mkdir -p "$staging_root/config"

started_at=$(utc_now)
snapshot_id=""
backup_error=BACKUP_FAILED
services_stopped=false
restic_output=""
previous_success=""
previous_check=""
if [ -f "$status_file" ]; then
  previous_success=$(jq -r '.lastSuccessAt // empty' "$status_file" 2>/dev/null || true)
  previous_check=$(jq -r '.resticCheckAt // empty' "$status_file" 2>/dev/null || true)
fi

repository_raw_bytes() {
  snapshots_json=$(DEPLOY_ENV_FILE="$DEPLOY_ENV_FILE" "$script_dir/restic-local.sh" snapshots --json)
  if printf '%s\n' "$snapshots_json" | jq -e 'length == 0' >/dev/null; then
    printf '%s\n' 0
    return
  fi
  DEPLOY_ENV_FILE="$DEPLOY_ENV_FILE" "$script_dir/restic-local.sh" stats --mode raw-data --json \
    | jq -er '.total_size | select(type == "number" and . >= 0) | floor'
}

write_backup_status() {
  state=$1
  error_code=$2
  success_at=$3
  temp_status=$(mktemp "$operations_dir/.backup-status.XXXXXX")
  jq -n \
    --arg state "$state" \
    --arg attempt "$started_at" \
    --arg success "$success_at" \
    --arg snapshot "$snapshot_id" \
    --arg target "$target_label" \
    --arg checked "$previous_check" \
    --arg error "$error_code" \
    '{state: $state, lastAttemptAt: $attempt, lastSuccessAt: (if $success == "" then null else $success end), snapshotId: $snapshot, targetLabel: $target, resticCheckAt: (if $checked == "" then null else $checked end), errorCode: $error}' >"$temp_status"
  chmod 644 "$temp_status"
  mv "$temp_status" "$status_file"
}

cleanup() {
  exit_code=$?
  trap - EXIT HUP INT TERM
  if [ "$services_stopped" = true ]; then
    if ! production_compose up -d --wait api ai-worker >/dev/null 2>&1; then
      backup_error=SERVICE_RESTART_FAILED
      exit_code=1
    fi
  fi
  if [ -n "$restic_output" ]; then
    rm -f "$restic_output"
  fi
  if [ -d "$staging_root" ] && [ ! -L "$staging_root" ]; then
    find "$staging_root" -mindepth 1 -delete
  fi
  if [ "$exit_code" -ne 0 ]; then
    write_backup_status failed "$backup_error" "$previous_success"
  fi
  exit "$exit_code"
}
trap cleanup EXIT
trap 'backup_error=BACKUP_INTERRUPTED; exit 130' HUP INT TERM

write_backup_status running "" "$previous_success"

repository_bytes=""
if [ "$repository_kind" = s3 ]; then
  backup_error=BACKUP_CAPACITY_CHECK_FAILED
  repository_bytes=$(repository_raw_bytes)
  database_bytes=$(production_compose exec -T postgres sh -c 'exec psql -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT pg_database_size(current_database())"')
  case "$database_bytes" in
    ""|*[!0-9]*) fail "无法读取 PostgreSQL 数据库大小" ;;
  esac
  attachment_bytes=$(apparent_file_bytes "$production_data_root/attachments")
  estimated_source_bytes=$((database_bytes + attachment_bytes + 100000000))
  backup_error=BACKUP_CAPACITY_LIMIT
  assert_backup_capacity "$repository_bytes" "$estimated_source_bytes"
fi

backup_error=SERVICE_STOP_FAILED
services_stopped=true
production_compose stop api ai-worker >/dev/null

backup_error=DATABASE_DUMP_FAILED
production_compose exec -T postgres sh -c 'exec pg_dump --format=custom --no-owner --no-acl -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >"$staging_root/database.dump"
[ -s "$staging_root/database.dump" ] || fail "PostgreSQL dump 为空"

backup_error=CONFIG_MANIFEST_FAILED
cp "$deploy_dir/compose.production.yaml" "$staging_root/config/compose.production.yaml"
cp "$deploy_dir/compose.production.external-nginx.yaml" "$staging_root/config/compose.production.external-nginx.yaml"
cp "$production_config_root/Caddyfile" "$staging_root/config/Caddyfile"
cp "$deploy_dir/nginx/external-nginx.conf.template" "$staging_root/config/external-nginx.conf.template"
jq -n --arg version "$version" --arg createdAt "$started_at" --arg edgeMode "$edge_mode" \
  --arg gateway "dev-toolbox-gateway:$version" --arg api "dev-toolbox-api:$version" \
  --arg worker "dev-toolbox-ai-worker:$version" --arg postgres "pgvector/pgvector:0.8.6-pg18-trixie" \
  '{manifestVersion: 1, appVersion: $version, edgeMode: $edgeMode, createdAt: $createdAt, images: {gateway: $gateway, api: $api, aiWorker: $worker, postgres: $postgres}, contents: ["database.dump", "data/attachments", "config/compose.production.yaml", "config/compose.production.external-nginx.yaml", "config/Caddyfile", "config/external-nginx.conf.template"]}' \
  >"$staging_root/config/manifest.json"

if [ "$repository_kind" = s3 ]; then
  staged_bytes=$(apparent_file_bytes "$staging_root")
  attachment_bytes=$(apparent_file_bytes "$production_data_root/attachments")
  backup_error=BACKUP_CAPACITY_LIMIT
  assert_backup_capacity "$repository_bytes" "$((staged_bytes + attachment_bytes))"
fi

backup_error=RESTIC_BACKUP_FAILED
restic_output=$(mktemp /tmp/dev-toolbox-restic-backup.XXXXXX)
DEPLOY_ENV_FILE="$DEPLOY_ENV_FILE" "$script_dir/restic-local.sh" backup \
  /backup-source/current/database.dump \
  /data-source/attachments \
  /backup-source/current/config \
  --tag dev-toolbox --tag "$version" --json >"$restic_output"
snapshot_id=$(jq -r 'select(.message_type == "summary") | .snapshot_id // empty' "$restic_output" | tail -n 1)
rm -f "$restic_output"
restic_output=""
[ -n "$snapshot_id" ] || fail "restic 未返回 snapshot ID"

backup_error=RESTIC_SNAPSHOT_MISSING
DEPLOY_ENV_FILE="$DEPLOY_ENV_FILE" "$script_dir/restic-local.sh" snapshots --json "$snapshot_id" \
  | jq -e --arg snapshot "$snapshot_id" 'any(.[]; .short_id == $snapshot or .id == $snapshot)' >/dev/null

if [ "$repository_kind" = s3 ]; then
  backup_error=BACKUP_CAPACITY_CHECK_FAILED
  repository_bytes=$(repository_raw_bytes)
  backup_error=BACKUP_CAPACITY_LIMIT
  assert_backup_capacity "$repository_bytes" 0
fi

backup_error=SERVICE_RESTART_FAILED
production_compose up -d --wait api ai-worker >/dev/null
services_stopped=false

find "$staging_root" -mindepth 1 -delete
completed_at=$(utc_now)
previous_success=$completed_at
write_backup_status succeeded "" "$completed_at"

printf '%s\n' "静默备份完成：snapshot ${snapshot_id}；API 与 AI Worker 已恢复"
