# Unraid Community Applications template

Status: **draft, blocked** until the Docker image is on a public registry. The template is written against the image name `ghcr.io/swgfan/beebo-server:latest` (see `../ghcr/README.md`).

`beebo-entertainment.xml` mirrors what `desktop/apps/desktop/docker/README.md` says for Unraid and the container's real settings (read from `docker/Dockerfile` and `docker/docker-compose.yml`):

| Template entry | Value | Source of truth |
| --- | --- | --- |
| Port | TCP 47811 | `EXPOSE 47811/tcp`, `BEEBO_PORT` |
| Paths | `/config`, `/media/movies`, `/media/tv`, `/media/music`, `/media/photos` | Dockerfile `VOLUME`, README "Folders" |
| PUID / PGID | 99 / 100 (Unraid `nobody:users`) plus `--user 0` in Extra Parameters so the entrypoint applies them | README "Users and permissions" |
| `BEEBO_UPNP=0` | bridge cannot reach the router | README "Networking" |
| `BEEBO_SECRET_KEY`, `BEEBO_TMDB_API_KEY` | masked, optional | README "Secrets" |
| Device `/dev/dri` | optional hardware transcoding (Intel/AMD); NVIDIA via the plugin + `--runtime=nvidia` | README "Hardware transcoding" |
| WebUI | `https://[IP]:[PORT:47811]/` | The admin pages open only over HTTPS (self-signed certificate); first-run `/setup` too |

Not mapped: UDP 47820-47829 (away-from-home video). It needs host networking and is "not in v1" of the headless server per its README. Add it if that changes.

Verification done: the XML is well-formed and every `Config` element has the attributes the Unraid template schema uses (Name, Target, Default, Mode, Description, Type, Display, Required, Mask), checked against the structure described at https://selfhosters.net/docker/templating/templating/ and
a real template (`selfhosters/unRAID-CA-templates/templates/adminer.xml`). **Not done:** loading it in a real Unraid box (no Unraid available).

## What must exist first

1. The image published, for example `ghcr.io/swgfan/beebo-server` (set the package to public). Until then the template's `Repository` does not resolve.
2. A **public GitHub repository for templates** (for example `SWGfan/unraid-templates`) containing `beebo-entertainment.xml` and a public icon PNG; then fix `TemplateURL` and `Icon` (currently placeholders).
3. An **Unraid forum support thread** (Docker Containers section) whose URL goes in `<Support>`. Community Applications requires a support link.

## Who submits, and how

Owner, with a free account on forums.unraid.net.

1. Do the three items above.
2. Test the template by hand on Unraid: Docker tab, "Add Container", "Template repositories" (bottom of the page), paste the repository URL, then pick Beebo-Entertainment. This also lets your first users install it before Community Applications lists it.
3. Ask for the repository to be added to Community Applications: Community Applications is maintained by Squidly271; the request is made through the Community Applications forum thread / "Application submission" form
   (https://forums.unraid.net/topic/38582-plug-in-community-applications/). Steps per the selfhosters template guide: a dedicated template repository, a support thread, then submit it to the CA moderation queue.
   **The exact current submission page could not be loaded (the Unraid docs URL returned 404), so re-check where to submit before you do.**
4. Review: moderators check the template (working image, sensible defaults, support thread, category) and may ask for edits. Review time not published; **unverified**, plan for days to a couple of weeks.

## Fields to check

- `Category` (`MediaServer:Video MediaServer:Music MediaServer:Photos`; CA has a "Application Categorizer" tool to validate), `Overview`, `Requires`.
- Whether you would rather default the media paths to read-only (`ro`). Uploads and organising need `rw`.
- Whether to default `BEEBO_SECRET_KEY` (Unraid has no secrets store, so it is optional and masked; empty means the server creates a key file in `/config`).
