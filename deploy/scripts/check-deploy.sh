#!/bin/sh
set -eu

. "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/lib.sh"

require_command docker
require_command jq
require_command openssl
validate_basic_production_env
validate_backup_repository

version=$(env_value APP_VERSION "$DEPLOY_ENV_FILE")
domain=$(env_value APP_DOMAIN "$DEPLOY_ENV_FILE")
edge_mode=$(production_edge_mode)
secrets_dir="$production_secrets_root"

mode_of() {
  if stat -c '%a' "$1" >/dev/null 2>&1; then
    stat -c '%a' "$1"
  else
    stat -f '%Lp' "$1"
  fi
}

require_mode() {
  path=$1
  expected=$2
  [ -e "$path" ] || fail "缺少部署文件：$path"
  actual=$(mode_of "$path")
  [ "$actual" = "$expected" ] || fail "${path} 权限应为 ${expected}，当前为 $actual"
}

require_mode "$DEPLOY_ENV_FILE" 600
require_mode "$secrets_dir" 700
for secret_name in postgres_password app_master_key restic_password; do
  require_mode "$secrets_dir/$secret_name" 600
  [ "$(wc -c <"$secrets_dir/$secret_name" | tr -d ' ')" -ge 32 ] || fail "Secret 长度不足：$secret_name"
done
if [ "$repository_kind" = s3 ]; then
  require_mode "$repository_credentials_file" 600
fi
require_mode "$secrets_dir/internal_service_token" 640
[ "$(wc -c <"$secrets_dir/internal_service_token" | tr -d ' ')" -ge 32 ] || fail "Secret 长度不足：internal_service_token"
require_mode "$secrets_dir/agent_console_internal_token" 640
[ "$(wc -c <"$secrets_dir/agent_console_internal_token" | tr -d ' ')" -ge 32 ] || fail "Secret 长度不足：agent_console_internal_token"

if [ "$(uname -s)" = Linux ]; then
  [ "$(stat -c '%u:%g' "$secrets_dir/postgres_password")" = "10001:10001" ] || fail "postgres_password 必须仅由 API 运行用户读取"
  [ "$(stat -c '%u:%g' "$secrets_dir/app_master_key")" = "10001:10001" ] || fail "app_master_key 必须仅由 API 运行用户读取"
  [ "$(stat -c '%u:%g' "$secrets_dir/internal_service_token")" = "0:20000" ] || fail "internal_service_token 必须授予 API 与 worker 的共享只读组"
  [ "$(stat -c '%u:%g' "$secrets_dir/agent_console_internal_token")" = "0:20000" ] || fail "agent_console_internal_token 必须授予 API 与 gateway 的共享只读组"
  [ "$(stat -c '%u:%g' "$secrets_dir/restic_password")" = "0:0" ] || fail "restic_password 必须仅由宿主机管理员读取"
  if [ "$repository_kind" = s3 ]; then
    [ "$(stat -c '%u:%g' "$repository_credentials_file")" = "0:0" ] || fail "S3 凭据文件必须仅由宿主机管理员读取"
  fi
fi

decoded_master_key_bytes=$(openssl base64 -d -A <"$secrets_dir/app_master_key" | wc -c | tr -d ' ')
[ "$decoded_master_key_bytes" = 32 ] || fail "app_master_key 必须解码为 32 字节"

for data_name in postgres attachments caddy caddy-config operations; do
  data_path="$production_data_root/$data_name"
  [ -d "$data_path" ] || fail "缺少持久化目录：$data_path"
  [ ! -L "$data_path" ] || fail "持久化目录不能是符号链接：$data_path"
done

if [ -d "$project_dir/.git" ]; then
  for private_path in deploy/.env.production deploy/secrets/postgres_password deploy/secrets/internal_service_token deploy/secrets/agent_console_internal_token deploy/secrets/app_master_key deploy/secrets/restic_password deploy/secrets/restic_s3.env; do
    if git -C "$project_dir" ls-files --error-unmatch "$private_path" >/dev/null 2>&1; then
      fail "私有部署文件被 Git 跟踪：$private_path"
    fi
  done
fi

config_file=$(mktemp /tmp/dev-toolbox-compose.XXXXXX)
trap 'rm -f "$config_file"' EXIT HUP INT TERM
production_compose config --format json >"$config_file"

jq -e --arg version "$version" --arg domain "$domain" --arg edgeMode "$edge_mode" '
  (.services | keys | sort) == ["ai-worker", "api", "gateway", "postgres"] and
  .services.gateway.image == ("dev-toolbox-gateway:" + $version) and
  .services.api.image == ("dev-toolbox-api:" + $version) and
  .services["ai-worker"].image == ("dev-toolbox-ai-worker:" + $version) and
  .services.postgres.image == "pgvector/pgvector:0.8.6-pg18-trixie" and
  .services.gateway.environment.APP_DOMAIN == (if $edgeMode == "external_nginx" then "http://" + $domain else $domain end) and
  .services.api.environment.APP_ORIGIN == ("https://" + $domain) and
  ((.services.api.ports // []) | length) == 0 and
  ((.services["ai-worker"].ports // []) | length) == 0 and
  ((.services.postgres.ports // []) | length) == 0 and
  .services.api.user == "10001:10001" and .services["ai-worker"].user == "1000:1000" and
  .services.api.group_add == ["20000"] and .services["ai-worker"].group_add == ["20000"] and
  .services.api.read_only == true and .services["ai-worker"].read_only == true and .services.gateway.read_only == true and
  .networks.backend.internal == true and (.networks.egress.internal // false) == false and
  ((.services["ai-worker"].networks | keys | sort) == ["backend", "egress"]) and
  ((.services.postgres.networks | keys) == ["backend"]) and
  ((.services.api.networks | keys | sort) == ["backend", "frontend"]) and
  ([.services[] | .logging.driver] | all(. == "local")) and
  ([.services[] | .logging.options["max-size"]] | all(. == "10m")) and
  ([.services[] | .logging.options["max-file"]] | all(. == "5")) and
  ([.services.api, .services["ai-worker"], .services.gateway] | all(.cap_drop == ["ALL"])) and
  ([.services.api, .services["ai-worker"], .services.gateway] | all(.security_opt | index("no-new-privileges:true") != null)) and
  ([.services[] | (.volumes // [])[]?.source] | all(contains("docker.sock") | not)) and
  ([.services[] | .image] | all(endswith(":latest") | not)) and
  .services.api.environment.ALLOW_INSECURE_PROVIDER_HTTP == "false"
' "$config_file" >/dev/null || fail "生产 Compose 未通过四容器、端口、卷、非 root、日志或版本固定检查"

if [ "$edge_mode" = external_nginx ]; then
  jq -e '
    ((.services.gateway.ports // []) | length) == 0 and
    ((.services.gateway.networks | keys | sort) == ["edge", "frontend"]) and
    .networks.edge.external == true
  ' "$config_file" >/dev/null || fail "外置 Nginx 模式不得映射 gateway 宿主机端口，且必须加入已存在的 edge 网络"
  edge_network=$(env_value EDGE_NETWORK_NAME "$DEPLOY_ENV_FILE")
  docker network inspect "$edge_network" >/dev/null 2>&1 || fail "外置 Nginx Docker 网络不存在：$edge_network"
  gateway_site="http://$domain"
  caddy_trusted_proxy_cidrs=$(optional_env_value EDGE_TRUSTED_PROXY_CIDRS "$DEPLOY_ENV_FILE" "172.16.0.0/12")
else
  jq -e '
    ([.services.gateway.ports[] | {target, published: (.published | tonumber), protocol}] | sort_by(.target, .protocol)) == [
      {target: 80, published: 80, protocol: "tcp"},
      {target: 443, published: 443, protocol: "tcp"},
      {target: 443, published: 443, protocol: "udp"}
    ] and
    ((.services.gateway.networks | keys) == ["frontend"])
  ' "$config_file" >/dev/null || fail "Caddy 直连模式必须仅由 gateway 映射 80/TCP 与 443/TCP+UDP"
  gateway_site="$domain"
  caddy_trusted_proxy_cidrs="127.0.0.1/8 ::1/128"
fi

for image in "dev-toolbox-api:$version" "dev-toolbox-ai-worker:$version" "dev-toolbox-gateway:$version"; do
  docker image inspect "$image" >/dev/null 2>&1 || fail "缺少本地发布镜像：${image}；请先运行 build-release.sh"
done

api_user=$(docker image inspect --format '{{.Config.User}}' "dev-toolbox-api:$version")
worker_user=$(docker image inspect --format '{{.Config.User}}' "dev-toolbox-ai-worker:$version")
[ -n "$api_user" ] && [ "$api_user" != 0 ] || fail "API 镜像必须声明非 root 用户"
[ -n "$worker_user" ] && [ "$worker_user" != 0 ] || fail "worker 镜像必须声明非 root 用户"

docker run --rm --network none --entrypoint /bin/sh "dev-toolbox-gateway:$version" \
  -c 'test -f /srv/agent-console/index.html' >/dev/null || fail "gateway 镜像缺少 Agent Console 静态产物"

docker run --rm --network none -e APP_DOMAIN="$gateway_site" -e CADDY_TRUSTED_PROXY_CIDRS="$caddy_trusted_proxy_cidrs" \
  -v "$production_config_root/Caddyfile:/etc/caddy/Caddyfile:ro" "dev-toolbox-gateway:$version" \
  caddy validate --config /etc/caddy/Caddyfile >/dev/null

if [ "$edge_mode" = external_nginx ]; then
  printf '%s\n' "生产部署静态检查通过：四个长期服务无宿主机端口映射，由现有 Nginx 提供公网 80/443；镜像版本 $version"
else
  printf '%s\n' "生产部署静态检查通过：四个长期服务，仅 gateway 暴露 80/443，镜像版本 $version"
fi
