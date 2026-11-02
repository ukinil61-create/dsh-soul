# 跑一个 Node 脚本：有 node 用 node，没有就借 ~/.dsh/electron 当 node 用。失败时抛错
# electron.exe 是窗口程序，PowerShell 直接调用不等它也拿不到输出，所以走 Start-Process
param([Parameter(Mandatory)][string]$Script, [Parameter(ValueFromRemainingArguments)][string[]]$Rest)
$ErrorActionPreference = 'Stop'
$quoted = @($Script) + $Rest | ForEach-Object { '"' + $_ + '"' }

if (Get-Command node -ErrorAction SilentlyContinue) {
    $exe = (Get-Command node).Source
} else {
    $exe = Join-Path $env:USERPROFILE '.dsh\electron\electron.exe'
    $env:ELECTRON_RUN_AS_NODE = '1'
}
$out = [IO.Path]::GetTempFileName()
$err = [IO.Path]::GetTempFileName()
try {
    $p = Start-Process -FilePath $exe -ArgumentList $quoted -Wait -PassThru -NoNewWindow -RedirectStandardOutput $out -RedirectStandardError $err
    Get-Content -LiteralPath $out, $err -Encoding UTF8
    if ($p.ExitCode -ne 0) { throw "$Script 失败（退出码 $($p.ExitCode)）" }
} finally {
    Remove-Item -LiteralPath $out, $err -ErrorAction SilentlyContinue
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
}
