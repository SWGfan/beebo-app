' ============================================================================
' Nodes.brs - turn trimmed records (lib/Models.brs) into ContentNodes for grids/rows.
' Needs lib/Urls.brs. Not unit-tested (creates scene-graph nodes).
' ============================================================================

' rec: { title, poster (server-relative), isNew?, currentTime?, duration? }
function nodesPoster(rec as object, serverBase as string) as object
  n = CreateObject("roSGNode", "ContentNode")
  n.title = fmtStr(rec.title, "")
  n.HDPosterUrl = urlAbsolute(serverBase, rec.poster)
  if fmtIsTrue(rec.isNew) then n.ShortDescriptionLine1 = "NEW"
  if rec.duration <> invalid then
    n.Length = fmtInt(rec.duration, 0)
    n.PlayStart = fmtInt(rec.currentTime, 0)
  end if
  return n
end function

' A RowList/list content root with one child per record.
function nodesPosterList(records as object, serverBase as string) as object
  root = CreateObject("roSGNode", "ContentNode")
  for each rec in records
    root.appendChild(nodesPoster(rec, serverBase))
  end for
  return root
end function

' Simple text list (LabelList / picker): one child per string.
function nodesTitles(titles as object) as object
  root = CreateObject("roSGNode", "ContentNode")
  for each t in titles
    n = root.createChild("ContentNode")
    n.title = t
  end for
  return root
end function
