sub init()
  baseInit()
  L = m.theme.layout
  C = m.theme.color
  m.brand = m.top.findNode("brand")
  m.title = m.top.findNode("title")
  m.message = m.top.findNode("message")
  m.spinner = m.top.findNode("spinner")
  m.menu = m.top.findNode("menu")
  themeLabel(m.brand, "heading", "accent")
  themeLabel(m.title, "title", "text")
  themeLabel(m.message, "body", "textDim")
  m.brand.text = "Beebo Entertainment"
  m.brand.translation = [L.marginX, L.marginY]
  m.title.translation = [L.marginX, 150]
  m.title.width = 1400
  m.message.translation = [L.marginX, 240]
  m.message.width = 1300
  m.spinner.poster.uri = "pkg:/images/PLACEHOLDER_spinner.png"
  m.spinner.translation = [L.marginX, 380]
  m.menu.translation = [L.marginX, 440]
  m.menu.itemSize = [1100, 72]
  m.menu.numRows = 6
  m.menu.color = C.text
  m.menu.focusedColor = C.accent
  m.menu.focusBitmapUri = themeFocusRing()
  m.menu.observeField("itemSelected", "onMenuSelected")
  m.entries = []
  m.scanning = false
end sub

sub onParams()
  p = m.top.params
  if p <> invalid and fmtStr(p.message, "") <> "" then m.note = p.message
  startScan()
end sub

sub focusMe()
  if m.menu.visible then m.menu.setFocus(true)
end sub

' ---- scanning --------------------------------------------------------------------
sub startScan()
  if m.scanning then return
  m.scanning = true
  m.menu.visible = false
  m.title.text = "Finding your Beebo"
  m.message.text = "Looking for Beebo on your home network..."
  m.spinner.visible = true
  m.spinner.control = "start"
  m.scan = CreateObject("roSGNode", "DiscoveryTask")
  m.scan.observeField("progress", "onScanProgress")
  m.scan.observeField("result", "onScanResult")
  m.scan.control = "RUN"
end sub

sub onScanProgress(event as object)
  p = event.getData()
  if p = invalid then return
  m.message.text = "Looking for Beebo on your home network... (" + Str(p.scanned).trim() + " of " + Str(p.total).trim() + " addresses)"
end sub

sub onScanResult(event as object)
  m.scanning = false
  m.spinner.control = "stop"
  m.spinner.visible = false
  r = event.getData()
  servers = []
  reason = ""
  if r <> invalid then
    if r.servers <> invalid then servers = r.servers
    reason = fmtStr(r.reason, "")
  end if
  showMenu(servers, reason)
end sub

sub showMenu(servers as object, reason as string)
  entries = []
  seen = {}
  for each s in servers
    if seen[s.url] = invalid then
      seen[s.url] = true
      entries.push({ kind: "server", url: s.url, title: "Beebo server at " + s.host })
    end if
  end for
  entries.push({ kind: "pair", title: "Find my Beebo with a code from my phone" })
  entries.push({ kind: "address", title: "Type a server address" })
  entries.push({ kind: "name", title: "Use my Beebo name (away from home)" })
  entries.push({ kind: "scan", title: "Scan again" })
  m.entries = entries

  if servers.count() > 0 then
    m.title.text = "Choose your Beebo"
    m.message.text = "Found Beebo on your network. Pick it to continue."
  else
    m.title.text = "Connect to your Beebo"
    if reason = "no_lan" then
      m.message.text = "This Roku isn't on a home network we can search. Type your Beebo server's address instead."
    else
      m.message.text = "No Beebo found on this network. Make sure Beebo is running on your computer and this Roku is on the same network. Or connect another way:"
    end if
  end if
  if fmtStr(m.note, "") <> "" then
    m.message.text = m.note + "  " + m.message.text
    m.note = ""
  end if

  content = CreateObject("roSGNode", "ContentNode")
  for each e in entries
    n = content.createChild("ContentNode")
    n.title = e.title
  end for
  m.menu.content = content
  m.menu.visible = true
  m.menu.setFocus(true)
end sub

sub onMenuSelected()
  idx = m.menu.itemSelected
  if idx < 0 or idx >= m.entries.count() then return
  e = m.entries[idx]
  if e.kind = "server" then
    chooseServer(e.url)
  else if e.kind = "scan" then
    startScan()
  else if e.kind = "address" then
    showKeyboard("Server address", "Example: 192.168.1.50 or nick.example.com", "", false, onAddressEntered)
  else if e.kind = "name" then
    showKeyboard("Your Beebo name", "The name in your address, like nick for nick.beebo.tv", "", false, onNameEntered)
  else if e.kind = "pair" then
    navPush("PairView", {})
  end if
end sub

' ---- typed address / name ------------------------------------------------------------
sub onAddressEntered(text as string)
  n = urlNormalizeServer(text)
  if not n.ok then
    if n.error = "empty" then return
    showMessage("That address doesn't look right", "Type an address like 192.168.1.50 or nick.example.com, without spaces.", "focusMe")
    return
  end if
  verifyAndChoose(n.url, n.local)
end sub

sub onNameEntered(text as string)
  n = urlServerFromBeeboName(text)
  if not n.ok then
    if n.error = "empty" then return
    showMessage("That name doesn't look right", "Use just your Beebo name, for example nick (for nick.beebo.tv).", "focusMe")
    return
  end if
  verifyAndChoose(n.url, false)
end sub

sub verifyAndChoose(url as string, isLocal as boolean)
  m.menu.visible = false
  m.title.text = "Checking " + url
  m.message.text = "One moment..."
  m.spinner.visible = true
  m.spinner.control = "start"
  m.verifying = { url: url, local: isLocal }
  apiGet("/api/ping", { url: url + "/api/ping", auth: false, timeoutMs: 9000 }, onVerified, m.verifying)
end sub

sub onVerified(resp as object, ctx as dynamic)
  m.spinner.control = "stop"
  m.spinner.visible = false
  good = false
  if resp.ok and resp.data <> invalid then good = LCase(fmtStr(resp.data.app, "")) = "beeboentertainment"
  if good then
    chooseServer(ctx.url)
    return
  end if
  if resp.ok then
    msg = "That address answered, but it isn't a Beebo server."
  else if ctx.local then
    msg = "Couldn't reach a Beebo server there. Check the address, that Beebo is running on the computer, and that this Roku is on the same network."
  else
    msg = "Couldn't reach a Beebo server there. Away from home this needs your home address to be reachable from the internet (the direct address and port 47811 opened on your router). Otherwise use the Beebo phone app, which connects another way."
  end if
  showMenu([], "")
  showMessage("Couldn't connect", msg, "focusMe")
end sub

sub chooseServer(url as string)
  logInfo("setup", "server chosen")
  m.top.navigate = { action: "server", url: url, params: {} }
end sub

function onKeyEvent(key as string, press as boolean) as boolean
  ' Back from setup has nowhere to go: let it exit the channel (the OS handles it).
  return false
end function
