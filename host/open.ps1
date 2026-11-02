param(
  [Parameter(Mandatory = $true)][string]$Target,
  [string]$Arguments = ''
)

# 在沙箱外面打开文件、文件夹、网址或程序，像用户双击一样。
# 她的命令行跑在 DSH 的沙箱里，从那里开的浏览器、记事本窗口用户看不见，
# 所以这件事由后台进程来做，它和用户在同一个桌面上。

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class Front {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public static string Title(IntPtr h) { var s = new StringBuilder(512); GetWindowTextW(h, s, 512); return s.ToString(); }
  public static uint Pid(IntPtr h) { uint pid; GetWindowThreadProcessId(h, out pid); return pid; }
  // 后台进程不能随便抢前台。先发一个空按键，系统就当它刚收到过输入（Keeper.cs 用的同一招）
  public static void Raise(IntPtr h) {
    keybd_event(0, 0, 0, IntPtr.Zero);
    keybd_event(0, 0, 2, IntPtr.Zero);
    if (IsIconic(h)) ShowWindow(h, 9);
    SetForegroundWindow(h);
  }
}
'@
[void][Front]::SetProcessDPIAware()

$start = @{ FilePath = $Target; PassThru = $true }
# 参数是一个带空格的路径时要加引号，不然程序收到的是拆开的几段
if ($Arguments -match '\s' -and $Arguments -notmatch '"' -and (Test-Path -LiteralPath $Arguments)) { $Arguments = "`"$Arguments`"" }
if ($Arguments) { $start.ArgumentList = $Arguments }
$process = Start-Process @start

# 自己起了新进程的，等它的窗口出来再提到前面。网址、文件常常交给已经开着的程序，就没有这个进程
$raised = $false
if ($process) {
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 250
    $process.Refresh()
    if ($process.HasExited) { break }
    if ($process.MainWindowHandle -ne [IntPtr]::Zero) {
      [Front]::Raise($process.MainWindowHandle)
      $raised = $true
      break
    }
  }
}
if (-not $raised) { Start-Sleep -Milliseconds 1500 }

$h = [Front]::GetForegroundWindow()
$name = ''
try { $name = (Get-Process -Id ([Front]::Pid($h))).ProcessName } catch { }
@{ ok = $true; foreground = @{ process = $name; title = [Front]::Title($h) } } | ConvertTo-Json -Compress -Depth 3
