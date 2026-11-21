!macro customCheckAppRunning
  Push $0
  Push $1
  Push $2
  StrCpy $2 0

  opengeo_check_executable:
    # Windows refuses write access to a mapped executable. Check the exact
    # installed file without opening a process or writing to the installation.
    # FILE_WRITE_DATA, FILE_SHARE_READ|WRITE|DELETE, OPEN_EXISTING.
    System::Call 'kernel32::CreateFileW(w "$INSTDIR\${APP_EXECUTABLE_FILENAME}", i 2, i 7, p 0, i 3, i 0, p 0) p .r0 ?e'
    Pop $1
    StrCmp $0 -1 opengeo_executable_unavailable
    System::Call 'kernel32::CloseHandle(p r0)'
    Goto opengeo_check_complete

  opengeo_executable_unavailable:
    StrCmp $1 2 opengeo_check_complete ; ERROR_FILE_NOT_FOUND
    StrCmp $1 3 opengeo_check_complete ; ERROR_PATH_NOT_FOUND
    StrCmp $1 32 opengeo_wait_for_exit ; ERROR_SHARING_VIOLATION
    StrCmp $1 33 opengeo_wait_for_exit ; ERROR_LOCK_VIOLATION
    Goto opengeo_request_close

  opengeo_wait_for_exit:
    # Give a requested app shutdown time to release its executable.
    IntOp $2 $2 + 1
    IntCmpU $2 20 opengeo_request_close
    Sleep 200
    Goto opengeo_check_executable

  opengeo_request_close:
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY opengeo_retry_check
    SetErrorLevel 1
    Quit

  opengeo_retry_check:
    StrCpy $2 0
    Goto opengeo_check_executable

  opengeo_check_complete:
    Pop $2
    Pop $1
    Pop $0
!macroend

!macro customFinishPage
  Function OpenGeoStart
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" ""
  FunctionEnd
  Function OpenGeoShortcut
    CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
  FunctionEnd
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_TEXT "Open OpenGEO"
  !define MUI_FINISHPAGE_RUN_FUNCTION OpenGeoStart
  !define MUI_FINISHPAGE_SHOWREADME ""
  !define MUI_FINISHPAGE_SHOWREADME_TEXT "Create a desktop shortcut"
  !define MUI_FINISHPAGE_SHOWREADME_FUNCTION OpenGeoShortcut
  !insertmacro MUI_PAGE_FINISH
!macroend
