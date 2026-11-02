# 卸载桌面面板：停守护进程、摘掉插件、删开机自启。App 和会话不受影响。
$ErrorActionPreference = 'Continue'
$root = $PSScriptRoot

# 先立这个标记：插件不再重开外壳，外壳也不再把守护进程叫回来。重新安装时会删掉
New-Item -ItemType Directory -Force -Path (Join-Path $env:USERPROFILE '.dsh\desk') | Out-Null
Set-Content -LiteralPath (Join-Path $env:USERPROFILE '.dsh\desk\paused') -Value (Get-Date -Format o)

Get-Process -Name 'dsh-desk-keeper' -ErrorAction SilentlyContinue | Stop-Process -Force
Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'DshDesk' -ErrorAction SilentlyContinue

Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
    Where-Object { $_.CommandLine -like '*shell\main.cjs*' -and $_.CommandLine -like "*$(Split-Path $root -Leaf)*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

& (Join-Path $root 'scripts\run-node.ps1') (Join-Path $root 'scripts\profile-link.cjs') uninstall
(Get-Item (Join-Path $env:USERPROFILE '.dsh\profiles\desktop\cordis.patch.yml')).LastWriteTime = Get-Date

Write-Output '已卸载。重启一次 DeepSeek Harness 后彻底生效；~/.dsh/desk 里的日志和布局可以手动删除。'
