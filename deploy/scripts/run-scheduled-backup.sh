#!/bin/sh
set -u

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
lock_file=/run/lock/dev-toolbox-backup.lock
output_file=$(mktemp /tmp/dev-toolbox-scheduled-backup.XXXXXX) || exit 1

cleanup() {
  rm -f "$output_file"
}
trap cleanup EXIT HUP INT TERM

set +e
/usr/bin/flock -n "$lock_file" "$script_dir/backup.sh" >"$output_file" 2>&1
exit_code=$?
set -e

if [ -s "$output_file" ]; then
  /usr/bin/logger -t dev-toolbox-backup -f "$output_file" || true
fi

exit "$exit_code"
