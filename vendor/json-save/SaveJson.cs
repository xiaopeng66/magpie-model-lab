using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

[assembly: AssemblyTitle("模型实验室 JSON 保存")]
[assembly: AssemblyProduct("Magpie Model Lab")]
[assembly: AssemblyVersion("1.0.6.0")]

internal static class SaveJson
{
    private delegate bool EnumWindowProc(IntPtr handle, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowProc callback, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr handle, uint command);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);

    private static IntPtr VisibleWindow(Process process)
    {
        IntPtr main = process.MainWindowHandle;
        if (main != IntPtr.Zero && IsWindowVisible(main)) return main;
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate(IntPtr handle, IntPtr parameter)
        {
            uint processId;
            GetWindowThreadProcessId(handle, out processId);
            if (processId != process.Id || !IsWindowVisible(handle) || GetWindow(handle, 4) != IntPtr.Zero) return true;
            found = handle;
            return false;
        }, IntPtr.Zero);
        return found;
    }

    private static IntPtr ResolveParentWindow(int parentId)
    {
        IntPtr parent = IntPtr.Zero;
        try
        {
            using (Process process = Process.GetProcessById(parentId))
            {
                parent = VisibleWindow(process);
                if (parent != IntPtr.Zero && string.Equals(process.ProcessName, "magpie", StringComparison.OrdinalIgnoreCase)) return parent;
            }
        }
        catch { }
        IntPtr foreground = GetForegroundWindow(), magpie = IntPtr.Zero;
        foreach (Process process in Process.GetProcessesByName("magpie"))
        {
            using (process)
            {
                try
                {
                    IntPtr candidate = VisibleWindow(process);
                    if (candidate == IntPtr.Zero) continue;
                    uint foregroundId;
                    GetWindowThreadProcessId(foreground, out foregroundId);
                    if (foregroundId == process.Id) return candidate;
                    if (magpie == IntPtr.Zero) magpie = candidate;
                }
                catch { }
            }
        }
        // RYP: the service may outlive its headless launcher; own the dialog from Magpie.
        return magpie == IntPtr.Zero ? parent : magpie;
    }

    private sealed class ParentWindow : IWin32Window
    {
        public IntPtr Handle { get; private set; }
        public ParentWindow(IntPtr handle) { Handle = handle; }
    }

    [STAThread]
    private static int Main(string[] args)
    {
        int parentId;
        if (args.Length != 2 || !int.TryParse(args[1], out parentId)) return 2;
        string extension = Path.GetExtension(args[0]).ToLowerInvariant();
        if (extension != ".json" && extension != ".gif") return 2;
        string label = extension == ".gif" ? "GIF" : "JSON";
        try
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            IntPtr parent = ResolveParentWindow(parentId);
            using (var picker = new SaveFileDialog())
            {
                picker.Title = "保存 " + label;
                picker.Filter = label + " 文件 (*" + extension + ")|*" + extension;
                picker.FileName = args[0];
                picker.DefaultExt = extension.Substring(1);
                picker.AddExtension = true;
                picker.OverwritePrompt = true;
                picker.CheckPathExists = true;
                picker.RestoreDirectory = true;
                var result = parent == IntPtr.Zero ? picker.ShowDialog() : picker.ShowDialog(new ParentWindow(parent));
                if (result != DialogResult.OK) return 0;
                // A GUI process has no console code page; send UTF-8 directly to the redirected pipe.
                byte[] bytes = Encoding.UTF8.GetBytes(picker.FileName);
                using (var output = Console.OpenStandardOutput()) output.Write(bytes, 0, bytes.Length);
                return 0;
            }
        }
        catch { return 2; }
    }
}
