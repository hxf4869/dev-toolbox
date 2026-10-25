#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
deploy_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
project_dir=$(CDPATH= cd -- "$deploy_dir/.." && pwd)
compose_file="$deploy_dir/compose.yaml"
env_file="$deploy_dir/.env"
upgrade_database="dev_toolbox_m5_test"
empty_database="dev_toolbox_m5_empty_test"
test_container="dev-toolbox-m5-integration"
migration_root=$(mktemp -d /tmp/dev-toolbox-m5-migrations.XXXXXX)

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
  for database_name in "$upgrade_database" "$empty_database"; do
    docker compose --env-file "$env_file" -f "$compose_file" exec -T postgres \
      sh -lc "dropdb --if-exists --force -U \"\$POSTGRES_USER\" $database_name" >/dev/null 2>&1 || true
  done
  if [ -d "$migration_root" ] && [ ! -L "$migration_root" ]; then
    find "$migration_root" -mindepth 1 -delete
    rmdir "$migration_root" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

for sequence in 001 002 003 004 005; do
  cp "$project_dir/apps/api/migrations/$sequence"_*.sql "$migration_root/"
done

docker compose --env-file "$env_file" -f "$compose_file" up -d --wait postgres
expected_schema_version=$(printf '%s\n' "$project_dir"/apps/api/migrations/[0-9]*_*.sql \
  | sed 's|.*/||; s/_.*//' | sort -n | tail -n 1 | awk '{ print $1 + 0 }')
for database_name in "$upgrade_database" "$empty_database"; do
  docker compose --env-file "$env_file" -f "$compose_file" exec -T postgres \
    sh -lc "dropdb --if-exists --force -U \"\$POSTGRES_USER\" $database_name && createdb -U \"\$POSTGRES_USER\" $database_name"
done

docker compose --env-file "$env_file" -f "$compose_file" run --rm --no-deps \
  -e PGDATABASE="$upgrade_database" -e MIGRATIONS_PATH=/test-migrations \
  -v "$migration_root:/test-migrations:ro" api /app/migrate >/dev/null
docker compose --env-file "$env_file" -f "$compose_file" run --rm --no-deps \
  -e PGDATABASE="$upgrade_database" api /app/migrate --preflight >/dev/null
docker compose --env-file "$env_file" -f "$compose_file" run --rm --no-deps \
  -e PGDATABASE="$upgrade_database" api /app/migrate >/dev/null
docker compose --env-file "$env_file" -f "$compose_file" run --rm --no-deps \
  -e PGDATABASE="$upgrade_database" api /app/migrate --preflight >/dev/null

docker compose --env-file "$env_file" -f "$compose_file" run --rm --no-deps \
  -e PGDATABASE="$empty_database" api /app/migrate >/dev/null

for database_name in "$upgrade_database" "$empty_database"; do
  docker compose --env-file "$env_file" -f "$compose_file" exec -T postgres \
    sh -lc "psql -v ON_ERROR_STOP=1 -U \"\$POSTGRES_USER\" -d $database_name -Atc \"SELECT version FROM public.schema_version; SELECT count(*) FROM information_schema.columns WHERE table_name = 'provider_configs' AND column_name LIKE 'last_test%';\"" \
    | awk -v expected="$expected_schema_version" 'NR == 1 && $0 == expected { version = 1 } NR == 2 && $0 == "4" { columns = 1 } END { exit !(version && columns) }'
done

docker run -d --rm --name "$test_container" \
	--tmpfs /m5-full-storage:size=1m,mode=0700 \
  -v "$project_dir:/repo" \
  -v "$env_file:/run/config/dev.env:ro" \
  -v "$deploy_dir/secrets/postgres_password:/run/secrets/test_pg_password:ro" \
  -w /repo/apps/api golang:1.27.0-alpine3.23 sleep infinity >/dev/null
docker network connect dev-toolbox_backend "$test_container"
docker exec "$test_container" sh -c '
  . /run/config/dev.env
  test_password=$(tr -d "\n" </run/secrets/test_pg_password)
  export TEST_DATABASE_URL="host=postgres port=5432 dbname=dev_toolbox_m5_test user=$POSTGRES_USER password=$test_password sslmode=disable"
  export RUN_M5_FULL_STORAGE=1
  export M5_FULL_STORAGE_ROOT=/m5-full-storage
  unset test_password
  go test -tags=integration ./integration -run TestM5 -count=1 -v
'
