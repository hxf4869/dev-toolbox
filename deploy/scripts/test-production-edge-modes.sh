#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
deploy_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
test_root=$(mktemp -d /tmp/dev-toolbox-edge-test.XXXXXX)
trap 'rm -rf "$test_root"' EXIT HUP INT TERM
mkdir -p "$test_root/restic"

write_env() {
  target=$1
  edge_mode=$2
  {
    printf '%s\n' 'APP_DOMAIN=toolbox.example.net'
    printf '%s\n' 'APP_VERSION=v1.0.1'
    printf '%s\n' 'APP_TIMEZONE=Asia/Shanghai'
    printf '%s\n' 'POSTGRES_DB=dev_toolbox'
    printf '%s\n' 'POSTGRES_USER=dev_toolbox'
    printf 'DEPLOY_EDGE_MODE=%s\n' "$edge_mode"
    if [ "$edge_mode" = external_nginx ]; then
      printf '%s\n' 'EDGE_NETWORK_NAME=edge_contract_test'
      printf '%s\n' 'FAIL2BAN_AUTH_LOG_PATH=/var/log/nginx/access.log'
    fi
    printf 'RESTIC_LOCAL_REPOSITORY_PATH=%s\n' "$test_root/restic"
    printf '%s\n' 'BACKUP_TARGET_LABEL=edge-contract-test'
    printf '%s\n' 'RESTIC_IMAGE=ghcr.io/restic/restic:0.19.1'
  } >"$target"
  chmod 600 "$target"
}

direct_env="$test_root/direct.env"
external_env="$test_root/external.env"
write_env "$direct_env" caddy
write_env "$external_env" external_nginx

DEPLOY_ENV_FILE="$direct_env"
export DEPLOY_ENV_FILE
. "$script_dir/lib.sh"

direct_config="$test_root/direct.json"
production_compose config --format json >"$direct_config"
jq -e '
  .services.gateway.environment.APP_DOMAIN == "toolbox.example.net" and
  ([.services.gateway.ports[] | {target, published: (.published | tonumber), protocol}] | sort_by(.target, .protocol)) == [
    {target: 80, published: 80, protocol: "tcp"},
    {target: 443, published: 443, protocol: "tcp"},
    {target: 443, published: 443, protocol: "udp"}
  ] and
  ((.services.gateway.networks | keys) == ["frontend"])
' "$direct_config" >/dev/null

DEPLOY_ENV_FILE="$external_env"
export DEPLOY_ENV_FILE
external_config="$test_root/external.json"
production_compose config --format json >"$external_config"
jq -e '
  .services.gateway.environment.APP_DOMAIN == "http://toolbox.example.net" and
  .services.api.environment.APP_ORIGIN == "https://toolbox.example.net" and
  ((.services.gateway.ports // []) | length) == 0 and
  ((.services.gateway.networks | keys | sort) == ["edge", "frontend"]) and
  .networks.edge.external == true and .networks.edge.name == "edge_contract_test"
' "$external_config" >/dev/null

rendered_config="$test_root/nginx.conf"
"$script_dir/render-external-nginx-config.sh" >"$rendered_config"
grep -F 'server_name toolbox.example.net;' "$rendered_config" >/dev/null
grep -F 'limit_req_zone $binary_remote_addr zone=dev_toolbox_login_per_ip:10m rate=6r/m;' "$rendered_config" >/dev/null
grep -F 'limit_req zone=dev_toolbox_login_per_ip burst=5 nodelay;' "$rendered_config" >/dev/null
grep -F 'proxy_set_header X-Forwarded-For $remote_addr;' "$rendered_config" >/dev/null
grep -F 'proxy_pass http://dev-toolbox-gateway:80;' "$rendered_config" >/dev/null

rendered_filter="$test_root/fail2ban-filter.conf"
rendered_jail="$test_root/fail2ban-jail.conf"
"$script_dir/render-fail2ban-auth-config.sh" filter >"$rendered_filter"
"$script_dir/render-fail2ban-auth-config.sh" jail >"$rendered_jail"
grep -F 'https://toolbox[.]example[.]net/api/v1/auth/login' "$rendered_filter" >/dev/null
grep -F 'logpath = /var/log/nginx/access.log' "$rendered_jail" >/dev/null
grep -F 'maxretry = 12' "$rendered_jail" >/dev/null
grep -F 'bantime.maxtime = 24h' "$rendered_jail" >/dev/null

printf '%s\n' '生产边缘契约通过：Caddy 直连端口、外置 Nginx 零宿主机端口及登录防护配置均有效'
