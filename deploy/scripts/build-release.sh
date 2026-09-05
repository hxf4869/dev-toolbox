#!/bin/sh
set -eu

. "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/lib.sh"

require_command docker
validate_basic_production_env
version=$(env_value APP_VERSION "$DEPLOY_ENV_FILE")
go_proxy=${GOPROXY:-https://proxy.golang.org,direct}
agent_console_source_root=${AGENT_CONSOLE_SOURCE_ROOT:-"$(dirname "$project_dir")/agent-console"}
case "$agent_console_source_root" in
  /*) ;;
  *) fail "AGENT_CONSOLE_SOURCE_ROOT 必须是绝对路径：$agent_console_source_root" ;;
esac
[ -f "$agent_console_source_root/apps/web/package.json" ] || fail "缺少 Agent Console Web 源码：$agent_console_source_root/apps/web"
[ -f "$agent_console_source_root/packages/protocol-ts/package.json" ] || fail "缺少 Agent Console 协议源码：$agent_console_source_root/packages/protocol-ts"

docker build --build-arg APP_VERSION="$version" --build-arg GOPROXY="$go_proxy" -f "$project_dir/apps/api/Dockerfile" -t "dev-toolbox-api:$version" "$project_dir"
docker build --build-arg APP_VERSION="$version" -f "$project_dir/apps/ai-worker/Dockerfile" -t "dev-toolbox-ai-worker:$version" "$project_dir"
docker build --build-context "agent_console_web=$agent_console_source_root" --build-arg APP_VERSION="$version" -f "$project_dir/deploy/Dockerfile.gateway" -t "dev-toolbox-gateway:$version" "$project_dir"

docker image inspect "dev-toolbox-api:$version" "dev-toolbox-ai-worker:$version" "dev-toolbox-gateway:$version" >/dev/null
printf '%s\n' "已构建本地发布镜像：${version}（未推送远端）"
