' Starts Beebo Entertainment with NO black command window.
'
' The Beebo Entertainment window still opens normally - only the console is hidden.
' Anything the app prints goes to logs\movieapp.log instead of the screen, so
' there is still something to read if it fails to start.
'
' To stop the app: close the Beebo Entertainment window (that shuts the background pieces
' down too). If it ever gets stuck, end "electron.exe" in Task Manager.

Dim fso, sh, scriptDir, batPath, q
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
batPath = scriptDir & "\Start MovieAPP.bat"

' Fail loudly and usefully rather than with a bare "file not found" code.
If Not fso.FileExists(batPath) Then
  MsgBox "Can't find:" & vbCrLf & vbCrLf & batPath & vbCrLf & vbCrLf & _
         "This launcher has to sit in the same folder as ""Start MovieAPP.bat"".", _
         vbExclamation, "Beebo Entertainment"
  WScript.Quit 1
End If

' cmd.exe /c ""<path with spaces>" hidden"  - the doubled outer quotes are how
' cmd.exe wants a quoted program path followed by arguments.
q = Chr(34)
sh.CurrentDirectory = scriptDir
' 0 = hidden window, False = don't wait for it to finish
sh.Run "cmd.exe /c " & q & q & batPath & q & " hidden" & q, 0, False
