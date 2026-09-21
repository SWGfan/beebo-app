' DiscoveryTask - find a Beebo server on the Roku's own /24 by asking each address
' for GET /api/ping (unauthenticated) on the server port. See lib/Discovery.brs.
'
' Cost: 253 short probes in batches of 32, each batch waits at most ~1.5 s, so a
' quiet network takes ~10 s (hard stop after 25 s). Refused connections answer instantly,
' so a normal home network is much faster. Only /24 networks are scanned (v1 limitation).

sub init()
  m.top.functionName = "scan"
end sub

sub scan()
  di = CreateObject("roDeviceInfo")
  ownIp = discoveryPickOwnIp(di.GetIPAddrs())
  hosts = []
  input = m.top.input
  if input <> invalid and input.extraHosts <> invalid then
    for each h in input.extraHosts
      hosts.push(h)
    end for
  end if
  scanList = discoveryHostList(ownIp)
  for each h in scanList
    hosts.push(h)
  end for

  if hosts.count() = 0 then
    m.top.result = { ok: false, servers: [], reason: "no_lan" }
    return
  end if

  found = []
  total = hosts.count()
  scanned = 0
  batchSize = 32
  batchWaitMs = 1500
  idx = 0
  overall = CreateObject("roTimespan")
  overallMs = 25000 ' never scan longer than this, whatever the network does
  while idx < total
    if overall.TotalMilliseconds() > overallMs then exit while
    port = CreateObject("roMessagePort")
    pending = {}
    batchEnd = idx + batchSize
    if batchEnd > total then batchEnd = total
    xfers = []
    for i = idx to batchEnd - 1
      host = hosts[i]
      x = CreateObject("roUrlTransfer")
      x.SetMessagePort(port)
      x.SetUrl(discoveryServerUrl(host) + "/api/ping")
      x.AddHeader("Accept", "application/json")
      if x.AsyncGetToString() then
        pending[Str(x.GetIdentity()).trim()] = host
        xfers.push(x)
      end if
    end for
    remaining = pending.count()
    deadline = CreateObject("roTimespan")
    while remaining > 0
      left = batchWaitMs - deadline.TotalMilliseconds()
      if left <= 0 then exit while
      msg = wait(left, port)
      if msg = invalid then exit while
      if type(msg) = "roUrlEvent" then
        key = Str(msg.GetSourceIdentity()).trim()
        host = pending[key]
        if host <> invalid then
          pending.delete(key)
          remaining = remaining - 1
          if msg.GetResponseCode() = 200 and discoveryIsBeeboPing(msg.GetString()) then
            found.push({ url: discoveryServerUrl(host), host: host })
          end if
        end if
      end if
    end while
    for each x in xfers
      x.AsyncCancel()
    end for
    scanned = batchEnd
    idx = batchEnd
    m.top.progress = { scanned: scanned, total: total, found: found.count() }
  end while

  m.top.result = { ok: true, servers: found, reason: "" }
end sub
