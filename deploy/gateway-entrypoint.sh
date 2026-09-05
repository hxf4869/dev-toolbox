#!/bin/sh
# gateway 容器入口：把 Agent Console 内部服务令牌从 Secret 文件注入 Caddy 环境，
# 供 Caddyfile 中 forward_auth 的 Authorization 头使用。
# Secret 文件缺失时不阻塞启动：令牌为空时 API 会以 503 拒绝 agent-console
# 内部端点（fail closed），dev-toolbox 其余功能不受影响。
set -eu

token_file=/run/secrets/agent_console_internal_token
if [ -f "$token_file" ]; then
	AGENT_CONSOLE_INTERNAL_TOKEN="$(tr -d '\r\n' <"$token_file")"
	export AGENT_CONSOLE_INTERNAL_TOKEN
fi
exec "$@"
