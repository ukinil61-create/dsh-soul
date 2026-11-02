# 安装灵魂：补齐运行时、编译守护进程、挂进 desktop profile、写开机自启。可以重复运行。
# 用法：powershell -ExecutionPolicy Bypass -File install.ps1 [-SpeechModel]
#   -SpeechModel  另外下载本机转文字模型（约 220MB）。不下也能用，退回 DSH 自带的识别
param([switch]$SpeechModel)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$root = $PSScriptRoot
$dsh = Join-Path $env:USERPROFILE '.dsh'
$keeper = Join-Path $root 'keeper\dsh-desk-keeper.exe'

$profilePkg = Join-Path $dsh 'profiles\desktop\package.json'
if (-not (Test-Path $profilePkg)) {
    throw "找不到 $profilePkg。先安装并打开一次 DeepSeek Harness 桌面版。"
}

# 依次试几个地址，全失败返回 $false，由调用方决定是降级还是退出
function Get-File($urls, $out) {
    foreach ($url in $urls) {
        try {
            Write-Output "下载 $url"
            Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $out
            return $true
        } catch {
            Write-Output "  失败：$($_.Exception.Message)"
        }
    }
    return $false
}

# 解开 tar.bz2，把唯一的顶层目录改名成 $dest
function Expand-TarBz2($archive, $dest) {
    $tmp = "$dest.extract"
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    tar -xjf $archive -C $tmp
    if ($LASTEXITCODE -ne 0) { throw "解压失败：$archive" }
    $inner = Get-ChildItem -LiteralPath $tmp -Directory | Select-Object -First 1
    Remove-Item -LiteralPath $dest -Recurse -Force -ErrorAction SilentlyContinue
    Move-Item -LiteralPath $inner.FullName -Destination $dest
    Remove-Item -LiteralPath $tmp -Recurse -Force
}

# 1. Electron。和桌宠共用 ~/.dsh/electron，版本也和它一致；装过桌宠就跳过
$electronDir = Join-Path $dsh 'electron'
$electron = Join-Path $electronDir 'electron.exe'
if (-not (Test-Path $electron)) {
    $version = '43.3.0'
    $zip = Join-Path $env:TEMP "electron-v$version-win32-x64.zip"
    $ok = Get-File @(
        "https://npmmirror.com/mirrors/electron/$version/electron-v$version-win32-x64.zip",
        "https://github.com/electron/electron/releases/download/v$version/electron-v$version-win32-x64.zip"
    ) $zip
    if (-not $ok) { throw '下载 Electron 失败，检查网络后重新运行。' }
    Expand-Archive -LiteralPath $zip -DestinationPath $electronDir -Force
    Remove-Item -LiteralPath $zip
}

# 2. 唤醒模型。没有也能用，只是不能喊名字叫它，快捷键照常
$kwsReady = @((Join-Path $dsh 'desk\kws'), (Join-Path $dsh 'dsh-pet\kws')) |
    Where-Object { Test-Path $_ } |
    Where-Object { Get-ChildItem -LiteralPath $_ -Recurse -Filter 'tokens.txt' -ErrorAction SilentlyContinue }
if (-not $kwsReady) {
    $name = 'sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01'
    $archive = Join-Path $env:TEMP "$name.tar.bz2"
    if (Get-File @("https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/$name.tar.bz2") $archive) {
        $kwsDir = Join-Path $dsh 'desk\kws'
        New-Item -ItemType Directory -Force -Path $kwsDir | Out-Null
        Expand-TarBz2 $archive (Join-Path $kwsDir $name)
        Remove-Item -LiteralPath $archive
    } else {
        Write-Output '唤醒模型没下到：喊名字叫不醒它，Ctrl+Alt+V 说话照常。以后重新运行本脚本即可补上。'
    }
}

# 3. 可选：本机转文字模型
$stt = Join-Path $dsh 'speech-to-text\paraformer-zh'
if ($SpeechModel -and -not (Test-Path (Join-Path $stt 'model.int8.onnx'))) {
    $name = 'sherpa-onnx-paraformer-zh-2023-09-14'
    $archive = Join-Path $env:TEMP "$name.tar.bz2"
    if (Get-File @("https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/$name.tar.bz2") $archive) {
        New-Item -ItemType Directory -Force -Path (Split-Path $stt) | Out-Null
        Expand-TarBz2 $archive $stt
        Remove-Item -LiteralPath $archive
    } else {
        Write-Output '转文字模型没下到，先用 DSH 自带的识别。'
    }
}

# 4. 守护进程。不发预编译的 exe，用系统自带的编译器现场编
# 运行中的 exe 被占用，编译前先停
Get-Process -Name 'dsh-desk-keeper' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500

Push-Location (Join-Path $root 'keeper')
try {
    & "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:winexe /optimize+ `
        /out:dsh-desk-keeper.exe /r:System.Windows.Forms.dll /r:System.Core.dll Keeper.cs
    if ($LASTEXITCODE -ne 0) { throw "keeper compile failed" }
    & "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:exe /optimize+ `
        /out:desk-icons.exe /r:System.Windows.Forms.dll /r:System.Drawing.dll DeskIcons.cs
    if ($LASTEXITCODE -ne 0) { throw "desk-icons compile failed" }
} finally {
    Pop-Location
}

# 5. 挂进 desktop profile。别人的电脑上不一定有 node，借 Electron 自带的跑
& (Join-Path $root 'scripts\run-node.ps1') (Join-Path $root 'scripts\profile-link.cjs') install
# 让运行中的 DeepSeek Harness 重新读 profile，不用重启
(Get-Item (Join-Path $dsh 'profiles\desktop\cordis.patch.yml')).LastWriteTime = Get-Date


Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'DshDesk' -Value "`"$keeper`""
Remove-Item -LiteralPath (Join-Path $dsh 'desk\paused') -ErrorAction SilentlyContinue
# 经 explorer 启动：不算这个脚本的子进程，开它的终端或工具关掉时不会被一起带走
Start-Process -FilePath 'explorer.exe' -ArgumentList ('"' + $keeper + '"')

Write-Output '已安装。第一次安装要重启一次 DeepSeek Harness（插件只在启动时加载）。'
