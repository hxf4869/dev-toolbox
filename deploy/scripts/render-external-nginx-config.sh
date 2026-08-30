#!/bin/sh
set -eu

. "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/lib.sh"

validate_basic_production_env
[ "$(production_edge_mode)" = external_nginx ] || fail "只有 external_nginx 模式需要渲染外置 Nginx 配置"

domain=$(env_value APP_DOMAIN "$DEPLOY_ENV_FILE")
sed "s/__APP_DOMAIN__/$domain/g" "$deploy_dir/nginx/external-nginx.conf.template"
