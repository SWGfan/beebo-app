# Trip sharing: a private link for a finished trip

Written 2026-09-21 (Eastern). Nothing here is deployed, pushed or published. Not legal advice; items
marked LAWYER need one.

A person finishes a trip in the Beebo phone app ("We're home"), taps **Share a private link**, and gets
an address they can send to someone with no Beebo account (a grandparent on a tablet). The page shows
the trip as a big-text timeline with photos and clips. It is **served from the sender's own PC**.
Beebo hosts nothing.

## 1. The owner's decisions, and how they are built

| Decision | What was built |
|---|---|
| "Should the Trip Journal ever let a grandparent open a link with the song in it? Have the user decide." | The sender decides per link. **Add a song** is OFF by default. When on, the sender picks a file from their own phone, must tick the rights confirmation, and the link starts at 2 days (any length can still be chosen). |
| "Should Beebo never host trip media? Let the user decide." | The user chooses where the link lives. The only working choice is **their own computer**. **Beebo-hosted** is a visible but disabled stub (`ShareHosting.BEEBO_HOSTED`, `available = false`), with a test that fails if it is ever enabled or referenced from any other code. It needs a lawyer before it can exist (Beebo would become a controller of family and children's media: takedown, child-safety and privacy duties). |

## 2. Privacy model

| Promise | Enforced by | Tested in |
|---|---|---|
| Link is unguessable: 32 random bytes (256 bit), base64url, from `crypto.randomBytes` | `tripShares.js createShare` | `trip-shares.test.js` (entropy, uniqueness, source) |
| The PC never stores a working link, only its SHA-256, so a copy of the data folder cannot be turned into links | `tripShares.js` (`tokenHash`) | index and share files are searched for every token |
| Expires (default 30 days, sender chooses, owner caps; song links default 2 days) | `createShare`, `resolve` re-checks on **every request** | expiry, cap, extend-only-while-live |
| Revocable at any time, from the phone or the PC; effective on the next request | `revoke`, `removeShare`, `deleteTrip` | revoked and unknown links give the same 404 page |
| Unknown, expired and revoked look identical (no oracle) | `tripShareApi.handlePublic` | byte-for-byte compared |
| View-only: GET and HEAD only, no form, no input, no script, no comments | `handlePublic`, page has no `<script>` and CSP `default-src 'none'` | 405 on every other method; CSP and markup checks |
| No directory listing, no path traversal | Only `/trip/<43 chars>` and `/trip/<token>/m/<n>` exist. `<n>` indexes that share's own media list; files are found by SHA-256 in a folder the server chose. No client text is ever used in a path. | 25 hostile paths |
| Rate limited | Per viewer address: 20 failed lookups per 10 minutes (then even a correct link is refused from that address), 600 requests per minute overall. Bounded table. Uses the host agent's vouched viewer address when the request came through the tunnel. | limiter unit test and HTTP tests |
| Text is escaped, the page runs no code | `tripSharePage.js`: every string escaped (`& < > " ' \``), controls and bidi overrides stripped, lengths capped, unknown fields dropped. CSP forbids scripts. | XSS payloads in titles, captions, stories, lines, places, song title |
| Location off by default | See section 5 | tests below |
| No third-party requests | No fonts, scripts, images, trackers; `Referrer-Policy: no-referrer`, `Cache-Control: no-store` on pages, `X-Robots-Tag: noindex`, `<meta robots>`, `/robots.txt` disallows everything | markup and header tests |
| No copyrighted music ships or uploads | Beebo supplies no audio for links. A song is only the sender's own file, only for links they create, served only by a link made with "include song" | song tests |

## 3. Data flow

```
 Phone (Beebo app)                          Sender's PC (Beebo desktop / headless)             Viewer (any browser)
 -----------------                          --------------------------------------             --------------------
 "Share a private link"
   1. GET  /api/trip-shares/status  ------> limits, storage used/cap, address reach
   2. photos redrawn small, no Exif;
      clips copied, GPS atom blanked;
      song hashed (not copied)
   3. POST /api/trip-shares/check   ------> which hashes it already has
   4. begin / chunk (512 KB, own SHA-256) / finish
      resumable, whole-file SHA-256  ----> stored in <userData>/trip-shares/media/<trip>/<sha256>
                                            type sniffed from bytes; MP4 location blanked
   5. POST /api/trip-shares (manifest,
      options)                       ----> sanitised page data saved; token made; only its hash kept
      <---- link  https://<name>.beebo.tv/trip/<token>
   sender sends the link (share sheet)                                                        GET /trip/<token>
                                                                                              <--- page (no script)
                                                                                              GET /trip/<token>/m/3 ---> media (photos with
                                                                                                  metadata stripped, unless the link allows location)
```

Same authenticated channel as phone photo backup (bearer token, direct at home, peer-to-peer tunnel
away), same chunk protocol. The phone reuses `PhotoUploader` with trip wording (`TripShareLogic.stepFor`).

Who may create links: the owner, and household members the owner allowed to **back up their phone** (Photos
> Who can use Photos). A library-share guest from another household never can. Everyone manages only their
own links; the owner sees and can turn off all.

## 4. What the page shows

Large text (`clamp(20px, 2.3vw, 24px)`), light and dark, one column, days as headings with a timeline of:
setting off, games and winners, stories, scavenger-hunt finds, badges, packing, photos and clips, home
again. Photos use the browser's own `loading="lazy"`, clips `preload="none"`, so nothing heavy loads until
scrolled to. No map, no comments, no reactions, no download or share buttons. Footer: "Made with Beebo".
Guests read as "a friend" unless the sender ticked their name. The recap statistics are the trip's own.

## 5. Options per link

- **Include places** (default OFF). Adds only the scavenger-hunt places the sender chose to save on the trip.
  With it off the server drops `places` even if the phone sent them, and photos are served with every
  metadata segment removed (JPEG APPn/COM, PNG eXIf/text chunks). If a file is so malformed that stripping
  cannot be verified, nothing is served. **Photos never carry GPS from the Android app in any case**:
  every photo is redrawn from pixels, and the app could not read the original's GPS without the
  `ACCESS_MEDIA_LOCATION` permission, which is deliberately not requested. Video location atoms are blanked
  on the phone before sending and again on arrival, always. Clips with iPhone-style keyed location
  metadata are refused rather than sent with a location.
- **Add a song** (default OFF). See section 1. The page says the song is played from the sender's own file and
  asks viewers not to pass it on. A viewer can still save the file (a web page cannot stop that), which is why the sender is asked to confirm the rights and the default is short.
- **How long**: 1, 2, 7, 30 or 90 days, capped by the owner's setting.
- **View only**: always; shown as a fixed line, not a switch.
- **Names**: guests hidden by default.
- **Send only on Wi-Fi** (default ON), because clips are sent as they are, not downsized.

## 6. Storage and limits (owner-editable, PC > Photos > Trip links)

Defaults: 10 GB total for trips, 25 MB per photo (the phone sends photos redrawn to at most 1600 px, typically well under 1 MB), 500 MB per clip, 40 MB song,
400 files per trip, 50 live links, links up to 90 days. Checked before any byte is sent, on the phone
(`TripShareLogic.plan`: last files are left out, never the first, the song first) and on the PC (413 / 507).
A link's files are deleted when it is revoked, expires or is deleted, unless another live link for the same
trip needs them; unused uploads are dropped after a day; ended link records are kept 30 days so the owner can
see them, then removed. **Delete trip** removes every link, file and half-finished upload for that trip.

The owner can switch trip links off for the whole PC: every link answers "not available" and phones cannot
send trips.

## 7. Owner controls

PC: a **Trip links** card in Photos > Settings (`src/components/TripShares.jsx`): on/off, storage bar and
limit, longest link, list of links (status, end, views, what is included) with Extend 7 days / Turn off /
Delete, and the stored trips with size and Delete trip. Phone: **Share a private link** screen: create,
copy, send, +7 days, turn off, delete, delete the trip from the computer. The full link is kept only on the
phone, in encrypted storage, and forgotten on sign-out.

## 8. Address reach

The link's address is built from what the server is configured as (`<name>.beebo.tv`, else the configured
domain, else the LAN address), **never from the request's Host header**. The phone is told when it is a LAN-only
address ("works on your home Wi-Fi only") before it makes a link. The link is dead whenever the PC is off,
and away-from-home viewing through Beebo's relay uses the owner's metered relay bandwidth (`relayMeter.js`).

## 9. API (signed-in phone or PC window)

`GET /api/trip-shares/status`, `POST .../settings` (owner), `POST .../check`, `POST .../media/begin`,
`PUT .../media/chunk?uploadId=&offset=` (+ `X-Chunk-Sha256`), `GET .../media/status`, `POST .../media/finish`,
`GET|POST /api/trip-shares` (list / create), `GET .../trips`, `POST .../revoke`, `.../extend`, `.../delete`,
`.../trip/delete`. Public: `GET /trip/<token>`, `GET /trip/<token>/m/<n>`, `GET /robots.txt`.

## 10. Store and legal notes

- The Play answer that says library sharing has "no link anyone can open" stays true for *library* sharing.
  Trip links are a second feature and the answers must cover both; `LIBRARY-SHARING-POLICY.md` now points here.
  LAWYER: wording of the terms addendum and the Play data-safety and UGC answers (the data stays on the
  sender's own PC; Beebo receives nothing).
- The trip screens are styled for adults, like the rest of the Trip Journal (a guard test checks no child
  wording in the strings). Minors' faces in shared photos are the sender's own family content on the
  sender's own computer; LAWYER on whether that needs any consent language.
- The song: personal-use position and whether a song option should exist at all is the plan's open LAWYER item.
  The build lets the sender decide, with the confirmation, a short default, and no Beebo-supplied music.
- The Amazon build links no Google Play services: the new code adds no dependency and no permission
  (`TripSharePrivacyGuardTest`).

## 11. What needs real devices or real infrastructure (not verified here)

Unit and HTTP tests run everywhere; these did not and need a phone, a PC and a second device:

1. Photo picker grants surviving until upload; the document picker for the song (`OpenDocument`) and its persistable grant.
2. Bitmap decode and redraw on low-memory phones; EXIF orientation of real camera photos (the maths is tested, the decoder is not).
3. Copying a 500 MB clip into the cache (free-space check), blanking its location, and the send taking several minutes.
4. WorkManager: the 8-minute slices, retry backoff, `Wi-Fi only` constraint, killing the app mid-send and resuming.
5. The peer-to-peer tunnel's small-body fallback with trip uploads (reuses the photo-backup code, unproven for trips).
6. **A viewer's browser reaching `https://<name>.beebo.tv/trip/<token>` through the Worker and host agent.** The plan's
   "Worker/service pass-through check" is still open: it is not known whether the Worker lets an unauthenticated
   browser reach a path outside `/api`, or how the away-from-home licence gate (`remote_requires_plan`) treats
   viewers of a relayed link. Test with a tablet on mobile data.
7. Tablet and TV browsers: text size, video playback of phone-made MP4s, lazy loading, dark mode.
8. Range seeking of clips and audio in Safari/iPad.

## 12. Deferred, and decisions still needed

Deferred (not built): a PIN on a link (the plan wants one for song links; off by default elsewhere), a QR code for
the link, downsizing clips on the phone (Media3), adding the phase-2 MP4 video to a link, view counts by day,
Beebo-hosted links (stub only, by decision), per-viewer names, iOS.

Decisions for the owner: see the final report of the change that added this file; the short list is
(1) PIN on song links, (2) who may create links (owner plus phone-backup members, as built), (3) default caps
(10 GB, 30 days, 90-day maximum), (4) the Worker/relay behaviour in item 6 above and who pays for relayed views,
(5) site-wide `robots.txt` that disallows everything, (6) terms wording (LAWYER).

## 13. Where things are

Desktop `desktop/apps/desktop/electron/`: `tripShares.js` (storage, links, uploads), `tripShareApi.js` (HTTP, rate
limits), `tripSharePage.js` (sanitiser, page), `tripShareMedia.js` (type sniffing, metadata stripping),
`tripSharesIpc.js`, `src/components/TripShares.jsx`; wired in `streamServer.js`, `main.js`, `preload.js`.
Tests: `test/trip-shares.test.js`.
Android `apps/core/app/src/main/java/com/beeboentertainment/movie/tripshare/`: models, manifest builder,
logic, transfer, client, store, media prep, worker, screen. Tests in the matching `src/test` folder.
