' ============================================================================
' PairingMachine.brs - PURE device-code sign-in state machine.
'
' No network, no timers, no nodes: the pairing view feeds events in and does
' whatever the returned action says. That keeps the tricky part (interval
' respect, slow_down back-off, expiry, retry budget) unit-testable.
'
' phase: "idle" | "starting" | "waiting" | "approved" | "expired" | "denied" | "error"
'
' events (AA with .type):
'   { type: "begin" }
'   { type: "start_result", ok: bool, parsed: <pairParseStart result>, now: sec }
'   { type: "poll_result",  parsed: <pairParsePoll result>, now: sec }
'   { type: "poll_failed",  now: sec }            ' network / server error
'   { type: "tick",         now: sec }            ' 1s clock, detects local expiry
'
' actions returned (AA with .type):
'   request_start | poll {delaySec} | approved {token, name} | none
' ============================================================================

function pairNew() as object
  return {
    phase: "idle"
    deviceCode: ""
    userCode: ""
    verificationUri: ""
    interval: 5
    expiresAt: 0
    failures: 0
    maxFailures: 5
    error: ""
    reason: ""
    token: ""
    name: ""
  }
end function

function pairAction(kind as string) as object
  return { type: kind, delaySec: 0, token: "", name: "" }
end function

function pairHandle(st as object, ev as object) as object
  c = pairContract()
  t = ev.type

  if t = "begin" then
    st.phase = "starting"
    st.failures = 0
    st.error = ""
    st.reason = ""
    st.deviceCode = ""
    st.userCode = ""
    st.token = ""
    st.name = ""
    return pairAction("request_start")
  end if

  if t = "start_result" then
    if st.phase <> "starting" then return pairAction("none")
    good = false
    if ev.ok = true then
      if ev.parsed <> invalid then good = ev.parsed.ok = true
    end if
    if good then
      p = ev.parsed
      st.phase = "waiting"
      st.deviceCode = p.deviceCode
      st.userCode = p.userCode
      st.verificationUri = p.verificationUri
      st.interval = p.interval
      st.expiresAt = ev.now + p.expiresIn
      st.failures = 0
      a = pairAction("poll")
      a.delaySec = st.interval
      return a
    end if
    st.phase = "error"
    st.error = "start_failed"
    return pairAction("none")
  end if

  if t = "tick" then
    if st.phase = "waiting" and ev.now >= st.expiresAt then st.phase = "expired"
    return pairAction("none")
  end if

  if st.phase <> "waiting" then return pairAction("none")

  if t = "poll_failed" then
    st.failures = st.failures + 1
    if st.failures >= st.maxFailures then
      st.phase = "error"
      st.error = "network"
      return pairAction("none")
    end if
    if ev.now >= st.expiresAt then
      st.phase = "expired"
      return pairAction("none")
    end if
    a = pairAction("poll")
    a.delaySec = st.interval * 2 ' back off while the network is struggling
    if a.delaySec > c.maxIntervalSec then a.delaySec = c.maxIntervalSec
    return a
  end if

  if t = "poll_result" then
    r = ev.parsed
    if r.status = "approved" then
      st.phase = "approved"
      st.token = "" ' the viewer token is NOT kept in state: only this one action carries it (PairView uses it once, then drops it)
      st.name = r.name
      a = pairAction("approved")
      a.token = r.token
      a.name = r.name
      return a
    end if
    if r.status = "denied" then
      st.phase = "denied"
      st.reason = r.reason
      return pairAction("none")
    end if
    if r.status = "expired" then
      st.phase = "expired"
      return pairAction("none")
    end if
    if r.status = "error" then
      ' an unintelligible answer counts like a failed poll
      return pairHandle(st, { type: "poll_failed", now: ev.now })
    end if
    ' pending / slow_down
    st.failures = 0
    if r.status = "slow_down" then
      if r.interval > 0 then
        st.interval = pairClampInterval(r.interval)
      else
        st.interval = pairClampInterval(st.interval + c.slowDownStepSec)
      end if
    end if
    if ev.now >= st.expiresAt then
      st.phase = "expired"
      return pairAction("none")
    end if
    a = pairAction("poll")
    a.delaySec = st.interval
    return a
  end if

  return pairAction("none")
end function

function pairSecondsLeft(st as object, now as integer) as integer
  left = st.expiresAt - now
  if left < 0 then return 0
  return left
end function
