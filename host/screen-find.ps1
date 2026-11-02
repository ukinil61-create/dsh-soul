param(
  [ValidateSet('taskbar', 'window', 'all')][string]$Scope = 'all',
  [string]$Query = '',
  # 只问这一个点上是什么，写法 "x,y"。点击前用它告诉她要点的是什么
  [string]$At = ''
)

# 问 Windows 屏幕上有哪些控件、各在哪。只读，不碰鼠标键盘。
# 从截图估小图标的坐标很不准，这里给的是系统自己的数字。

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class Fg {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@
[void][Fg]::SetProcessDPIAware()

$MaxPerRoot = 400
$MaxRows = 80
$Auto = [System.Windows.Automation.AutomationElement]
$Tree = [System.Windows.Automation.TreeScope]
$Cond = [System.Windows.Automation.PropertyCondition]
$root = $Auto::RootElement

$rows = New-Object System.Collections.ArrayList
$seen = @{}

function Add-Elements($element, [string]$where) {
  if (-not $element) { return }
  $all = $element.FindAll($Tree::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $count = [Math]::Min($all.Count, $MaxPerRoot)
  for ($i = 0; $i -lt $count; $i++) {
    try {
      $info = $all.Item($i).Current
      if ($info.IsOffscreen -or -not $info.Name) { continue }
      $box = $info.BoundingRectangle
      if ($box.IsEmpty -or $box.Width -lt 2 -or $box.Height -lt 2) { continue }
      if ($Query -and $info.Name -notlike "*$Query*") { continue }
      $x = [int]($box.X + $box.Width / 2)
      $y = [int]($box.Y + $box.Height / 2)
      $key = "$($info.Name)|$x|$y"
      if ($seen[$key]) { continue }
      $seen[$key] = $true
      $kind = $info.ControlType.ProgrammaticName -replace '^ControlType\.', ''
      [void]$rows.Add(@{ name = $info.Name; kind = $kind; x = $x; y = $y; w = [int]$box.Width; h = [int]$box.Height; where = $where })
    } catch { }
  }
}

if ($At) {
  $x, $y = $At.Split(',') | ForEach-Object { [double]$_ }
  $point = New-Object System.Windows.Point($x, $y)
  $hit = $Auto::FromPoint($point)
  # 任务栏这类 XAML 界面，FromPoint 只停在外面那层面板上。往里找包住这个点、有名字的最小那个
  $named = $null
  $smallest = [double]::MaxValue
  $inside = $hit.FindAll($Tree::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  for ($i = 0; $i -lt [Math]::Min($inside.Count, $MaxPerRoot); $i++) {
    try {
      $info = $inside.Item($i).Current
      if (-not $info.Name -or $info.IsOffscreen -or -not $info.BoundingRectangle.Contains($point)) { continue }
      $area = $info.BoundingRectangle.Width * $info.BoundingRectangle.Height
      if ($area -lt $smallest) { $smallest = $area; $named = $inside.Item($i) }
    } catch { }
  }
  # 最里层的常常没有名字（一块面板），往外找最近的有名字的那层
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  if (-not $named) { $named = $hit }
  for ($i = 0; $i -lt 6 -and $named -and -not $named.Current.Name; $i++) { $named = $walker.GetParent($named) }
  # 顶层窗口：说清楚是在任务栏、桌面还是哪个程序里
  $top = $hit
  while ($top) {
    $parent = $walker.GetParent($top)
    if (-not $parent -or $parent -eq $root) { break }
    $top = $parent
  }
  $info = if ($named) { $named.Current } else { $hit.Current }
  @{ at = @{
      name = $info.Name
      kind = $info.ControlType.ProgrammaticName -replace '^ControlType\.', ''
      window = if ($top) { $top.Current.Name } else { '' }
      windowClass = if ($top) { $top.Current.ClassName } else { '' }
    } } | ConvertTo-Json -Compress -Depth 4
  exit
}

if ($Scope -ne 'window') {
  foreach ($class in 'Shell_TrayWnd', 'TopLevelWindowForOverflowXamlIsland', 'NotifyIconOverflowWindow') {
    $condition = New-Object $Cond($Auto::ClassNameProperty, $class)
    Add-Elements ($root.FindFirst($Tree::Children, $condition)) 'taskbar'
  }
}
# 右键菜单是单独的窗口，不算前台窗口，哪个范围都要找
Add-Elements ($root.FindFirst($Tree::Children, (New-Object $Cond($Auto::ClassNameProperty, '#32768')))) 'menu'
if ($Scope -ne 'taskbar') {
  $handle = [Fg]::GetForegroundWindow()
  if ($handle -ne [IntPtr]::Zero) { Add-Elements ($Auto::FromHandle($handle)) 'window' }
}

$total = $rows.Count
@{ total = $total; rows = @($rows | Select-Object -First $MaxRows) } | ConvertTo-Json -Compress -Depth 4
