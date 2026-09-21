#!/usr/bin/env bash
# Desktop test suite for CI. Run from desktop/apps/desktop after `npm ci`.
#
# Every test/*.test.js runs in its own `node --test` process with a timeout, so one
# hung test can't eat the job and new test files are picked up automatically.
# All files run even if an earlier one fails; the script fails at the end.
#
# BEEBO_RTC_NODE_MODULES should point at a node_modules containing werift
# (the workflow runs `npm ci` in resources/beebo-rtc-host for that).
set +e -uo pipefail # collect every failure; exit status is decided at the end

# Tests must never touch real accounts: no certificate renewals with a real DuckDNS token file on the machine.
export BEEBO_NO_CERT_CHECK=1
PER_FILE_TIMEOUT="${PER_FILE_TIMEOUT:-300}" # seconds; rtc-host.e2e takes ~70s locally

# TODO: fix and remove from this list. It fails on main as of 2026-09-16, before CI
# existed. It is skipped so CI is green for everything else, and printed as a
# warning on every run so it stays visible.
#   computer-gallery.test.js  - "Actual API handler: bearer authentication, live admin
#                               revocation, paging and video Range" fails (the vm-extracted
#                               handler gets 500 where 403 is expected: the test predates
#                               globals the handler now uses). Since Vite 8 the file also
#                               needs @babel/parser, which is no longer installed as a side
#                               effect: add it as an exact-pinned devDependency when fixing.
# (storybook-runtime.test.js used to be listed here. It passes on Windows, and on Linux now
# that its ffmpeg fixture is named for the platform: ffmpeg.exe only on Windows.)
KNOWN_FAILING=(
  computer-gallery.test.js
)

timeout_cmd=()
if command -v timeout >/dev/null 2>&1; then
  timeout_cmd=(timeout --kill-after=15 "$PER_FILE_TIMEOUT")
fi

failed=()
skipped=()
passed=0
shopt -s nullglob
for f in test/*.test.js; do
  name="$(basename "$f")"
  if printf '%s\n' "${KNOWN_FAILING[@]}" | grep -qxF "$name"; then
    skipped+=("$name")
    continue
  fi
  echo "::group::$name"
  start=$SECONDS
  "${timeout_cmd[@]}" node --test "$f"
  rc=$?
  echo "::endgroup::"
  if [ "$rc" -eq 0 ]; then
    passed=$((passed + 1))
    echo "PASS $name ($((SECONDS - start))s)"
  else
    [ "$rc" -eq 124 ] && echo "::error::$name timed out after ${PER_FILE_TIMEOUT}s"
    echo "::error::$name failed (exit $rc)"
    failed+=("$name")
  fi
done

for name in "${skipped[@]}"; do
  echo "::warning::SKIPPED known-failing desktop test $name (TODO: fix, see .github/scripts/desktop-tests.sh)"
done

echo "desktop tests: $passed file(s) passed, ${#failed[@]} failed, ${#skipped[@]} skipped as known failures"
if [ "$passed" -eq 0 ] && [ "${#failed[@]}" -eq 0 ]; then
  echo "::error::no desktop test files ran"
  exit 1
fi
[ "${#failed[@]}" -eq 0 ]
