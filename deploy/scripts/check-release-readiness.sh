#!/bin/sh
set -eu

. "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/lib.sh"

require_command jq
validate_basic_production_env

version=$(env_value APP_VERSION "$DEPLOY_ENV_FILE")
domain=$(env_value APP_DOMAIN "$DEPLOY_ENV_FILE")
edge_mode=$(production_edge_mode)
release_file=${RELEASE_STATUS_FILE:-"$deploy_dir/release-status.v1.json"}
performance_file=${PERFORMANCE_REPORT_FILE:-"$deploy_dir/data/operations/performance-report.json"}
recovery_file=${RECOVERY_REPORT_FILE:-"$deploy_dir/data/operations/recovery-test-report.json"}
https_file=${HTTPS_REPORT_FILE:-"$production_data_root/operations/https-status.json"}

DEPLOY_ENV_FILE="$DEPLOY_ENV_FILE" RELEASE_STATUS_FILE="$release_file" RELEASE_STATUS_VALIDATE_ONLY=1 \
  "$script_dir/publish-release-status.sh" >/dev/null

for evidence_file in "$performance_file" "$recovery_file" "$https_file"; do
  [ -f "$evidence_file" ] && [ ! -L "$evidence_file" ] || fail "缺少可信发布证据：$evidence_file"
done

if ! jq -e '
  (.checks | length == 8) and
  (.checks | all(.status == "passed" and .checkedAt != null))
' "$release_file" >/dev/null; then
  jq -r '.checks[] | select(.status != "passed") | "未通过：\(.label)（\(.status)）— \(.summary)"' "$release_file" >&2
  fail "发布状态仍有未通过门禁"
fi

jq -e '
  .reportVersion == 1 and .passed == true and .containsUserContent == false and
  .fixture.items == 50000 and .fixture.rawRecords == 50000 and
  .fixture.searchFragments == 500000 and .fixture.attachmentApparentBytes == 21474836480 and
  .measurements.search.p95Ms <= .thresholds.searchP95Ms and
  .measurements.textSave.p95Ms <= .thresholds.textSaveP95Ms
' "$performance_file" >/dev/null || fail "固定规模性能报告未通过或数据规模不完整：$performance_file"

jq -e --arg version "$version" '
  .reportVersion == 1 and .state == "succeeded" and .productionShape == true and
  .encryptedResticSnapshot == true and .backupFailureRestartVerified == true and
  .emptyRootAndDatabase == true and .restartPersistenceVerified == true and
  .workerIsolationVerified == true and .databaseFailureSanitized == true and
  .runtimeLogRedactionVerified == true and .containsUserContent == false and
  .samples.state == "succeeded" and .samples.textRecordsVerified >= 20 and
  .samples.originalImagesVerified >= 5 and .samples.ordinaryFilesVerified >= 5 and
  .samples.referencedAttachments == .samples.verifiedAttachments and
  .samples.authenticationVerified == true and .samples.organizationVerified == true and
  .samples.trashVerified == true and .samples.aiVersionsVerified == true and
  .restore.state == "succeeded" and .restore.appVersion == $version and
  .restore.failurePoint == null and .restore.containsUserContent == false
' "$recovery_file" >/dev/null || fail "生产形态空机恢复报告未通过或版本不一致：$recovery_file"

if [ "$edge_mode" = external_nginx ]; then
  expected_udp_ports='[]'
else
  expected_udp_ports='[443]'
fi

jq -e --arg domain "$domain" --arg edgeMode "$edge_mode" --argjson expectedUdpPorts "$expected_udp_ports" '
  .version == 1 and .state == "succeeded" and .domain == $domain and
  .edgeMode == $edgeMode and .httpRedirect == true and .httpsReady == true and .securityHeaders == true and
  .exposedTcpPorts == [80, 443] and .exposedUdpPorts == $expectedUdpPorts
' "$https_file" >/dev/null || fail "正式域名 HTTPS 报告未通过或域名不一致：$https_file"

DEPLOY_ENV_FILE="$DEPLOY_ENV_FILE" "$script_dir/check-deploy.sh" >/dev/null

printf '%s\n' "开发百宝箱发布门禁全部通过：${domain}；版本 ${version}"
