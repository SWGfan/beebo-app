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

# One Gradle invocation per flavor, NOT one invocation for all of them. Given several
# flavors at once, the Kotlin Gradle plugin starts every compile<Flavor>DebugKotlin task
# in the same Kotlin daemon at the same time; apps/core (600+ Kotlin files, Compose) then
# ran that daemon out of heap ("GC overhead limit exceeded", "Not enough memory to run
# compilation") and all three compiles failed. One flavor at a time is the same work as a
# developer's own build, and Gradle's own outputs are shared between the runs.
# The Kotlin daemon also gets 4 GB here instead of gradle.properties' 3 GB: the runner has
# 16 GB, and a clean CI build has no incremental state to lean on.
echo "Running one flavor at a time: ${tasks[*]/#/:app:}"
failed=()
for task in "${tasks[@]}"; do
  echo "::group::gradle :app:$task"
  if ! ./gradlew --console=plain --continue -Pkotlin.daemon.jvmargs=-Xmx4g ":app:$task"; then
    failed+=("$task")
  fi
  echo "::endgroup::"
done
if [ "${#failed[@]}" -gt 0 ]; then
  echo "::error::failed: ${failed[*]}"
  exit 1
fi
