## What and why

<!-- One or two sentences. Link the issue or plan doc if there is one. -->

## How it was tested

<!-- Commands run, suites passed (CI OK), manual checks, screenshots. -->

## Security checklist

Tick each line or write "n/a" and why. Do not paste secrets or real user data anywhere in this PR.

- [ ] No secrets, tokens, keys, `.env` files, keystores or real user data added (gitleaks CI is green)
- [ ] Every new HTTP route or IPC handler checks who is calling (auth, owner check, sender validation) or is deliberately public and listed as such
- [ ] Untrusted input (query, body, headers, file names, device names, poster ids) is validated and escaped/encoded where it is used (HTML, SQL, paths, shell, ffmpeg arguments)
- [ ] File, network and subprocess access stays inside what the feature needs (no path traversal, no SSRF, no shell string building)
- [ ] Cookies and tokens keep `Secure`/`HttpOnly`/`SameSite`; cookie-authenticated POSTs keep the cross-site check
- [ ] Logs and errors do not contain passwords, tokens, licence keys or full emails
- [ ] New or updated dependencies were reviewed (why needed, maintainer, install scripts); lockfile committed; no `npm audit` regression at high or critical
- [ ] Workflow changes: actions pinned to a full commit SHA, `permissions:` as narrow as possible, no untrusted `${{ }}` (branch names, PR titles) used directly in `run:`
- [ ] Changes to auth, licensing, the updater or its signature checks (see `.github/CODEOWNERS`) got a second look and a test
- [ ] Privacy: no new data collected or sent off-device, or `docs/` privacy text was updated

## Release impact

- [ ] Needs a desktop/Android version bump and release notes
- [ ] None of the above
