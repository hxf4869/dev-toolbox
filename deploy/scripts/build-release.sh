#!/bin/sh
set -eu

. "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/lib.sh"

require_command docker
validate_basic_production_env
version=$(env_value APP_VERSION "$DEPLOY_ENV_FILE")
go_proxy=${GOPROXY:-https://proxy.golang.org,direct}

docker build --build-arg APP_VERSION="$version" --build-arg GOPROXY="$go_proxy" -f "$project_dir/apps/api/Dockerfile" -t "dev-toolbox-api:$version" "$project_dir"
docker build --build-arg APP_VERSION="$version" -f "$project_dir/apps/ai-worker/Dockerfile" -t "dev-toolbox-ai-worker:$version" "$project_dir"
docker build --build-arg APP_VERSION="$version" -f "$project_dir/deploy/Dockerfile.gateway" -t "dev-toolbox-gateway:$version" "$project_dir"

docker image inspect "dev-toolbox-api:$version" "dev-toolbox-ai-worker:$version" "dev-toolbox-gateway:$version" >/dev/null
printf '%s\n' "已构建本地发布镜像：${version}（未推送远端）"
