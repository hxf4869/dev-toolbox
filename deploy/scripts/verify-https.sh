#!/bin/sh
set -eu

. "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/lib.sh"

require_command curl
require_command jq
validate_basic_production_env

domain=$(env_value APP_DOMAIN "$DEPLOY_ENV_FILE")
edge_mode=$(production_edge_mode)
operations_dir="$production_data_root/operations"
mkdir -p "$operations_dir"

headers_file=$(mktemp /tmp/dev-toolbox-http-headers.XXXXXX)
body_file=$(mktemp /tmp/dev-toolbox-https-body.XXXXXX)
trap 'rm -f "$headers_file" "$body_file"' EXIT HUP INT TERM

http_status=$(curl --silent --show-error --max-time 15 --output /dev/null --dump-header "$headers_file" --write-out '%{http_code}' "http://$domain/health/live")
[ "$http_status" = 301 ] || [ "$http_status" = 302 ] || [ "$http_status" = 307 ] || [ "$http_status" = 308 ] || fail "HTTP 未返回重定向状态"
location=$(awk 'BEGIN { IGNORECASE=1 } /^Location:/ { sub(/\r$/, ""); sub(/^[^:]*:[[:space:]]*/, ""); print; exit }' "$headers_file")
case "$location" in
  "https://$domain"/*|"https://$domain") ;;
  *) fail "HTTP 没有重定向到同域 HTTPS" ;;
esac

https_status=$(curl --silent --show-error --fail --max-time 20 --output "$body_file" --dump-header "$headers_file" --write-out '%{http_code}' "https://$domain/health/live")
[ "$https_status" = 200 ] || fail "HTTPS 健康检查未返回 200"
jq -e '.status == "live" and .service == "api"' "$body_file" >/dev/null || fail "HTTPS 健康响应无效"

header_value() {
  wanted=$1
  awk -v wanted="$wanted" '
    BEGIN { IGNORECASE=1 }
    {
      line=$0
      sub(/\r$/, "", line)
      if (index(tolower(line), tolower(wanted) ":") == 1) {
        sub(/^[^:]*:[[:space:]]*/, "", line)
        print line
        exit
      }
    }
  ' "$headers_file"
}

[ "$(header_value X-Content-Type-Options)" = nosniff ] || fail "HTTPS 缺少 X-Content-Type-Options: nosniff"
case "$(header_value Strict-Transport-Security)" in max-age=*) ;; *) fail "HTTPS 缺少有效 HSTS" ;; esac
[ "$(header_value Referrer-Policy)" = no-referrer ] || fail "HTTPS 缺少 Referrer-Policy: no-referrer"
csp=$(header_value Content-Security-Policy)
for directive in "default-src 'self'" "script-src 'self'" "object-src 'none'" "frame-ancestors 'none'" "form-action 'self'"; do
  case "$csp" in *"$directive"*) ;; *) fail "HTTPS CSP 缺少约束：$directive" ;; esac
done

if [ "$edge_mode" = external_nginx ]; then
  exposed_udp_ports='[]'
else
  exposed_udp_ports='[443]'
fi

checked_at=$(utc_now)
report_tmp=$(mktemp "$operations_dir/.https-status.XXXXXX")
jq -n --arg checkedAt "$checked_at" --arg domain "$domain" --arg edgeMode "$edge_mode" --argjson exposedUdpPorts "$exposed_udp_ports" \
  '{version: 1, state: "succeeded", checkedAt: $checkedAt, domain: $domain, edgeMode: $edgeMode, httpRedirect: true, httpsReady: true, securityHeaders: true, exposedTcpPorts: [80, 443], exposedUdpPorts: $exposedUdpPorts}' >"$report_tmp"
chmod 644 "$report_tmp"
mv "$report_tmp" "$operations_dir/https-status.json"

printf '%s\n' "正式域名 HTTP→HTTPS 与有效 TLS 健康检查通过：$domain"
