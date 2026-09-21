#!/usr/bin/env bash
# Android debug unit tests for CI. Run from an app root (apps/core or apps/auto).
#
# Runs the debug unit-test task of EVERY product flavor: testDebugUnitTest when the
# app has no flavors, or testPlayDebugUnitTest, testWebDebugUnitTest, ... when it
# does. Tasks are discovered from Gradle, so adding or renaming flavors needs no
# change here.
set -euo pipefail

mapfile -t tasks < <(
  ./gradlew --console=plain -q :app:tasks --all \
    | grep -oE '^test[A-Za-z0-9]*DebugUnitTest\b' | sort -u
)

if [ "${#tasks[@]}" -eq 0 ]; then
  echo "::error::no test*DebugUnitTest task found in :app"
  exit 1
fi

echo "Running: ${tasks[*]/#/:app:}"
./gradlew --console=plain --continue "${tasks[@]/#/:app:}"
