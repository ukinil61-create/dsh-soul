@echo off
rem Double-click to restart the soul's desktop shell. The plugin reopens it within seconds.
del "%USERPROFILE%\.dsh\desk\dev-mode" 2>nul
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.CommandLine -match 'shell.main\.cjs' -and $_.CommandLine -notmatch '--type=' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
timeout /t 5
