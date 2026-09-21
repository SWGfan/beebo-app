' Beebo Entertainment - Roku channel entry point.
' All logic lives in the scene (components/BeeboScene.*); main() only owns the screen and
' forwards launch / deep-link arguments.

sub main(args as dynamic)
  screen = CreateObject("roSGScreen")
  port = CreateObject("roMessagePort")
  screen.setMessagePort(port)

  scene = screen.CreateScene("BeeboScene")
  screen.show()

  input = CreateObject("roInput")
  input.setMessagePort(port)

  if args <> invalid then scene.launchArgs = args

  while true
    msg = wait(0, port)
    msgType = type(msg)
    if msgType = "roSGScreenEvent" then
      if msg.isScreenClosed() then return
    else if msgType = "roInputEvent" then
      info = msg.getInfo()
      if info <> invalid then scene.launchArgs = info
    end if
  end while
end sub
