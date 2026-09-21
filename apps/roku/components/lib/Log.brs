' ============================================================================
' Log.brs - logging that never leaks a secret.
'
' Everything printed goes through logInfo(), which redacts bearer tokens,
' device codes, HLS tickets and media tokens. Never print() a token directly.
' ============================================================================

' Cut the value that follows `marker` up to the first delimiter.
function logRedactAfter(text as string, marker as string, delims as string) as string
  out = ""
  rest = text
  while true
    p = Instr(1, rest, marker)
    if p = 0 then
      out = out + rest
      exit while
    end if
    out = out + Left(rest, p - 1 + Len(marker)) + "[redacted]"
    rest = Mid(rest, p + Len(marker))
    cut = Len(rest) + 1
    for i = 1 to Len(rest)
      if Instr(1, delims, Mid(rest, i, 1)) > 0 then
        cut = i
        exit for
      end if
    end for
    rest = Mid(rest, cut)
  end while
  return out
end function

function logRedact(text as dynamic) as string
  if text = invalid then return ""
  s = text
  s = logRedactAfter(s, "Bearer ", " " + Chr(10) + Chr(13) + Chr(34) + "&")
  s = logRedactAfter(s, "/hls/", "/" + " " + Chr(34))
  s = logRedactAfter(s, "mt=", "& " + Chr(34))
  s = logRedactAfter(s, "token=", "& " + Chr(34))
  s = logRedactAfter(s, "device_code=", "& " + Chr(34))
  s = logRedactAfter(s, "device_code" + Chr(34) + ":" + Chr(34), Chr(34))
  s = logRedactAfter(s, "token" + Chr(34) + ":" + Chr(34), Chr(34))
  return s
end function

sub logInfo(tag as string, message = "" as dynamic)
  print "[beebo] "; tag; " "; logRedact(message)
end sub
