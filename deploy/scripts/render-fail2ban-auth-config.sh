#!/bin/sh
set -eu

. "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/lib.sh"

validate_basic_production_env
[ "$(production_edge_mode)" = external_nginx ] || fail "只有 external_nginx 模式需要外置 Fail2ban 登录防护"

case "${1:-}" in
  filter)
    domain=$(env_value APP_DOMAIN "$DEPLOY_ENV_FILE")
    domain_regex=$(printf '%s\n' "$domain" | sed 's/[.]/[.]/g')
    sed "s/__APP_DOMAIN_REGEX__/$domain_regex/g" "$deploy_dir/fail2ban/filter.d/dev-toolbox-auth.conf.template"
    ;;
  jail)
    access_log=$(optional_env_value FAIL2BAN_AUTH_LOG_PATH "$DEPLOY_ENV_FILE" "/home/nginx/logs/access.log")
    case "$access_log" in
      /*) ;;
      *) fail "FAIL2BAN_AUTH_LOG_PATH 必须是绝对路径" ;;
    esac
    case "$access_log" in
      *'|'*|*' '*|*'\t'*|*'\n'*) fail "FAIL2BAN_AUTH_LOG_PATH 包含不支持的字符" ;;
    esac
    sed "s|__AUTH_LOG_PATH__|$access_log|g" "$deploy_dir/fail2ban/jail.d/dev-toolbox-auth.conf.template"
    ;;
  *)
    fail "用法：render-fail2ban-auth-config.sh filter|jail"
    ;;
esac
