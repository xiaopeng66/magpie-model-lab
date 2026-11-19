using System;
using System.Diagnostics;
using System.Reflection;
using System.Text;
using System.Windows.Forms;

[assembly: AssemblyTitle("模型实验室 JSON 保存")]
[assembly: AssemblyProduct("Magpie Model Lab")]
[assembly: AssemblyVersion("1.0.3.0")]

internal static class SaveJson
{
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
        try
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            IntPtr parent = IntPtr.Zero;
            try { parent = Process.GetProcessById(parentId).MainWindowHandle; }
            catch { }
            using (var picker = new SaveFileDialog())
            {
                picker.Title = "保存批次 JSON";
                picker.Filter = "JSON 文件 (*.json)|*.json";
                picker.FileName = args[0];
                picker.DefaultExt = "json";
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
