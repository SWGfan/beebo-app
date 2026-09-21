' ============================================================================
' Theme.brs - the ONE place for colors, fonts and layout sizes.
'
' A designer restyles the channel by editing this file only. Components read
' these values in their init() and apply them to their nodes; the XML files
' carry structure, not styling. All measurements are in FHD (1920x1080) UI
' coordinates (manifest: ui_resolutions=fhd).
' ============================================================================

function Theme() as object
  return {
    ' Colors are "0xRRGGBBAA".
    color: {
      background: "0x0B0F14FF"
      surface: "0x161C24FF"
      surfaceRaised: "0x212A35FF"
      accent: "0xF5A524FF"
      accentText: "0x241704FF"
      text: "0xF4ECDDFF"
      textDim: "0xA79B87FF"
      textFaint: "0x6F6759FF"
      danger: "0xE5776BFF"
      success: "0x6FCF97FF"
      scrim: "0x000000B8"
      progressTrack: "0xFFFFFF33"
      focusRing: "0xF5A524FF"
    }

    ' Fonts: role -> { uri, size }. uri is a Roku system font.
    font: {
      display: { uri: "font:LargeBoldSystemFont", size: 64 }
      title: { uri: "font:LargeBoldSystemFont", size: 52 }
      heading: { uri: "font:MediumBoldSystemFont", size: 38 }
      body: { uri: "font:MediumSystemFont", size: 30 }
      label: { uri: "font:SmallSystemFont", size: 26 }
      caption: { uri: "font:SmallestSystemFont", size: 22 }
      button: { uri: "font:MediumBoldSystemFont", size: 30 }
      code: { uri: "font:LargeBoldSystemFont", size: 120 }
    }

    ' Layout. Title-safe zone: Roku recommends keeping content inside 5% of
    ' every edge (96px horizontally, 54px vertically at FHD).
    layout: {
      screenWidth: 1920
      screenHeight: 1080
      marginX: 96
      marginY: 54
      tabBarY: 54
      tabBarHeight: 72
      contentY: 170
      posterWidth: 210
      posterHeight: 315
      posterTitleHeight: 44
      gridColumns: 7
      gridRows: 2
      cellWidth: 240
      cellHeight: 372
      gridSpacingX: 6
      gridSpacingY: 20
      buttonHeight: 68
      buttonPadX: 36
      buttonGap: 20
      pageSize: 56
      pageLookahead: 14
    }
  }
end function

' Font role + color name in one call: themeLabel(m.title, "heading", "text")
sub themeLabel(node as object, role as string, colorName as string)
  themeApplyFont(node, role)
  c = Theme().color[colorName]
  if c <> invalid then node.color = c
end sub

' The amber focus ring (9-patch) used by grids and lists. PLACEHOLDER art.
function themeFocusRing() as string
  return "pkg:/images/PLACEHOLDER_focus.9.png"
end function

function themePosterMissing() as string
  return "pkg:/images/PLACEHOLDER_poster_missing.png"
end function

' Apply a font role to any Label.
sub themeApplyFont(node as object, role as string)
  f = Theme().font[role]
  if f = invalid then return
  font = CreateObject("roSGNode", "Font")
  font.uri = f.uri
  font.size = f.size
  node.font = font
end sub
