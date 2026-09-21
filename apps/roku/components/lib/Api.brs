' ============================================================================
' Api.brs - talk to the Beebo home server from a component.
'
' Include this in any component that makes requests (BeeboView already does).
' Each request runs in its own HttpTask (a Task node = a background thread),
' so the UI never blocks. Usage:
'
'   apiInit()                                   ' once, in init()
'   apiGet("/api/continue", { transform: "continue" }, onContinue, ctx)
'   apiPost("/api/watch-session", body, {}, onSession, ctx)
'   sub onContinue(resp as object, ctx as dynamic)
'     if resp.ok then ... resp.data ... else ... resp.message ...
'   end sub
'
' resp = { ok, status, data, code, message, errorKind }
'   data       parsed (and transformed) JSON on success
'   code       the server's "error" string, e.g. "bad_credentials"
'   errorKind  "" | "network" | "timeout" | "http" | "blocked"
'
' The server origin and bearer token live in m.global (set by BeeboScene);
' they are attached here and never logged.
' ============================================================================

sub apiInit()
  m.apiSeq = 0
  m.apiPending = {}
end sub

' spec keys (all optional): transform, timeoutMs, auth (default true), url (absolute
' override, e.g. the pairing service), raw (skip JSON parse/transform), bearer (an explicit one-off
' credential for auth:false calls: the pairing viewer token for POST /api/viewer-session. It is sent
' only in the Authorization header, a 401 for it is NOT "the saved sign-in was rejected", and the
' HttpTask refuses it over plain http off the home network)
function apiSend(method as string, path as string, body as dynamic, spec as object, callback as function, context = invalid as dynamic) as string
  base = m.global.server
  url = ""
  if fmtStr(spec.url, "") <> "" then
    url = spec.url
  else
    url = urlAbsolute(base, path)
  end if
  useAuth = true
  if spec.auth <> invalid then useAuth = spec.auth
  req = {
    url: url
    method: method
    body: ""
    timeoutMs: 15000
    transform: ""
    token: ""
    raw: false
  }
  if body <> invalid then
    ' a body that is already a JSON string (POST /api/playback/negotiate splices the device profile in) is sent as it is
    if type(body) = "roString" or type(body) = "String" then
      req.body = body
    else
      req.body = FormatJson(body)
    end if
  end if
  if spec.timeoutMs <> invalid then req.timeoutMs = spec.timeoutMs
  if spec.transform <> invalid then req.transform = spec.transform
  if spec.raw <> invalid then req.raw = spec.raw
  ' The bearer token only ever goes to the home server, never to another host.
  explicit = false
  if useAuth and Left(url, Len(base)) = base and base <> "" then
    req.token = m.global.token
  else if not useAuth and fmtStr(spec.bearer, "") <> "" then
    req.token = spec.bearer
    explicit = true
  end if

  m.apiSeq = m.apiSeq + 1
  id = "api" + Str(m.apiSeq).trim()
  task = CreateObject("roSGNode", "HttpTask")
  task.id = id
  task.observeField("response", "apiOnResponse")
  m.apiPending[id] = { task: task, callback: callback, context: context, authed: req.token <> "" and not explicit }
  task.request = req
  task.control = "RUN"
  return id
end function

function apiGet(path as string, spec as object, callback as function, context = invalid as dynamic) as string
  return apiSend("GET", path, invalid, spec, callback, context)
end function

function apiPost(path as string, body as dynamic, spec as object, callback as function, context = invalid as dynamic) as string
  return apiSend("POST", path, body, spec, callback, context)
end function

' Observer for every HttpTask this component started.
sub apiOnResponse(event as object)
  node = event.getRoSGNode()
  id = node.id
  entry = m.apiPending[id]
  if entry = invalid then return ' cancelled while in flight
  m.apiPending.delete(id)
  resp = event.getData()
  if resp = invalid then resp = { ok: false, status: 0, data: invalid, code: "", message: "", errorKind: "network" }
  ' A rejected token anywhere means "sign in again": tell the scene once.
  if resp.status = 401 and entry.authed then m.global.authFailures = m.global.authFailures + 1
  cb = entry.callback
  cb(resp, entry.context)
end sub

' Stop caring about everything in flight (leaving a screen).
sub apiCancelAll()
  if m.apiPending = invalid then return
  for each id in m.apiPending
    entry = m.apiPending[id]
    if entry.task <> invalid then
      entry.task.unobserveField("response")
      entry.task.control = "STOP"
    end if
  end for
  m.apiPending = {}
end sub
