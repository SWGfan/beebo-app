' Shared helpers for every view. A view's init() calls baseInit() first.

sub baseInit()
  m.theme = Theme()
  apiInit()
end sub

' ---- navigation (handled by BeeboScene) ------------------------------------
sub navPush(view as string, params = {} as object)
  m.top.navigate = { action: "push", view: view, params: params }
end sub

sub navPop()
  m.top.navigate = { action: "pop" }
end sub

' Clear the stack and show `view` (after sign-in, server change, sign-out).
sub navReplaceAll(view as string, params = {} as object)
  m.top.navigate = { action: "reset", view: view, params: params }
end sub

' ---- small helpers ------------------------------------------------------------
function imageUrl(rel as dynamic) as string
  return urlAbsolute(m.global.server, rel)
end function

' Show an error/info dialog (OK button) on the scene.
sub showMessage(title as string, message as string, onClosed = "" as string)
  dlg = CreateObject("roSGNode", "StandardMessageDialog")
  dlg.title = title
  dlg.message = [message]
  dlg.buttons = ["OK"]
  dlg.observeFieldScoped("buttonSelected", "onMessageButton")
  dlg.observeFieldScoped("wasClosed", "onMessageClosed")
  m.messageDialog = dlg
  m.messageOnClosed = onClosed
  m.top.getScene().dialog = dlg
end sub

sub onMessageButton()
  if m.messageDialog <> invalid then m.messageDialog.close = true
end sub

sub onMessageClosed()
  m.messageDialog = invalid
  if m.messageOnClosed <> "" then
    cb = m.messageOnClosed
    m.messageOnClosed = ""
    if cb = "focusMe" then m.top.callFunc("focusMe")
  end if
end sub

' Open the on-screen keyboard. `onDone` is called as onDone(text as string) via the
' view's m.keyboardDone function reference when OK is chosen.
sub showKeyboard(title as string, message as string, initial as string, secure as boolean, done as function)
  dlg = CreateObject("roSGNode", "StandardKeyboardDialog")
  dlg.title = title
  dlg.message = [message]
  dlg.text = initial
  dlg.buttons = ["OK", "Cancel"]
  if secure then dlg.textEditBox.secureMode = true
  dlg.observeFieldScoped("buttonSelected", "onKeyboardButton")
  m.keyboardDialog = dlg
  m.keyboardDone = done
  m.top.getScene().dialog = dlg
end sub

sub onKeyboardButton()
  dlg = m.keyboardDialog
  if dlg = invalid then return
  idx = dlg.buttonSelected
  text = dlg.text
  dlg.close = true
  m.keyboardDialog = invalid
  if idx = 0 then
    cb = m.keyboardDone
    m.keyboardDone = invalid
    if cb <> invalid then cb(text)
  else
    m.top.callFunc("focusMe")
  end if
end sub
