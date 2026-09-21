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
' WHAT "APPROVED" GIVES A TV, AND HOW THE ROKU FINISHES SIGNING IN:
'   `token` is the 12-hour Beebo *viewer* token for the house `name` (the credential the
'   phone app uses to open a WebRTC tunnel). The home server's plain /api/* does not accept it
'   directly, so the Roku trades it ONCE for a normal API session, exactly as apps/smarttv and
'   apps/apple do (docs: desktop/apps/desktop/docs/VIEWER-EXCHANGE.md):
'
'   POST {server}/api/viewer-session   Authorization: Bearer <viewer token>   { "deviceName": "Den Roku" }
'     -> 200 { ok, token (30-day API token), user {id,name,isAdmin,...}, expiresAt, server {name} }
'        401 { error: "unauthorized" }  every reason a token is refused looks the same
'        403 { error }  https_required | viewer_exchange_disabled | no_remote_access | household_pass |
'                       guest_not_supported | admin_requires_password | private_profile_sign_in |
'                       two_factor_sign_in | two_factor_setup_required
'        402 { error: "remote_requires_plan" }   429 { error: "locked" } + Retry-After   404 older server
'
'   Rules this file (and PairView) keep:
'     * the viewer token goes ONLY in the Authorization header, never in a body, URL or log;
'     * it is sent only over https, or over plain http to a private LAN address (pairSafeExchangeUrl);
'     * it is used once, then discarded (never stored in the registry, never kept in the state machine);
'     * a 401 means "pair again", not "retry" (ten wrong tokens in 15 minutes lock the address out);
'     * anything but 200 falls back to typing a username and password (POST /api/login);
'     * the returned API token is kept exactly like an /api/login token (registry, never logged).
' ============================================================================

function pairContract() as object
  return {
    baseUrl: "https://beebo.tv"
    startPath: "/tvpair/start"
    pollPath: "/tvpair/poll"
    exchangePath: "/api/viewer-session"
    tokenExchange: true
    tokenMaxLen: 4096
    deviceNameMax: 40
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

' ---- viewer-token -> API-session exchange (POST /api/viewer-session) ---------------------

' A house name is one DNS label (worker/ddns.js name rules): a-z 0-9 and inner hyphens, 1..63.
function pairIsHouseName(name as dynamic) as boolean
  if not fmtIsString(name) then return false
  n = Len(name)
  if n < 1 or n > 63 then return false
  for i = 1 to n
    c = Asc(Mid(name, i, 1))
    isAlnum = (c >= 48 and c <= 57) or (c >= 97 and c <= 122)
    if not isAlnum then
      if not (c = 45 and i > 1 and i < n) then return false
    end if
  end for
  return true
end function

' The viewer token may only travel over https, or plain http to a private LAN address (the
' desktop server accepts the exchange over plain http from the home network only).
function pairSafeExchangeUrl(serverUrl as dynamic) as boolean
  if not fmtIsString(serverUrl) then return false
  if serverUrl = "" then return false
  return urlIsAllowed(serverUrl)
end function

' A viewer token is a compact "header.payload.signature" string: no spaces, sane length.
function pairIsViewerToken(token as dynamic) as boolean
  if not fmtIsString(token) then return false
  if token = "" or Len(token) > pairContract().tokenMaxLen then return false
  for i = 1 to Len(token)
    if Asc(Mid(token, i, 1)) < 33 then return false
  end for
  return true
end function

' Body of POST /api/viewer-session: only the device name (40 chars shown to the owner), never the token.
function pairExchangeBody(deviceName as dynamic) as object
  body = CreateObject("roAssociativeArray")
  body.SetModeCaseSensitive()
  n = fmtStr(deviceName, "").trim()
  if n <> "" then body["deviceName"] = Left(n, pairContract().deviceNameMax)
  return body
end function

' Classify the answer of POST /api/viewer-session. httpStatus 0 = no answer at all.
' Returns { status, token, userName, serverName, code }
'   status: "signed_in" | "unsupported" (404) | "rejected" (401) | "not_allowed" (403) |
'           "plan_required" (402) | "rate_limited" (429) | "bad_response" | "unreachable"
'   code:   the server's error string for 402 / 403 (see pairExchangeText)
' A result NEVER contains the viewer token; on "signed_in" `token` is the new API token.
function pairClassifyExchange(httpStatus as integer, json as dynamic) as object
  out = { status: "unreachable", token: "", userName: "", serverName: "", code: "" }
  isObj = json <> invalid and type(json) = "roAssociativeArray"
  if isObj then out.code = fmtStr(json.error, "")
  if httpStatus = 200 then
    out.status = "bad_response"
    if not isObj then return out
    tk = fmtStr(json.token, "")
    if not pairIsViewerToken(tk) then return out
    out.status = "signed_in"
    out.token = tk
    out.code = ""
    if json.user <> invalid and type(json.user) = "roAssociativeArray" then out.userName = Left(fmtStr(json.user.name, "").trim(), 60)
    if json.server <> invalid and type(json.server) = "roAssociativeArray" then out.serverName = Left(fmtStr(json.server.name, "").trim(), 60)
    return out
  end if
  if httpStatus = 404 then
    out.status = "unsupported"
  else if httpStatus = 401 then
    out.status = "rejected"
  else if httpStatus = 403 then
    out.status = "not_allowed"
  else if httpStatus = 402 then
    out.status = "plan_required"
  else if httpStatus = 429 then
    out.status = "rate_limited"
  end if
  return out
end function

' Plain words for the sign-in screen when the exchange did not give a session. Every text
' ends by pointing at the username + password sign-in, which always works.
function pairExchangeText(r as object) as string
  tail = " Sign in with your username and password instead."
  st = r.status
  code = r.code
  if st = "unsupported" then return "Your Beebo computer is running an older version that can't sign in a TV with a phone code." + tail
  if st = "rejected" then return "Your phone approved this Roku, but your Beebo computer wouldn't accept it (the code may have expired, or it belongs to a different Beebo home)." + tail
  if st = "plan_required" then return "Watching away from home through Beebo's relay needs an active plan on this account. At home, use your home network address." + tail
  if st = "rate_limited" then return "Too many attempts from this network. Wait a few minutes." + tail
  if st = "not_allowed" then
    if code = "two_factor_sign_in" or code = "two_factor_setup_required" then return "This account uses two-factor sign-in, which a Roku can't type." + tail
    if code = "private_profile_sign_in" then return "This is a private profile, so it has to be opened with its own username and password." + tail
    if code = "admin_requires_password" then return "This person is an administrator. Administrators sign in with their password." + tail
    if code = "no_remote_access" then return "This person doesn't have away-from-home access on this Beebo computer." + tail
    if code = "household_pass" or code = "guest_not_supported" then return "That approval was for the shared household or a guest, not a person's own account." + tail
    if code = "viewer_exchange_disabled" then return "The owner has switched off phone-code sign-in for TVs in Beebo's settings." + tail
    if code = "https_required" then return "Away from home a TV needs the secure (https) address." + tail
    return "Your Beebo computer didn't allow a phone-code sign-in for this Roku." + tail
  end if
  if st = "bad_response" then return "Your Beebo computer sent something this Roku didn't understand." + tail
  return "Couldn't reach your Beebo computer to finish signing in." + tail
end function
