' ============================================================================
' Urls.brs - PURE url / address helpers (no Roku-only APIs; unit-tested under
' the brs interpreter, see test/).
'
' Address policy (mirrors the Android app's CleartextPolicy):
'   * https is always allowed.
'   * plain http is allowed ONLY to a local-network host (private IPv4, CGNAT
'     100.64/10, link-local, loopback, .local/.lan/.home/.home.arpa/.internal
'     names, or a single-label name). The home server serves plain http to
'     those clients on port 47811 because no certificate can name a LAN IP.
'   * anything else typed as http:// is upgraded to https://.
' ============================================================================

function urlDefaultPort() as integer
  return 47811
end function

' Split a string on a single-character separator, KEEPING empty parts
' (unlike roString.Tokenize).
function urlSplit(s as string, sep as string) as object
  parts = []
  if s = "" then return parts
  rest = s
  while true
    p = Instr(1, rest, sep)
    if p = 0 then
      parts.push(rest)
      exit while
    end if
    parts.push(Left(rest, p - 1))
    rest = Mid(rest, p + Len(sep))
  end while
  return parts
end function

function urlIsDigits(s as string) as boolean
  if s = "" then return false
  for i = 1 to Len(s)
    c = Asc(Mid(s, i, 1))
    if c < 48 or c > 57 then return false
  end for
  return true
end function

' "192.168.1.5" -> [192,168,1,5], anything else -> invalid
function urlParseIpv4(host as string) as dynamic
  parts = urlSplit(host, ".")
  if parts.count() <> 4 then return invalid
  out = []
  for each p in parts
    if Len(p) < 1 or Len(p) > 3 or not urlIsDigits(p) then return invalid
    n = Val(p)
    if n > 255 then return invalid
    out.push(n)
  end for
  return out
end function

function urlEndsWith(s as string, suffix as string) as boolean
  if Len(s) < Len(suffix) then return false
  return Right(s, Len(suffix)) = suffix
end function

function urlIsPrivateIpv4(a as object) as boolean
  if a[0] = 10 or a[0] = 127 then return true
  if a[0] = 172 and a[1] >= 16 and a[1] <= 31 then return true
  if a[0] = 192 and a[1] = 168 then return true
  if a[0] = 100 and a[1] >= 64 and a[1] <= 127 then return true
  if a[0] = 169 and a[1] = 254 then return true
  return false
end function

' Is this host only reachable on a local network (so plain http is acceptable)?
function urlIsLocalHost(rawHost as dynamic) as boolean
  if rawHost = invalid then return false
  host = LCase(rawHost)
  if Right(host, 1) = "." then host = Left(host, Len(host) - 1)
  if host = "" then return false
  if host = "localhost" or urlEndsWith(host, ".localhost") then return true
  ip = urlParseIpv4(host)
  if ip <> invalid then return urlIsPrivateIpv4(ip)
  if Instr(1, host, ":") > 0 then return false ' IPv6 literals are not supported on this client
  suffixes = [".local", ".lan", ".home", ".home.arpa", ".internal"]
  for each sfx in suffixes
    if urlEndsWith(host, sfx) then return true
  end for
  ' a bare name with no dot cannot be a public internet host
  if Instr(1, host, ".") = 0 then return urlIsHostname(host)
  return false
end function

function urlIsHostname(host as string) as boolean
  if host = "" or Len(host) > 253 then return false
  for i = 1 to Len(host)
    c = Asc(Mid(host, i, 1))
    isAlnum = (c >= 48 and c <= 57) or (c >= 97 and c <= 122)
    if not (isAlnum or c = 45 or c = 46) then return false
  end for
  if Left(host, 1) = "-" or Left(host, 1) = "." then return false
  return true
end function

' Is http:// or https:// with a legal host that this app may talk to?
' (used by the HTTP task as a last line of defence)
function urlIsAllowed(url as dynamic) as boolean
  if url = invalid then return false
  p = urlParse(url)
  if p = invalid then return false
  if p.scheme = "https" then return true
  return p.scheme = "http" and urlIsLocalHost(p.host)
end function

' Minimal parser: scheme://host[:port][/path]  ->  {scheme, host, port, path}
' port is 0 when absent. Returns invalid for anything unparseable.
function urlParse(url as string) as dynamic
  s = url.trim()
  sp = Instr(1, s, "://")
  if sp < 2 then return invalid
  scheme = LCase(Left(s, sp - 1))
  if scheme <> "http" and scheme <> "https" then return invalid
  rest = Mid(s, sp + 3)
  path = ""
  for i = 1 to Len(rest)
    ch = Mid(rest, i, 1)
    if ch = "/" or ch = "?" or ch = "#" then
      path = Mid(rest, i)
      rest = Left(rest, i - 1)
      exit for
    end if
  end for
  if Instr(1, rest, "@") > 0 or Instr(1, rest, "[") > 0 then return invalid ' no credentials / IPv6 literals
  host = rest
  port = 0
  cp = Instr(1, rest, ":")
  if cp > 0 then
    host = Left(rest, cp - 1)
    portText = Mid(rest, cp + 1)
    if not urlIsDigits(portText) or Len(portText) > 5 then return invalid
    port = Val(portText)
    if port < 1 or port > 65535 then return invalid
  end if
  host = LCase(host)
  if Right(host, 1) = "." then host = Left(host, Len(host) - 1)
  if not urlIsHostname(host) then return invalid
  return { scheme: scheme, host: host, port: port, path: path }
end function

' Turn what a person typed into the server origin we will use.
' Returns { ok, url, host, local, note, error }
'   error is one of: "empty", "bad_address"
'   note  is a short friendly hint (e.g. that http was upgraded to https)
function urlNormalizeServer(input as dynamic) as object
  out = { ok: false, url: "", host: "", local: false, note: "", error: "" }
  if input = invalid then
    out.error = "empty"
    return out
  end if
  s = input.trim()
  if s = "" then
    out.error = "empty"
    return out
  end if
  explicitScheme = Instr(1, s, "://") > 0
  if not explicitScheme then s = "//" + s ' placeholder, scheme chosen below
  if Left(s, 2) = "//" then
    hostPart = Mid(s, 3)
    ' strip a path/query the person may have pasted
    hp = urlParse("http://" + hostPart)
    if hp = invalid then
      out.error = "bad_address"
      return out
    end if
    scheme = "http"
    if not urlIsLocalHost(hp.host) then scheme = "https"
    port = hp.port
    if port = 0 then port = urlDefaultPort()
    host = hp.host
  else
    hp = urlParse(s)
    if hp = invalid then
      out.error = "bad_address"
      return out
    end if
    scheme = hp.scheme
    host = hp.host
    port = hp.port
    if scheme = "http" and not urlIsLocalHost(host) then
      scheme = "https"
      out.note = "Changed to a secure (https) connection."
    end if
    ' an explicit scheme with no port means the scheme's own default port
  end if
  out.ok = true
  out.host = host
  out.local = urlIsLocalHost(host)
  out.url = scheme + "://" + host
  if port > 0 then
    isDefault = (scheme = "http" and port = 80) or (scheme = "https" and port = 443)
    if not isDefault then out.url = out.url + ":" + Str(port).trim()
  end if
  return out
end function

' The direct HTTPS address of a house: <name>.home.beebo.tv:47811.
' (<name>.beebo.tv itself is Beebo's signalling page; it does not carry the
' JSON API, so it cannot be used from a TV that has no WebRTC.)
' Accepts "nick", "nick.beebo.tv", "nick.home.beebo.tv", "https://nick.beebo.tv".
function urlServerFromBeeboName(input as dynamic) as object
  out = { ok: false, url: "", name: "", error: "" }
  if input = invalid then
    out.error = "empty"
    return out
  end if
  s = LCase(input.trim())
  sp = Instr(1, s, "://")
  if sp > 0 then s = Mid(s, sp + 3)
  for i = 1 to Len(s)
    ch = Mid(s, i, 1)
    if ch = "/" or ch = ":" or ch = "?" or ch = "#" then
      s = Left(s, i - 1)
      exit for
    end if
  end for
  if urlEndsWith(s, ".home.beebo.tv") then
    s = Left(s, Len(s) - Len(".home.beebo.tv"))
  else if urlEndsWith(s, ".beebo.tv") then
    s = Left(s, Len(s) - Len(".beebo.tv"))
  end if
  if s = "" then
    out.error = "empty"
    return out
  end if
  if Len(s) > 63 or not urlIsHostname(s) or Instr(1, s, ".") > 0 then
    out.error = "bad_name"
    return out
  end if
  out.ok = true
  out.name = s
  out.url = "https://" + s + ".home.beebo.tv:" + Str(urlDefaultPort()).trim()
  return out
end function

' Join a server origin and a server-relative path. Absolute https URLs pass
' through untouched (e.g. TMDB backdrops); absolute http URLs are only kept
' for local hosts. Anything else -> "".
function urlAbsolute(base as string, rel as dynamic) as string
  if rel = invalid then return ""
  r = rel.trim()
  if r = "" then return ""
  if Left(r, 1) = "/" then
    b = base
    while Right(b, 1) = "/"
      b = Left(b, Len(b) - 1)
    end while
    return b + r
  end if
  if urlIsAllowed(r) then return r
  return ""
end function

function urlHex2(n as integer) as string
  digits = "0123456789ABCDEF"
  return "%" + Mid(digits, (n \ 16) + 1, 1) + Mid(digits, (n mod 16) + 1, 1)
end function

' RFC 3986 percent-encoding of a UTF-8 string.
function urlEncode(value as dynamic) as string
  if value = invalid then return ""
  s = value
  out = ""
  for i = 1 to Len(s)
    ch = Mid(s, i, 1)
    c = Asc(ch)
    isUnreserved = (c >= 48 and c <= 57) or (c >= 65 and c <= 90) or (c >= 97 and c <= 122) or c = 45 or c = 46 or c = 95 or c = 126
    if isUnreserved then
      out = out + ch
    else if c < 128 then
      out = out + urlHex2(c)
    else if c < 2048 then
      out = out + urlHex2(192 + (c \ 64)) + urlHex2(128 + (c mod 64))
    else if c < 65536 then
      out = out + urlHex2(224 + (c \ 4096)) + urlHex2(128 + ((c \ 64) mod 64)) + urlHex2(128 + (c mod 64))
    else
      out = out + urlHex2(240 + (c \ 262144)) + urlHex2(128 + ((c \ 4096) mod 64)) + urlHex2(128 + ((c \ 64) mod 64)) + urlHex2(128 + (c mod 64))
    end if
  end for
  return out
end function

' {a: "x y", b: 2} -> "a=x%20y&b=2" (keys sorted, invalid values skipped)
function urlQuery(params as object) as string
  keys = []
  for each k in params
    keys.push(k)
  end for
  keys.sort()
  parts = []
  for each k in keys
    v = params[k]
    if v <> invalid then
      t = type(v)
      if Instr(1, t, "String") > 0 then
        parts.push(urlEncode(k) + "=" + urlEncode(v))
      else
        parts.push(urlEncode(k) + "=" + urlEncode(Str(v).trim()))
      end if
    end if
  end for
  out = ""
  for i = 0 to parts.count() - 1
    if i > 0 then out = out + "&"
    out = out + parts[i]
  end for
  return out
end function

' path + optional query -> "/api/movies?sort=title"
function urlWithQuery(path as string, params as object) as string
  q = urlQuery(params)
  if q = "" then return path
  return path + "?" + q
end function
