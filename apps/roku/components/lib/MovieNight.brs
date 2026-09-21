' ============================================================================
' MovieNight.brs - PURE helpers for the Movie Night screen (docs/MOVIE-NIGHT.md). Unit-tested.
'
' Movie Night is drawn by the Beebo desktop server as a web page (GET /tv, /movie-night/tv) that phones join
' by scanning a code. A Roku has no web view, so this channel cannot draw it. What it CAN do honestly:
'   * ask GET /api/movie-night/status whether the server has Movie Night switched on, and say so;
'   * tell the person exactly which address to open on a device that has a browser (a laptop, a tablet, a
'     smart TV) on the same home network, where the code and the join square for phones appear.
' (POST /api/movie-night/tv/create is NOT used: it makes a room only the page that holds its ticket can draw.)
' ============================================================================

' The shared-screen page of the server the channel is signed in to, e.g. "http://192.168.1.20:47811/tv".
function mnTvAddress(server as dynamic) as string
  s = fmtStr(server, "").trim()
  while Right(s, 1) = "/"
    s = Left(s, Len(s) - 1)
  end while
  if s = "" then return ""
  return s + "/tv"
end function

' GET /api/movie-night/status -> { state, message }
'   state: "available" | "off" | "unsupported" (an older Beebo without Movie Night) | "signed_out" | "error"
'   message: one plain sentence (the server's own when it gives one, cut to a safe length)
function mnParseStatus(status as integer, json as dynamic) as object
  out = { state: "error", message: "Couldn't check Movie Night right now." }
  if status = 404 then
    out.state = "unsupported"
    out.message = "Movie Night isn't available on this Beebo computer. Update Beebo on the computer, then try again."
    return out
  end if
  if status = 401 then
    out.state = "signed_out"
    out.message = "You have been signed out. Please sign in again."
    return out
  end if
  if status = 403 then
    out.state = "off"
    out.message = "Movie Night works on the home Wi-Fi. Connect this Roku to it and try again."
    return out
  end if
  if status <> 200 then return out
  if json = invalid then return out
  if type(json) <> "roAssociativeArray" then return out
  if fmtIsTrue(json.available) then
    out.state = "available"
    out.message = "Movie Night is switched on."
    return out
  end if
  out.state = "off"
  msg = fmtStr(json.message, "").trim()
  if msg = "" then msg = "Movie Night is switched off on your Beebo computer (Settings > Movie Night)."
  out.message = fmtTruncate(mnCleanLine(msg), 200)
  return out
end function

' Control characters become spaces (the text goes into a Label; nothing here is ever markup).
function mnCleanLine(s as string) as string
  out = ""
  for i = 1 to Len(s)
    c = Asc(Mid(s, i, 1))
    if c < 32 or c = 127 then
      out = out + " "
    else
      out = out + Mid(s, i, 1)
    end if
  end for
  return out
end function

' The instructions shown above the address (the address itself is a separate, larger label).
function mnInstructions() as string
  txt = "Movie Night is a party game for the whole room: movie trivia, a poster-guessing game and a fair vote for tonight's film, made from your own library. Everyone joins from their phone, with no account."
  txt = txt + Chr(10) + Chr(10) + "A Roku can't show it, because it has no web browser. To play, open this address in a browser on a laptop, a tablet or another smart TV on your home Wi-Fi:"
  return txt
end function
