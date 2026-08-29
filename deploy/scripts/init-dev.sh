#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
deploy_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
secrets_dir="$deploy_dir/secrets"

mkdir -p "$secrets_dir" "$deploy_dir/data/postgres" "$deploy_dir/data/attachments" "$deploy_dir/data/caddy"
chmod 700 "$secrets_dir"

if [ ! -f "$deploy_dir/.env" ]; then
  cp "$deploy_dir/env.example" "$deploy_dir/.env"
  chmod 600 "$deploy_dir/.env"
  echo "已创建 deploy/.env（本地开发配置）"
fi

postgres_password_file="$secrets_dir/postgres_password"
if [ ! -f "$postgres_password_file" ]; then
  postgres_password=$(openssl rand -base64 36 | tr -d '\n')
  printf '%s\n' "$postgres_password" >"$postgres_password_file"
  chmod 600 "$postgres_password_file"
  unset postgres_password
fi

for secret_name in internal_service_token; do
  secret_file="$secrets_dir/$secret_name"
  if [ ! -f "$secret_file" ]; then
    openssl rand -base64 48 | tr -d '\n' >"$secret_file"
    printf '\n' >>"$secret_file"
    chmod 600 "$secret_file"
  fi
done

app_master_key_file="$secrets_dir/app_master_key"
if [ ! -f "$app_master_key_file" ]; then
  openssl rand -base64 32 | tr -d '\n' >"$app_master_key_file"
  printf '\n' >>"$app_master_key_file"
  chmod 600 "$app_master_key_file"
fi
