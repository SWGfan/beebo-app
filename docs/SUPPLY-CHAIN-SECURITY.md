# Supply-chain and repository security

What protects the build, the dependencies and this repository. Related: [SECURITY.md](../SECURITY.md).

## What is in place

| Control | Where | Notes |
|---|---|---|
| Actions pinned to full commit SHAs | every `uses:` in `.github/workflows/*.yml` | A trailing `# vX.Y.Z` names the release. `.github/scripts/verify-action-pins.py` proves each SHA is that tag's commit (annotated tags dereferenced); the **Workflow lint** workflow runs it on every change under `.github/`. |
| Least-privilege tokens | top-level `permissions: contents: read` in every workflow | No job needs more today, so none grants more. The only extra grants are `pull-requests: read` for the secret scan and `security-events: write` for CodeQL. |
| No stored git credentials | `persist-credentials: false` on every checkout | A later step (or a compromised action) cannot reuse the checkout token to push. |
| Untrusted input kept out of shells | matrix values are passed through `env:`; `github.head_ref` appears only in `concurrency.group` (never in `run:`) | No `pull_request_target`, no `workflow_run`, no secrets in any workflow. |
| Time limits and concurrency | `timeout-minutes` on every job, a `concurrency` group on every workflow | Stops runaway jobs and duplicate runs. |
| `npm audit` | separate `npm audit --omit=dev --audit-level=high` steps with `continue-on-error: true` in `ci.yml`, `headless-docker.yml`, `roku-build.yml`, `smarttv-build.yml` | Informational so existing advisories do not turn every build red; tighten once the baseline is clean. |
| npm install-script and freshness policy | `.npmrc` in `desktop/apps/desktop`, its `resources/beebo-rtc-host`, `apps/roku`, `apps/smarttv`, `apps/xbox` | `min-release-age=7`, `audit-level=high`, `strict-allow-scripts=true` plus a reviewed `allow-scripts` list. Needs npm 11.17 or newer (Node 24); older npm ignores these keys. |
| Dependabot | `.github/dependabot.yml` | Weekly, grouped minor/patch PRs, 7-day cooldown, PR limits, for npm, GitHub Actions, Docker, Gradle (`apps/core`, `apps/auto`) and Swift (`apps/apple`). Electron, electron-builder and vite major bumps are left for a deliberate upgrade. |
| Secret scanning | `secret-scan.yml` + `.gitleaks.toml` | gitleaks on the commits each pull request or push to `main` adds. Real provider keys are never allowlisted, even in tests. |
| Code scanning | `codeql.yml` | CodeQL for JavaScript/TypeScript and Java/Kotlin, on pull requests, pushes and weekly. |
| Dependency review | `dependency-review.yml` | Fails a pull request that adds a dependency with a known high or critical vulnerability. |
| SBOMs | `sbom.yml` (manual, and on release) | CycloneDX 1.6 JSON for the desktop app, its rtc-host, and the smart-TV, Roku and Xbox clients as workflow artifacts. |
| Workflow lint | `workflow-lint.yml` | pin verification and actionlint. |
| Ownership and review prompts | `.github/CODEOWNERS`, `.github/PULL_REQUEST_TEMPLATE.md` | Sensitive paths listed separately; the PR template has a security checklist. |
| Disclosure | `SECURITY.md` | Private reporting by email (and GitHub private vulnerability reporting if enabled). |

### The npm script policy in one paragraph

npm 11.17 added an `allowScripts` policy. With `strict-allow-scripts=true`, a dependency whose
`install`/`postinstall` script is not on the approved list makes `npm install` and `npm ci` fail
instead of running it, which blunts postinstall-worm style attacks. Install scripts approved in the desktop app: only `fsevents` (macOS-only). Electron 42+ and esbuild need no install script, and `electron-winstaller` (a Squirrel.Windows helper Beebo does not ship) is denied. If a
future dependency update adds or changes a script, the install fails with a message naming the package:
review the script, then approve it (`npm approve-scripts <pkg>`, or add it to `allow-scripts` in the
`.npmrc`). The `headless-docker.yml` test job stays on Node 22 (npm 10), which ignores these keys, so nothing
there gets weaker or stricter. The Docker image build already uses `npm ci --omit=dev --ignore-scripts`.

## Recommended repository settings (for the maintainers)

- Settings > Code security: enable **Dependency graph**, **Dependabot alerts**, **Dependabot security
  updates**, **Secret scanning** and **Push protection**, and **Private vulnerability reporting**. Leave
  CodeQL "default setup" off (the `codeql.yml` workflow is the configuration).
- Branch protection or a ruleset on `main`: require the **CI OK** check, require a pull request, block force
  pushes and deletion, and require code-owner review once there is a second reviewer.
- Settings > Actions > General: tick **Require actions to be pinned to a full-length commit SHA** and keep
  "Workflow permissions" on read-only.
- If the repository lives in a GitHub **organization**, `gitleaks-action` needs a (free) `GITLEAKS_LICENSE`
  secret; personal accounts do not.
- Optional: build provenance attestations for release artifacts (`actions/attest-build-provenance`); the
  exact permissions are in the commented steps of `linux-build.yml` and `headless-docker.yml`.

## Working with the pins

- Update: let Dependabot do it, or resolve a tag with
  `git ls-remote --tags https://github.com/<owner>/<repo> "refs/tags/<tag>*"` (use the `^{}` line when the
  tag is annotated) and put `@<sha> # <tag>` in the workflow.
- Verify: `python .github/scripts/verify-action-pins.py` (needs network; `--offline` only checks the format).
- `mac-build.yml` builds ffmpeg from source on every run; to cache it, add an `actions/cache` step pinned to a
  full commit SHA the same way.
- New workflow? Start from the top of `ci.yml`: `permissions: contents: read`, a `concurrency` group,
  `timeout-minutes`, `persist-credentials: false`, no untrusted `${{ }}` inside `run:`.
