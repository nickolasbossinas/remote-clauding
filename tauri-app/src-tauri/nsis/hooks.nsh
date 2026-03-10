!macro NSIS_HOOK_PREUNINSTALL
  ; Kill the running agent (read PID from agent.pid file)
  nsExec::ExecToLog 'powershell -NonInteractive -WindowStyle Hidden -Command "$f = Join-Path $env:APPDATA \"remote-clauding\agent.pid\"; if(Test-Path $f){Stop-Process -Id (Get-Content $f) -Force -ErrorAction SilentlyContinue}"'

  ; Kill tray helper process if still running
  nsExec::ExecToLog 'powershell -NonInteractive -WindowStyle Hidden -Command "Get-Process tray_windows_release -ErrorAction SilentlyContinue | Stop-Process -Force"'

  ; Kill any node process still on port 9680
  nsExec::ExecToLog 'powershell -NonInteractive -WindowStyle Hidden -Command "Get-NetTCPConnection -LocalPort 9680 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"'

  ; Uninstall from system npm (if installed there)
  nsExec::ExecToLog 'cmd /C npm uninstall -g remote-clauding 2>nul'

  ; Uninstall from portable npm (if installed there)
  nsExec::ExecToLog 'powershell -NonInteractive -WindowStyle Hidden -Command "$npm = Join-Path $env:APPDATA \"remote-clauding\node\npm.cmd\"; if(Test-Path $npm){ & $npm uninstall -g remote-clauding --prefix=(Join-Path $env:APPDATA \"remote-clauding\node\") 2>$null }"'

  ; Remove VSCode extension by deleting the directory directly
  nsExec::ExecToLog 'powershell -NonInteractive -WindowStyle Hidden -Command "Get-ChildItem \"$env:USERPROFILE\.vscode\extensions\" -Directory | Where-Object { $_.Name -like \"remote-clauding.*\" } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue"'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Remove all app data (config, portable node, etc.)
  RMDir /r "$APPDATA\remote-clauding"
!macroend
