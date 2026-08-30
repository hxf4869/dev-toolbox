#!/bin/sh
set -eu

. "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/lib.sh"

validate_basic_production_env
validate_backup_repository

case "$#:${1:-}" in
  0:)
    apply=false
    ;;
  1:--apply)
    apply=true
    ;;
  *)
    fail "用法：prune-backups.sh [--apply]"
    ;;
esac

DEPLOY_ENV_FILE="$DEPLOY_ENV_FILE" "$script_dir/restic-local.sh" forget --dry-run \
  --tag dev-toolbox --keep-daily 7 --keep-weekly 4 --keep-monthly 6

if [ "$apply" = false ]; then
  printf '%s\n' "以上仅为保留策略预览；确认后使用 prune-backups.sh --apply"
  exit 0
fi

DEPLOY_ENV_FILE="$DEPLOY_ENV_FILE" "$script_dir/restic-local.sh" forget --prune \
  --tag dev-toolbox --keep-daily 7 --keep-weekly 4 --keep-monthly 6
printf '%s\n' "restic 保留策略已应用：7 日、4 周、6 月"
