import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { UUID } from "./store.mjs";
import { invalid } from "./gateway.mjs";

export async function openBrowser(address, { platform = process.platform, launch = spawn } = {}) {
  let url;
  try { url = new URL(address); } catch { throw invalid("预览地址无效"); }
  const id = /^\/preview\/([^/]+)$/.exec(url.pathname)?.[1];
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) || !url.port || url.username || url.password || url.hash ||
      !UUID.test(id || "") || !/^\?key=[a-f0-9]{64}$/.test(url.search)) throw invalid("只能打开本机已保存结果的预览");
  const options = { stdio: "ignore", windowsHide: true };
  let command, args;
  if (platform === "win32") {
    command = "powershell.exe";
    args = ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", "Start-Process -FilePath $env:MAGPIE_PELICAN_PREVIEW_URL"];
    options.env = { ...process.env, MAGPIE_PELICAN_PREVIEW_URL: url.href };
  } else { command = platform === "darwin" ? "open" : "xdg-open"; args = [url.href]; }
  await new Promise((resolve, reject) => {
    const child = launch(command, args, options);
    child.once("error", () => reject(invalid("无法打开默认浏览器", 502)));
    child.once("close", (code) => code === 0 ? resolve() : reject(invalid("默认浏览器启动失败", 502)));
  });
}

export async function openDirectory(path, { platform = process.platform, launch = spawn } = {}) {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0") || (platform === "win32" && /^\\\\/.test(path))) throw invalid("保存目录需为本机绝对路径");
  let target;
  try {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Not a directory");
    target = await realpath(path);
    if (platform === "win32" && /^\\\\/.test(target)) throw new Error("Not a local directory");
  } catch { throw invalid("保存目录不存在或不是普通文件夹"); }
  const options = { stdio: "ignore", windowsHide: true };
  let command, args;
  if (platform === "win32") {
    command = "powershell.exe";
    args = ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", "Start-Process -FilePath $env:MAGPIE_PELICAN_DATA_DIR"];
    options.env = { ...process.env, MAGPIE_PELICAN_DATA_DIR: target };
  } else { command = platform === "darwin" ? "open" : "xdg-open"; args = [target]; }
  await new Promise((resolve, reject) => {
    const child = launch(command, args, options);
    child.once("error", () => reject(invalid("无法打开保存文件夹", 502)));
    child.once("close", code => code === 0 ? resolve() : reject(invalid("保存文件夹打开失败", 502)));
  });
}
