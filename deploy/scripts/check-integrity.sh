#!/bin/sh
set -eu

. "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/lib.sh"

require_command jq
validate_basic_production_env

operations_dir="$production_data_root/operations"
mkdir -p "$operations_dir"
report_tmp=$(mktemp "$operations_dir/.integrity-report.XXXXXX")

set +e
production_compose exec -T api /app/dev-toolbox maintenance check-integrity --json >"$report_tmp"
check_exit=$?
set -e
chmod 644 "$report_tmp"
mv "$report_tmp" "$operations_dir/integrity-report.json"

jq -e '.version == 1 and (.orphanAttachments | type == "array") and (.issues | type == "array")' "$operations_dir/integrity-report.json" >/dev/null || fail "完整性报告格式无效"
if [ "$check_exit" -ne 0 ]; then
  printf '%s\n' "附件完整性检查发现阻塞项；报告已保留且未删除任何文件" >&2
  exit "$check_exit"
fi

referenced=$(jq -r '.referencedAttachments' "$operations_dir/integrity-report.json")
orphans=$(jq -r '.orphanAttachments | length' "$operations_dir/integrity-report.json")
printf '%s\n' "附件完整性通过：引用 ${referenced}；孤儿 ${orphans}（只报告，不删除）"
