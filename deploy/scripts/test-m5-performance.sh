#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
deploy_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
project_dir=$(CDPATH= cd -- "$deploy_dir/.." && pwd)
compose_file="$deploy_dir/compose.yaml"
production_env_file=${M5_PERFORMANCE_PRODUCTION_ENV_FILE:-}
if [ -n "$production_env_file" ]; then
  env_file=$production_env_file
  production_mode=1
  performance_network=${M5_PERFORMANCE_NETWORK:-dev-toolbox_backend}
else
  env_file="$deploy_dir/.env"
  production_mode=0
  performance_network=dev-toolbox_backend
fi
test_database="dev_toolbox_m5_performance_test"
test_container="dev-toolbox-m5-performance"
report_file="$deploy_dir/data/operations/performance-report.json"
runner_image=${M5_PERFORMANCE_RUNNER_IMAGE:-golang:1.27.0-alpine3.23}

performance_compose() {
  if [ "$production_mode" = 1 ]; then
    DEPLOY_ENV_FILE="$env_file" "$script_dir/production-compose.sh" "$@"
  else
    docker compose --env-file "$env_file" -f "$compose_file" "$@"
  fi
}

if [ ! -f "$env_file" ] || [ ! -f "$deploy_dir/secrets/postgres_password" ]; then
  echo "请先运行 make init-dev" >&2
  exit 1
fi
if [ ! -d "$project_dir/apps/web/dist" ]; then
  echo "缺少 Web 生产构建；请通过 make m5-performance-test 启动" >&2
  exit 1
fi
if docker container inspect "$test_container" >/dev/null 2>&1; then
  echo "测试容器 $test_container 已存在，请先检查并停止它" >&2
  exit 1
fi

cleanup() {
  docker stop --time 1 "$test_container" >/dev/null 2>&1 || true
  if [ "${KEEP_M5_PERFORMANCE_DATABASE:-0}" = 1 ]; then
    printf '%s\n' "已保留性能测试数据库供查询计划诊断：$test_database" >&2
  else
    performance_compose exec -T postgres \
      sh -lc "dropdb --if-exists --force -U \"\$POSTGRES_USER\" $test_database" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

host_cpu=$(sysctl -n machdep.cpu.brand_string 2>/dev/null || awk -F: '/model name/ { sub(/^[[:space:]]+/, "", $2); print $2; exit }' /proc/cpuinfo 2>/dev/null || uname -m)
host_memory=$(sysctl -n hw.memsize 2>/dev/null || awk '/MemTotal/ { printf "%.0f\n", $2 * 1024; found=1; exit } END { if (!found) print 0 }' /proc/meminfo 2>/dev/null || printf '0')
host_os=$(uname -srv)
if filesystem=$(stat -f '%T' "$project_dir" 2>/dev/null); then
  :
else
  filesystem=$(stat -f -c '%T' "$project_dir" 2>/dev/null || printf 'unknown')
fi
solid_state=$(diskutil info / 2>/dev/null | awk -F: '/Solid State/ { gsub(/^[[:space:]]+|[[:space:]]+$/, "", $2); print $2; exit }')
disk_description="$filesystem; solid-state=${solid_state:-unknown}"
if first_dist_file=$(find "$project_dir/apps/web/dist" -type f -print -quit) && [ -n "$first_dist_file" ] && stat -f '%z' "$first_dist_file" >/dev/null 2>&1; then
  web_build_bytes=$(find "$project_dir/apps/web/dist" -type f -exec stat -f '%z' {} \; | awk '{ total += $1 } END { print total + 0 }')
else
  web_build_bytes=$(find "$project_dir/apps/web/dist" -type f -exec stat -c '%s' {} \; | awk '{ total += $1 } END { print total + 0 }')
fi

if [ "$production_mode" = 1 ]; then
  performance_compose exec -T postgres sh -lc 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null
else
  performance_compose up -d --wait postgres
fi
performance_compose exec -T postgres \
  sh -lc "dropdb --if-exists --force -U \"\$POSTGRES_USER\" $test_database && createdb -U \"\$POSTGRES_USER\" $test_database"
performance_compose run --rm --no-deps \
  -e PGDATABASE="$test_database" api /app/migrate >/dev/null

mkdir -p "$deploy_dir/data/operations"
docker run -d --rm --name "$test_container" \
  -v "$project_dir:/repo" \
  -v "$env_file:/run/config/dev.env:ro" \
  -v "$deploy_dir/secrets/postgres_password:/run/secrets/test_pg_password:ro" \
  -w /repo/apps/api "$runner_image" sleep infinity >/dev/null
docker network connect "$performance_network" "$test_container"
docker exec \
  -e RUN_M5_PERFORMANCE=1 \
  -e "M5_PERF_SKIP_REBUILD=${M5_PERF_SKIP_REBUILD:-0}" \
  -e "KEEP_M5_PERFORMANCE_DATABASE=${KEEP_M5_PERFORMANCE_DATABASE:-0}" \
  -e "PERF_HOST_CPU=$host_cpu" \
  -e "PERF_HOST_MEMORY_BYTES=$host_memory" \
  -e "PERF_HOST_OS=$host_os" \
  -e "PERF_DISK_DESCRIPTION=$disk_description" \
  -e "PERF_WEB_BUILD_BYTES=$web_build_bytes" \
  -e "PERFORMANCE_REPORT_PATH=/repo/deploy/data/operations/performance-report.json" \
  "$test_container" sh -c '
    database_user=$(sed -n "s/^POSTGRES_USER=//p" /run/config/dev.env)
    [ -n "$database_user" ]
    test_password=$(tr -d "\n" </run/secrets/test_pg_password)
    export TEST_DATABASE_URL="host=postgres port=5432 dbname=dev_toolbox_m5_performance_test user=$database_user password=$test_password sslmode=disable"
    unset database_user test_password
    go test -tags=integration ./integration -run TestM5FixedScalePerformance -count=1 -timeout 60m -v
  '

test -s "$report_file"
if [ "${M5_PERF_SKIP_REBUILD:-0}" = 1 ]; then
  printf '%s\n' "固定规模性能诊断完成（未执行索引重建，不作为正式验收）；报告：$report_file"
else
  printf '%s\n' "固定规模性能验收通过；报告：$report_file"
fi
