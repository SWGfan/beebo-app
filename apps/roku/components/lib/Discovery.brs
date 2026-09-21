' ============================================================================
' Discovery.brs - PURE helpers for finding the home server on the LAN.
'
' Roku has no mDNS / SSDP API and Beebo's server does not advertise itself, so
' the DiscoveryTask probes the Roku's own /24 for GET /api/ping (which the
' server answers WITHOUT a login: { ok:true, app:"beeboentertainment" }).
' This file holds the pure parts (address list, answer check) so they can be
' unit-tested; the network probing is in components/tasks/DiscoveryTask.brs.
' ============================================================================

' "192.168.1.20" -> ["192.168.1.1", ... "192.168.1.254"] minus the Roku's own address.
' Returns [] for anything that is not a private IPv4 (a public-IP Roku is not on
' a home LAN we can scan) -- see urlIsLocalHost.
function discoveryHostList(ownIp as dynamic) as object
  out = []
  if ownIp = invalid then return out
  a = urlParseIpv4(ownIp)
  if a = invalid then return out
  if not urlIsPrivateIpv4(a) then return out
  prefix = Str(a[0]).trim() + "." + Str(a[1]).trim() + "." + Str(a[2]).trim() + "."
  for i = 1 to 254
    if i <> a[3] then out.push(prefix + Str(i).trim())
  end for
  return out
end function

' Is this the body of a Beebo server's /api/ping answer?
function discoveryIsBeeboPing(text as dynamic) as boolean
  if text = invalid then return false
  if not fmtIsString(text) then return false
  if Len(text) > 2000 then return false
  j = ParseJson(text)
  if j = invalid then return false
  if type(j) <> "roAssociativeArray" then return false
  if not fmtIsTrue(j.ok) then return false
  return LCase(fmtStr(j.app, "")) = "beeboentertainment"
end function

' Address a probe should use for a host on the LAN: plain http, server port.
function discoveryServerUrl(host as string) as string
  return "http://" + host + ":" + Str(urlDefaultPort()).trim()
end function

' Pick the first usable LAN address out of roDeviceInfo.GetIPAddrs()'s
' { "eth0": "192.168.1.20", ... } (an AA of interface -> address).
function discoveryPickOwnIp(addrs as dynamic) as string
  if addrs = invalid then return ""
  if type(addrs) <> "roAssociativeArray" then return ""
  ' Prefer an ordinary home-LAN address (10/8, 172.16/12, 192.168/16) over CGNAT (VPN) or
  ' link-local ones, which are not a network worth scanning.
  fallback = ""
  for each k in addrs
    v = addrs[k]
    if fmtIsString(v) then
      a = urlParseIpv4(v)
      if a <> invalid then
        isLan = a[0] = 10 or (a[0] = 172 and a[1] >= 16 and a[1] <= 31) or (a[0] = 192 and a[1] = 168)
        if isLan then return v
        if urlIsPrivateIpv4(a) and a[0] <> 127 and a[0] <> 169 and fallback = "" then fallback = v
      end if
    end if
  end for
  return fallback
end function
