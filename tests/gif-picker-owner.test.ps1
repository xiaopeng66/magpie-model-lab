$ErrorActionPreference = 'Stop'
$picker = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../vendor/json-save/SaveJson.exe'))
$magpie = Get-Process -Name magpie -ErrorAction Stop | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
if (-not $magpie) { throw 'A visible Magpie window is required for native GIF owner acceptance' }
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
public static class GifPickerProbe {
    private delegate bool Callback(IntPtr handle, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool EnumWindows(Callback callback, IntPtr parameter);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr handle, out uint pid);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr handle, uint command);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam);
    public static long Owner(string picker, int parent) {
        var start = new ProcessStartInfo(picker, "magpie-owner-acceptance.gif " + parent);
        start.UseShellExecute = false;
        start.RedirectStandardOutput = true;
        using (var process = Process.Start(start)) {
            IntPtr dialog = IntPtr.Zero;
            try {
                for (int i = 0; i < 100 && dialog == IntPtr.Zero; i++) {
                    EnumWindows(delegate(IntPtr handle, IntPtr parameter) {
                        uint pid; GetWindowThreadProcessId(handle, out pid);
                        if (pid == process.Id && IsWindowVisible(handle)) { dialog = handle; return false; }
                        return true;
                    }, IntPtr.Zero);
                    if (dialog == IntPtr.Zero) Thread.Sleep(100);
                }
                if (dialog == IntPtr.Zero) throw new Exception("The native GIF picker did not become visible");
                return GetWindow(dialog, 4).ToInt64();
            } finally {
                if (dialog != IntPtr.Zero) PostMessage(dialog, 0x0010, IntPtr.Zero, IntPtr.Zero);
                if (!process.WaitForExit(3000)) process.Kill();
            }
        }
    }
}
'@
$owner = [GifPickerProbe]::Owner($picker, $magpie.Id)
$expected = $magpie.MainWindowHandle.ToInt64()
if ($owner -ne $expected) { throw "GIF save dialog has owner $owner; expected the visible Magpie window $expected" }
[pscustomobject]@{ pass=$true; dialog='GIF'; owner=$owner; expected=$expected; cancelledWithoutWriting=$true } | ConvertTo-Json
