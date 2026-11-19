import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { temporary } from './helpers.mjs';

const execute = promisify(execFile);

test('the compiled Windows JSON picker opts into monitor DPI before any window is created', { skip: process.platform !== 'win32' }, async t => {
  const dir = await temporary(t);
  const picker = fileURLToPath(new URL('../vendor/json-save/SaveJson.exe', import.meta.url));
  const manifest = (await readFile(picker)).toString('utf8').match(/<assembly\b[\s\S]*?<\/assembly>/)?.[0];
  assert.ok(manifest, 'The shipped picker must contain its Windows activation manifest');
  const source = `using System;
using System.Runtime.InteropServices;
using System.Text;

internal static class DpiProbe {
    [DllImport("shcore.dll")] private static extern int GetProcessDpiAwareness(IntPtr process, out int awareness);
    [DllImport("shcore.dll")] private static extern int GetScaleFactorForDevice(int device);
    [DllImport("user32.dll")] private static extern IntPtr GetThreadDpiAwarenessContext();
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool AreDpiAwarenessContextsEqual(IntPtr first, IntPtr second);
    [STAThread] private static int Main() {
        int awareness;
        if (GetProcessDpiAwareness(IntPtr.Zero, out awareness) != 0) return 2;
        bool v2 = AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(), new IntPtr(-4));
        string result = "{\\"awareness\\":" + awareness + ",\\"perMonitorV2\\":" + (v2 ? "true" : "false") + ",\\"primaryScalePercent\\":" + GetScaleFactorForDevice(0) + "}";
        byte[] bytes = Encoding.UTF8.GetBytes(result);
        using (var output = Console.OpenStandardOutput()) output.Write(bytes, 0, bytes.Length);
        return 0;
    }
}`;
  const probeSource = join(dir, 'DpiProbe.cs'), probeManifest = join(dir, 'DpiProbe.manifest'), probe = join(dir, 'DpiProbe.exe');
  await writeFile(probeSource, source, 'utf8');
  await writeFile(probeManifest, manifest, 'utf8');
  const compiler = join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  await execute(compiler, ['/nologo', '/target:winexe', '/optimize+', `/win32manifest:${probeManifest}`, `/out:${probe}`, probeSource], { windowsHide: true });
  // Apply the shipped EXE's manifest to a windowless probe and ask Windows about its real DPI context.
  const { stdout } = await execute(probe, [], { windowsHide: true });
  const observed = JSON.parse(stdout);
  t.diagnostic(JSON.stringify(observed));
  assert.equal(observed.awareness, 2, 'DPI unaware windows are bitmap scaled and blur on enlarged displays');
  assert.equal(observed.perMonitorV2, true, 'The picker must follow the DPI of the monitor hosting it');
});
