import childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, lstat, mkdir, readFile, readdir, realpath, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { inflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { setImmediate as yieldToServer } from "node:timers/promises";
import { GIFEncoder, nearestColorIndex, quantize } from "../vendor/gifenc/gifenc.mjs";
import { invalid } from "./gateway.mjs";
import { PREVIEW_POLICY } from "./result.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SOURCE_LIMIT = 3 * 1024 * 1024, GIF_LIMIT = 8 * 1024 * 1024, KEEP_FOR = 24 * 60 * 60 * 1000;
const FILE_LIMIT = 5, TOTAL_LIMIT = 40 * 1024 * 1024, CAPTURE_LIMIT = 128 * 1024 * 1024;
const SESSION_MARKER = ".magpie-gif-session.json", SESSION_OWNER = '{"schema":"magpie-gif-session-v1"}';
const NATIVE_HELPER = fileURLToPath(new URL("../vendor/gifenc/CopyGif.ps1", import.meta.url));
const NATIVE_PICKER = fileURLToPath(new URL("../vendor/json-save/SaveJson.exe", import.meta.url));
function boundedInteger(value, fallback, minimum, maximum) {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate)) throw invalid("GIF 导出参数无效");
  return Math.max(minimum, Math.min(maximum, candidate));
}
const wait = (ms, signal) => new Promise((resolve, reject) => {
  signal?.throwIfAborted();
  const timer = setTimeout(done, ms);
  function done() { signal?.removeEventListener("abort", stop); resolve(); }
  function stop() { clearTimeout(timer); reject(signal.reason || new Error("已取消")); }
  signal?.addEventListener("abort", stop, { once: true });
});
const inside = (parent, child) => process.platform === "win32" ? child.toLowerCase().startsWith(resolve(parent).toLowerCase() + "\\") : child.startsWith(resolve(parent) + "/");

export function appendCaptureFrame(frames, png, at, capturedBytes, limit = CAPTURE_LIMIT) {
  const total = capturedBytes + png.length;
  if (total > limit) throw new Error("GIF 帧数据超过 128 MiB，请缩短动画或降低分辨率后重试");
  frames.push({ png, at });
  return total;
}

async function plainDirectory(path, allowMissing = false) {
  for (let at = resolve(path); ; at = dirname(at)) {
    try { const stat = await lstat(at); if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalid("GIF 临时路径包含非普通目录"); }
    catch (error) { if (!allowMissing || error.code !== "ENOENT") throw error; }
    if (dirname(at) === at) return;
  }
}

async function ownedSession(path) {
  try {
    const stat = await lstat(path), marker = await lstat(join(path, SESSION_MARKER));
    return stat.isDirectory() && !stat.isSymbolicLink() && marker.isFile() && !marker.isSymbolicLink() && marker.size < 256 && await readFile(join(path, SESSION_MARKER), "utf8") === SESSION_OWNER;
  } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

async function discardUnownedSession(path) {
  const marker = join(path, SESSION_MARKER);
  try {
    const stat = await lstat(marker);
    if (!stat.isFile() || stat.isSymbolicLink()) return;
    const content = await readFile(marker, "utf8");
    if (!SESSION_OWNER.startsWith(content)) return;
    await unlink(marker);
  } catch (error) { if (error.code !== "ENOENT") return; }
  await rmdir(path).catch(() => {});
}

async function presentStat(path) {
  try { return await lstat(path); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function decodeScreenshot(png, width, height) {
  if (!Buffer.isBuffer(png) || png.length < 57 || png.length > 3 * 1024 * 1024 || png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw invalid("浏览器截图格式无效");
  const parts = []; let cursor = 8, layout = null, ended = false;
  while (cursor + 12 <= png.length) {
    const size = png.readUInt32BE(cursor), type = png.toString("ascii", cursor + 4, cursor + 8), start = cursor + 8;
    if (size > png.length - cursor - 12) throw invalid("浏览器截图块长度无效");
    if (type === "IHDR") layout = { width: png.readUInt32BE(start), height: png.readUInt32BE(start + 4), depth: png[start + 8], color: png[start + 9], compression: png[start + 10], filter: png[start + 11], interlace: png[start + 12] };
    if (type === "IDAT") parts.push(png.subarray(start, start + size));
    cursor = start + size + 4;
    if (type === "IEND") { ended = true; break; }
  }
  const channels = layout?.color === 2 ? 3 : layout?.color === 6 ? 4 : 0;
  if (!ended || layout?.width !== width || layout?.height !== height || layout.depth !== 8 || !channels || layout.compression || layout.filter || layout.interlace) throw invalid("浏览器截图 PNG 编码不受支持");
  const rowBytes = width * channels, filtered = inflateSync(Buffer.concat(parts), { maxOutputLength: height * (rowBytes + 1) });
  if (filtered.length !== height * (rowBytes + 1)) throw invalid("浏览器截图像素长度异常");
  const output = Buffer.alloc(height * width * 4); let from = 0;
  const paeth = (a, b, c) => { const p = a + b - c, da = Math.abs(p - a), db = Math.abs(p - b), dc = Math.abs(p - c); return da <= db && da <= dc ? a : db <= dc ? b : c; };
  for (let y = 0; y < height; y++) {
    const mode = filtered[from++], row = y * rowBytes;
    if (mode > 4) throw invalid("浏览器截图滤镜无效");
    const rawRow = Buffer.alloc(rowBytes);
    for (let x = 0; x < rowBytes; x++) {
      const channel = x % channels, pixel = Math.floor(x / channels), prior = y ? (y - 1) * width * 4 + pixel * 4 + channel : 0, priorLeft = y && pixel ? (y - 1) * width * 4 + (pixel - 1) * 4 + channel : 0;
      const raw = filtered[from++], left = x >= channels ? rawRow[x - channels] : 0, up = y ? output[prior] : 0, upperLeft = y && x >= channels ? output[priorLeft] : 0;
      rawRow[x] = raw + (mode === 1 ? left : mode === 2 ? up : mode === 3 ? Math.floor((left + up) / 2) : mode === 4 ? paeth(left, up, upperLeft) : 0);
    }
    for (let x = 0; x < width; x++) {
      const source = x * channels, target = (y * width + x) * 4;
      output[target] = rawRow[source]; output[target + 1] = rawRow[source + 1]; output[target + 2] = rawRow[source + 2]; output[target + 3] = channels === 4 ? rawRow[source + 3] : 255;
    }
  }
  return new Uint8Array(output.buffer, output.byteOffset, output.byteLength);
}

async function edgeExecutable() {
  const roots = [process.env["PROGRAMFILES(X86)"], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  for (const root of roots) {
    const path = join(root, "Microsoft", "Edge", "Application", "msedge.exe");
    try { await access(path); return path; } catch {}
  }
  throw invalid("未找到可用于 GIF 导出的 Edge 浏览器", 501);
}

export class DevTools {
  constructor(socket) { this.socket = socket; this.nextId = 0; this.pending = new Map(); this.onRequest = null; }
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("浏览器调试连接超时")), 8000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("无法连接 GIF 渲染浏览器")); }, { once: true });
    });
    const client = new DevTools(socket);
    socket.addEventListener("message", async event => {
      try {
        const data = typeof event.data === "string" ? event.data : await event.data.text(), message = JSON.parse(data), pending = client.pending.get(message.id);
        if (message.method === "Emulation.virtualTimeBudgetExpired") { client.budgetDone?.(); return; }
        if (message.method === "Fetch.requestPaused") { await client.onRequest?.(message.params, message.sessionId); return; }
        if (!pending) return;
        client.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message || "浏览器页面执行失败")); else pending.resolve(message.result);
      } catch {}
    });
    socket.addEventListener("close", () => { const error = new Error("GIF 渲染浏览器已关闭"); client.budgetDone?.(error); for (const entry of client.pending.values()) entry.reject(error); client.pending.clear(); });
    return client;
  }
  send(method, params = {}, sessionId, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      if (this.socket.readyState !== WebSocket.OPEN) { reject(new Error("GIF 渲染浏览器已关闭")); return; }
      const id = ++this.nextId, finish = (callback, value) => { clearTimeout(timer); this.pending.delete(id); callback(value); };
      const timer = setTimeout(() => { const error = new Error(`GIF 浏览器命令超时：${method}`); error.code = "CDP_TIMEOUT"; finish(reject, error); }, timeoutMs);
      this.pending.set(id, { resolve: value => finish(resolve, value), reject: error => finish(reject, error) });
      try { this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch (error) { finish(reject, error); }
    });
  }
  async evaluate(sessionId, expression) {
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error("动画页面无法完成渲染");
    return result.result?.value;
  }
  advance(milliseconds, sessionId) {
    return new Promise((resolve, reject) => {
      const finish = error => { clearTimeout(timer); this.budgetDone = null; error ? reject(error) : resolve(); };
      const timer = setTimeout(() => finish(new Error("动画虚拟时钟推进超时")), 5000);
      this.budgetDone = finish;
      this.send("Emulation.setVirtualTimePolicy", { policy: "advance", budget: milliseconds, maxVirtualTimeTaskStarvationCount: 1000 }, sessionId).catch(finish);
    });
  }
  close() { try { this.socket.close(); } catch {} }
}

export async function captureScreenshot(client, params, sessionId) {
  try { return await client.send("Page.captureScreenshot", params, sessionId, 5000); }
  catch (error) {
    if (error.code !== "CDP_TIMEOUT" && !/Unable to capture screenshot/.test(error.message)) throw error;
    // Reawaken the page compositor; headless view screenshots can return black pixels.
    await client.send("Page.bringToFront", {}, sessionId, 2000);
    return client.send("Page.captureScreenshot", params, sessionId, 5000);
  }
}

function captureFrames() {
  const callbacks = new Map(), animations = new WeakMap(); let id = 0;
  window.requestAnimationFrame = callback => { callbacks.set(++id, callback); return id; };
  window.cancelAnimationFrame = key => callbacks.delete(key);
  Object.defineProperty(window, "__magpieGifFrame", { value: async () => {
    const now = performance.now(), pending = [...callbacks.values()]; callbacks.clear();
    for (const callback of pending) callback(now);
    await Promise.resolve();
    for (const animation of document.getAnimations()) {
      let state = animations.get(animation);
      if (!state) {
        state = { at: now, time: animation.currentTime || 0, playing: animation.playState !== "paused", rate: animation.playbackRate };
        animations.set(animation, state); animation.pause();
      }
      if (state.playing) animation.currentTime = state.time + (now - state.at) * state.rate;
    }
  } });
}

async function launchEdge(profile, html, { width, height, durationMs, fps, signal }) {
  for (let attempt = 0; attempt < 2; attempt++) {
    signal?.throwIfAborted();
    const isolated = join(profile, `attempt-${attempt}`);
    await mkdir(isolated, { mode: 0o700 });
    try { return await renderEdge(isolated, html, { width, height, durationMs, fps, signal }); }
    catch (error) { if (error.code !== "CDP_TIMEOUT" || attempt || signal?.aborted) throw error; }
  }
}

async function renderEdge(profile, html, { width, height, durationMs, fps, signal }) {
  if (process.platform !== "win32") throw invalid("首版 GIF 渲染需要 Windows Edge", 501);
  const executable = await edgeExecutable(), bin = join(profile, "DevToolsActivePort"), absolute = resolve(profile);
  const child = childProcess.spawn(executable, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-background-networking", "--no-proxy-server", "--remote-debugging-port=0", `--user-data-dir=${absolute}`, `--window-size=${width},${height}`, "about:blank"], { stdio: "ignore", windowsHide: true });
  const exited = new Promise(resolve => child.once("close", resolve));
  let client, sessionId, targetId, stopping;
  const stop = () => stopping ||= (async () => {
    signal?.removeEventListener("abort", stop);
    if (client) {
      // A normal browser exit releases its profile lock before the directory is removed.
      await Promise.race([client.send("Browser.close").catch(() => {}), wait(1000)]);
      await Promise.race([exited, wait(1000)]);
    }
    if (child.exitCode === null && child.signalCode === null) {
      if (process.platform === "win32") {
        const root = process.env.SystemRoot || "C:\\Windows";
        await new Promise(resolve => {
          const task = childProcess.spawn(join(root, "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
          const timer = setTimeout(() => { task.kill(); resolve(); }, 5000); timer.unref?.();
          task.once("error", () => { clearTimeout(timer); resolve(); }); task.once("close", () => { clearTimeout(timer); resolve(); });
        });
      } else { try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); } }
    }
    await Promise.race([exited, wait(2000)]);
    client?.close();
  })();
  signal?.addEventListener("abort", stop, { once: true });
  const timeout = setTimeout(() => { void stop(); }, 60000); timeout.unref?.();
  try {
    child.once("error", () => {});
    let activePort;
    for (let attempt = 0; attempt < 120; attempt++) {
      signal?.throwIfAborted();
      if (child.exitCode !== null) throw new Error("Edge GIF 渲染进程提前退出");
      try { activePort = (await readFile(bin, "utf8")).trim().split(/\r?\n/); if (/^\d+$/.test(activePort[0]) && activePort[1]?.startsWith("/devtools/browser/")) break; activePort = null; } catch {}
      await wait(100, signal);
    }
    if (!activePort) throw new Error("Edge GIF 渲染连接未启动");
    client = await DevTools.connect(`ws://127.0.0.1:${activePort[0]}${activePort[1]}`);
    ({ targetId } = await client.send("Target.createTarget", { url: "about:blank" }));
    ({ sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true }));
    await client.send("Page.bringToFront", {}, sessionId);
    await client.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
    await client.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 255, g: 255, b: 255, a: 1 } }, sessionId);
    await client.send("Page.enable", {}, sessionId); await client.send("Runtime.enable", {}, sessionId);
    await client.send("Network.enable", {}, sessionId);
    await client.send("Network.setBlockedURLs", { urls: ["http://*", "https://*", "ws://*", "wss://*", "file://*", "ftp://*"] }, sessionId);
    await client.send("Page.setDownloadBehavior", { behavior: "deny" }, sessionId);
    const renderURL = "https://magpie-gif.invalid/animation";
    let served = false;
    client.onRequest = (request, session) => {
      if (!served && session === sessionId && request.resourceType === "Document" && request.request.url === renderURL) {
        served = true;
        return client.send("Fetch.fulfillRequest", { requestId: request.requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "text/html; charset=utf-8" }, { name: "Content-Security-Policy", value: PREVIEW_POLICY }], body: Buffer.from(html).toString("base64") }, session);
      }
      return client.send("Fetch.failRequest", { requestId: request.requestId, errorReason: "BlockedByClient" }, session);
    };
    await client.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, sessionId);
    await client.send("Page.addScriptToEvaluateOnNewDocument", { source: `(${captureFrames.toString()})()` }, sessionId);
    await client.send("Page.navigate", { url: renderURL }, sessionId);
    const readyAt = Date.now() + 10000;
    while (Date.now() < readyAt) {
      signal?.throwIfAborted();
      if (await client.evaluate(sessionId, "document.readyState === 'complete' && !!document.body")) break;
      await wait(40, signal);
    }
    if (!served || !await client.evaluate(sessionId, "document.readyState === 'complete' && !!document.body")) throw new Error("动画页面加载超时");
    // Commit the initial paint before freezing time, so capture cannot wait on a paused first surface.
    await captureScreenshot(client, { format: "png", fromSurface: true }, sessionId);
    await client.send("Emulation.setVirtualTimePolicy", { policy: "pause" }, sessionId);
    await client.evaluate(sessionId, "window.__magpieGifFrame()");
    const frames = [], frameTotal = Math.ceil(durationMs / (1000 / fps)); let elapsed = 0, simulated = 0, capturedBytes = 0;
    for (let index = 0; index < frameTotal; index++) {
      signal?.throwIfAborted();
      const at = index * 1000 / fps;
      // End each interval with a real draw at its presentation time, retaining the 60 Hz callback count.
      const ticks = Math.floor(at * 60 / 1000 + 0.000001) - simulated, before = elapsed;
      for (let tick = 1; tick <= ticks; tick++) {
        signal?.throwIfAborted();
        const tickAt = before + (at - before) * tick / ticks;
        await client.advance(tickAt - elapsed, sessionId); elapsed = tickAt;
        await client.evaluate(sessionId, "window.__magpieGifFrame()");
      }
      simulated += ticks;
      const { data } = await captureScreenshot(client, { format: "png", fromSurface: true, captureBeyondViewport: false, clip: { x: 0, y: 0, width, height, scale: 1 } }, sessionId);
      capturedBytes = appendCaptureFrame(frames, Buffer.from(data, "base64"), at, capturedBytes);
    }
    const perFrame = Math.ceil(262144 / frames.length), samples = new Uint8Array(perFrame * frames.length * 4);
    for (let index = 0; index < frames.length; index++) {
      await yieldToServer();
      signal?.throwIfAborted();
      const rgba = decodeScreenshot(frames[index].png, width, height);
      for (let pixel = 0; pixel < perFrame; pixel++) {
        const from = Math.floor((pixel + .5) * width * height / perFrame) * 4;
        samples.set(rgba.subarray(from, from + 4), (index * perFrame + pixel) * 4);
      }
    }
    await yieldToServer(); signal?.throwIfAborted();
    const palette = quantize(samples, 256, { format: "rgb565" });
    // A fixed lookup avoids per-frame, first-seen-color cache changes in otherwise identical pixels.
    const paletteMap = new Uint8Array(65536);
    for (let color = 0; color < paletteMap.length; color++) {
      if (!(color % 1024)) { await yieldToServer(); signal?.throwIfAborted(); }
      paletteMap[color] = nearestColorIndex(palette, [(color >> 11) * 8 + 4, ((color >> 5) & 63) * 4 + 2, (color & 31) * 8 + 4]);
    }
    const encoder = GIFEncoder();
    for (let index = 0; index < frames.length; index++) {
      await yieldToServer();
      signal?.throwIfAborted();
      const rgba = decodeScreenshot(frames[index].png, width, height);
      const indexed = new Uint8Array(width * height);
      for (let pixel = 0, from = 0; pixel < indexed.length; pixel++, from += 4) {
        indexed[pixel] = paletteMap[(rgba[from] >> 3) << 11 | (rgba[from + 1] >> 2) << 5 | rgba[from + 2] >> 3];
      }
      const delay = Math.max(20, Math.round((frames[index + 1]?.at ?? durationMs) / 10) * 10 - Math.round(frames[index].at / 10) * 10);
      encoder.writeFrame(indexed, width, height, { ...(index ? {} : { palette }), delay, repeat: 0, dispose: 1 });
    }
    encoder.finish(); const bytes = Buffer.from(encoder.bytes());
    if (bytes.length < 100 || bytes.length > GIF_LIMIT) throw new Error(bytes.length > GIF_LIMIT ? "GIF 超出 8 MiB，请简化动画后重试" : "生成的 GIF 内容为空");
    return bytes;
  } finally { clearTimeout(timeout); await stop(); }
}

function nativeAction(action, path, signal) {
  signal?.throwIfAborted();
  if (process.platform !== "win32") return Promise.reject(invalid("此系统暂不支持 GIF 文件复制或保存窗口", 501));
  return new Promise((resolve, reject) => {
    let child, stdout = "", failed = false;
    const saving = action === "save-file";
    const command = saving ? NATIVE_PICKER : "powershell.exe", args = saving ? [path, String(process.ppid)] : ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-File", NATIVE_HELPER, path];
    // The existing GUI picker owns its visible window; only the clipboard helper stays hidden.
    try { child = childProcess.spawn(command, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: !saving, ...(signal ? { signal } : {}) }); }
    catch { reject(invalid("无法启动 GIF 文件操作，请重试")); return; }
    const timeout = setTimeout(() => { failed = true; child.kill(); reject(invalid("GIF 文件操作等待超时", 504)); }, 15 * 60 * 1000); timeout.unref?.();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", data => { stdout += data; if (stdout.length > 16384) { failed = true; child.kill(); clearTimeout(timeout); reject(invalid("GIF 文件操作返回的数据无效")); } });
    child.once("error", () => { clearTimeout(timeout); if (!failed) reject(invalid("无法打开 GIF 文件操作，请重试")); });
    child.once("close", code => {
      clearTimeout(timeout);
      if (failed) return;
      if (code !== 0) { reject(invalid("GIF 文件操作失败，请重试")); return; }
      const encoded = stdout.trim();
      if (!encoded) { resolve(null); return; }
      if (saving) { resolve(encoded); return; }
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) { reject(invalid("GIF 文件复制确认无效")); return; }
      resolve(Buffer.from(encoded, "base64").toString("utf8"));
    });
  });
}

async function outputPath(root, path) {
  if (!isAbsolute(path) || /[\0\r\n]/.test(path) || /^\\\\/.test(path) || !path.toLowerCase().endsWith(".gif")) throw invalid("请选择本机的 GIF 文件保存位置");
  const parent = await realpath(dirname(path));
  if (/^\\\\/.test(parent)) throw invalid("请选择本机的 GIF 文件保存位置");
  const target = join(parent, basename(path));
  if (resolve(target) === resolve(root) || inside(root, resolve(target))) throw invalid("请将 GIF 保存到临时目录之外");
  try { const stat = await lstat(target); if (!stat.isFile() || stat.isSymbolicLink()) throw invalid("保存目标不是普通 GIF 文件"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  return target;
}

export class GIFExports {
  constructor({ root = join(tmpdir(), "magpie-pelican-gifs"), writeSessionMarker = writeFile } = {}) {
    this.root = resolve(root); this.session = join(this.root, randomUUID()); this.writeSessionMarker = writeSessionMarker; this.entries = new Map(); this.generating = false;
    this.abort = new AbortController(); this.job = null;
  }

  async init() {
    await this.sweep(); await this.prune();
    const { files } = await this.usage();
    for (const file of files) this.entries.set(basename(file.path, ".gif"), { path: file.path, size: file.size, createdAt: file.modifiedAt });
  }

  async sweep() {
    await this.initRoot();
    const cutoff = Date.now() - KEEP_FOR;
    for (const [id, entry] of this.entries) if (entry.createdAt < cutoff) await this.remove(id);
    for (const name of await readdir(this.root)) {
      if (!UUID.test(name)) continue;
      try {
      const path = join(this.root, name), stat = await presentStat(path);
      if (!stat?.isDirectory() || stat.isSymbolicLink() || !inside(this.root, resolve(path)) || !await ownedSession(path)) continue;
      await plainDirectory(path);
      for (const file of await readdir(path)) {
        const child = join(path, file), info = await presentStat(child);
        if (!info || info.isSymbolicLink() || info.mtimeMs >= cutoff) continue;
        if (file.endsWith(".gif") && UUID.test(file.slice(0, -4)) && info.isFile()) await rm(child, { force: true });
        else if (file.startsWith("browser-") && UUID.test(file.slice(8)) && info.isDirectory()) {
          await plainDirectory(child); await rm(child, { recursive: true, force: true });
        }
      }
      if (path !== this.session && stat.mtimeMs < cutoff && (await readdir(path)).every(file => file === SESSION_MARKER)) await rm(path, { recursive: true, force: true });
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }

  async initRoot() {
    await plainDirectory(this.root, true); await mkdir(this.root, { recursive: true }); await plainDirectory(this.root);
    let created = false;
    try {
      await mkdir(this.session, { mode: 0o700 }); created = true;
      await this.writeSessionMarker(join(this.session, SESSION_MARKER), SESSION_OWNER, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (created && !await ownedSession(this.session).catch(() => false)) await discardUnownedSession(this.session);
      if (error.code !== "EEXIST") throw error;
    }
    if (!await ownedSession(this.session)) throw invalid("GIF 临时会话目录已改变");
    await plainDirectory(this.session);
  }

  async usage() {
    let size = 0; const files = [];
    for (const name of await readdir(this.root)) {
      if (!UUID.test(name)) continue;
      try {
      const directory = join(this.root, name), info = await presentStat(directory);
      if (!info?.isDirectory() || info.isSymbolicLink() || !inside(this.root, resolve(directory)) || !await ownedSession(directory)) continue;
      for (const file of await readdir(directory)) {
        if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.gif$/.test(file)) continue;
        const path = join(directory, file), stat = await presentStat(path);
        if (stat?.isFile() && !stat.isSymbolicLink()) { size += stat.size; files.push({ path, size: stat.size, modifiedAt: stat.mtimeMs }); }
      }
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    return { count: files.length, size, files };
  }

  async prune(newestPath) {
    const { files } = await this.usage(), newest = newestPath && files.find(file => file.path === newestPath);
    if (newestPath && !newest) throw invalid("GIF 临时文件生成后无法校验");
    let count = files.length, size = files.reduce((total, file) => total + file.size, 0);
    const oldest = files.filter(file => !newestPath || file.path !== newestPath).sort((a, b) => a.modifiedAt - b.modifiedAt);
    const removed = [];
    for (const file of oldest) {
      if (count <= FILE_LIMIT && size <= TOTAL_LIMIT) break;
      const directory = dirname(file.path);
      await plainDirectory(directory);
      if (!inside(this.root, resolve(directory)) || !await ownedSession(directory)) throw invalid("GIF 临时会话目录已改变");
      const stat = await presentStat(file.path);
      const id = basename(file.path, ".gif");
      if (!stat) { count--; size -= file.size; removed.push(id); this.entries.delete(id); continue; }
      if (!stat.isFile() || stat.isSymbolicLink()) throw invalid("GIF 临时文件已改变，无法安全清理");
      await rm(file.path);
      count--; size -= stat.size;
      removed.push(id); this.entries.delete(id);
    }
    if (count > FILE_LIMIT || size > TOTAL_LIMIT) throw invalid("无法清理最旧的临时 GIF，请检查临时目录权限", 500);
    return removed;
  }

  async generate(html, options = {}) {
    if (this.generating) throw invalid("已有 GIF 正在生成，请完成后再试", 409);
    if (typeof html !== "string" || !html || Buffer.byteLength(html) > SOURCE_LIMIT) throw invalid("动画源码超过 3 MiB，无法导出 GIF", 413);
    options ??= {};
    if (typeof options !== "object" || Array.isArray(options)) throw invalid("GIF 导出参数无效");
    const width = boundedInteger(options.width, 960, 180, 960), height = boundedInteger(options.height, 600, 100, 600);
    const durationMs = boundedInteger(options.durationMs, 4000, 500, 6000), fps = boundedInteger(options.fps, 25, 4, 25);
    options = { ...options, signal: AbortSignal.any([this.abort.signal, ...(options.signal ? [options.signal] : [])]) };
    options.signal.throwIfAborted();
    this.generating = true;
    let finished; this.job = new Promise(resolve => { finished = resolve; });
    try {
      await this.sweep();
      if (options.signal.aborted) throw invalid("GIF 生成已取消", 409);
      const id = randomUUID(), profile = join(this.session, `browser-${id}`), path = join(this.session, `${id}.gif`);
      try {
        await mkdir(profile, { mode: 0o700 });
        const bytes = await launchEdge(profile, html, { width, height, durationMs, fps, signal: options.signal });
        options.signal.throwIfAborted();
        await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
        this.entries.set(id, { path, size: bytes.length, createdAt: Date.now() });
        const removed = await this.prune(path);
        return { id, name: `magpie-animation-${id.slice(0, 8)}.gif`, size: bytes.length, width, height, fps, frames: Math.ceil(durationMs * fps / 1000), durationMs, expiresAt: new Date(Date.now() + KEEP_FOR).toISOString(), removed };
      } catch (error) {
        if (this.entries.has(id)) await this.remove(id).catch(() => {});
        if (options.signal.aborted) throw invalid("GIF 生成已取消", 409);
        throw error.status ? error : invalid(error.message || "GIF 生成失败，请重试", 502);
      } finally {
        if (inside(this.session, resolve(profile))) {
          await plainDirectory(this.session);
          for (let attempt = 0; ; attempt++) {
            try { await rm(profile, { recursive: true, force: true }); break; }
            catch (error) { if (attempt >= 7 || !["EBUSY", "EPERM", "EACCES"].includes(error.code)) throw error; await wait(250); }
          }
        }
      }
    } finally {
      this.generating = false; this.job = null; finished();
    }
  }

  async entry(id) {
    if (!UUID.test(id || "")) throw invalid("GIF 文件标识无效");
    const entry = this.entries.get(id);
    if (!entry) throw invalid("GIF 临时文件不存在或已过期", 404);
    const path = resolve(entry.path), directory = dirname(path);
    if (!inside(this.root, path) || dirname(directory) !== this.root || basename(path) !== `${id}.gif`) throw invalid("GIF 临时文件路径无效");
    await plainDirectory(this.root); await plainDirectory(directory);
    if (!await ownedSession(directory)) throw invalid("GIF 临时文件不存在或已过期", 404);
    let stat;
    try { stat = await lstat(path); } catch (error) { if (error.code === "ENOENT") { this.entries.delete(id); throw invalid("GIF 临时文件不存在或已过期", 404); } throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > GIF_LIMIT || Date.now() - entry.createdAt > KEEP_FOR) {
      await this.remove(id); throw invalid("GIF 临时文件不存在或已过期", 404);
    }
    return entry;
  }

  async read(id) { return readFile((await this.entry(id)).path); }

  async save(id, { signal } = {}) {
    const bytes = await this.read(id), filename = `magpie-animation-${id.slice(0, 8)}.gif`, selected = await nativeAction("save-file", filename, signal);
    if (!selected) return { cancelled: true };
    signal?.throwIfAborted();
    const target = await outputPath(this.root, selected), temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
    try { signal?.throwIfAborted(); await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 }); signal?.throwIfAborted(); await rename(temporary, target); }
    catch (error) { await rm(temporary, { force: true }).catch(() => {}); throw error.code === "ENOENT" ? invalid("GIF 临时文件已过期，请重新生成", 404) : invalid("无法写入 GIF，请换一个可写位置再试", 502); }
    return { path: target };
  }

  async copy(id, { signal } = {}) {
    const path = (await this.entry(id)).path;
    if (await nativeAction("copy-file", path, signal) === null) throw invalid("没有复制 GIF 文件，请重试", 502);
    return { copied: true };
  }

  async remove(id) {
    if (!UUID.test(id || "")) throw invalid("GIF 文件标识无效");
    const entry = this.entries.get(id);
    if (!entry) return { removed: false };
    const path = resolve(entry.path), directory = dirname(path);
    if (!inside(this.root, path) || dirname(directory) !== this.root || basename(path) !== `${id}.gif`) throw invalid("GIF 临时文件路径无效");
    await plainDirectory(this.root); await plainDirectory(directory);
    if (!await ownedSession(directory)) throw invalid("GIF 临时会话目录已改变");
    try { const stat = await lstat(path); if (stat.isFile() && !stat.isSymbolicLink()) await rm(path); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    this.entries.delete(id);
    return { removed: true };
  }

  async close() {
    this.abort.abort(); await this.job;
    if (inside(this.root, resolve(this.session)) && await ownedSession(this.session)) {
      await plainDirectory(this.session);
      if ((await readdir(this.session)).every(name => name === SESSION_MARKER)) await rm(this.session, { recursive: true, force: true });
    }
  }
}
