import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { invalid } from './gateway.mjs';

// The host's script-only iframe cannot download; the local service owns this native picker.
const WINDOWS_PICKER = fileURLToPath(new URL('../vendor/json-save/SaveJson.exe', import.meta.url));
const MAC_PICKER = `on run argv
  try
    return POSIX path of (choose file name with prompt "保存批次 JSON" default name (item 1 of argv))
  on error number -128
    return ""
  end try
end run`;

async function savePath(filename, { platform, launch, signal }) {
  const options = { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...(signal ? { signal } : {}) };
  let command, args;
  if (platform === 'win32') {
    command = WINDOWS_PICKER; args = [filename, String(process.ppid)];
    // This is a GUI executable; hiding its first window also hides the file picker.
    options.windowsHide = false;
  } else if (platform === 'darwin') { command = 'osascript'; args = ['-e', MAC_PICKER, filename]; }
  else if (platform === 'linux') { command = 'zenity'; args = ['--file-selection', '--save', '--confirm-overwrite', '--title=保存批次 JSON', `--filename=${filename}`, '--file-filter=JSON | *.json']; }
  else throw invalid('此系统暂不支持 JSON 保存窗口', 501);
  return new Promise((resolve, reject) => {
    let child;
    try { child = launch(command, args, options); } catch { reject(invalid('无法打开 JSON 保存窗口', 502)); return; }
    const chunks = []; let size = 0, failed = false;
    child.stdout.on('data', bytes => {
      size += bytes.length;
      if (size > 16384) { failed = true; child.kill(); reject(invalid('保存窗口返回的路径无效', 502)); }
      else chunks.push(bytes);
    });
    child.stderr.on('data', () => {});
    child.once('error', () => reject(invalid('无法打开 JSON 保存窗口', 502)));
    child.once('close', code => {
      if (failed) return;
      if (platform === 'linux' && code === 1) resolve('');
      else if (code !== 0) reject(invalid('JSON 保存窗口未正常完成，请重试', 502));
      else resolve(Buffer.concat(chunks).toString('utf8').trim());
    });
  });
}

export async function saveJSON(data, filename, { platform = process.platform, launch = spawn, signal } = {}) {
  if (typeof filename !== 'string' || !/^[a-z0-9][a-z0-9._-]*\.json$/i.test(filename) || filename.length > 160) throw invalid('JSON 文件名无效');
  const content = JSON.stringify(data, null, 2);
  if (typeof content !== 'string') throw invalid('没有可保存的 JSON 内容');
  const path = await savePath(filename, { platform, launch, signal });
  if (!path) return { cancelled: true };
  if (!isAbsolute(path) || /[\0\r\n]/.test(path) || /^\\\\/.test(path) || !/\.json$/i.test(path)) throw invalid('请选择本机的 JSON 文件保存位置');
  const parent = await realpath(dirname(path));
  if (/^\\\\/.test(parent)) throw invalid('请选择本机的 JSON 文件保存位置');
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw invalid('保存目标不是普通 JSON 文件');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (signal?.aborted) throw invalid('JSON 保存已取消', 409);
  const temporary = join(parent, `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw invalid('无法写入 JSON，请选择可写的保存位置后重试', 502);
  }
  return { path };
}
