' ============================================================================
' Registry.brs - persistent settings in roRegistrySection.
'
' The registry is private to this channel on this device. The bearer token is
' kept here (Roku offers no encrypted store); it is never logged (Log.brs),
' never put in a URL, and is removed on sign-out / when the server rejects it.
' ============================================================================

function regSectionName() as string
  return "beebo"
end function

function regRead(key as string, fallback = "" as string) as string
  sec = CreateObject("roRegistrySection", regSectionName())
  if sec.Exists(key) then return sec.Read(key)
  return fallback
end function

sub regWrite(key as string, value as string)
  sec = CreateObject("roRegistrySection", regSectionName())
  sec.Write(key, value)
  sec.Flush()
end sub

sub regDelete(key as string)
  sec = CreateObject("roRegistrySection", regSectionName())
  sec.Delete(key)
  sec.Flush()
end sub

' Everything the app remembers, with defaults.
function regLoadSettings() as object
  return {
    server: regRead("server", "")
    token: regRead("token", "")
    userName: regRead("userName", "")
    quality: regRead("quality", "auto")
    subtitles: regRead("subtitles", "off")
  }
end function

' Changing server invalidates the old sign-in (a token belongs to one server).
sub regSaveServer(url as string)
  if regRead("server", "") <> url then
    regDelete("token")
    regDelete("userName")
  end if
  regWrite("server", url)
end sub

sub regSaveToken(token as string, userName as string)
  regWrite("token", token)
  regWrite("userName", userName)
end sub

sub regClearSignIn()
  regDelete("token")
  regDelete("userName")
end sub
