; Beebo Entertainment installer customisation (electron-builder 24, NSIS, oneClick).
;
; Included by electron-builder BEFORE its own templates (package.json build.nsis.include),
; for both the installer and the uninstaller compile passes. The build runs makensis
; with -WX (warnings are errors), so anything only the installer uses is guarded with
; !ifndef BUILD_UNINSTALLER, and only macros are used (an unused Function would warn).
;
; WHAT IT ADDS
;  1. The one-click progress window ("SpiderBanner") normally just says
;     "Installing, please wait...". Its text line is replaced at each step with
;     "Step 3 of 4: Copying Beebo's files (the big part)" plus the seconds so far and
;     "usually about N more seconds". NSIS can't redraw while a step runs (the 7-Zip
;     extract + copy is one blocking call of a minute or more), so the text is set at
;     each step boundary and worded as "usually", not as a countdown.
;     Measured on this PC (2026-09-16, per-user test build into %TEMP%): removing the
;     previous copy ~19 s, copying ~85 s, 112 s in all - hence the defaults below.
;     The total comes from --beebo-eta=<seconds> (the app passes how long installs
;     have really taken on this PC) or a default, and is stretched if the steps
;     done so far show this run is slower than expected.
;  2. update-in-progress.json in %ProgramData%\Beebo Entertainment while installing,
;     so the BeeboWatchdog task doesn't relaunch the old Beebo mid-install
;     (electron/updateMarker.js and Beebo-Watchdog.ps1 read the same file).
;  3. When started by the app for an update (--updated), give the app a few seconds
;     to quit by itself before electron-builder's standard "close it" logic.
;  4. The Windows Firewall rule for port 47811 (unchanged from build/installer.nsh).
;  5. Start at login is NOT done here: the app registers itself (electron/alwaysOn.js, started
;     with --hidden into the tray) after the first successful sign-in, because a person who
;     has not signed in yet has nothing to serve. Settings > Keep Beebo available turns it off.
;     It is deliberately not removed on uninstall/update here: the updater runs the old
;     uninstaller on every update, and the app re-applies the setting at each start anyway.

!include "getProcessInfo.nsh"
Var pid

!define BEEBO_MARKER_DIR "Beebo Entertainment"
!define BEEBO_MARKER_FILE "update-in-progress.json"
!define BEEBO_STEPS 4

!ifndef BUILD_UNINSTALLER
  Var beeboStartTick
  Var beeboEta
  Var beeboBannerSized
  Var beeboText

  ; Replace the banner's "Installing, please wait..." line (control 1000 of the
  ; banner dialog - the same lookup electron-builder's installSection.nsh uses to
  ; put that text there) and log the step. Preserves every register it touches.
  ; The text control is sized for one line; the first time, make it three lines tall
  ; (there is empty space above the progress bar) so the time estimate fits.
  !macro beeboSetBannerText TEXT
    ; Expand the text NOW: it may refer to $R0-$R3, which the sizing below reuses.
    StrCpy $beeboText "${TEXT}"
    Push $R1
    Push $R2
    Push $R3
    Push $R4
    Push $R5
    Push $R6
    FindWindow $R6 "#32770" "" $hwndparent
    FindWindow $R6 "#32770" "" $hwndparent $R6
    ${if} $R6 != 0
      GetDlgItem $R6 $R6 1000
      ${if} $R6 != 0
        ${if} $beeboBannerSized != "1"
          StrCpy $beeboBannerSized "1"
          System::Call '*(i,i,i,i)p.R5'
          System::Call 'user32::GetWindowRect(p R6, p R5)i'
          System::Call '*$R5(i.R1,i.R2,i.R3,i.R4)'
          System::Free $R5
          IntOp $R3 $R3 - $R1
          IntOp $R4 $R4 - $R2
          ${if} $R4 > 0
          ${andIf} $R4 < 40
            IntOp $R4 $R4 * 3
            ; SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE
            System::Call 'user32::SetWindowPos(p R6, p 0, i 0, i 0, i R3, i R4, i 0x16)i'
          ${endif}
        ${endif}
        SendMessage $R6 ${WM_SETTEXT} 0 "STR:$beeboText"
      ${endif}
    ${endif}
    Pop $R6
    Pop $R5
    Pop $R4
    Pop $R3
    Pop $R2
    Pop $R1
  !macroend

  ; STEP: 1-based step number. LABEL: what is happening. DONE_PCT: roughly how much
  ; of a typical install is finished when this step STARTS (used to stretch the
  ; estimate when this PC is slower than the estimate said).
  !macro beeboStatus STEP LABEL DONE_PCT
    Push $R0
    Push $R1
    Push $R2
    Push $R3
    System::Call 'kernel32::GetTickCount()i.R0'
    IntOp $R0 $R0 - $beeboStartTick
    ${if} $R0 < 0
      StrCpy $R0 0
    ${endif}
    IntOp $R0 $R0 / 1000
    StrCpy $R1 $beeboEta
    ${if} ${DONE_PCT} >= 20
      IntOp $R2 $R0 * 100
      IntOp $R2 $R2 / ${DONE_PCT}
      ${if} $R2 > $R1
        StrCpy $R1 $R2
      ${endif}
    ${endif}
    IntOp $R2 $R1 - $R0
    ${if} $R2 < 8
      StrCpy $R3 "almost done"
    ${elseif} $R2 < 90
      IntOp $R2 $R2 + 4
      IntOp $R2 $R2 / 5
      IntOp $R2 $R2 * 5
      StrCpy $R3 "usually about $R2 more seconds"
    ${else}
      IntOp $R2 $R2 + 30
      IntOp $R2 $R2 / 60
      StrCpy $R3 "usually about $R2 more minutes"
    ${endif}
    DetailPrint "Step ${STEP} of ${BEEBO_STEPS}: ${LABEL} ($R0 s)"
    !insertmacro beeboSetBannerText "Step ${STEP} of ${BEEBO_STEPS}: ${LABEL}$\r$\n$R0 seconds so far - $R3"
    Pop $R3
    Pop $R2
    Pop $R1
    Pop $R0
  !macroend

  !macro beeboWriteMarker
    Push $R0
    Push $R1
    ReadEnvStr $R0 PROGRAMDATA
    ${if} $R0 != ""
      CreateDirectory "$R0\${BEEBO_MARKER_DIR}"
      ClearErrors
      FileOpen $R1 "$R0\${BEEBO_MARKER_DIR}\${BEEBO_MARKER_FILE}" w
      ${ifNot} ${Errors}
        FileWrite $R1 '{"by":"installer","version":"${VERSION}"}'
        FileClose $R1
      ${endif}
      ClearErrors
    ${endif}
    Pop $R1
    Pop $R0
  !macroend

  !macro beeboClearMarker
    Push $R0
    ReadEnvStr $R0 PROGRAMDATA
    ${if} $R0 != ""
      Delete "$R0\${BEEBO_MARKER_DIR}\${BEEBO_MARKER_FILE}"
    ${endif}
    ClearErrors
    Pop $R0
  !macroend
!endif

; --- .onInit (installer) -----------------------------------------------------------
!macro customInit
  System::Call 'kernel32::GetTickCount()i.R0'
  StrCpy $beeboStartTick $R0
  ; The app measures "Beebo was closed" from launch to the new version starting,
  ; which includes the relaunch itself; the installer part is a little shorter.
  ${StdUtils.GetParameter} $R0 "beebo-eta" "0"
  IntOp $R0 $R0 + 0
  ${if} $R0 >= 15
  ${andIf} $R0 <= 900
    IntOp $R0 $R0 - 5
    StrCpy $beeboEta $R0
  ${elseif} ${isUpdated}
    StrCpy $beeboEta 95
  ${else}
    StrCpy $beeboEta 80
  ${endif}
!macroend

; --- first thing in the install section: close Beebo ---------------------------------
!macro customCheckAppRunning
  !ifndef BUILD_UNINSTALLER
    !insertmacro beeboWriteMarker
    !insertmacro beeboStatus 1 "Closing Beebo if it's running..." 0
    ${if} ${isUpdated}
      ; The app quits by itself right after starting us; don't kill it mid-cleanup
      ; (it releases router port forwards on the way out) unless it takes too long.
      StrCpy $R1 0
      beeboWaitForExit:
        !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
        ${if} $R0 == 0
        ${andIf} $R1 < 16
          IntOp $R1 $R1 + 1
          Sleep 500
          Goto beeboWaitForExit
        ${endif}
    ${endif}
  !endif
  !insertmacro _CHECK_APP_RUNNING
  !ifndef BUILD_UNINSTALLER
    !insertmacro beeboStatus 2 "Removing the old version (your films and settings stay)..." 10
  !endif
!macroend

; --- after the old version's uninstaller ran (installer only) ------------------------
; Defining this macro REPLACES electron-builder's own result check, so that check is
; reproduced exactly here before the status line changes.
!macro customUnInstallCheck
  ${if} ${Errors}
    DetailPrint `Uninstall was not successful. Not able to launch uninstaller!`
  ${else}
    ${if} $R0 != 0
      MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed): $R0"
      DetailPrint `Uninstall was not successful. Uninstaller error code: $R0.`
      SetErrorLevel 2
      Quit
    ${endif}
  ${endif}
  !insertmacro beeboStatus 3 "Copying Beebo's files - this is the big part..." 30
!macroend

; (No step between "copying" and "finishing": the only hook there, customFiles_x64,
; is generated by electron-builder itself for pre-compressed resources like the .mp4.)

; --- end of the install section ---------------------------------------------------
!macro customInstall
  !ifdef INSTALL_MODE_PER_ALL_USERS
    !insertmacro beeboStatus 4 "Letting phones on your Wi-Fi reach Beebo..." 90
    ; Open the Windows Firewall so phones/tablets on the same Wi-Fi can reach the
    ; Beebo server (port 47811). Elevated per-machine install, so no manual step.
    nsExec::Exec 'netsh advfirewall firewall delete rule name="Beebo Entertainment"'
    Pop $R0
    nsExec::Exec 'netsh advfirewall firewall add rule name="Beebo Entertainment" dir=in action=allow protocol=TCP localport=47811 profile=any'
    Pop $R0
  !endif
  DetailPrint "Beebo will start quietly with Windows after you sign in to it (turn this off in Settings)."
  !insertmacro beeboStatus 4 "Done - starting Beebo..." 98
  !insertmacro beeboClearMarker
!macroend

!macro customUnInstall
  ; Same guard as the install side: only the elevated per-machine build owns the rule
  ; (a per-user test build must never remove the real one).
  !ifdef INSTALL_MODE_PER_ALL_USERS
    nsExec::Exec 'netsh advfirewall firewall delete rule name="Beebo Entertainment"'
    Pop $R0
  !endif
!macroend
