// dsh-desk 守护进程：开机自启，只干 Electron 干不了的事。
//   1. 把灵魂窗口挂进壁纸层（Progman 下的 WorkerW），真图标浮在它上面。
//   2. 点空白桌面时把键盘交给灵魂。壁纸层默认是禁用的，也收不到鼠标，这些都得手动给。
//   3. 浮层用完后把前台还给原窗口，Windows 不会自动还。
//   4. 告诉外壳现在桌面是不是在最前面，它据此决定快捷键用壁纸层还是浮层。
//   5. 保证 DeepSeek Harness 活着：没在跑就拉起并把主窗口藏到托盘。灵魂跟着插件起来。

using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

static class Keeper
{
    const string SoulTitle = "DSH Soul";
    const string PanelTitle = "DSH Soul Panel";
    const string TabTitle = "DSH Soul Tab";
    const string RaiseSuffix = " (raise)";
    const string OverlayTitle = "DSH Soul Overlay";
    const string WantFocusSuffix = " (focus)";
    const string ReleaseSuffix = " (release)";
    const string KeySuffix = " (key:";
    const string AppProcess = "DeepSeek Harness";

    const int WH_MOUSE_LL = 14;
    const int WM_LBUTTONDOWN = 0x0201;
    const int WM_LBUTTONUP = 0x0202;
    const int GWL_STYLE = -16;
    const long WS_CHILD = 0x40000000L;
    const long WS_POPUP = 0x80000000L;
    const long WS_CAPTION = 0x00C00000L;
    const long WS_THICKFRAME = 0x00040000L;
    const uint SWP_NOACTIVATE = 0x0010;
    const uint SWP_FRAMECHANGED = 0x0020;
    const uint SWP_SHOWWINDOW = 0x0040;
    const uint WM_CLOSE = 0x0010;
    const uint WM_FOCUS_PAGE = 0x8001;
    const uint WM_DROP_OPEN = 0x8002;
    const uint WM_DROP_CLOSE = 0x8003;
    const uint WM_DESKTOP_FOREGROUND = 0x8004;
    const uint WM_WHEEL = 0x8005;
    const int WM_MOUSEMOVE = 0x0200;
    const int WM_MOUSEWHEEL = 0x020A;
    const int DragSlop = 12;
    const uint LVM_GETSELECTEDCOUNT = 0x1032;
    const uint SMTO_ABORTIFHUNG = 2;
    const uint SPAWN_WORKERW = 0x052C;
    const uint KEYEVENTF_KEYUP = 2;
    const byte VK_SHIFT = 0x10;
    const byte VK_CONTROL = 0x11;
    const byte VK_F5 = 0x74;
    const int ClickSlop = 5;

    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct MouseHook { public POINT Pt; public uint Data, Flags, Time; public IntPtr Extra; }

    delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);
    delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);

    [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id, HookProc proc, IntPtr module, uint thread);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc proc, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindow(string cls, string title);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool EnableWindow(IntPtr hwnd, bool enable);
    [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr hwnd);
    [DllImport("user32.dll")] static extern IntPtr SetParent(IntPtr child, IntPtr parent);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT pt);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int w, int h, uint flags);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from, uint to, bool attach);
    [DllImport("user32.dll")] static extern IntPtr SetFocus(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr hwnd, int index);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] static extern IntPtr SetWindowLongPtr(IntPtr hwnd, int index, IntPtr value);
    [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW")] static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint msg, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);

    static readonly string Home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
    static readonly string StateDir = Path.Combine(Home, ".dsh", "desk");
    static readonly string PausedFlag = Path.Combine(StateDir, "paused");
    static readonly string LogFile = Path.Combine(StateDir, "keeper.log");
    static readonly string PidFile = Path.Combine(StateDir, "keeper.pid");
    static readonly string SafeStart = Path.Combine(Home, ".dsh", "tools", "start-desktop-safe.ps1");
    static readonly string AppExe = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "DeepSeek Harness", "DeepSeek Harness.exe");

    // App 没了先等一等：官方更新安装时也会退出，抢着拉起来会撞车
    static readonly TimeSpan RelaunchGrace = TimeSpan.FromSeconds(45);
    static readonly TimeSpan HideTimeout = TimeSpan.FromSeconds(90);

    // 钩子回调必须有强引用，否则被 GC 回收后一触发就崩
    static HookProc mouseProc;
    static System.Windows.Forms.Timer checkTimer;
    static bool overlayWasFront;
    static System.Windows.Forms.Timer dragTimer;
    static System.Windows.Forms.Timer panelFocusTimer;
    static IntPtr panel = IntPtr.Zero;
    static bool raiseHandled;
    static bool buttonDown;
    static bool dragDecided;
    static bool dropZoneOpen;
    static IntPtr soul = IntPtr.Zero;
    static IntPtr lastForeground = IntPtr.Zero;
    static IntPtr reportedSoul = IntPtr.Zero;
    static bool reportedDesktop;
    static bool focusHandled;
    static bool releaseHandled;
    static string keyHandled = "";
    static POINT downAt;
    static POINT upAt;
    static bool downOnDesktop;
    static DateTime appGoneSince = DateTime.MinValue;
    static DateTime hideDeadline = DateTime.MinValue;

    static void Log(string line)
    {
        try { File.AppendAllText(LogFile, DateTime.Now.ToString("s") + " " + line + "\r\n"); }
        catch (IOException) { }
    }

    static string TitleOf(IntPtr hwnd)
    {
        var text = new StringBuilder(128);
        GetWindowText(hwnd, text, text.Capacity);
        return text.ToString();
    }

    static string ClassOf(IntPtr hwnd)
    {
        var text = new StringBuilder(64);
        GetClassName(hwnd, text, text.Capacity);
        return text.ToString();
    }

    static IntPtr Desktop()
    {
        return FindWindow("Progman", null);
    }

    /** Win11 24H2 以后壁纸层是 Progman 的子窗口，排在 SHELLDLL_DefView 之下 */
    static IntPtr WallpaperLayer()
    {
        var progman = Desktop();
        if (progman == IntPtr.Zero) return IntPtr.Zero;
        var layer = FindWindowEx(progman, IntPtr.Zero, "WorkerW", null);
        if (layer != IntPtr.Zero) return layer;
        // 资源管理器刚重启时可能还没有这一层，这条未公开的消息让它生成
        IntPtr ignored;
        SendMessageTimeout(progman, SPAWN_WORKERW, IntPtr.Zero, IntPtr.Zero, SMTO_ABORTIFHUNG, 1000, out ignored);
        return FindWindowEx(progman, IntPtr.Zero, "WorkerW", null);
    }

    static bool IsSoulTitle(string title)
    {
        return title.StartsWith(SoulTitle) && !title.StartsWith(OverlayTitle) && !title.StartsWith(PanelTitle) && !title.StartsWith(TabTitle);
    }

    /** 会话界面是普通的顶层窗口：输入法只认真正的前台窗口，子窗口切不了中英文 */
    static IntPtr FindPanel()
    {
        if (panel != IntPtr.Zero && IsWindow(panel) && TitleOf(panel).StartsWith(PanelTitle)) return panel;
        var found = IntPtr.Zero;
        EnumProc visit = delegate (IntPtr hwnd, IntPtr l)
        {
            if (!TitleOf(hwnd).StartsWith(PanelTitle)) return true;
            found = hwnd;
            return false;
        };
        EnumWindows(visit, IntPtr.Zero);
        GC.KeepAlive(visit);
        return panel = found;
    }

    /** 小按钮挂成桌面的子窗口，排在图标层之上：露出桌面才看得到，不会盖住别的窗口 */
    static void EmbedTab()
    {
        var found = IntPtr.Zero;
        EnumProc visit = delegate (IntPtr hwnd, IntPtr l)
        {
            if (!TitleOf(hwnd).StartsWith(TabTitle)) return true;
            found = hwnd;
            return false;
        };
        EnumWindows(visit, IntPtr.Zero);
        GC.KeepAlive(visit);
        var desktop = Desktop();
        if (found == IntPtr.Zero || desktop == IntPtr.Zero || !IsWindowVisible(found)) return;
        RECT r;
        GetWindowRect(found, out r);
        long style = (long)GetWindowLongPtr(found, GWL_STYLE);
        SetWindowLongPtr(found, GWL_STYLE, new IntPtr((style & ~(WS_POPUP | WS_CAPTION | WS_THICKFRAME)) | WS_CHILD));
        SetParent(found, desktop);
        SetWindowPos(found, IntPtr.Zero, r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top, SWP_FRAMECHANGED | SWP_SHOWWINDOW | SWP_NOACTIVATE);
        Log("tab embedded");
    }

    /** 前台锁只放行“收到了最后一次输入”的进程，这个空按键不会产生任何字符 */
    static void BringToFront(IntPtr hwnd)
    {
        uint pid;
        uint thread = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
        uint me = GetCurrentThreadId();
        keybd_event(0, 0, 0, IntPtr.Zero);
        keybd_event(0, 0, KEYEVENTF_KEYUP, IntPtr.Zero);
        bool attached = thread != 0 && AttachThreadInput(me, thread, true);
        SetForegroundWindow(hwnd);
        if (attached) AttachThreadInput(me, thread, false);
    }

    static void GivePanelFocus()
    {
        var hwnd = FindPanel();
        if (hwnd != IntPtr.Zero) BringToFront(hwnd);
    }

    /** 外壳要打开会话界面：窗口都收起来露出桌面，再把键盘交过去 */
    static void HandlePanelRaise()
    {
        var hwnd = FindPanel();
        bool wanted = hwnd != IntPtr.Zero && TitleOf(hwnd).EndsWith(RaiseSuffix);
        if (!wanted) { raiseHandled = false; return; }
        if (raiseHandled) return;
        raiseHandled = true;
        var fg = GetForegroundWindow();
        var cls = ClassOf(fg);
        if (cls != "Progman" && cls != "WorkerW" && fg != hwnd)
        {
            try
            {
                var shell = Activator.CreateInstance(Type.GetTypeFromProgID("Shell.Application"));
                shell.GetType().InvokeMember("MinimizeAll", System.Reflection.BindingFlags.InvokeMethod, null, shell, null);
                Marshal.ReleaseComObject(shell);
            }
            catch (Exception e) { Log("show desktop failed: " + e.Message); }
        }
        panelFocusTimer.Stop();
        panelFocusTimer.Interval = 250;
        panelFocusTimer.Start();
    }

    /** 灵魂窗口可能还是顶层窗口（刚启动），也可能已经挂进壁纸层 */
    static IntPtr FindSoul()
    {
        if (soul != IntPtr.Zero && IsWindow(soul) && IsSoulTitle(TitleOf(soul))) return soul;
        var found = IntPtr.Zero;
        EnumProc visit = delegate (IntPtr hwnd, IntPtr l)
        {
            if (!IsSoulTitle(TitleOf(hwnd))) return true;
            found = hwnd;
            return false;
        };
        EnumWindows(visit, IntPtr.Zero);
        var layer = WallpaperLayer();
        if (found == IntPtr.Zero && layer != IntPtr.Zero) EnumChildWindows(layer, visit, IntPtr.Zero);
        GC.KeepAlive(visit);
        return soul = found;
    }

    /** 资源管理器重启后 Progman 是新窗口，旧窗口已随它销毁，外壳重开后这里会再挂一次 */
    static void Embed()
    {
        var hwnd = FindSoul();
        var layer = WallpaperLayer();
        if (hwnd == IntPtr.Zero || layer == IntPtr.Zero || GetParent(hwnd) == layer) return;
        // 还没显示出来就别挂：外壳在 ready-to-show 之后才亮出窗口
        if (!IsWindowVisible(hwnd)) return;

        RECT r;
        GetWindowRect(hwnd, out r);
        long style = (long)GetWindowLongPtr(hwnd, GWL_STYLE);
        // 无边框窗口也带着隐形的窗框样式，挂进来后会在四周留出 8 像素
        SetWindowLongPtr(hwnd, GWL_STYLE, new IntPtr((style & ~(WS_POPUP | WS_CAPTION | WS_THICKFRAME)) | WS_CHILD));
        SetParent(hwnd, layer);
        // 外壳把窗口放在屏幕外启动的，这里才摆回原点
        SetWindowPos(hwnd, IntPtr.Zero, 0, 0, r.Right - r.Left, r.Bottom - r.Top, SWP_FRAMECHANGED | SWP_SHOWWINDOW | SWP_NOACTIVATE);
        Log("soul embedded into wallpaper layer");
    }

    /** x、y 为负表示没有点击位置，用固定输入区 */
    static void GiveFocus(int x, int y)
    {
        var hwnd = FindSoul();
        if (hwnd == IntPtr.Zero) return;
        uint pid;
        uint thread = GetWindowThreadProcessId(hwnd, out pid);
        uint me = GetCurrentThreadId();
        // 壁纸层默认是禁用的，禁用窗口的子窗口拿不到键盘焦点
        EnableWindow(GetParent(hwnd), true);
        if (!AttachThreadInput(me, thread, true)) return;
        SetFocus(hwnd);
        AttachThreadInput(me, thread, false);
        // 鼠标没进过 Chromium，它不知道该把焦点交给页面，得告诉外壳
        long packed = (long)(x & 0xFFFF) | ((long)(y & 0xFFFF) << 16);
        PostMessage(hwnd, WM_FOCUS_PAGE, IntPtr.Zero, new IntPtr(packed));
    }

    static IntPtr IconList()
    {
        var view = FindWindowEx(Desktop(), IntPtr.Zero, "SHELLDLL_DefView", null);
        return view == IntPtr.Zero ? IntPtr.Zero : FindWindowEx(view, IntPtr.Zero, "SysListView32", null);
    }

    /** 没有选中的图标，说明这次单击落在空白处：点中图标一定会选中它 */
    static void CheckBlankClick()
    {
        var list = IconList();
        if (list == IntPtr.Zero) return;
        // 不是点击触发的（没有点击位置）时，前台必须确实是桌面，不然会抢别的窗口的键盘
        if (upAt.X < 0 && !IsDesktopClass(ClassOf(GetForegroundWindow()))) return;
        IntPtr count;
        if (SendMessageTimeout(list, LVM_GETSELECTEDCOUNT, IntPtr.Zero, IntPtr.Zero, SMTO_ABORTIFHUNG, 200, out count) == IntPtr.Zero) return;
        if (count == IntPtr.Zero) GiveFocus(upAt.X, upAt.Y);
    }

    /** 真的在拖东西，而且光的位置露着桌面，才打开拖放区。框选和被窗口盖住时都不开 */
    static void DecideDrag()
    {
        if (!buttonDown || FindSoul() == IntPtr.Zero) return;
        var bounds = Screen.PrimaryScreen.Bounds;
        var lightAt = new POINT { X = bounds.Width * 6 / 10, Y = bounds.Height * 38 / 100 };
        if (ClassOf(WindowFromPoint(lightAt)) != "SysListView32") return;
        if (downOnDesktop)
        {
            IntPtr count;
            var list = IconList();
            // 按在图标上时它已经被选中；框选是按在空白处，这时没有选中项
            if (list == IntPtr.Zero || SendMessageTimeout(list, LVM_GETSELECTEDCOUNT, IntPtr.Zero, IntPtr.Zero, SMTO_ABORTIFHUNG, 200, out count) == IntPtr.Zero || count == IntPtr.Zero) return;
        }
        dropZoneOpen = true;
        PostMessage(soul, WM_DROP_OPEN, IntPtr.Zero, IntPtr.Zero);
    }

    static IntPtr OnMouse(int code, IntPtr wParam, IntPtr lParam)
    {
        if (code >= 0)
        {
            int msg = wParam.ToInt32();
            if (msg == WM_MOUSEMOVE)
            {
                if (buttonDown && !dragDecided)
                {
                    var data = (MouseHook)Marshal.PtrToStructure(lParam, typeof(MouseHook));
                    if (Math.Abs(data.Pt.X - downAt.X) + Math.Abs(data.Pt.Y - downAt.Y) > DragSlop)
                    {
                        dragDecided = true;
                        // 钩子里不能跨进程问图标层，放到定时器里判断
                        dragTimer.Stop();
                        dragTimer.Start();
                    }
                }
            }
            else if (msg == WM_MOUSEWHEEL)
            {
                var data = (MouseHook)Marshal.PtrToStructure(lParam, typeof(MouseHook));
                if (soul != IntPtr.Zero && ClassOf(WindowFromPoint(data.Pt)) == "SysListView32")
                    PostMessage(soul, WM_WHEEL, new IntPtr((short)(data.Data >> 16)), IntPtr.Zero);
            }
            else if (msg == WM_LBUTTONDOWN || msg == WM_LBUTTONUP)
            {
                var data = (MouseHook)Marshal.PtrToStructure(lParam, typeof(MouseHook));
                bool onDesktop = ClassOf(WindowFromPoint(data.Pt)) == "SysListView32";
                buttonDown = msg == WM_LBUTTONDOWN;
                if (msg == WM_LBUTTONDOWN)
                {
                    downAt = data.Pt;
                    downOnDesktop = onDesktop;
                    dragDecided = false;
                }
                else if (dropZoneOpen)
                {
                    dropZoneOpen = false;
                    PostMessage(soul, WM_DROP_CLOSE, IntPtr.Zero, IntPtr.Zero);
                }
                else if (onDesktop && downOnDesktop && Math.Abs(data.Pt.X - downAt.X) < ClickSlop && Math.Abs(data.Pt.Y - downAt.Y) < ClickSlop)
                {
                    upAt = data.Pt;
                    // 钩子里不能干活，鼠标会卡。等图标层处理完这次单击再判断
                    checkTimer.Stop();
                    checkTimer.Start();
                }
            }
        }
        return CallNextHookEx(IntPtr.Zero, code, wParam, lParam);
    }

    /** 浮层隐藏或要求放手后，把前台还给用户之前在用的窗口 */
    static void TrackForeground()
    {
        var fg = GetForegroundWindow();
        if (fg == IntPtr.Zero) return;
        var title = TitleOf(fg);
        if (!title.StartsWith(OverlayTitle))
        {
            lastForeground = fg;
            releaseHandled = false;
            ReportDesktop(fg);
            // 浮层说完话收起、前台回到桌面：键盘也要回到页面上，下次回车才能直接呼出输入框
            if (overlayWasFront && IsDesktopClass(ClassOf(fg))) FocusPageSoon();
            overlayWasFront = false;
            return;
        }
        overlayWasFront = true;
        bool release = title.EndsWith(ReleaseSuffix) || !IsWindowVisible(fg);
        if (!release || releaseHandled || lastForeground == IntPtr.Zero || !IsWindow(lastForeground)) return;
        releaseHandled = true;
        uint pid;
        uint thread = GetWindowThreadProcessId(fg, out pid);
        uint me = GetCurrentThreadId();
        // 前台锁只放行“收到了最后一次输入”的进程，这个空按键不会产生任何字符
        keybd_event(0, 0, 0, IntPtr.Zero);
        keybd_event(0, 0, KEYEVENTF_KEYUP, IntPtr.Zero);
        AttachThreadInput(me, thread, true);
        SetForegroundWindow(lastForeground);
        AttachThreadInput(me, thread, false);
    }

    static void ReportDesktop(IntPtr fg)
    {
        var hwnd = FindSoul();
        if (hwnd == IntPtr.Zero) return;
        bool desktop = IsDesktopClass(ClassOf(fg));
        if (desktop == reportedDesktop && hwnd == reportedSoul) return;
        reportedDesktop = desktop;
        reportedSoul = hwnd;
        PostMessage(hwnd, WM_DESKTOP_FOREGROUND, new IntPtr(desktop ? 1 : 0), IntPtr.Zero);
        // 回到桌面时没有选中图标，就直接把键盘交给页面，不用先点一下桌面
        if (desktop) FocusPageSoon();
    }

    static bool IsDesktopClass(string cls)
    {
        return cls == "Progman" || cls == "WorkerW";
    }

    static void FocusPageSoon()
    {
        upAt = new POINT { X = -1, Y = -1 };
        checkTimer.Stop();
        checkTimer.Start();
    }

    /** 外壳在标题上加后缀表示快捷键要在壁纸层输入 */
    static void HandleFocusRequest()
    {
        var hwnd = FindSoul();
        bool wanted = hwnd != IntPtr.Zero && TitleOf(hwnd).EndsWith(WantFocusSuffix);
        if (!wanted) { focusHandled = false; return; }
        if (focusHandled) return;
        focusHandled = true;
        GiveFocus(-1, -1);
    }

    static void PressKey(byte vk, uint flags)
    {
        keybd_event(vk, 0, flags, IntPtr.Zero);
    }

    /** 空白桌面上按 Ctrl+V 这些键是给图标层的，不是对它说话。把键盘还回去再按一次。写法：^V、^+N、F5 */
    static void HandleDesktopKey()
    {
        var hwnd = FindSoul();
        if (hwnd == IntPtr.Zero) return;
        var title = TitleOf(hwnd);
        int at = title.IndexOf(KeySuffix, StringComparison.Ordinal);
        if (at < 0) { keyHandled = ""; return; }
        var key = title.Substring(at + KeySuffix.Length).TrimEnd(')');
        if (key == keyHandled) return;
        keyHandled = key;
        var list = IconList();
        if (list == IntPtr.Zero) return;
        uint pid;
        uint thread = GetWindowThreadProcessId(list, out pid);
        uint me = GetCurrentThreadId();
        if (!AttachThreadInput(me, thread, true)) return;
        SetFocus(list);
        AttachThreadInput(me, thread, false);
        bool ctrl = key.IndexOf('^') >= 0;
        bool shift = key.IndexOf('+') >= 0;
        var name = key.TrimStart('^', '+');
        byte vk = name == "F5" ? VK_F5 : (byte)name[0];
        if (ctrl) PressKey(VK_CONTROL, 0);
        if (shift) PressKey(VK_SHIFT, 0);
        PressKey(vk, 0);
        PressKey(vk, KEYEVENTF_KEYUP);
        if (shift) PressKey(VK_SHIFT, KEYEVENTF_KEYUP);
        if (ctrl) PressKey(VK_CONTROL, KEYEVENTF_KEYUP);
    }

    static bool InstallerRunning()
    {
        foreach (var p in Process.GetProcesses())
        {
            var n = p.ProcessName;
            if (n.IndexOf("DeepSeek", StringComparison.OrdinalIgnoreCase) >= 0 && n != AppProcess) return true;
        }
        return false;
    }

    static void StartApp()
    {
        Log("starting app");
        var start = new ProcessStartInfo { UseShellExecute = false, CreateNoWindow = true };
        // 优先走桌面快捷方式同款的安全启动脚本，它会先修 package.json 的 BOM
        if (File.Exists(SafeStart))
        {
            start.FileName = "powershell.exe";
            start.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + SafeStart + "\"";
        }
        else
        {
            start.FileName = AppExe;
            start.WorkingDirectory = Path.GetDirectoryName(AppExe);
        }
        try { Process.Start(start); }
        catch (System.ComponentModel.Win32Exception e) { Log("start failed: " + e.Message); }
        hideDeadline = DateTime.Now + HideTimeout;
    }

    /** 由我们拉起的 App 不该把主窗口亮出来；关闭在 Windows 上就是缩到托盘，后台不停 */
    static void HideAppWindow()
    {
        if (hideDeadline == DateTime.MinValue) return;
        if (DateTime.Now > hideDeadline) { hideDeadline = DateTime.MinValue; return; }
        var pids = new System.Collections.Generic.HashSet<uint>();
        foreach (var p in Process.GetProcessesByName(AppProcess)) pids.Add((uint)p.Id);
        var target = IntPtr.Zero;
        EnumProc visit = delegate (IntPtr hwnd, IntPtr l)
        {
            uint pid;
            GetWindowThreadProcessId(hwnd, out pid);
            if (!pids.Contains(pid) || !IsWindowVisible(hwnd) || TitleOf(hwnd).IndexOf(AppProcess, StringComparison.Ordinal) < 0) return true;
            target = hwnd;
            return false;
        };
        EnumWindows(visit, IntPtr.Zero);
        GC.KeepAlive(visit);
        if (target == IntPtr.Zero) return;
        PostMessage(target, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
        hideDeadline = DateTime.MinValue;
        Log("app window hidden");
    }

    static void SuperviseApp()
    {
        HideAppWindow();
        if (Process.GetProcessesByName(AppProcess).Length > 0)
        {
            appGoneSince = DateTime.MinValue;
            return;
        }
        if (File.Exists(PausedFlag)) return;
        if (appGoneSince == DateTime.MinValue) appGoneSince = DateTime.Now;
        if (DateTime.Now - appGoneSince < RelaunchGrace || InstallerRunning()) return;
        appGoneSince = DateTime.MinValue;
        StartApp();
    }

    [STAThread]
    static void Main()
    {
        bool created;
        using (new Mutex(true, @"Local\DshDeskKeeper", out created))
        {
            if (!created) return;
            Directory.CreateDirectory(StateDir);
            // 重新开机或手动启动，就是要它回来
            if (File.Exists(PausedFlag)) File.Delete(PausedFlag);
            // 外壳靠这个看守护进程还在不在，没了会叫回来
            File.WriteAllText(PidFile, Process.GetCurrentProcess().Id.ToString());
            Log("keeper up");

            // 刚开机时 App 不在：不用等宽限期
            if (Process.GetProcessesByName(AppProcess).Length == 0) StartApp();

            checkTimer = new System.Windows.Forms.Timer { Interval = 80 };
            checkTimer.Tick += delegate { checkTimer.Stop(); CheckBlankClick(); };
            dragTimer = new System.Windows.Forms.Timer { Interval = 1 };
            dragTimer.Tick += delegate { dragTimer.Stop(); DecideDrag(); };

            mouseProc = OnMouse;
            SetWindowsHookEx(WH_MOUSE_LL, mouseProc, GetModuleHandle(null), 0);

            var soulTimer = new System.Windows.Forms.Timer { Interval = 300 };
            soulTimer.Tick += delegate { Embed(); EmbedTab(); HandlePanelRaise(); };
            panelFocusTimer = new System.Windows.Forms.Timer { Interval = 60 };
            panelFocusTimer.Tick += delegate { panelFocusTimer.Stop(); GivePanelFocus(); };
            soulTimer.Start();

            var inputTimer = new System.Windows.Forms.Timer { Interval = 50 };
            inputTimer.Tick += delegate { TrackForeground(); HandleFocusRequest(); HandleDesktopKey(); };
            inputTimer.Start();

            var appTimer = new System.Windows.Forms.Timer { Interval = 2000 };
            appTimer.Tick += delegate { SuperviseApp(); };
            appTimer.Start();

            Application.Run();
        }
    }
}
