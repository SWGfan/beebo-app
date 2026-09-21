# Publishing the Docker image to GHCR (design and inactive workflow)

Status: **designed, deliberately not active.** `publish-image.yml.example` is a complete workflow, but it sits outside `.github/workflows/`, so nothing runs and nothing can be pushed until you move it. `headless-docker.yml`
is untouched and still "never pushes an image".

Why GHCR (`ghcr.io/swgfan/beebo-server`): the workflow's own `GITHUB_TOKEN` can push (no Docker Hub account or stored secret), no Docker Hub anonymous pull limits for your users, and the release, package and CI live in one place.
Unraid Community Applications, TrueNAS, CasaOS and Umbrel all accept GHCR images.

## What the workflow does

1. Trigger: a pushed tag `Beebo-<version>` (the same tag style as the Windows releases) or a manual run with a version.
2. Checks the version string is digits and dots only (it becomes an image tag).
3. Builds the amd64 image without pushing, starts it, and waits for `/api/ping` = 200. (The deep smoke test stays in `headless-docker.yml`; tag only a commit where that is green.)
4. Logs in to `ghcr.io` with `GITHUB_TOKEN`, builds `linux/amd64,linux/arm64` (QEMU for arm64) and pushes `:<version>` and `:latest`, with an attestation (provenance) for the digest.
5. Writes the digest into the run summary: the Umbrel store needs `image: ...@sha256:<digest>`.

## Before you turn it on (owner)

1. **Decide the licence question.** The image contains the proprietary Beebo server. A public image is redistribution: your terms must allow it. Otherwise keep the package private (private GHCR packages cannot be pulled by store users).
2. Copy the file: `.github/workflows/publish-image.yml`.
3. **Make the repository that owns the package public or link it.** `SWGfan/JenkinsAPP` is private; a package published from it inherits that visibility and is private. Options: publish from the public `SWGfan/beebotv` repository (copy the
   workflow there and its build inputs), or publish from here and set the package visibility to Public by hand once (GitHub > your profile > Packages > `beebo-server` > Package settings > Change visibility). Either way it is a one-time manual step; the workflow cannot do it.
4. **Actions must be able to run** on the repository.
5. Run it once by hand with `latest` unchecked, then `docker pull ghcr.io/swgfan/beebo-server:<version>` from a machine that is not logged in to GitHub to prove it is public.
6. Put the resulting digest into the Umbrel compose file and the version tag into the Unraid/CasaOS/TrueNAS files.

## Not verified

The workflow was never run (no Actions available, and it must not be run without your decision). It was checked for YAML syntax only. `actions/attest-build-provenance@v2` and the `provenance: mode=max` option are from general
knowledge of the Docker and GitHub actions at the time of writing; check their current major versions when you activate it.
