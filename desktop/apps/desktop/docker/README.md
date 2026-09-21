# Beebo server in Docker (headless)

Beebo Entertainment's media server without the desktop window. It runs on Linux
servers, NAS boxes (Synology, QNAP, Unraid, TrueNAS), Raspberry Pi 4/5 (arm64) and
anything else that runs Docker. It is the same server code as the Windows app:
your movies, TV, music and photos, a web viewer, the phone apps and the admin pages.

The image is built from this repository and is not published to any registry yet.

## Quick start

From `desktop/apps/desktop`:

```sh
docker build -f docker/Dockerfile -t beebo-server .

docker run -d --name beebo --restart unless-stopped \
  -p 47811:47811 \
  -e BEEBO_UPNP=0 \
  -e BEEBO_SECRET_KEY="$(openssl rand -hex 32)" \
  -v /srv/beebo/config:/config \
  -v /srv/media/movies:/media/movies \
  -v /srv/media/tv:/media/tv \
  -v /srv/media/music:/media/music \
  -v /srv/media/photos:/media/photos \
  beebo-server
```

Save the `BEEBO_SECRET_KEY` value somewhere safe (see [Secrets](#secrets)); the
data in `/config` cannot be read without it. A compose file that keeps the key in a
Docker secret is in `docker-compose.yml`.

### First run: create the owner account

A new server has no accounts. It prints a one-time setup message to its log:

```sh
docker logs beebo
```

```
[setup] First-run setup: this server has no owner account yet.
[setup]   Open https://192.168.1.20:47811/setup
[setup]   Setup code: 7KQ2-M9XD-4TNB
```

Open that address, accept the browser's certificate warning (Beebo made the
certificate itself), enter the code, and choose the owner username and a password
of 8 or more characters. Setup closes for good as soon as the account exists.
If you miss the message, restart the container for a new code. The code lives only
in the log and in memory; without it nobody can create the owner account.

Then sign in at `https://<server-ip>:47811/`. The admin pages (`/admin`) only open
over HTTPS; the self-signed certificate is created on first start in `/config/certs`.
Phones and TVs on your network can keep using `http://<server-ip>:47811`.

## Folders (volumes)

| Container path | What | Notes |
| --- | --- | --- |
| `/config` | Settings, accounts, watch history, artwork cache, certificates | Back this up. Needs to be writable. |
| `/media/movies` | Movie files | Read-only (`:ro`) is fine for watching. |
| `/media/tv` | TV shows | |
| `/media/music` | Music | |
| `/media/audiobooks` | Audiobooks (.m4b files, or one folder of .mp3/.flac files per book) | |
| `/media/photos` | Photos | |

Uploads from the phone app, the Inbox and "clean up file names" write to the
media folders, so they need write access. To add more folders, list them:
`BEEBO_MOVIES_DIRS=/media/movies,/media/movies-2` (movies, tv, music, photos have
one variable each). The first folder of a list is where uploads go.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `BEEBO_PORT` | `47811` | Port (1024-65535). Changing it changes the address phones use. |
| `BEEBO_BIND_ADDRESS` | `0.0.0.0` | Address to listen on (for example one NIC on a host-network container). |
| `BEEBO_DATA_DIR` | `/config` | Data folder. |
| `BEEBO_MEDIA_ROOT` | `/media` | Parent of `movies`, `tv`, `music`, `audiobooks`, `photos`. |
| `BEEBO_MOVIES_DIRS`, `BEEBO_TV_DIRS`, `BEEBO_MUSIC_DIRS`, `BEEBO_AUDIOBOOKS_DIRS`, `BEEBO_PHOTOS_DIRS` | under `BEEBO_MEDIA_ROOT` | Comma, semicolon or newline separated absolute folders. |
| `BEEBO_INBOX_DIR`, `BEEBO_PHONE_BACKUP_DIR`, `BEEBO_PRIVATE_DIR`, `BEEBO_ARTWORK_DIR` | under `/config` | Other writable folders. |
| `BEEBO_TRANSCODE_DIR` | system temp | Where transcoded video is written. Use a tmpfs or a fast disk. |
| `BEEBO_TMDB_API_KEY` | none | TMDB key for titles, posters and cast. Also read from `TMDB_API_KEY`. |
| `BEEBO_SECRET_KEY` / `BEEBO_SECRET_KEY_FILE` | generated file | Encryption key for saved secrets. |
| `BEEBO_ALLOW_PLAINTEXT_SECRETS` | off | Explicit opt-in to store secrets unencrypted. |
| `BEEBO_UPNP` | `1` | `0` stops it asking the router to open ports. |
| `BEEBO_SELF_SIGNED_TLS` | `1` | `0` stops it creating an HTTPS certificate (the admin pages then do not open). |
| `BEEBO_CERT_DIR` | `/config/certs` | Put your own `cert.pem` and `key.pem` here; they are never replaced. |
| `BEEBO_SEED_SAMPLE` | off | Copy the "Welcome to Beebo" clip into the movies folder once. |
| `BEEBO_LOG_TIMESTAMPS` | off | Prefix every log line with an ISO time (Docker `-t` does this too). |
| `BEEBO_FFMPEG`, `BEEBO_FFPROBE` | bundled | Use a different ffmpeg (for example one with more hardware encoders). |
| `BEEBO_CONFIG_FILE` | `/config/beebo.json` if present | JSON file with the same settings (`port`, `moviesDirs`, ...). Environment variables win. |
| `PUID`, `PGID` | 1000 / 1000 | See below. Only used when the container starts as root. |
| `TZ` | UTC | Time zone. |

A wrong value stops the container with a message that lists every problem
(exit code 78), so a typo does not silently start an empty server.

## Users and permissions (PUID / PGID)

The server never runs as root. The image starts as uid/gid `1000:1000`. Media and
`/config` must be readable (and `/config` writable) by whoever runs it. Two ways:

1. `user:` in compose (or `--user 1026:100` with `docker run`): run as the owner
   of your files. Nothing else needed; make sure the `/config` folder is writable by
   that user.
2. Start as root (`user: "0"` / `--user 0`) and set `PUID` and `PGID`: the entrypoint
   makes `/config` belong to that user and then drops to it before starting Beebo.
   Extra groups (for example `render` for GPUs) go in `group_add`.

Typical values: Synology admin user `1026:100`, Unraid `99:100` (nobody:users),
TrueNAS SCALE `568:568` (apps), QNAP user `1000:100` or the id shown by `id <user>`
over SSH.

## Synology, QNAP, Unraid, TrueNAS

* **Synology (Container Manager, DSM 7.2+):** create the folders in File Station
  (for example `docker/beebo/config` and your existing `video` share). Project ->
  Create -> paste `docker-compose.yml`, change the volume paths and set
  `user: "1026:100"` (find yours with `id` over SSH; group 100 is `users`). Give that
  user read access to the media share (Control Panel -> Shared Folder -> Permissions).
  The image must be built on a machine with Docker and loaded onto the NAS
  (`docker save beebo-server | ssh nas docker load`), or built on the NAS over SSH.
  Port 47811 does not clash with DSM's own ports.
* **QNAP (Container Station):** Applications -> Create -> compose, paste
  `docker-compose.yml`, set the paths (`/share/Multimedia/...`) and a `user:` that owns
  them. Container Station's default network mode is bridge; add `BEEBO_UPNP=0`.
* **Unraid:** Docker tab -> Add Container. Repository: your local image name
  (`beebo-server`). Add Port 47811 (TCP), Paths `/config` -> `/mnt/user/appdata/beebo`,
  `/media/movies` -> `/mnt/user/media/movies` and so on, Variables `PUID=99`,
  `PGID=100`, `BEEBO_SECRET_KEY=...`, `BEEBO_UPNP=0`, and Extra Parameters `--user 0`
  (so `PUID`/`PGID` apply). For an Intel iGPU add Device `/dev/dri`.
* **TrueNAS SCALE:** Apps -> Discover -> Custom App. Image `beebo-server` (tag as
  you built it), run as user `568`, Port 47811, storage: host path
  `/mnt/<pool>/apps/beebo` -> `/config`, your dataset -> `/media/...` (read access for
  user 568 or its group), environment `BEEBO_UPNP=0` and `BEEBO_SECRET_KEY`.

## Hardware transcoding

Video that a device cannot play as it is gets converted on the fly (H.264 HLS).
With no hardware access this is done on the CPU with the bundled ffmpeg's
`libopenh264` encoder. The image's ffmpeg is the same LGPL build family as the
desktop apps, and the server picks the best encoder it can actually open, so
enabling hardware is a matter of giving the container the device. Check what it
chose with `docker logs beebo | grep "live conversion"`.

* **Intel (Quick Sync / VA-API), amd64:** `--device /dev/dri` (compose: `devices:
  - /dev/dri:/dev/dri`) and the group that owns `/dev/dri/renderD128`
  (`--group-add $(stat -c %g /dev/dri/renderD128)`). The image includes the Intel
  media driver, `libva` and the oneVPL runtime for this.
* **AMD (VA-API), amd64:** same `/dev/dri` pass-through; the Mesa VA driver is included.
* **NVIDIA (NVENC):** install the NVIDIA Container Toolkit on the host and add
  `--gpus all` (compose: the `deploy.resources.reservations.devices` block in the
  example). The image sets `NVIDIA_DRIVER_CAPABILITIES=compute,video,utility`.
* **Raspberry Pi (arm64):** software encoding only for now; the Pi 4/5 hardware
  encoder is not exposed through this ffmpeg build.

Honest limits: the bundled ffmpeg is a static LGPL build. Whether it contains a
given hardware encoder is a property of that build, not of Beebo: list what it has
with `docker exec beebo /app/resources/ffmpeg/ffmpeg -hide_banner -encoders | grep -E "vaapi|qsv|nvenc"`.
If your GPU needs a different ffmpeg, mount one and set `BEEBO_FFMPEG` and
`BEEBO_FFPROBE`. Hardware paths could not be tested on real GPUs in CI (the smoke test
runs the software path); tell us what works on your hardware.

## Networking

* **Bridge (default, `docker-compose.yml`):** publish `47811`. Phones on the LAN
  use `http://<nas-ip>:47811`. The router cannot be reached from inside a bridged
  container, so automatic port mapping (UPnP, NAT-PMP) does not work: use
  `BEEBO_UPNP=0` and, if you want access from outside your home, forward the port on
  your router yourself or put Beebo behind a VPN (Tailscale, WireGuard).
* **Host (`docker-compose.host.yml`, Linux hosts):** the container uses the
  machine's network. Router port mapping works like the desktop app, and the setup
  message lists the real LAN addresses. TCP 47811 (server) and UDP 47820-47829
  (away-from-home video) then belong to this container.
* **Reverse proxy:** the admin pages require HTTPS to Beebo itself, so proxy to
  `https://<nas>:47811` (your proxy will need to accept Beebo's certificate, or put your
  own certificate in `/config/certs`). Plain HTTP proxying works for watching.

## Secrets

Password hashes, sign-in signing keys, the TMDB key, webhook secrets and access codes
are encrypted at rest in `/config/config.json` with AES-256-GCM. The key comes from
(first match wins): `BEEBO_SECRET_KEY`, the file named by `BEEBO_SECRET_KEY_FILE`
(Docker/Compose secrets, Kubernetes), or a key file `/config/secret.key` created on
first start with permissions 0600 (it refuses to start if the filesystem cannot keep
that private, for example some SMB/NTFS mounts).

* Keeping the key inside `/config` only protects against `config.json` leaking by
  itself (a backup, a support upload). Anyone with the whole `/config` folder also has
  the key. For real separation use `BEEBO_SECRET_KEY` or a Docker secret and keep the
  key elsewhere.
* Changing or losing the key makes the saved secrets unreadable. Beebo notices at
  start-up and stops with a message instead of signing everyone out silently.
* There is no silent fallback to plain text. If no key can be made the server does not
  start, unless you set `BEEBO_ALLOW_PLAINTEXT_SECRETS=1`, which is logged as a warning
  on every start.
* Log lines pass through a redactor for media tokens, `token=`/`password=` query
  values, bearer tokens and cookies.

## What works headless

| Feature | Status |
| --- | --- |
| Web viewer and phone/TV apps on the LAN | Works (smoke test signs in and streams) |
| Library scan of movies and TV, off the main thread | Works (smoke test) |
| HLS transcoding, software encoder | Works (smoke test fetches a segment) |
| Hardware transcoding (Intel/AMD/NVIDIA) | Available if the device is passed in and the ffmpeg build has the encoder; not tested on hardware |
| Admin pages and API over HTTPS | Works (self-signed, or your own certificate in `/config/certs`) |
| First-run owner account | Works (log code plus `/setup`) |
| TMDB titles, posters, cast, artwork cache | Same code as the desktop; needs `BEEBO_TMDB_API_KEY`; not run in CI |
| Users, access codes, parental controls, history, playlists, webhooks, requests | Same code as the desktop; sign-in and admin API verified |
| Music library, photos, uploads, Inbox, format conversion queue | Started at boot and running; folder-dependent, not exercised by CI |
| Router port mapping (UPnP/NAT-PMP) | Works on host network; not possible on bridge |
| Sign in with a Beebo account, `<name>.beebo.tv`, away-from-home P2P, Beebo Relay wallet | Not in v1: the code is present but there is no sign-in screen. LAN plus your own address only |
| Automatic certificates (DuckDNS, `*.home.beebo.tv`) | Not in v1. Bring your own certificate in `/config/certs` |
| Email verification/reset mail (SMTP), OpenSubtitles account | Not in v1: these are set from the desktop Settings screen only |
| Settings screen (folders, port, keys) | Replaced by environment variables / `beebo.json` |
| Desktop updater | Not used; update by pulling or building a newer image |
| Tray icon, windows, folder pickers, "open in player" | Desktop only |
| BeeboBook story generation, BeeboSchool window, home game server | Not included |

## Without Docker (Linux, Windows, macOS)

The same server runs directly with Node 22 or newer, from a checkout of this repository:

```sh
cd desktop/apps/desktop
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --workspaces=false
(cd resources/beebo-rtc-host && npm ci --omit=dev)      # only for away-from-home, later
export BEEBO_DATA_DIR=/var/lib/beebo BEEBO_MOVIES_DIRS=/srv/media/movies BEEBO_TV_DIRS=/srv/media/tv
export BEEBO_SECRET_KEY="$(openssl rand -hex 32)"
npm run headless                                        # same as: node headless/main.js
```

Put `ffmpeg` and `ffprobe` on `PATH` (or set `BEEBO_FFMPEG` / `BEEBO_FFPROBE`). SIGTERM and
Ctrl+C stop it cleanly, so a systemd unit, launchd job or a Windows service wrapper (NSSM)
works. Logs go to stdout. On a machine that also runs the desktop app, use a different
`BEEBO_DATA_DIR` and `BEEBO_PORT`: two servers must never share one data folder.

## Building and testing

```sh
docker buildx build -f docker/Dockerfile --platform linux/amd64,linux/arm64 -t beebo-server .
node docker/smoke.js --base https://localhost:47811 --log server.log --expect-title "Test Movie"
```

`docker/smoke.js` is what the CI workflow (`.github/workflows/headless-docker.yml`)
runs against a container holding a 5 second generated video: ping, setup code flow,
sign-in, admin API, library scan, HLS playlist and first segment. The workflow builds
and tests only; it never pushes an image.

## Licences

Beebo itself is proprietary. The image bundles FFmpeg (LGPL 2.1 or later, static
build from BtbN/FFmpeg-Builds, with libopenh264), pinned by release and SHA-256 in the
Dockerfile. The licence texts are in `/app/THIRD_PARTY_LICENSES/ffmpeg/` and the FFmpeg
source for the pinned build is available from the same release page
(https://github.com/BtbN/FFmpeg-Builds/releases, tag `autobuild-2026-08-31-13-27`) and
from https://ffmpeg.org/. You may replace the bundled binaries with your own build at
any time (`BEEBO_FFMPEG`). See `THIRD_PARTY_LICENSES/FFMPEG-SETUP.md`.
