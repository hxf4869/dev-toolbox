#!/bin/sh
set -eu

. "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/lib.sh"

require_command jq
validate_basic_production_env
validate_backup_repository

operations_dir="$production_data_root/operations"
status_file="$operations_dir/backup-status.json"
[ -f "$status_file" ] || fail "尚无备份状态；先完成一次备份"

if ! DEPLOY_ENV_FILE="$DEPLOY_ENV_FILE" "$script_dir/restic-local.sh" check; then
  temp_status=$(mktemp "$operations_dir/.backup-status.XXXXXX")
  jq '.state = "failed" | .errorCode = "RESTIC_CHECK_FAILED"' "$status_file" >"$temp_status"
  chmod 644 "$temp_status"
  mv "$temp_status" "$status_file"
  fail "restic check 失败"
fi

checked_at=$(utc_now)
temp_status=$(mktemp "$operations_dir/.backup-status.XXXXXX")
jq --arg checkedAt "$checked_at" '.resticCheckAt = $checkedAt | .errorCode = ""' "$status_file" >"$temp_status"
chmod 644 "$temp_status"
mv "$temp_status" "$status_file"
printf '%s\n' "restic 仓库检查通过：$checked_at"
