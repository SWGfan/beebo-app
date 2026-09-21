' ============================================================================
' Paging.brs - PURE lazy-paging arithmetic (unit-tested under brs).
'
' The server returns a whole library in one JSON list (no offset/limit yet),
' so the channel keeps that list as small trimmed records and only turns a
' page of it into scene-graph nodes at a time, adding the next page when the
' viewer's focus gets near the end of what is already built.
' ============================================================================

function pagerNew(pageSize as integer, lookahead as integer) as object
  return { pageSize: pageSize, lookahead: lookahead, total: 0, loaded: 0 }
end function

sub pagerReset(p as object, total as integer)
  p.total = total
  p.loaded = 0
end sub

' Which slice of the list should be built now? Returns invalid when nothing
' more is needed. focusedIndex is the item the viewer is on (0-based).
function pagerNextRange(p as object, focusedIndex as integer) as dynamic
  if p.loaded >= p.total then return invalid
  if p.loaded = 0 or focusedIndex >= p.loaded - p.lookahead then
    count = p.pageSize
    if p.loaded + count > p.total then count = p.total - p.loaded
    return { start: p.loaded, count: count }
  end if
  return invalid
end function

sub pagerMarkLoaded(p as object, count as integer)
  p.loaded = p.loaded + count
  if p.loaded > p.total then p.loaded = p.total
end sub

' Jump support (e.g. instant-replay to the top is not needed, but a caller may
' want to be sure an index exists): how many items must be built to include idx?
function pagerCountNeededFor(p as object, idx as integer) as integer
  if idx < p.loaded then return 0
  needed = idx + 1 - p.loaded
  pages = (needed + p.pageSize - 1) \ p.pageSize
  return pages * p.pageSize
end function
