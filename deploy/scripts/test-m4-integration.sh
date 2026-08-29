#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
deploy_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
project_dir=$(CDPATH= cd -- "$deploy_dir/.." && pwd)
compose_file="$deploy_dir/compose.yaml"
env_file="$deploy_dir/.env"
test_database="dev_toolbox_m4_test"
test_container="dev-toolbox-m4-integration"

if [ ! -f "$env_file" ] || [ ! -f "$deploy_dir/secrets/postgres_password" ]; then
  echo "请先运行 make init-dev" >&2
  exit 1
fi

if docker container inspect "$test_container" >/dev/null 2>&1; then
  echo "测试容器 $test_container 已存在，请先检查并停止它" >&2
  exit 1
fi

cleanup() {
  docker stop --time 1 "$test_container" >/dev/null 2>&1 || true
  docker compose --env-file "$env_file" -f "$compose_file" exec -T postgres \
    sh -lc "dropdb --if-exists --force -U \"\$POSTGRES_USER\" $test_database" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker compose --env-file "$env_file" -f "$compose_file" up -d --wait postgres
docker compose --env-file "$env_file" -f "$compose_file" exec -T postgres \
  sh -lc "dropdb --if-exists --force -U \"\$POSTGRES_USER\" $test_database && createdb -U \"\$POSTGRES_USER\" $test_database"
docker compose --env-file "$env_file" -f "$compose_file" run --rm --no-deps \
  -e PGDATABASE="$test_database" api /app/migrate >/dev/null

docker run -d --rm --name "$test_container" \
  -v "$project_dir:/repo" \
  -v "$env_file:/run/config/dev.env:ro" \
  -v "$deploy_dir/secrets/postgres_password:/run/secrets/test_pg_password:ro" \
  -w /repo/apps/api golang:1.27.0-alpine3.23 sleep infinity >/dev/null
docker network connect dev-toolbox_backend "$test_container"
docker exec "$test_container" sh -c '
  . /run/config/dev.env
  test_password=$(tr -d "\n" </run/secrets/test_pg_password)
  export TEST_DATABASE_URL="host=postgres port=5432 dbname=dev_toolbox_m4_test user=$POSTGRES_USER password=$test_password sslmode=disable"
  unset test_password
  go test -tags=integration ./integration -run TestM4 -count=1 -v
'
