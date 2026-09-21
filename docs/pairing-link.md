# Pairing link (`beebo://pair`)

The QR code Beebo shows on the computer (Get Started, the connection test, Settings) carries a
pairing link, so a phone can fill in the sign-in screen without typing an address.

```
beebo://pair?server=<host:port>&name=<house name>
```

| Field    | Required | Meaning |
|----------|----------|---------|
| `server` | yes      | The computer's address on the home network, `192.168.1.20:47811`. Percent-encoding is accepted (`%3A` for `:`, `%5B`/`%5D` for IPv6 brackets). |
| `name`   | no       | The `<name>` of `<name>.beebo.tv`, lowercase letters, digits and hyphens. Present once the computer has a beebo.tv address. |

Unknown fields are ignored, so the format can grow. Field names are case-insensitive; the scheme and
`pair` host are too.

## What a phone does with it

* It **only pre-fills** the sign-in screen (Home, and the address tried first on the home Wi-Fi). It
  never signs in, stores anything or sends anything. The person still types their own username and
  password.
* Home becomes `name` when there is one (so the same sign-in works away from home), otherwise the
  `server` address.
* The address is classified by the phone, not by anything the link says: a private address
  (10/8, 172.16/12, 192.168/16, link-local, 100.64/10, IPv6 fc00::/7 and fe80::/10) or a `.local` /
  `.lan` / one-word name is a **home network**; `<name>.beebo.tv` is **beebo.tv**; everything else is
  **other**, and the phone asks the person to confirm before using it, because a QR code can be printed
  by anyone and the person will type their password for whatever it points to.

## Strict parsing (phone: `core/PairLink.kt`, tests in `PairLinkTest`)

A link is refused, with a plain message, when it: is longer than 300 characters; contains whitespace
or control characters; repeats `server` or `name`; has a `server` with a scheme other than
`http://` / `https://`, a path, query, fragment, user info (`@`), backslash or a `%` left after
decoding; has a port outside 1 to 65535; has a malformed IPv4/IPv6 address or host name (empty or
hyphen-edged labels, `_`, `999.1.1.1`); uses bad percent-escapes or non-UTF-8 bytes; or has a `name`
that is not a valid house name. `beebo://pairing`, `beebo://pair.evil.com` and other look-alikes are
not pairing links.

## Older addresses still work

Older Beebo versions showed a plain `http://192.168.1.20:47811` in the QR code. The phone app accepts
that too (scanned, or a bare `192.168.1.20:47811` pasted from the clipboard, or
`https://<name>.beebo.tv`), and the computer still prints the plain address under the code for typing
or for a phone or browser without the app.

## Where it is handled

* Desktop builds it: `desktop/apps/desktop/src/lib/pairLink.js` (`buildPairLink`, `pairFromAddress`).
* Phone, cold and warm start: `apps/core` `MainActivity` hands the intent data to `PairRequests`; the
  manifest registers `beebo://pair` on `MainActivity`. The sign-in screen (`SetupScreen`) consumes it.
  A link nobody picks up (the app is already signed in) expires after ten minutes.
* Phone, in-app scanning: Google Play build uses Google's code scanner (no camera permission); the
  website build uses CameraX with ZXing (camera permission declared in `src/web` only). Both, and
  "Paste a link instead", end in the same parser.
