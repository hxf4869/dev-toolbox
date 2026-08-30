#!/bin/sh
set -eu

. "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/lib.sh"

require_command docker
validate_basic_production_env
validate_backup_repository

restic_image=$(optional_env_value RESTIC_IMAGE "$DEPLOY_ENV_FILE" "ghcr.io/restic/restic:0.19.1")
case "$restic_image" in
  *:latest|""|*[!A-Za-z0-9._/:@-]*) fail "RESTIC_IMAGE 必须使用明确版本或 digest，不能使用 latest" ;;
esac

password_file="$production_secrets_root/restic_password"
[ -f "$password_file" ] || fail "缺少 restic 密码文件：$password_file"
restic_uid=$(id -u)
restic_gid=$(id -g)
restic_tmpfs="/tmp:size=256m,mode=1700,uid=$restic_uid,gid=$restic_gid"

if [ "$repository_kind" = s3 ]; then
  if [ -n "${RESTIC_RESTORE_TARGET:-}" ]; then
    exec docker run --rm --network bridge --read-only --tmpfs "$restic_tmpfs" \
      --user "$restic_uid:$restic_gid" \
      --env-file "$repository_credentials_file" \
      -e RESTIC_REPOSITORY="$repository_url" \
      -e RESTIC_PASSWORD_FILE=/run/secrets/restic_password \
      -e RESTIC_CACHE_DIR=/tmp/restic-cache \
      -e AWS_DEFAULT_REGION="$repository_region" \
      -v "$production_data_root:/data-source:ro" \
      -v "$production_staging_root:/backup-source:ro" \
      -v "$password_file:/run/secrets/restic_password:ro" \
      -v "$RESTIC_RESTORE_TARGET:/restore:rw" \
      "$restic_image" -o s3.bucket-lookup=dns "$@"
  fi

  exec docker run --rm --network bridge --read-only --tmpfs "$restic_tmpfs" \
    --user "$restic_uid:$restic_gid" \
    --env-file "$repository_credentials_file" \
    -e RESTIC_REPOSITORY="$repository_url" \
    -e RESTIC_PASSWORD_FILE=/run/secrets/restic_password \
    -e RESTIC_CACHE_DIR=/tmp/restic-cache \
    -e AWS_DEFAULT_REGION="$repository_region" \
    -v "$production_data_root:/data-source:ro" \
    -v "$production_staging_root:/backup-source:ro" \
    -v "$password_file:/run/secrets/restic_password:ro" \
    "$restic_image" -o s3.bucket-lookup=dns "$@"
fi

if [ -n "${RESTIC_RESTORE_TARGET:-}" ]; then
  exec docker run --rm --network none --read-only --tmpfs "$restic_tmpfs" \
    --user "$restic_uid:$restic_gid" \
    -e RESTIC_REPOSITORY=/repository \
    -e RESTIC_PASSWORD_FILE=/run/secrets/restic_password \
    -e RESTIC_CACHE_DIR=/tmp/restic-cache \
    -v "$repository_path:/repository:rw" \
    -v "$production_data_root:/data-source:ro" \
    -v "$production_staging_root:/backup-source:ro" \
    -v "$password_file:/run/secrets/restic_password:ro" \
    -v "$RESTIC_RESTORE_TARGET:/restore:rw" \
    "$restic_image" "$@"
fi

exec docker run --rm --network none --read-only --tmpfs "$restic_tmpfs" \
  --user "$restic_uid:$restic_gid" \
  -e RESTIC_REPOSITORY=/repository \
  -e RESTIC_PASSWORD_FILE=/run/secrets/restic_password \
  -e RESTIC_CACHE_DIR=/tmp/restic-cache \
  -v "$repository_path:/repository:rw" \
  -v "$production_data_root:/data-source:ro" \
  -v "$production_staging_root:/backup-source:ro" \
  -v "$password_file:/run/secrets/restic_password:ro" \
  "$restic_image" "$@"
