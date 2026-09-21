' HttpTask - one HTTP request on a background thread. See lib/Api.brs for the caller side.

sub init()
  m.top.functionName = "doRequest"
end sub

sub doRequest()
  m.top.response = httpExecute(m.top.request)
end sub

function httpFail(kind as string, status as integer, code as string, message as string) as object
  return { ok: false, status: status, data: invalid, code: code, message: message, errorKind: kind }
end function

function httpExecute(req as object) as object
  url = fmtStr(req.url, "")
  ' Last line of defence: https always, plain http only to a LAN host.
  if not urlIsAllowed(url) then
    return httpFail("blocked", 0, "blocked", "That address isn't allowed. Use a secure (https) address, or your home network.")
  end if

  xfer = CreateObject("roUrlTransfer")
  port = CreateObject("roMessagePort")
  xfer.SetMessagePort(port)
  xfer.SetUrl(url)
  if Left(LCase(url), 8) = "https://" then
    xfer.SetCertificatesFile("common:/certs/ca-bundle.crt")
    xfer.InitClientCertificates()
    xfer.EnablePeerVerification(true)
    xfer.EnableHostVerification(true)
  end if
  xfer.EnableEncodings(true)
  xfer.RetainBodyOnError(true)
  xfer.AddHeader("Accept", "application/json")
  if fmtStr(req.token, "") <> "" then xfer.AddHeader("Authorization", "Bearer " + req.token)

  method = UCase(fmtStr(req.method, "GET"))
  started = false
  if method = "POST" then
    xfer.AddHeader("Content-Type", "application/json")
    xfer.SetRequest("POST")
    body = fmtStr(req.body, "")
    if body = "" then body = "{}"
    started = xfer.AsyncPostFromString(body)
  else
    started = xfer.AsyncGetToString()
  end if
  if not started then return httpFail("network", 0, "", "")

  timeoutMs = fmtInt(req.timeoutMs, 15000)
  msg = wait(timeoutMs, port)
  if msg = invalid then
    xfer.AsyncCancel()
    return httpFail("timeout", 0, "", "")
  end if
  if type(msg) <> "roUrlEvent" then return httpFail("network", 0, "", "")

  status = msg.GetResponseCode()
  text = msg.GetString()
  if status <= 0 then return httpFail("network", 0, "", fmtStr(msg.GetFailureReason(), ""))

  raw = fmtIsTrue(req.raw)
  data = invalid
  if not raw and text <> invalid and text <> "" then data = ParseJson(text)

  code = ""
  message = ""
  if data <> invalid and type(data) = "roAssociativeArray" then
    code = fmtStr(data.error, "")
    message = fmtStr(data.message, "")
  end if

  if status >= 200 and status < 300 then
    if not raw and data = invalid and status <> 204 then return httpFail("http", status, "bad_json", "")
    tf = fmtStr(req.transform, "")
    if tf <> "" and data <> invalid then data = modelTransform(tf, data)
    return { ok: true, status: status, data: data, code: "", message: "", errorKind: "" }
  end if

  ' Not 2xx. Keep a small parsed body (the server explains itself in JSON), never a big one.
  out = httpFail("http", status, code, message)
  if data <> invalid and type(data) = "roAssociativeArray" then out.data = data
  return out
end function
