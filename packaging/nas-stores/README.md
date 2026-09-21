# NAS and home-server app stores (Synology, TrueNAS, CasaOS/ZimaOS, Umbrel)

All four need the **Docker image published to a public registry first** (recommended: GHCR, design in `../ghcr/README.md`). Until then, the only route is the "build it yourself" instructions already in
`desktop/apps/desktop/docker/README.md`. Facts about the image used below come from that folder (`Dockerfile`, `docker-compose.yml`, `README.md`): port TCP 47811, `/config`, `/media/{movies,tv,music,photos}`,
`PUID`/`PGID`, `/dev/dri`, non-root by default, and admin pages that only work over HTTPS.

| Store | What it needs | Readiness | Files here |
| --- | --- | --- | --- |
| **CasaOS / ZimaOS AppStore** (IceWhale) | A compose file with an `x-casaos` block, icon, screenshots, published image. Own store (any static host) or a PR to the official store. | Draft manifest written; straightforward. | `casaos/` |
| **Umbrel** | `umbrel-app.yml` + `docker-compose.yml` with `app_proxy`, image pinned by digest, PR to the official store or your own community store. | Draft written, **but has a blocking technical problem** (below). | `umbrel/` |
| **TrueNAS SCALE Apps** | A Jinja-templated app (`app.yaml`, `questions.yaml`, compose template, tests) in `truenas/apps`, community train. | Checklist only (not straightforward; needs their dev tooling). | below |
| **Synology** | No store for Docker apps. Container Manager runs a compose project; a native `.spk` package is the only "store" route. | Documentation exists (docker README); nothing to submit. | below |

## CasaOS / ZimaOS (draft manifest written)

`casaos/Apps/Beebo/docker-compose.yml` follows the store protocol v2 from the store's own docs
(https://github.com/IceWhaleTech/CasaOS-AppStore/tree/main/docs, read 2026-09-21: `Apps/<Name>/docker-compose.yml` with a top-level `x-casaos` block: `id`, `main`, `index`, `port_map`, `icon`, `title`, `category` required),
and `casaos/store-config.json` is the store identity file for your own store. The compose file is valid YAML and has every required `x-casaos` field; it was **not** run through `docker compose config -q` or the store's `build_dist.sh` (no Docker on the machine this was prepared on).

Two ways to ship it:
1. **Your own store (no review).** Make a GitHub repository with `Apps/Beebo/` (plus `icon.svg`/`thumbnail.png`/`screenshot-1.png`), `store-config.json` and `supported-languages.json`, build it with the official action
   (`IceWhaleTech/build-appstore-action`) or `scripts/build_dist.sh`, publish the generated `dist/` on GitHub Pages. Users add the store URL in CasaOS/ZimaOS. See docs/quick-start/overview.md in the store repo.
2. **The official store.** Fork https://github.com/IceWhaleTech/CasaOS-AppStore, add `Apps/Beebo/`, run `./scripts/build_dist.sh`, open a pull request explaining "new app", what changed and how you validated it (their `CONTRIBUTING.md`).
   Their CI validates the compose file. Review time is not published (**unverified**).

To do first: publish the image, replace the placeholder `image`, `icon` URL (a public PNG/SVG) and add screenshots. The `network_mode: bridge` + `user: "0"` + `PUID/PGID` choices follow the image's README; `/dev/dri` is commented out on purpose (a missing device stops the container).

## Umbrel (draft written, blocked by HTTPS)

`umbrel/beebo-entertainment/` has `umbrel-app.yml` (manifestVersion 1.1, modelled on the official Jellyfin app in https://github.com/getumbrel/umbrel-apps) and `docker-compose.yml` (`app_proxy` pointing at port 47811, config volume, downloads folder read-only).

**Blockers before this is worth submitting:**

1. Umbrel's `app_proxy` talks plain HTTP to the app. In `electron/streamServer.js` the plain-HTTP side redirects (`308`) requests that name a real host to `https` (LAN-IP, loopback and Tailscale hosts and requests carrying
   `X-Forwarded-Proto: https` are exempt, around line 16550), and the admin API deliberately ignores `X-Forwarded-Proto` and refuses any request that did not arrive on the TLS socket (comment at the admin gate around line 7510:
   "There is no reverse proxy in front of this server"). So behind Umbrel's proxy the web viewer may work depending on the Host header and forwarded headers Umbrel sends, but **the admin pages, and probably the first-run owner setup
   (`/setup`, which the headless server prints as an `https://` address), cannot work through it**. Fix options: a setting that trusts a proxy for admin (does not exist today), or expose port 47811 directly and tell users to open
   `https://<umbrel-ip>:47811`. Not tested (no Umbrel here).
2. The compose file must pin the image by digest (`image: ...@sha256:<digest>`), which only exists after the image is published.
3. The `folderAccess` mount layout is a guess: Beebo expects `/media/movies`, `/media/tv` ...; the draft mounts the Umbrel Downloads folder at `/media/downloads` and sets `BEEBO_MOVIES_DIRS=/media/downloads`.
4. Gallery images (`gallery`), an icon and the app store's artwork rules (see the `umbrel-package-app` skill in the umbrel-apps repository's `.claude/skills/`, which is where Umbrel now documents packaging) are not prepared.

Submission if you go ahead: fork https://github.com/getumbrel/umbrel-apps, add `beebo-entertainment/` with these files plus `icon.svg` and gallery images, and open a PR; Umbrel reviews and tests apps on umbrelOS
(review time not published, **unverified**). Alternatively publish your own community store (same folder layout with the store id as prefix).

## TrueNAS SCALE Apps (checklist, not written)

TrueNAS Apps is a Docker-Compose-based catalog (https://github.com/truenas/apps; its `CONTRIBUTIONS.md`, read 2026-09-21). An app is `ix-dev/community/<app>/` with `app.yaml` (metadata), `questions.yaml` (the UI form),
`templates/docker-compose.yaml` (Jinja2) and `templates/test_values/*.yaml`; the repository's `zz.py` and `devbox` tooling render and test it. Checklist:

- [ ] Published, public image with a fixed tag (`ghcr.io/swgfan/beebo-server:<version>`).
- [ ] Clone `truenas/apps`, set up the dev environment (`devbox`), copy a similar media app (for example Jellyfin's folder in `ix-dev/community/`) as the template.
- [ ] `app.yaml`: title, description, home URL, screenshots, icon, categories (media), run-as user `568:568`, port 47811.
- [ ] `questions.yaml`: config storage (ix volume or host path for `/config`), media host paths, `BEEBO_TMDB_API_KEY`, optional GPU passthrough (`/dev/dri`), port.
- [ ] Add `test_values`, run their render/test script, fix lint.
- [ ] PR in the format of their template (app info, license, upstream link, testing, icon and screenshot links). Only `ix-dev/` and `library/` may change. Review: TrueNAS staff; time not published (**unverified**).
- [ ] Do not expect the same HTTPS-behind-proxy problem: TrueNAS exposes the container port directly, so `https://<truenas>:47811` works; make the app's web-portal entry HTTPS.
- Meanwhile, users can already run it as a **Custom App** using the values in `docker/README.md` (image, user 568, port 47811, host paths, `BEEBO_UPNP=0`).

## Synology (no store to submit to)

Synology has no third-party Docker app store. The options are: (1) the compose project in the docker README (Container Manager, DSM 7.2+), already documented there with the `user: "1026:100"` hint;
(2) a native `.spk` package, which is a separate packaging job (SPK is a tar with `INFO`, scripts and the app, listed in Package Center only if Synology or a community source such as SynoCommunity accepts it) and is not attempted here.
Recommended: a "Run Beebo on Synology" page on the website that links the image and shows the compose file. Nothing to submit.

## Other stores worth knowing (not started)

Portainer templates, Runtipi, Cosmos Cloud and Yunohost all take an app definition file plus a published image. Same prerequisite as above; skip until the image exists and one store is proven.
