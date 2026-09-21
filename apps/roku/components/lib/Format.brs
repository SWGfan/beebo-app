' ============================================================================
' Format.brs - PURE display/number helpers (unit-tested under brs).
' ============================================================================

' type() names differ slightly between firmware versions and simulators ("roInt", "roInteger",
' "Integer", "roLongInteger", ...), so match on the family, not the exact name.
function fmtIsNumber(v as dynamic) as boolean
  if v = invalid then return false
  t = type(v)
  if Instr(1, t, "Int") > 0 then return true
  if Instr(1, t, "Float") > 0 then return true
  if Instr(1, t, "Double") > 0 then return true
  return false
end function
function fmtIsString(v as dynamic) as boolean
  if v = invalid then return false
  t = type(v)
  return Instr(1, t, "String") > 0
end function

' Numbers arrive from JSON as Integer/Float/Double/String depending on the value.
function fmtNum(v as dynamic, fallback = 0 as dynamic) as dynamic
  if fmtIsNumber(v) then return v
  if fmtIsString(v) and v <> "" then return Val(v)
  return fallback
end function

function fmtInt(v as dynamic, fallback = 0 as integer) as integer
  n = fmtNum(v, fallback)
  return Int(n)
end function

function fmtStr(v as dynamic, fallback = "" as string) as string
  if fmtIsString(v) then return v
  if fmtIsNumber(v) then return Str(v).trim()
  return fallback
end function

' 6720 -> "1h 52m", 2700 -> "45m", 30 -> "1m" (never "0m" for a real duration)
function fmtDuration(seconds as dynamic) as string
  s = fmtNum(seconds, 0)
  if s <= 0 then return ""
  totalMin = Int((s + 30) / 60)
  if totalMin < 1 then totalMin = 1
  h = totalMin \ 60
  mm = totalMin mod 60
  if h > 0 and mm > 0 then return Str(h).trim() + "h " + Str(mm).trim() + "m"
  if h > 0 then return Str(h).trim() + "h"
  return Str(mm).trim() + "m"
end function

' 3909 -> "1:05:09", 65 -> "1:05"
function fmtClock(seconds as dynamic) as string
  s = Int(fmtNum(seconds, 0))
  if s < 0 then s = 0
  h = s \ 3600
  mm = (s mod 3600) \ 60
  ss = s mod 60
  if h > 0 then return Str(h).trim() + ":" + fmtPad2(mm) + ":" + fmtPad2(ss)
  return Str(mm).trim() + ":" + fmtPad2(ss)
end function

function fmtPad2(n as integer) as string
  t = Str(n).trim()
  if Len(t) < 2 then t = "0" + t
  return t
end function

' 1234567 -> "1,234,567"
function fmtCount(v as dynamic) as string
  n = Int(fmtNum(v, 0))
  neg = n < 0
  if neg then n = -n
  t = Str(n).trim()
  out = ""
  cnt = 0
  for i = Len(t) to 1 step -1
    out = Mid(t, i, 1) + out
    cnt = cnt + 1
    if cnt mod 3 = 0 and i > 1 then out = "," + out
  end for
  if neg then out = "-" + out
  return out
end function

' Join the non-empty parts with a middle dot.
function fmtJoin(parts as object, sep = "   |   " as string) as string
  out = ""
  for each p in parts
    if p <> invalid and p <> "" then
      if out <> "" then out = out + sep
      out = out + p
    end if
  end for
  return out
end function

function fmtTruncate(text as dynamic, maxLen as integer) as string
  s = fmtStr(text, "")
  if Len(s) <= maxLen then return s
  return Left(s, maxLen - 1) + "..."
end function

' 7.436 -> "7.4 / 10" ; invalid/0 -> ""
function fmtRating(vote as dynamic) as string
  v = fmtNum(vote, 0)
  if v <= 0 then return ""
  tenths = Int(v * 10 + 0.5)
  return Str(tenths \ 10).trim() + "." + Str(tenths mod 10).trim() + " / 10"
end function

function fmtSeasonLabel(season as dynamic) as string
  if not fmtIsNumber(season) then return "Other episodes"
  if season = 0 then return "Specials"
  return "Season " + Str(season).trim()
end function

' Percent (0-100) as an integer, clamped.
function fmtPercent(v as dynamic) as integer
  n = Int(fmtNum(v, 0))
  if n < 0 then return 0
  if n > 100 then return 100
  return n
end function

function fmtIsTrue(v as dynamic) as boolean
  if v = invalid then return false
  t = type(v)
  if Instr(1, t, "Boolean") > 0 then return v
  return false
end function

function fmtIsFalse(v as dynamic) as boolean
  if v = invalid then return false
  t = type(v)
  if Instr(1, t, "Boolean") > 0 then return not v
  return false
end function