#!/bin/sh

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
deploy_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
project_dir=$(CDPATH= cd -- "$deploy_dir/.." && pwd)
production_compose_file="$deploy_dir/compose.production.yaml"
production_external_nginx_compose_file="$deploy_dir/compose.production.external-nginx.yaml"
DEPLOY_ENV_FILE=${DEPLOY_ENV_FILE:-"$deploy_dir/.env.production"}

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "缺少必需命令：$1"
}

env_value() {
  key=$1
  file=$2
  awk -v wanted="$key" '
    /^[[:space:]]*#/ || /^[[:space:]]*$/ { next }
    {
      line = $0
      sub(/\r$/, "", line)
      sub(/^[[:space:]]*/, "", line)
      prefix = wanted "="
      if (index(line, prefix) == 1) {
        print substr(line, length(prefix) + 1)
        found++
      }
    }
    END { if (found != 1) exit 2 }
  ' "$file" || fail "配置 $key 缺失或重复：$file"
}

optional_env_value() {
  key=$1
  file=$2
  fallback=$3
  value=$(awk -v wanted="$key" '
    /^[[:space:]]*#/ || /^[[:space:]]*$/ { next }
    {
      line = $0
      sub(/\r$/, "", line)
      sub(/^[[:space:]]*/, "", line)
      prefix = wanted "="
      if (index(line, prefix) == 1) {
        print substr(line, length(prefix) + 1)
        found++
      }
    }
    END { if (found > 1) exit 2 }
  ' "$file") || fail "配置 $key 重复：$file"
  if [ -n "$value" ]; then
    printf '%s\n' "$value"
  else
    printf '%s\n' "$fallback"
  fi
}

deploy_path_value() {
  key=$1
  inherited=$2
  fallback=$3
  if [ -n "$inherited" ]; then
    value=$inherited
  elif [ -f "$DEPLOY_ENV_FILE" ]; then
    value=$(optional_env_value "$key" "$DEPLOY_ENV_FILE" "$fallback")
  else
    value=$fallback
  fi
  case "$value" in
    /*) ;;
    *) fail "$key 必须是绝对路径：$value" ;;
  esac
  [ "$value" != "/" ] || fail "$key 不能指向根目录"
  printf '%s\n' "${value%/}"
}

production_data_root=$(deploy_path_value DEPLOY_DATA_ROOT "${DEPLOY_DATA_ROOT:-}" "$deploy_dir/data")
production_secrets_root=$(deploy_path_value DEPLOY_SECRETS_ROOT "${DEPLOY_SECRETS_ROOT:-}" "$deploy_dir/secrets")
production_config_root=$(deploy_path_value DEPLOY_CONFIG_ROOT "${DEPLOY_CONFIG_ROOT:-}" "$deploy_dir")
production_staging_root=$(deploy_path_value DEPLOY_STAGING_ROOT "${DEPLOY_STAGING_ROOT:-}" "$deploy_dir/backup-staging")

prepare_postgres_data_directory() {
  postgres_data_directory=$1
  docker run --rm --network none --user root --entrypoint sh \
    -v "$postgres_data_directory:/target" postgres:18.6-alpine3.23 \
    -c 'chown -R postgres:postgres /target && chmod 0700 /target'
}

validate_basic_production_env() {
  [ -f "$DEPLOY_ENV_FILE" ] || fail "缺少生产配置：$DEPLOY_ENV_FILE"
  domain=$(env_value APP_DOMAIN "$DEPLOY_ENV_FILE")
  version=$(env_value APP_VERSION "$DEPLOY_ENV_FILE")
  database=$(env_value POSTGRES_DB "$DEPLOY_ENV_FILE")
  database_user=$(env_value POSTGRES_USER "$DEPLOY_ENV_FILE")

  case "$domain" in
    ""|*://*|*/*|*:*|*" "*|localhost|*.localhost|*.example|*.example.com|*.invalid|*.test)
      fail "APP_DOMAIN 必须是已解析到部署主机的正式域名，不能包含 scheme、端口、路径或保留测试域名"
      ;;
  esac
  if ! printf '%s\n' "$domain" | awk '
    length($0) > 253 || $0 !~ /\./ { exit 1 }
    {
      count = split($0, labels, ".")
      for (label_index = 1; label_index <= count; label_index++) {
        if (length(labels[label_index]) < 1 || length(labels[label_index]) > 63 ||
            labels[label_index] !~ /^[A-Za-z0-9][A-Za-z0-9-]*[A-Za-z0-9]$/ && labels[label_index] !~ /^[A-Za-z0-9]$/) exit 1
      }
    }
  '; then
    fail "APP_DOMAIN 必须是有效的 DNS 主机名"
  fi
  case "$version" in
    ""|latest|development|dev|[.-]*|*[!A-Za-z0-9._-]*)
      fail "APP_VERSION 必须是 1–128 字符的明确镜像标签，不能使用 latest/development"
      ;;
  esac
  [ "$(printf '%s' "$version" | wc -c | tr -d ' ')" -le 128 ] || fail "APP_VERSION 最多 128 个字符"
  case "$database" in ""|*[!A-Za-z0-9_-]*) fail "POSTGRES_DB 格式无效" ;; esac
  case "$database_user" in ""|*[!A-Za-z0-9_-]*) fail "POSTGRES_USER 格式无效" ;; esac

  edge_mode=$(production_edge_mode)
  if [ "$edge_mode" = external_nginx ]; then
    edge_network=$(env_value EDGE_NETWORK_NAME "$DEPLOY_ENV_FILE")
    case "$edge_network" in
      ""|*[!A-Za-z0-9_.-]*) fail "EDGE_NETWORK_NAME 格式无效" ;;
    esac
  fi
}

production_edge_mode() {
  mode=$(optional_env_value DEPLOY_EDGE_MODE "$DEPLOY_ENV_FILE" caddy)
  case "$mode" in
    caddy|external_nginx) printf '%s\n' "$mode" ;;
    *) fail "DEPLOY_EDGE_MODE 只允许 caddy 或 external_nginx" ;;
  esac
}

validate_backup_repository() {
  repository_url=$(optional_env_value RESTIC_REPOSITORY "$DEPLOY_ENV_FILE" "")
  configured_local_repository=$(optional_env_value RESTIC_LOCAL_REPOSITORY_PATH "$DEPLOY_ENV_FILE" "")
  repository_kind=local
  repository_path=""
  repository_credentials_file=""
  repository_region=""
  repository_max_bytes=""
  repository_reserve_bytes=""

  if [ -z "$repository_url" ]; then
    [ -n "$configured_local_repository" ] || fail "必须配置 RESTIC_LOCAL_REPOSITORY_PATH 或 RESTIC_REPOSITORY"
    repository_path=$configured_local_repository
    case "$repository_path" in
      /*) ;;
      *) fail "RESTIC_LOCAL_REPOSITORY_PATH 必须是绝对路径" ;;
    esac
    [ "$repository_path" != "/" ] || fail "restic 仓库不能是根目录"
    [ ! -L "$repository_path" ] || fail "restic 仓库挂载点不能是符号链接：$repository_path"
    for protected_root in "$deploy_dir" "$production_data_root" "$production_secrets_root" "$production_staging_root"; do
      case "$repository_path/" in
        "$protected_root/"*) fail "restic 仓库必须位于应用、数据、Secret 和暂存目录之外" ;;
      esac
    done
    [ -d "$repository_path" ] || fail "restic 仓库挂载点不存在：$repository_path"
    repository_url=/repository
    return
  fi

  [ -z "$configured_local_repository" ] || fail "RESTIC_LOCAL_REPOSITORY_PATH 与 RESTIC_REPOSITORY 只能配置一个"
  repository_kind=s3
  case "$repository_url" in
    s3:https://*) ;;
    *) fail "RESTIC_REPOSITORY 仅允许使用 s3:https:// 的加密对象存储地址" ;;
  esac
  case "$repository_url" in
    *[[:space:]@?#]*|*\\*|*//*//*|*/../*|*/./*)
      fail "RESTIC_REPOSITORY 包含不允许的凭据、查询参数或路径"
      ;;
  esac
  repository_host_and_path=${repository_url#s3:https://}
  repository_host=${repository_host_and_path%%/*}
  repository_bucket_path=${repository_host_and_path#*/}
  [ "$repository_host" != "$repository_host_and_path" ] || fail "RESTIC_REPOSITORY 必须包含 Bucket 名称"
  case "$repository_host" in
    ""|.*|*.|*[!A-Za-z0-9.-]*) fail "RESTIC_REPOSITORY Endpoint 格式无效" ;;
  esac
  case "$repository_bucket_path" in
    ""|/*|*/|*//*|.*|*/.*) fail "RESTIC_REPOSITORY Bucket 或前缀格式无效" ;;
  esac

  repository_region=$(env_value RESTIC_S3_REGION "$DEPLOY_ENV_FILE")
  case "$repository_region" in
    ""|*[!A-Za-z0-9-]*) fail "RESTIC_S3_REGION 格式无效" ;;
  esac
  repository_credentials_file=$(deploy_path_value RESTIC_S3_CREDENTIALS_FILE "${RESTIC_S3_CREDENTIALS_FILE:-}" "$production_secrets_root/restic_s3.env")
  [ -f "$repository_credentials_file" ] || fail "缺少 S3 凭据文件：$repository_credentials_file"
  [ ! -L "$repository_credentials_file" ] || fail "S3 凭据文件不能是符号链接：$repository_credentials_file"
  awk -F= '
    /^[[:space:]]*($|#)/ { next }
    $1 == "AWS_ACCESS_KEY_ID" && length(substr($0, index($0, "=") + 1)) > 0 { access_key++ ; next }
    $1 == "AWS_SECRET_ACCESS_KEY" && length(substr($0, index($0, "=") + 1)) > 0 { secret_key++ ; next }
    { invalid++ }
    END { exit !(access_key == 1 && secret_key == 1 && invalid == 0) }
  ' "$repository_credentials_file" || fail "S3 凭据文件必须且只能各包含一项 AWS_ACCESS_KEY_ID 和 AWS_SECRET_ACCESS_KEY"

  repository_max_bytes=$(env_value RESTIC_REPOSITORY_MAX_BYTES "$DEPLOY_ENV_FILE")
  repository_reserve_bytes=$(env_value RESTIC_REPOSITORY_RESERVE_BYTES "$DEPLOY_ENV_FILE")
  case "$repository_max_bytes:$repository_reserve_bytes" in
    *[!0-9:]*) fail "restic 对象存储容量上限和安全余量必须是十进制字节数" ;;
  esac
  [ "$repository_max_bytes" -gt 0 ] || fail "RESTIC_REPOSITORY_MAX_BYTES 必须大于 0"
  [ "$repository_reserve_bytes" -gt 0 ] || fail "RESTIC_REPOSITORY_RESERVE_BYTES 必须大于 0"
  [ "$repository_reserve_bytes" -lt "$repository_max_bytes" ] || fail "restic 对象存储安全余量必须小于容量上限"
}

assert_backup_capacity() {
  current_bytes=$1
  next_source_bytes=$2
  case "$current_bytes:$next_source_bytes" in
    *[!0-9:]*) fail "restic 容量计算只接受非负十进制字节数" ;;
  esac
  projected_bytes=$((current_bytes + next_source_bytes + repository_reserve_bytes))
  [ "$projected_bytes" -le "$repository_max_bytes" ] || fail "预计对象存储占用将超过安全容量门禁：当前 ${current_bytes} 字节，本次源数据 ${next_source_bytes} 字节，预留 ${repository_reserve_bytes} 字节，上限 ${repository_max_bytes} 字节"
}

apparent_file_bytes() {
  target=$1
  [ -e "$target" ] || {
    printf '%s\n' 0
    return
  }
  if stat -c '%s' "$target" >/dev/null 2>&1; then
    find "$target" -type f -exec stat -c '%s' {} + | awk '{ total += $1 } END { printf "%.0f\n", total + 0 }'
  else
    find "$target" -type f -exec stat -f '%z' {} + | awk '{ total += $1 } END { printf "%.0f\n", total + 0 }'
  fi
}

production_compose() {
  compose_project=${COMPOSE_PROJECT_NAME:-dev-toolbox}
  edge_mode=$(production_edge_mode)
  if [ "$edge_mode" = external_nginx ]; then
    DEPLOY_DATA_ROOT="$production_data_root" DEPLOY_SECRETS_ROOT="$production_secrets_root" \
      DEPLOY_CONFIG_ROOT="$production_config_root" \
      docker compose --project-name "$compose_project" --env-file "$DEPLOY_ENV_FILE" \
        -f "$production_compose_file" -f "$production_external_nginx_compose_file" "$@"
  else
    DEPLOY_DATA_ROOT="$production_data_root" DEPLOY_SECRETS_ROOT="$production_secrets_root" \
      DEPLOY_CONFIG_ROOT="$production_config_root" \
      docker compose --project-name "$compose_project" --env-file "$DEPLOY_ENV_FILE" -f "$production_compose_file" "$@"
  fi
}

utc_now() {
  date -u '+%Y-%m-%dT%H:%M:%SZ'
}

safe_empty_directory() {
  target=$1
  label=$2
  [ -d "$target" ] || fail "$label 目录不存在：$target"
  [ ! -L "$target" ] || fail "$label 不能是符号链接：$target"
  if find "$target" -mindepth 1 -print -quit | grep . >/dev/null 2>&1; then
    fail "$label 必须为空：$target"
  fi
}
