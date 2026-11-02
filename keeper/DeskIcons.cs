// 读写桌面真图标的位置，走系统公开接口 IFolderView。
// 用法：desk-icons list
//       desk-icons arrange   从标准输入读，每行：名字<Tab>x<Tab>y
// 输出和输入都是 UTF-8。

using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

[StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
[StructLayout(LayoutKind.Explicit, Size = 272)] struct STRRET { [FieldOffset(0)] public uint Type; [FieldOffset(8)] public IntPtr Str; }

[ComImport, Guid("85CB6900-4D95-11CF-960C-0080C7F4EE85"), InterfaceType(ComInterfaceType.InterfaceIsDual)]
interface IShellWindows
{
    int get_Count();
    [return: MarshalAs(UnmanagedType.IDispatch)] object Item(object index);
    [return: MarshalAs(UnmanagedType.IUnknown)] object _NewEnum();
    void Register(); void RegisterPending(); void Revoke(); void OnNavigate(); void OnActivated();
    [return: MarshalAs(UnmanagedType.IDispatch)] object FindWindowSW(ref object loc, ref object root, int cls, out int hwnd, int options);
}

[ComImport, Guid("6D5140C1-7436-11CE-8034-00AA006009FA"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IServiceProvider2 { [return: MarshalAs(UnmanagedType.IUnknown)] object QueryService(ref Guid sid, ref Guid iid); }

[ComImport, Guid("000214E2-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IShellBrowser
{
    void GetWindow(); void ContextSensitiveHelp(); void InsertMenusSB(); void SetMenuSB(); void RemoveMenusSB(); void SetStatusTextSB();
    void EnableModelessSB(); void TranslateAcceleratorSB(); void BrowseObject(); void GetViewStateStream(); void GetControlWindow(); void SendControlMsg();
    [return: MarshalAs(UnmanagedType.IUnknown)] object QueryActiveShellView();
}

[ComImport, Guid("CDE725B0-CCC9-4519-917E-325D72FAB4CE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IFolderView
{
    void GetCurrentViewMode(); void SetCurrentViewMode();
    [return: MarshalAs(UnmanagedType.IUnknown)] object GetFolder(ref Guid iid);
    IntPtr Item(int index);
    int ItemCount(uint flags);
    void Items(); void GetSelectionMarkedItem(); void GetFocusedItem();
    POINT GetItemPosition(IntPtr pidl);
    void GetSpacing(); void GetDefaultSpacing(); void GetAutoArrange(); void SelectItem();
    void SelectAndPositionItems(uint count, [MarshalAs(UnmanagedType.LPArray)] IntPtr[] pidls, [MarshalAs(UnmanagedType.LPArray)] POINT[] points, uint flags);
}

[ComImport, Guid("000214E6-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IShellFolder
{
    void ParseDisplayName(); void EnumObjects(); void BindToObject(); void BindToStorage(); void CompareIDs();
    void CreateViewObject(); void GetAttributesOf(); void GetUIObjectOf();
    void GetDisplayNameOf(IntPtr pidl, uint flags, out STRRET name);
}

static class DeskIcons
{
    const int SWC_DESKTOP = 8, SWFO_NEEDDISPATCH = 1;
    const uint SVGIO_ALLVIEW = 2, SVSI_POSITIONITEM = 0x80, SHGDN_INFOLDER_FORPARSING = 0x8001;
    /** 挪动分这么多步，用户能看见图标是被移过去的 */
    const int AnimationSteps = 18;
    const int AnimationFrameMs = 25;

    [DllImport("shlwapi.dll", CharSet = CharSet.Unicode)] static extern int StrRetToBuf(ref STRRET ret, IntPtr pidl, StringBuilder buf, uint size);

    static IFolderView Desktop()
    {
        var windows = (IShellWindows)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("9BA05972-F6A8-11CF-A442-00A0C90A8F39")));
        object loc = 0, root = null;
        int hwnd;
        var disp = windows.FindWindowSW(ref loc, ref root, SWC_DESKTOP, out hwnd, SWFO_NEEDDISPATCH);
        var topBrowser = new Guid("4C96BE40-915C-11CF-99D3-00AA004AE837");
        var browserIid = typeof(IShellBrowser).GUID;
        var browser = (IShellBrowser)((IServiceProvider2)disp).QueryService(ref topBrowser, ref browserIid);
        return (IFolderView)browser.QueryActiveShellView();
    }

    static Dictionary<string, IntPtr> Items(IFolderView view)
    {
        var folderIid = typeof(IShellFolder).GUID;
        var folder = (IShellFolder)view.GetFolder(ref folderIid);
        var items = new Dictionary<string, IntPtr>();
        int count = view.ItemCount(SVGIO_ALLVIEW);
        for (int i = 0; i < count; i++)
        {
            var pidl = view.Item(i);
            STRRET ret;
            folder.GetDisplayNameOf(pidl, SHGDN_INFOLDER_FORPARSING, out ret);
            var name = new StringBuilder(520);
            StrRetToBuf(ref ret, pidl, name, 520);
            items[name.ToString()] = pidl;
        }
        return items;
    }

    static void List(IFolderView view, TextWriter output)
    {
        var bounds = Screen.PrimaryScreen.Bounds;
        output.WriteLine("desktop\t" + Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory) + "\t" + bounds.Width + "\t" + bounds.Height);
        foreach (var kv in Items(view))
        {
            var p = view.GetItemPosition(kv.Value);
            output.WriteLine(kv.Key + "\t" + p.X + "\t" + p.Y);
        }
    }

    static void Arrange(IFolderView view, TextReader input, TextWriter output)
    {
        var items = Items(view);
        var pidls = new List<IntPtr>();
        var starts = new List<POINT>();
        var ends = new List<POINT>();
        var missing = new List<string>();
        string line;
        while ((line = input.ReadLine()) != null)
        {
            var parts = line.Split('\t');
            if (parts.Length != 3) continue;
            IntPtr pidl;
            if (!items.TryGetValue(parts[0], out pidl)) { missing.Add(parts[0]); continue; }
            var from = view.GetItemPosition(pidl);
            var to = new POINT { X = int.Parse(parts[1]), Y = int.Parse(parts[2]) };
            if (from.X == to.X && from.Y == to.Y) continue;
            pidls.Add(pidl);
            starts.Add(from);
            ends.Add(to);
        }
        if (pidls.Count > 0)
        {
            var array = pidls.ToArray();
            for (int step = 1; step <= AnimationSteps; step++)
            {
                double t = (double)step / AnimationSteps;
                double eased = t * t * (3 - 2 * t);
                var points = new POINT[array.Length];
                for (int i = 0; i < array.Length; i++)
                {
                    points[i].X = starts[i].X + (int)((ends[i].X - starts[i].X) * eased);
                    points[i].Y = starts[i].Y + (int)((ends[i].Y - starts[i].Y) * eased);
                }
                view.SelectAndPositionItems((uint)array.Length, array, points, SVSI_POSITIONITEM);
                Thread.Sleep(AnimationFrameMs);
            }
        }
        output.WriteLine("挪动了 " + pidls.Count + " 个图标" + (missing.Count > 0 ? "；找不到：" + string.Join("、", missing.ToArray()) : "") + "。如果桌面开了对齐网格，图标会吸附到最近的格子。");
    }

    [STAThread]
    static int Main(string[] args)
    {
        var utf8 = new UTF8Encoding(false);
        var output = new StreamWriter(Console.OpenStandardOutput(), utf8) { AutoFlush = true };
        var input = new StreamReader(Console.OpenStandardInput(), utf8);
        try
        {
            var view = Desktop();
            if (args.Length > 0 && args[0] == "list") { List(view, output); return 0; }
            if (args.Length > 0 && args[0] == "arrange") { Arrange(view, input, output); return 0; }
            Console.Error.WriteLine("usage: desk-icons list | arrange");
            return 2;
        }
        catch (Exception e)
        {
            Console.Error.WriteLine(e.Message);
            return 1;
        }
    }
}
