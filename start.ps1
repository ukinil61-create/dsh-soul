# 从托盘「退出」之后，用这个脚本把它叫回来（或者重启电脑也会回来）。
Remove-Item -LiteralPath (Join-Path $env:USERPROFILE '.dsh\desk\paused') -ErrorAction SilentlyContinue
# 经 explorer 启动：不算这个脚本的子进程，开它的终端或工具关掉时不会被一起带走
Start-Process -FilePath 'explorer.exe' -ArgumentList ('"' + (Join-Path $PSScriptRoot 'keeper\dsh-desk-keeper.exe') + '"')
