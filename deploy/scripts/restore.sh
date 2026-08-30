#!/bin/sh
set -eu

. "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/lib.sh"

require_command docker
require_command jq
validate_basic_production_env
validate_backup_repository
source_operations_dir="$production_data_root/operations"
source_config_root=$production_config_root
mkdir -p "$source_operations_dir"

restore_root=${RESTORE_ROOT:-}
snapshot_requested=${SNAPSHOT_ID:-}
[ -n "$restore_root" ] || fail "必须通过 RESTORE_ROOT 指定新的空恢复目录"
[ -n "$snapshot_requested" ] || fail "必须通过 SNAPSHOT_ID 指定经过选择的 restic snapshot"
case "$restore_root" in /*) ;; *) fail "RESTORE_ROOT 必须是绝对路径" ;; esac
[ "$restore_root" != "/" ] && [ "$restore_root" != "$deploy_dir" ] && [ "$restore_root" != "$project_dir" ] || fail "RESTORE_ROOT 范围过大"
[ ! -L "$restore_root" ] || fail "RESTORE_ROOT 不能是符号链接"
for protected_root in "$project_dir" "$production_data_root" "$production_secrets_root" "$production_staging_root"; do
  case "$restore_root/" in
    "$protected_root/"*) fail "RESTORE_ROOT 不能位于源码、现有数据、Secret、暂存或 restic 仓库内" ;;
  esac
done
if [ "$repository_kind" = local ]; then
  case "$restore_root/" in
    "$repository_path/"*) fail "RESTORE_ROOT 不能位于源码、现有数据、Secret、暂存或 restic 仓库内" ;;
  esac
fi

mkdir -p "$restore_root"
safe_empty_directory "$restore_root" "恢复根"
mkdir -p "$restore_root/data/postgres" "$restore_root/data/attachments" "$restore_root/data/caddy" \
  "$restore_root/data/caddy-config" "$restore_root/data/operations" "$restore_root/backup-staging" "$restore_root/restore-staging"

export DEPLOY_DATA_ROOT="$restore_root/data"
export DEPLOY_SECRETS_ROOT="$production_secrets_root"
export DEPLOY_CONFIG_ROOT="$source_config_root"
export DEPLOY_STAGING_ROOT="$restore_root/backup-staging"
production_data_root=$DEPLOY_DATA_ROOT
production_secrets_root=$DEPLOY_SECRETS_ROOT
production_config_root=$DEPLOY_CONFIG_ROOT
production_staging_root=$DEPLOY_STAGING_ROOT
export COMPOSE_PROJECT_NAME=${RESTORE_PROJECT_NAME:-dev-toolbox-restore}
case "$COMPOSE_PROJECT_NAME" in ""|*[!a-z0-9_-]*) fail "RESTORE_PROJECT_NAME 只能包含小写字母、数字、下划线和连字符" ;; esac
if production_compose ps -q | grep . >/dev/null 2>&1; then
  fail "恢复项目已有容器：${COMPOSE_PROJECT_NAME}；请使用新的 RESTORE_PROJECT_NAME 或先人工检查"
fi

operations_dir="$restore_root/data/operations"
status_file="$operations_dir/restore-status.json"
report_file="$operations_dir/restore-report.json"
staging_root="$restore_root/restore-staging"
started_at=$(utc_now)
started_epoch=$(date -u '+%s')
failure_code=RESTORE_FAILED
resolved_snapshot=""
source_version=""
referenced=0
verified=0
orphans=0

write_restore_status() {
  state=$1
  error_code=$2
  verified_at=$3
  temp_status=$(mktemp "$operations_dir/.restore-status.XXXXXX")
  jq -n --arg state "$state" --arg verifiedAt "$verified_at" --arg snapshot "$resolved_snapshot" \
    --argjson referenced "$referenced" --argjson verified "$verified" --argjson orphans "$orphans" --arg error "$error_code" \
    '{state: $state, verifiedAt: (if $verifiedAt == "" then null else $verifiedAt end), snapshotId: $snapshot, referencedAttachments: $referenced, verifiedAttachments: $verified, orphanAttachments: $orphans, errorCode: $error}' >"$temp_status"
  chmod 644 "$temp_status"
  mv "$temp_status" "$status_file"
}

write_restore_report() {
  state=$1
  error_code=$2
  completed_at=$3
  completed_epoch=$4
  version=$(env_value APP_VERSION "$DEPLOY_ENV_FILE")
  temp_report=$(mktemp "$operations_dir/.restore-report.XXXXXX")
  jq -n --arg state "$state" --arg error "$error_code" --arg startedAt "$started_at" --arg completedAt "$completed_at" \
    --arg snapshot "$resolved_snapshot" --arg version "$version" --arg sourceVersion "$source_version" --arg host "$(uname -srm)" \
    --argjson duration "$((completed_epoch - started_epoch))" --argjson referenced "$referenced" \
    --argjson verified "$verified" --argjson orphans "$orphans" \
    '{reportVersion: 1, state: $state, errorCode: $error, failurePoint: (if $error == "" then null else $error end), correction: null, startedAt: $startedAt, completedAt: $completedAt, durationSeconds: $duration, snapshotId: $snapshot, sourceAppVersion: $sourceVersion, appVersion: $version, environment: $host, integrity: {referencedAttachments: $referenced, verifiedAttachments: $verified, orphanAttachments: $orphans}, containsUserContent: false}' >"$temp_report"
  chmod 644 "$temp_report"
  mv "$temp_report" "$report_file"
}

publish_restore_result() {
  [ "$source_operations_dir" != "$operations_dir" ] || return 0
  for result_name in restore-status.json restore-report.json; do
    source_file="$operations_dir/$result_name"
    target_tmp=$(mktemp "$source_operations_dir/.$result_name.XXXXXX")
    cp "$source_file" "$target_tmp"
    chmod 644 "$target_tmp"
    mv "$target_tmp" "$source_operations_dir/$result_name"
  done
}

on_exit() {
  exit_code=$?
  trap - EXIT HUP INT TERM
  if [ "$exit_code" -ne 0 ]; then
    production_compose stop gateway ai-worker >/dev/null 2>&1 || true
    completed_at=$(utc_now)
    completed_epoch=$(date -u '+%s')
    write_restore_status failed "$failure_code" ""
    write_restore_report failed "$failure_code" "$completed_at" "$completed_epoch"
    publish_restore_result || printf '%s\n' "无法把失败状态写回源部署运维目录" >&2
    printf '%s\n' "恢复失败并已保留现场：${restore_root}；worker 与 gateway 未作为成功步骤启动" >&2
  fi
  exit "$exit_code"
}
trap on_exit EXIT
trap 'failure_code=RESTORE_INTERRUPTED; exit 130' HUP INT TERM

write_restore_status running "" ""

failure_code=SNAPSHOT_NOT_FOUND
resolved_snapshot=$(DEPLOY_ENV_FILE="$DEPLOY_ENV_FILE" "$script_dir/restic-local.sh" snapshots --json "$snapshot_requested" \
  | jq -r 'if length == 1 then .[0].id else empty end')
[ -n "$resolved_snapshot" ] || fail "snapshot 不存在或不唯一：$snapshot_requested"

failure_code=SNAPSHOT_RESTORE_FAILED
RESTIC_RESTORE_TARGET="$staging_root" DEPLOY_ENV_FILE="$DEPLOY_ENV_FILE" \
  "$script_dir/restic-local.sh" restore "$resolved_snapshot" --target /restore >/dev/null

dump_file="$staging_root/backup-source/current/database.dump"
restored_attachments="$staging_root/data-source/attachments"
manifest_file="$staging_root/backup-source/current/config/manifest.json"
[ -s "$dump_file" ] || fail "snapshot 缺少 PostgreSQL custom dump"
[ -d "$restored_attachments" ] || fail "snapshot 缺少原始附件目录"
jq -e '.manifestVersion == 1 and (.contents | index("database.dump")) != null and (.contents | index("data/attachments")) != null' "$manifest_file" >/dev/null || fail "snapshot 配置清单无效"
source_version=$(jq -r '.appVersion // empty' "$manifest_file")
[ -n "$source_version" ] || fail "snapshot 配置清单缺少应用版本"

failure_code=ATTACHMENT_RESTORE_FAILED
cp -a "$restored_attachments/." "$restore_root/data/attachments/"
docker run --rm --network none -v "$restore_root/data/attachments:/target" alpine:3.23.3 \
  sh -c 'chown -R 10001:10001 /target && chmod 0700 /target'
prepare_postgres_data_directory "$restore_root/data/postgres"

failure_code=POSTGRES_START_FAILED
production_compose up -d --wait postgres >/dev/null

failure_code=DATABASE_RESTORE_FAILED
production_compose exec -T postgres sh -c 'exec pg_restore --no-owner --no-acl -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <"$dump_file"

failure_code=MIGRATION_PREFLIGHT_FAILED
production_compose run --rm --no-deps api /app/migrate --preflight >/dev/null
failure_code=MIGRATION_FAILED
production_compose run --rm --no-deps api /app/migrate >/dev/null

failure_code=API_START_FAILED
production_compose up -d --wait api >/dev/null

failure_code=ATTACHMENT_INTEGRITY_FAILED
integrity_tmp=$(mktemp "$operations_dir/.integrity-report.XXXXXX")
set +e
production_compose exec -T api /app/dev-toolbox maintenance check-integrity --json >"$integrity_tmp"
integrity_exit=$?
set -e
chmod 644 "$integrity_tmp"
mv "$integrity_tmp" "$operations_dir/integrity-report.json"
integrity_file="$operations_dir/integrity-report.json"
referenced=$(jq -r '.referencedAttachments // 0' "$integrity_file")
verified=$(jq -r '.verifiedAttachments // 0' "$integrity_file")
orphans=$(jq -r '.orphanAttachments | length' "$integrity_file")
[ "$integrity_exit" -eq 0 ] && jq -e '.state == "succeeded"' "$integrity_file" >/dev/null || fail "附件完整性校验未通过"

failure_code=RELEASE_STATUS_PUBLISH_FAILED
DEPLOY_ENV_FILE="$DEPLOY_ENV_FILE" "$script_dir/publish-release-status.sh" >/dev/null

failure_code=SERVICE_START_FAILED
production_compose up -d --wait ai-worker gateway >/dev/null
production_compose exec -T api wget -q -O - http://127.0.0.1:8080/health/ready | jq -e '.status == "ready"' >/dev/null
production_compose exec -T ai-worker node -e "fetch('http://127.0.0.1:3001/health/live').then(async r=>{const b=await r.json();if(!r.ok||b.status!=='live')process.exit(1)}).catch(()=>process.exit(1))"

find "$staging_root" -mindepth 1 -delete
completed_at=$(utc_now)
completed_epoch=$(date -u '+%s')
write_restore_status succeeded "" "$completed_at"
write_restore_report succeeded "" "$completed_at" "$completed_epoch"
failure_code=RESTORE_STATUS_PUBLISH_FAILED
publish_restore_result

trap - EXIT HUP INT TERM
printf '%s\n' "空目录恢复完成：snapshot ${resolved_snapshot}；完整性 ${verified}/${referenced}，孤儿 ${orphans}；项目 ${COMPOSE_PROJECT_NAME} 保持运行供验收"
