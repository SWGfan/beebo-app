' ============================================================================
' PairingContract.brs - the wire format of the Beebo "tvpair" device-code
' sign-in. This is the ONLY file that knows it.
'
' Source of truth: worker/tvPair.js (merged; RFC 8628 shaped). Verified against
' that file, not assumed. Summary of what the Worker does:
'
'   POST {baseUrl}/tvpair/start  { device_name?, device_model? }
'     -> 200 { device_code (43 url-safe chars, secret), user_code "ABCD-EFGH",
'              verification_uri (default https://beebo.tv/tv),
'              verification_uri_complete (uri + "?code=ABCD-EFGH"),
'              expires_in (<=600), interval (5) }
'     404 when the feature is switched off (BEEBO_TVPAIR_ENABLED != "1")
'     429 when this address started too many sessions (8 / 15 min)
'
'   POST {baseUrl}/tvpair/poll   { device_code }
'     -> 200 { status: "pending", interval }
'        200 { status: "approved", name, token, iceServers, expiresAt }   (ONCE)
'        200 { status: "denied"|"expired", error }
'        429 { status: "slow_down", interval } + Retry-After
'
' IMPORTANT (see README "Top risks"): `token` is the 12-hour Beebo *viewer*
' token for the house `name` -- the credential the phone app uses to open a
' WebRTC tunnel to the house. It is NOT accepted by the home server's HTTP API
' (/api/* wants the token /api/login or /api/remote-session returns, and
' /api/remote-session only trusts a request that arrived through the host
' agent's tunnel). A Roku has no WebRTC, so today it can use pairing to LEARN
' THE HOUSE NAME (=> the direct address <name>.home.beebo.tv:47811) but it
' cannot turn the viewer token into a home-server session by itself.
' `tokenExchange` below records that (nothing reads it yet). Once the desktop server grows
' a route that accepts a Worker viewer token over plain HTTPS, PairView.finishApproved is
' the place to call it and store the resulting home-server token.
' ============================================================================

function pairContract() as object
  return {
    baseUrl: "https://beebo.tv"
    startPath: "/tvpair/start"
    pollPath: "/tvpair/poll"
    exchangePath: "/api/remote-session"
    tokenExchange: false
    defaultIntervalSec: 5
    minIntervalSec: 2
    maxIntervalSec: 30
    slowDownStepSec: 5
    defaultExpiresSec: 600
    deviceCodeLength: 43
  }
end function

' Body of POST /tvpair/start (both fields optional on the server, 40 chars max).
function pairStartBody(deviceName as dynamic, deviceModel as dynamic) as object
  body = CreateObject("roAssociativeArray")
  body.SetModeCaseSensitive()
  if fmtStr(deviceName, "") <> "" then body["device_name"] = Left(deviceName, 40)
  if fmtStr(deviceModel, "") <> "" then body["device_model"] = Left(deviceModel, 40)
  return body
end function

function pairPollBody(deviceCode as string) as object
  body = CreateObject("roAssociativeArray")
  body.SetModeCaseSensitive()
  body["device_code"] = deviceCode
  return body
end function

function pairIsDeviceCode(s as string) as boolean
  if Len(s) <> pairContract().deviceCodeLength then return false
  for i = 1 to Len(s)
    c = Asc(Mid(s, i, 1))
    ok = (c >= 48 and c <= 57) or (c >= 65 and c <= 90) or (c >= 97 and c <= 122) or c = 45 or c = 95
    if not ok then return false
  end for
  return true
end function

' Normalise a /tvpair/start answer. Returns
'   { ok, deviceCode, userCode, verificationUri, expiresIn, interval, error }
function pairParseStart(json as dynamic) as object
  c = pairContract()
  out = { ok: false, deviceCode: "", userCode: "", verificationUri: "", expiresIn: c.defaultExpiresSec, interval: c.defaultIntervalSec, error: "bad_response" }
  if json = invalid then return out
  if type(json) <> "roAssociativeArray" then return out
  dc = fmtStr(json.device_code, "")
  uc = fmtStr(json.user_code, "")
  if not pairIsDeviceCode(dc) or uc = "" then return out
  out.deviceCode = dc
  out.userCode = UCase(uc)
  out.verificationUri = pairDisplayUri(fmtStr(json.verification_uri, ""))
  exp = fmtInt(json.expires_in, c.defaultExpiresSec)
  if exp < 30 then exp = c.defaultExpiresSec
  if exp > 3600 then exp = 3600
  out.expiresIn = exp
  out.interval = pairClampInterval(fmtInt(json.interval, c.defaultIntervalSec))
  out.ok = true
  out.error = ""
  return out
end function

function pairClampInterval(iv as integer) as integer
  c = pairContract()
  if iv < c.minIntervalSec then return c.minIntervalSec
  if iv > c.maxIntervalSec then return c.maxIntervalSec
  return iv
end function

' Show a URL the way a person would type it: drop "https://" and a trailing "/".
function pairDisplayUri(uri as string) as string
  s = uri.trim()
  if LCase(Left(s, 8)) = "https://" then s = Mid(s, 9)
  if LCase(Left(s, 7)) = "http://" then s = Mid(s, 8)
  while Right(s, 1) = "/"
    s = Left(s, Len(s) - 1)
  end while
  return s
end function

' Normalise a /tvpair/poll answer (httpStatus is what the HTTP layer saw).
' Returns { status, token, name, interval, reason }
'   status: "pending" | "slow_down" | "expired" | "denied" | "approved" | "error"
'   interval: server-suggested seconds (0 = none)
'   reason: server error code on denied/expired ("no_home", "password_reset_required", ...)
function pairParsePoll(json as dynamic, httpStatus as integer) as object
  out = { status: "error", token: "", name: "", interval: 0, reason: "" }
  if json <> invalid and type(json) = "roAssociativeArray" then
    out.interval = fmtInt(json.interval, 0)
    out.reason = fmtStr(json.error, "")
  end if
  if httpStatus = 429 then
    out.status = "slow_down"
    return out
  end if
  if json = invalid then return out
  if type(json) <> "roAssociativeArray" then return out
  st = LCase(fmtStr(json.status, ""))
  if st = "approved" then
    tk = fmtStr(json.token, "")
    if tk = "" then return out ' approved without a token is a contract violation
    out.status = "approved"
    out.token = tk
    out.name = LCase(fmtStr(json.name, ""))
    return out
  end if
  if st = "pending" or st = "slow_down" or st = "expired" or st = "denied" then out.status = st
  return out
end function

' Friendly text for a "denied" reason from the poll answer.
function pairDeniedText(reason as string) as string
  if reason = "no_home" then return "That Beebo account has no Beebo home set up on a computer yet."
  if reason = "password_reset_required" then return "Reset your Beebo password on the website first, then try again."
  return "The sign-in was declined on your phone."
end function
