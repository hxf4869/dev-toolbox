#!/bin/sh
set -eu

. "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/lib.sh"

require_command jq

source_file=${RELEASE_STATUS_FILE:-"$deploy_dir/release-status.v1.json"}
operations_dir="$production_data_root/operations"
target_file="$operations_dir/release-status.json"

[ -f "$source_file" ] && [ ! -L "$source_file" ] || fail "缺少可信发布状态清单：$source_file"

jq -e '
  def clean_text($maximum):
    type == "string" and length <= $maximum and test("[[:cntrl:]]") == false;
  def timestamp_or_null:
    . == null or (type == "string" and fromdateiso8601 > 0);
  (keys | sort) == ["candidateVersion", "checks", "generatedAt"] and
  (.candidateVersion | clean_text(80) and length > 0) and
  (.generatedAt | type == "string" and fromdateiso8601 > 0) and
  (.checks | length == 8) and
  ([.checks[].id] | sort) == [
    "ai_policy", "auth_security", "backup_restore", "browser_accessibility",
    "data_integrity", "deployment_security", "performance", "search_privacy"
  ] and
  (.checks | all(
    (keys | sort) == ["checkedAt", "id", "label", "status", "summary"] and
    (.id | clean_text(80) and length > 0) and
    (.label | clean_text(80) and length > 0) and
    (.summary | clean_text(240) and length > 0) and
    (.status == "not_run" or .status == "passed" or .status == "review" or .status == "blocked") and
    (.checkedAt | timestamp_or_null) and
    (if .status == "not_run" then true else .checkedAt != null end)
  )) and
  ([.checks[] | {id, label}] | sort_by(.id)) == ([
    {"id":"ai_policy","label":"AI 策略与版本"},
    {"id":"auth_security","label":"认证与安全会话"},
    {"id":"backup_restore","label":"备份与灾难恢复"},
    {"id":"browser_accessibility","label":"浏览器与可访问性"},
    {"id":"data_integrity","label":"原始数据与附件"},
    {"id":"deployment_security","label":"生产部署与依赖"},
    {"id":"performance","label":"目标主机性能"},
    {"id":"search_privacy","label":"搜索与隐私脱敏"}
  ] | sort_by(.id))
' "$source_file" >/dev/null || fail "发布状态清单格式或固定门禁集合无效：$source_file"

if [ "${RELEASE_STATUS_SKIP_VERSION_CHECK:-0}" != "1" ] && [ -f "$DEPLOY_ENV_FILE" ]; then
  configured_version=$(env_value APP_VERSION "$DEPLOY_ENV_FILE")
  manifest_version=$(jq -r '.candidateVersion' "$source_file")
  [ "$manifest_version" = "$configured_version" ] || fail "发布状态版本 $manifest_version 与部署版本 $configured_version 不一致"
fi

if [ "${RELEASE_STATUS_VALIDATE_ONLY:-0}" = "1" ]; then
  printf '%s\n' "发布状态清单校验通过：$source_file"
  exit 0
fi

mkdir -p "$operations_dir"
[ ! -L "$operations_dir" ] || fail "运维状态目录不能是符号链接：$operations_dir"
target_tmp=$(mktemp "$operations_dir/.release-status.XXXXXX")
trap 'rm -f "$target_tmp"' EXIT HUP INT TERM
jq '.' "$source_file" >"$target_tmp"
chmod 644 "$target_tmp"
mv "$target_tmp" "$target_file"
trap - EXIT HUP INT TERM

printf '%s\n' "发布状态已写入只读运维页：$target_file"
