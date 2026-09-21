#!/usr/bin/env python3
"""Check that every third-party GitHub Action is pinned to a full commit SHA, and that the SHA
really is the commit of the tag named in the trailing "# vX.Y.Z" comment.

    python3 .github/scripts/verify-action-pins.py            # checks .github/workflows and .github/actions
    python3 .github/scripts/verify-action-pins.py --offline  # only check the SHA + comment format

Why: a tag can be moved to malicious code (the tj-actions/changed-files incident, March 2025);
a full commit SHA cannot. The comment lets a human (and Dependabot) see which release it is, and
this script proves the comment is not lying (a SHA pasted next to the wrong tag).

Exit status 0 = all good, 1 = a problem. Uses only `git ls-remote` on public repos: no token.
"""
import glob
import re
import subprocess
import sys

USES = re.compile(r"^\s*(?:-\s*)?uses:\s*(?P<ref>\S+)(?P<rest>.*)$")
SHA = re.compile(r"^[0-9a-f]{40}$")
COMMENT_TAG = re.compile(r"#\s*(?P<tag>v?\d+(?:\.\d+){0,2}\S*)")


def resolve(repo, tag, cache):
    key = (repo, tag)
    if key in cache:
        return cache[key]
    out = subprocess.run(
        ["git", "ls-remote", "--tags", "https://github.com/" + repo, "refs/tags/" + tag, "refs/tags/" + tag + "^{}"],
        capture_output=True, text=True, timeout=60)
    refs = {}
    for line in out.stdout.splitlines():
        sha, ref = line.split()
        refs[ref] = sha
    # Annotated tags list the tag object AND the commit ("^{}"); the commit is what a workflow pins.
    cache[key] = refs.get("refs/tags/%s^{}" % tag) or refs.get("refs/tags/%s" % tag)
    return cache[key]


def main():
    offline = "--offline" in sys.argv
    files = sorted(glob.glob(".github/workflows/*.y*ml") + glob.glob(".github/actions/**/action.y*ml", recursive=True))
    problems, checked, cache = [], 0, {}
    for path in files:
        with open(path, encoding="utf-8") as fh:
            for n, line in enumerate(fh, 1):
                if line.lstrip().startswith("#"):
                    continue
                m = USES.match(line)
                if not m:
                    continue
                ref = m.group("ref")
                if ref.startswith("./") or ref.startswith("docker://"):
                    # local actions are in this repo; docker:// must carry @sha256:<digest>
                    if ref.startswith("docker://") and "@sha256:" not in ref:
                        problems.append("%s:%d docker action not pinned by digest: %s" % (path, n, ref))
                    continue
                if "@" not in ref:
                    problems.append("%s:%d no version at all: %s" % (path, n, ref))
                    continue
                name, _, version = ref.partition("@")
                repo = "/".join(name.split("/")[:2])
                checked += 1
                if not SHA.match(version):
                    problems.append("%s:%d not pinned to a full commit SHA: %s" % (path, n, ref))
                    continue
                c = COMMENT_TAG.search(m.group("rest"))
                if not c:
                    problems.append("%s:%d missing trailing '# vX.Y.Z' comment: %s" % (path, n, ref))
                    continue
                if offline:
                    continue
                tag = c.group("tag")
                real = resolve(repo, tag, cache)
                if real is None:
                    problems.append("%s:%d tag %s not found in %s" % (path, n, tag, repo))
                elif real != version:
                    problems.append("%s:%d %s@%s is NOT the commit of %s (that tag is %s)" % (path, n, name, version[:12], tag, real[:12]))
    print("checked %d action reference(s) in %d file(s)" % (checked, len(files)))
    for p in problems:
        print("PROBLEM: " + p)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
