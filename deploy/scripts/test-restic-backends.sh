#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
test_root=$(mktemp -d /tmp/dev-toolbox-restic-backends.XXXXXX)
trap 'rm -rf "$test_root"' EXIT HUP INT TERM

mkdir -p "$test_root/bin" "$test_root/data/attachments" "$test_root/secrets" \
  "$test_root/staging" "$test_root/local-repository"
printf '%s\n' 'test-restic-password-with-more-than-thirty-two-bytes' >"$test_root/secrets/restic_password"
printf '%s\n' 'AWS_ACCESS_KEY_ID=test-access-key' 'AWS_SECRET_ACCESS_KEY=test-secret-key' >"$test_root/secrets/restic_s3.env"
chmod 600 "$test_root/secrets/restic_password" "$test_root/secrets/restic_s3.env"

printf '%s\n' \
  '#!/bin/sh' \
  ': "${FAKE_DOCKER_LOG:?}"' \
  'printf "%s\n" "$@" >"$FAKE_DOCKER_LOG"' \
  >"$test_root/bin/docker"
chmod 700 "$test_root/bin/docker"

write_common_env() {
  target=$1
  {
    printf '%s\n' 'APP_DOMAIN=toolbox.example.net'
    printf '%s\n' 'APP_VERSION=v1.0.0'
    printf '%s\n' 'APP_TIMEZONE=Asia/Shanghai'
    printf '%s\n' 'POSTGRES_DB=dev_toolbox'
    printf '%s\n' 'POSTGRES_USER=dev_toolbox'
    printf 'DEPLOY_DATA_ROOT=%s\n' "$test_root/data"
    printf 'DEPLOY_SECRETS_ROOT=%s\n' "$test_root/secrets"
    printf 'DEPLOY_STAGING_ROOT=%s\n' "$test_root/staging"
    printf '%s\n' 'BACKUP_TARGET_LABEL=restic-backend-contract'
    printf '%s\n' 'RESTIC_IMAGE=ghcr.io/restic/restic:0.19.1'
  } >"$target"
}

local_env="$test_root/local.env"
write_common_env "$local_env"
printf 'RESTIC_LOCAL_REPOSITORY_PATH=%s\n' "$test_root/local-repository" >>"$local_env"
chmod 600 "$local_env"

local_log="$test_root/local-docker.log"
PATH="$test_root/bin:$PATH" FAKE_DOCKER_LOG="$local_log" DEPLOY_ENV_FILE="$local_env" \
  "$script_dir/restic-local.sh" snapshots --json
grep -Fx 'none' "$local_log" >/dev/null
grep -Fx 'RESTIC_REPOSITORY=/repository' "$local_log" >/dev/null
grep -Fx "$test_root/local-repository:/repository:rw" "$local_log" >/dev/null

s3_env="$test_root/s3.env"
write_common_env "$s3_env"
{
  printf '%s\n' 'RESTIC_REPOSITORY=s3:https://s3.cn-north-1.jdcloud-oss.com/hxf/dev-toolbox-production'
  printf '%s\n' 'RESTIC_S3_REGION=cn-north-1'
  printf 'RESTIC_S3_CREDENTIALS_FILE=%s\n' "$test_root/secrets/restic_s3.env"
  printf '%s\n' 'RESTIC_REPOSITORY_MAX_BYTES=10000000000'
  printf '%s\n' 'RESTIC_REPOSITORY_RESERVE_BYTES=1000000000'
} >>"$s3_env"
chmod 600 "$s3_env"

s3_log="$test_root/s3-docker.log"
PATH="$test_root/bin:$PATH" FAKE_DOCKER_LOG="$s3_log" DEPLOY_ENV_FILE="$s3_env" \
  "$script_dir/restic-local.sh" snapshots --json
grep -Fx 'bridge' "$s3_log" >/dev/null
grep -Fx "$test_root/secrets/restic_s3.env" "$s3_log" >/dev/null
grep -Fx 'RESTIC_REPOSITORY=s3:https://s3.cn-north-1.jdcloud-oss.com/hxf/dev-toolbox-production' "$s3_log" >/dev/null
grep -Fx 'AWS_DEFAULT_REGION=cn-north-1' "$s3_log" >/dev/null
grep -Fx 's3.bucket-lookup=dns' "$s3_log" >/dev/null
if grep -F 'test-secret-key' "$s3_log" >/dev/null; then
  printf '%s\n' 'S3 Secret 不得出现在 docker 命令参数中' >&2
  exit 1
fi

DEPLOY_ENV_FILE="$s3_env"
export DEPLOY_ENV_FILE
. "$script_dir/lib.sh"
validate_backup_repository
assert_backup_capacity 7000000000 1000000000
if (assert_backup_capacity 8500000000 600000000) >/dev/null 2>&1; then
  printf '%s\n' '超过容量上限的投影被错误接受' >&2
  exit 1
fi

invalid_env="$test_root/invalid.env"
write_common_env "$invalid_env"
{
  printf '%s\n' 'RESTIC_REPOSITORY=s3:http://s3.cn-north-1.jdcloud-oss.com/hxf'
  printf '%s\n' 'RESTIC_S3_REGION=cn-north-1'
  printf 'RESTIC_S3_CREDENTIALS_FILE=%s\n' "$test_root/secrets/restic_s3.env"
  printf '%s\n' 'RESTIC_REPOSITORY_MAX_BYTES=10000000000'
  printf '%s\n' 'RESTIC_REPOSITORY_RESERVE_BYTES=1000000000'
} >>"$invalid_env"
chmod 600 "$invalid_env"
if PATH="$test_root/bin:$PATH" FAKE_DOCKER_LOG="$test_root/invalid.log" DEPLOY_ENV_FILE="$invalid_env" \
  "$script_dir/restic-local.sh" snapshots --json >/dev/null 2>&1; then
  printf '%s\n' '未加密的 S3 Endpoint 被错误接受' >&2
  exit 1
fi

sh -n "$script_dir/run-scheduled-backup.sh"
grep -Fx 'lock_file=/run/lock/dev-toolbox-backup.lock' "$script_dir/run-scheduled-backup.sh" >/dev/null
grep -F '/usr/bin/flock -n "$lock_file" "$script_dir/backup.sh"' "$script_dir/run-scheduled-backup.sh" >/dev/null
grep -Fx '17 3 * * * root /home/toolbox/deploy/scripts/run-scheduled-backup.sh' \
  "$script_dir/../cron/dev-toolbox-backup" >/dev/null

printf '%s\n' 'restic 后端契约通过：本地仓库保持离线网络，S3 使用 HTTPS、独立凭据文件、容量安全余量和单实例每日调度'
