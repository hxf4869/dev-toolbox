#!/bin/sh
set -eu

. "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/lib.sh"

require_command docker
require_command openssl

if [ ! -f "$DEPLOY_ENV_FILE" ]; then
  cp "$deploy_dir/env.production.example" "$DEPLOY_ENV_FILE"
  chmod 600 "$DEPLOY_ENV_FILE"
  fail "已创建 ${DEPLOY_ENV_FILE}；请填写正式域名和异地 restic 仓库后重新运行"
fi

validate_basic_production_env
validate_backup_repository

secrets_dir="$production_secrets_root"
mkdir -p "$secrets_dir" "$production_data_root/postgres" "$production_data_root/attachments" \
  "$production_data_root/caddy" "$production_data_root/caddy-config" "$production_data_root/operations" "$production_staging_root"
chmod 600 "$DEPLOY_ENV_FILE"
chmod 700 "$secrets_dir" "$production_data_root/postgres" "$production_data_root/caddy" "$production_data_root/caddy-config" "$production_staging_root"
chmod 755 "$production_data_root/operations"

create_text_secret() {
  secret_path=$1
  byte_count=$2
  if [ ! -f "$secret_path" ]; then
    openssl rand -base64 "$byte_count" | tr -d '\n' >"$secret_path"
    printf '\n' >>"$secret_path"
  fi
  chmod 600 "$secret_path"
}

create_text_secret "$secrets_dir/postgres_password" 48
create_text_secret "$secrets_dir/internal_service_token" 48
create_text_secret "$secrets_dir/app_master_key" 32
create_text_secret "$secrets_dir/restic_password" 48

docker run --rm --network none --user root -v "$secrets_dir:/secrets" alpine:3.23.3 sh -c '
  chown 10001:10001 /secrets/postgres_password /secrets/app_master_key
  chown 0:20000 /secrets/internal_service_token
  chown 0:0 /secrets/restic_password
  chmod 0600 /secrets/postgres_password /secrets/app_master_key /secrets/restic_password
  chmod 0640 /secrets/internal_service_token
'
if [ "$repository_kind" = s3 ]; then
  chmod 600 "$repository_credentials_file"
  if [ "$(uname -s)" = Linux ]; then
    chown 0:0 "$repository_credentials_file"
  fi
fi
docker run --rm --network none -v "$production_data_root/attachments:/target" alpine:3.23.3 \
  sh -c 'chown -R 10001:10001 /target && chmod 0700 /target'
prepare_postgres_data_directory "$production_data_root/postgres"

if ! DEPLOY_ENV_FILE="$DEPLOY_ENV_FILE" "$script_dir/restic-local.sh" snapshots --json >/dev/null 2>&1; then
  DEPLOY_ENV_FILE="$DEPLOY_ENV_FILE" "$script_dir/restic-local.sh" init >/dev/null
fi

DEPLOY_ENV_FILE="$DEPLOY_ENV_FILE" "$script_dir/publish-release-status.sh" >/dev/null

printf '%s\n' "生产目录和 Secret 已初始化；应用主密钥与 restic 密码仍需另存离线副本"
