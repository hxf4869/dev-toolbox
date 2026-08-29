#!/bin/sh
set -eu

if [ "${CONFIRM_RESET:-}" != "dev-toolbox" ]; then
  echo "拒绝清理：请通过 make reset-dev 运行" >&2
  exit 1
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
deploy_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)

docker compose --env-file "$deploy_dir/.env" -f "$deploy_dir/compose.yaml" down

for data_name in postgres attachments caddy; do
  data_dir="$deploy_dir/data/$data_name"
  if [ -L "$data_dir" ]; then
    echo "拒绝清理符号链接：$data_dir" >&2
    exit 1
  fi
  if [ -d "$data_dir" ]; then
    find "$data_dir" -mindepth 1 -delete
  fi
done

echo "本地开发数据已清空；deploy/.env 与 deploy/secrets/ 已保留"
