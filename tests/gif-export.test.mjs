import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { basename, join } from "node:path";
import { access, mkdir, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { appendCaptureFrame, GIFExports } from "../lib/gif-export.mjs";
import { temporary } from "./helpers.mjs";

const animation = `<!doctype html><html><head><style>@keyframes move { from { transform: translateX(0); } to { transform: translateX(70px); } } #dot { width:24px;height:24px;border-radius:50%;background:#e63;animation:move .7s linear infinite alternate; }</style></head><body><div id="dot"></div></body></html>`;

test("capture stops at the cumulative PNG budget without retaining the over-budget frame", () => {
  const frames = [], first = Buffer.alloc(4), second = Buffer.alloc(5), overflow = Buffer.alloc(1);
  let bytes = appendCaptureFrame(frames, first, 0, 0, 9);
  bytes = appendCaptureFrame(frames, second, 40, bytes, 9);
  assert.equal(bytes, 9); assert.equal(frames.length, 2);
  assert.throws(() => appendCaptureFrame(frames, overflow, 80, bytes, 9), /超过 128 MiB/);
  assert.equal(frames.length, 2, "A rejected capture is not appended to the retained PNG buffers");
});

test("a stalled screenshot retries the real page surface after bringing the page forward", async () => {
  const { captureScreenshot } = await import("../lib/gif-export.mjs");
  assert.equal(typeof captureScreenshot, "function");
  const calls = [], client = { send: async (method, params, sessionId, timeoutMs) => {
    calls.push({ method, params, sessionId, timeoutMs });
    if (calls.length === 1) { const error = new Error("GIF 浏览器命令超时"); error.code = "CDP_TIMEOUT"; throw error; }
    return { data: "encoded" };
  } };
  assert.deepEqual(await captureScreenshot(client, { format: "png", fromSurface: true }, "session"), { data: "encoded" });
  assert.equal(calls.length, 3); assert.equal(calls[0].params.fromSurface, true);
  assert.equal(calls[1].method, "Page.bringToFront"); assert.equal(calls[2].params.fromSurface, true); assert.equal(calls[0].timeoutMs, calls[2].timeoutMs);
  await captureScreenshot(client, { format: "png", fromSurface: true }, "session");
  assert.equal(calls[3].params.fromSurface, true, "Headless view screenshots can be black and must never replace page pixels");
});

test("a persistent screenshot failure rejects after two bounded capture attempts", async () => {
  const { captureScreenshot } = await import("../lib/gif-export.mjs"); let attempts = 0;
  const client = { send: async method => { if (method === "Page.bringToFront") return {}; attempts++; const error = new Error("lost screenshot response"); error.code = "CDP_TIMEOUT"; throw error; } };
  await assert.rejects(captureScreenshot(client, { format: "png", fromSurface: true }, "session"), /lost screenshot/);
  assert.equal(attempts, 2);
});

test("unanswered browser commands time out and release their pending promise", { timeout: 1000 }, async () => {
  const { DevTools } = await import("../lib/gif-export.mjs");
  const client = new DevTools({ readyState: WebSocket.OPEN, send() {} });
  await assert.rejects(client.send("Page.captureScreenshot", {}, "session", 20), error => error.code === "CDP_TIMEOUT" && error.message.includes("Page.captureScreenshot"));
  assert.equal(client.pending.size, 0);
});

test("a lost screenshot response recovers with real Edge viewport pixels and allows a later export", { timeout: 45000 }, async t => {
  if (process.platform !== "win32") { t.skip("Windows Edge required"); return; }
  const NativeWebSocket = globalThis.WebSocket; let dropped = false;
  globalThis.WebSocket = class extends NativeWebSocket {
    send(message) { const request = JSON.parse(message); if (!dropped && request.method === "Page.captureScreenshot") { dropped = true; return; } return super.send(message); }
  };
  const dir = await temporary(t), gifs = new GIFExports({ root: join(dir, "gifs") });
  try {
    const html = '<body style="margin:0;background:blue"></body>', started = Date.now();
    const result = await gifs.generate(html, { width: 180, height: 100, durationMs: 500, fps: 4 });
    const gif = await gifs.read(result.id); assert.equal(imageFrames(gif).length, 2);
    const [red, green, blue] = pixelColor(gif, imageFrames(gif)[0], 0);
    assert.ok(red < 40 && green < 40 && blue > 200, `Recovered screenshot must contain the blue page: ${red},${green},${blue}`);
    assert.ok(Date.now() - started < 20000, "One lost frame response must not wait for the 60-second job deadline");
    globalThis.WebSocket = NativeWebSocket;
    const retry = await gifs.generate(html, { width: 180, height: 100, durationMs: 500, fps: 4 }); assert.equal(imageFrames(await gifs.read(retry.id)).length, 2);
  } finally { globalThis.WebSocket = NativeWebSocket; await gifs.close(); }
});

test("a wedged browser capture queue is rebuilt once and preserves real page pixels", { timeout: 45000 }, async t => {
  if (process.platform !== "win32") { t.skip("Windows Edge required"); return; }
  const NativeWebSocket = globalThis.WebSocket; let browsers = 0;
  globalThis.WebSocket = class extends NativeWebSocket {
    constructor(...args) { super(...args); this.wedged = ++browsers === 1; }
    send(message) { if (this.wedged && JSON.parse(message).method === "Page.captureScreenshot") return; return super.send(message); }
  };
  const dir = await temporary(t), gifs = new GIFExports({ root: join(dir, "gifs") });
  try {
    const started = Date.now(), result = await gifs.generate('<body style="margin:0;background:blue"></body>', { width: 180, height: 100, durationMs: 500, fps: 4 });
    const gif = await gifs.read(result.id), frames = imageFrames(gif), [red, green, blue] = pixelColor(gif, frames[0], 0);
    assert.equal(browsers, 2); assert.equal(frames.length, 2); assert.ok(red < 40 && green < 40 && blue > 200);
    assert.ok(Date.now() - started < 35000, "A fresh isolated browser must replace the frozen capture queue without waiting for a global job deadline");
  } finally { globalThis.WebSocket = NativeWebSocket; await gifs.close(); }
});

test("lost screenshot responses during paused animation fail cleanly and a later export still works", { timeout: 45000 }, async t => {
  if (process.platform !== "win32") { t.skip("Windows Edge required"); return; }
  const NativeWebSocket = globalThis.WebSocket; let captures = 0;
  globalThis.WebSocket = class extends NativeWebSocket {
    send(message) { const request = JSON.parse(message); if (request.method === "Page.captureScreenshot" && ++captures > 1) return; return super.send(message); }
  };
  const dir = await temporary(t), gifs = new GIFExports({ root: join(dir, "gifs") });
  try {
    const started = Date.now();
    await assert.rejects(gifs.generate(animation, { width: 180, height: 100, durationMs: 500, fps: 4 }), /超时/);
    assert.ok(Date.now() - started < 35000); assert.equal(gifs.generating, false);
    assert.deepEqual((await readdir(gifs.session)).filter(name => name !== ".magpie-gif-session.json"), [], "A failed capture releases its child browser and removes the temporary profile");
    globalThis.WebSocket = NativeWebSocket;
    const retry = await gifs.generate(animation, { width: 180, height: 100, durationMs: 500, fps: 4 }); assert.equal(imageFrames(await gifs.read(retry.id)).length, 2);
  } finally { globalThis.WebSocket = NativeWebSocket; await gifs.close(); }
});

test("GIF save snapshots source bytes before a picker can trigger retention cleanup", { timeout: 5000 }, async t => {
  const dir = await temporary(t), gifs = new GIFExports({ root: join(dir, "gifs") }); await gifs.init();
  const id = randomUUID(), source = join(gifs.session, `${id}.gif`), bytes = Buffer.from("GIF89a source retained while dialog is open"), selected = join(dir, "saved.gif");
  await writeFile(source, bytes); gifs.entries.set(id, { path: source, size: bytes.length, createdAt: Date.now() - 10000 });
  const originalSpawn = childProcess.spawn, dialog = Promise.withResolvers();
  childProcess.spawn = (command, args, options) => {
    assert.equal(basename(command), "SaveJson.exe"); assert.equal(options.windowsHide, false);
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stdout.setEncoding = () => child.stdout; child.kill = () => true; dialog.resolve(child); return child;
  };
  syncBuiltinESMExports();
  try {
    const pending = gifs.save(id), picker = await dialog.promise;
    let newest;
    for (let index = 0; index < 5; index++) {
      const newer = randomUUID(), path = join(gifs.session, `${newer}.gif`); await writeFile(path, Buffer.from("GIF89a newer")); gifs.entries.set(newer, { path, size: 12, createdAt: Date.now() + index }); newest = path;
    }
    const removed = await gifs.prune(newest); assert.ok(removed.includes(id)); await assert.rejects(access(source), { code: "ENOENT" });
    picker.stdout.emit("data", selected); picker.emit("close", 0);
    assert.deepEqual(await pending, { path: selected }); assert.deepEqual(await readFile(selected), bytes);
  } finally { childProcess.spawn = originalSpawn; syncBuiltinESMExports(); await rm(selected, { force: true }); await gifs.close(); }
});

test("GIF export rejects invalid render limits before starting the renderer", async t => {
  const dir = await temporary(t), gifs = new GIFExports({ root: join(dir, "gifs") }); t.after(() => gifs.close());
  let sweeps = 0; gifs.sweep = async () => { sweeps++; };
  for (const options of [{ width: Number.NaN }, { height: Infinity }, { durationMs: Number.NaN }, { fps: 24.5 }, { width: "960" }]) {
    await assert.rejects(gifs.generate(animation, options), error => error.status === 400 && /参数无效/.test(error.message));
  }
  assert.equal(sweeps, 0, "Invalid dimensions must fail before touching temporary storage");
});

function imageFrames(gif, delays = []) {
  assert.equal(gif.toString("ascii", 0, 6), "GIF89a");
  let offset = 13;
  const packed = gif[10];
  if (packed & 0x80) offset += 3 * (2 ** ((packed & 7) + 1));
  const frames = [];
  while (offset < gif.length) {
    const marker = gif[offset++];
    if (marker === 0x3b) return frames;
    if (marker === 0x21) { if (gif[offset] === 0xf9) delays.push(gif.readUInt16LE(offset + 3) * 10); offset += 1; while (true) { const length = gif[offset++]; if (!length) break; offset += length; } continue; }
    assert.equal(marker, 0x2c, "Each output frame must be a well-formed GIF image block");
    const start = offset - 1;
    offset += 9;
    const flags = gif[offset - 1];
    if (flags & 0x80) offset += 3 * (2 ** ((flags & 7) + 1));
    offset += 1;
    while (true) { const length = gif[offset++]; if (!length) break; offset += length; }
    frames.push(gif.subarray(start, offset));
  }
  throw new Error("Missing GIF trailer");
}

function framePixels(frame) {
  assert.equal(frame[9] & 0xc0, 0, "Test fixtures use full, non-interlaced global-palette frames");
  const minimum = frame[10], clear = 1 << minimum, end = clear + 1, chunks = [];
  for (let at = 11; frame[at]; at += frame[at] + 1) chunks.push(frame.subarray(at + 1, at + 1 + frame[at]));
  const data = Buffer.concat(chunks), pixels = new Uint8Array(frame.readUInt16LE(5) * frame.readUInt16LE(7));
  let dictionary, bits, next, previous, bit = 0, written = 0;
  const reset = () => { dictionary = Array.from({ length: clear }, (_, i) => [i]); bits = minimum + 1; next = end + 1; previous = null; };
  reset();
  while (bit + bits <= data.length * 8) {
    let code = 0;
    for (let n = 0; n < bits; n++, bit++) code |= ((data[bit >> 3] >> (bit & 7)) & 1) << n;
    if (code === clear) { reset(); continue; }
    if (code === end) break;
    const entry = dictionary[code] || (code === next && previous ? [...previous, previous[0]] : null);
    assert.ok(entry, "Valid GIF LZW dictionary reference");
    pixels.set(entry, written); written += entry.length;
    if (previous && next < 4096) { dictionary[next++] = [...previous, entry[0]]; if (next === 1 << bits && bits < 12) bits++; }
    previous = entry;
  }
  assert.equal(written, pixels.length);
  return pixels;
}

const pixelColor = (gif, frame, pixel) => [...gif.subarray(13 + framePixels(frame)[pixel] * 3, 16 + framePixels(frame)[pixel] * 3)];

test("Canvas frames use presentation timestamps without alternating short and long motion steps", { timeout: 30000 }, async t => {
  if (process.platform !== "win32") { t.skip("Windows Edge required"); return; }
  const dir = await temporary(t), gifs = new GIFExports({ root: join(dir, "gifs") }); t.after(() => gifs.close());
  const html = `<body style="margin:0"><canvas width="180" height="100"></canvas><script>
    const c=document.querySelector('canvas').getContext('2d');let start;
    function draw(now){start??=now;c.fillStyle='rgb('+Math.round((now-start)/2)+',0,0)';c.fillRect(0,0,180,100);requestAnimationFrame(draw)}requestAnimationFrame(draw);
    </script>`;
  const result = await gifs.generate(html, { width: 180, height: 100, durationMs: 500, fps: 25 });
  const gif = await gifs.read(result.id), reds = imageFrames(gif).map(frame => pixelColor(gif, frame, 0)[0]);
  assert.deepEqual(reds, [0,20,40,60,80,100,120,140,160,180,200,220,240], "Every frame samples the exact 40 ms presentation time");
  await gifs.remove(result.id);
});

test("static colors do not flicker when the first pixel in a quantization bucket changes", { timeout: 30000 }, async t => {
  if (process.platform !== "win32") { t.skip("Windows Edge required"); return; }
  const dir = await temporary(t), gifs = new GIFExports({ root: join(dir, "gifs") }); t.after(() => gifs.close());
  const html = `<body style="margin:0"><canvas width="180" height="100"></canvas><script>
    const c=document.querySelector('canvas').getContext('2d');let start;
    function draw(now){start??=now;c.fillStyle='rgb(12,0,0)';c.fillRect(0,0,180,100);
      c.fillStyle='rgb(7,0,0)';c.fillRect(0,99,1,1);c.fillStyle='rgb(16,0,0)';c.fillRect(179,99,1,1);
      c.fillStyle='rgb('+(Math.round((now-start)/40)%2?15:8)+',0,0)';c.fillRect(0,0,1,1);requestAnimationFrame(draw)}requestAnimationFrame(draw);
    </script>`;
  const result = await gifs.generate(html, { width: 180, height: 100, durationMs: 500, fps: 25 });
  const gif = await gifs.read(result.id), colors = imageFrames(gif).map(frame => pixelColor(gif, frame, 50 * 180 + 50).join(','));
  assert.equal(new Set(colors).size, 1, `A moving leading pixel must not recolor a static background: ${colors}`);
  await gifs.remove(result.id);
});

test("the isolated browser exports a real animated GIF from inline HTML and removes it on request", { timeout: 60000 }, async t => {
  if (process.platform !== "win32") { t.skip("Windows GIF rendering requires the local Edge browser"); return; }
  const dir = await temporary(t), gifs = new GIFExports({ root: join(dir, "temporary-gifs") });
  let previousBeat = performance.now(), maximumGap = 0;
  const heartbeat = setInterval(() => { const at = performance.now(); maximumGap = Math.max(maximumGap, at - previousBeat); previousBeat = at; }, 20);
  t.after(() => clearInterval(heartbeat));
  const result = await gifs.generate(animation);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.ok(maximumGap < 750, `Encoding must keep the page service responsive (longest heartbeat gap ${Math.round(maximumGap)} ms)`);
  const content = await gifs.read(result.id);
  assert.ok(content.length > 250, "A valid GIF contains its palette and changing frames");
  const delays = [], frames = imageFrames(content, delays);
  assert.equal(content.readUInt16LE(6), 960, "Export keeps the preview's logical width without downsampling");
  assert.equal(content.readUInt16LE(8), 600);
  assert.equal(frames.length, 100, "Screenshot overhead must not drop frames from four seconds at 25 fps");
  assert.equal(delays.length, frames.length);
  assert.ok(delays.every(delay => delay === 40), "Even capture intervals prevent screenshot latency from causing stutter");
  assert.ok(frames.every(frame => !(frame[9] & 0x80)), "One shared color table keeps static backgrounds from changing color between frames");
  assert.ok(new Set(frames.map(frame => frame.toString("base64"))).size > 1, "Moving artwork produces genuinely changing frames");
  assert.deepEqual((await gifs.read(result.id)).subarray(0, 6).toString("ascii"), "GIF89a");
  const expiredFile = gifs.entries.get(result.id).path;
  gifs.entries.get(result.id).createdAt = Date.now() - 25 * 60 * 60 * 1000;
  await gifs.sweep();
  await assert.rejects(() => readFile(expiredFile), { code: "ENOENT" }, "Expired files are removed, not only hidden from the UI");
  assert.deepEqual(await gifs.remove(result.id), { removed: false });
  await assert.rejects(() => gifs.read(result.id), /不存在/);
  const abort = new AbortController(), cancelled = gifs.generate(animation, { width: 180, height: 100, durationMs: 4000, fps: 10, signal: abort.signal });
  const cancelTimer = setTimeout(() => abort.abort(), 250);
  await assert.rejects(cancelled, /GIF 生成已取消/); clearTimeout(cancelTimer);
  assert.equal(gifs.generating, false); assert.deepEqual((await readdir(gifs.session)).filter(name => name !== ".magpie-gif-session.json"), [], "Cancellation removes the throwaway browser profile");
  await gifs.close();
});

test("GIF rendering enforces the preview content policy while allowing inline animation scripts", { timeout: 30000 }, async t => {
  if (process.platform !== "win32") { t.skip("Windows Edge required"); return; }
  const dir = await temporary(t), gifs = new GIFExports({ root: join(dir, "gifs") });
  const html = `<!doctype html><html><body style="margin:0"><script>try { eval("document.body.style.background='red'"); } catch { document.body.style.background='blue'; }</script></body></html>`;
  const result = await gifs.generate(html, { width: 180, height: 100, durationMs: 500, fps: 4 });
  const gif = await gifs.read(result.id), colors = [];
  for (let at = 13; at < 13 + 3 * 2 ** ((gif[10] & 7) + 1); at += 3) colors.push([...gif.subarray(at, at + 3)]);
  assert.ok(colors.some(([r, g, b]) => r < 40 && g < 40 && b > 200), "Inline scripts run, but unsafe eval is blocked by the same CSP used for previews");
  await gifs.remove(result.id); await gifs.close();
});

test("offline capture retains 60 Hz animation callbacks independently of the GIF frame rate", { timeout: 30000 }, async t => {
  if (process.platform !== "win32") { t.skip("Windows Edge required"); return; }
  const dir = await temporary(t), gifs = new GIFExports({ root: join(dir, "gifs") });
  t.after(() => gifs.close());
  const html = `<!doctype html><html><head><style>
    body{margin:0;background:#000}canvas{position:absolute;left:0;top:0}
    #css{position:absolute;left:120px;width:60px;height:100px;animation:color 1s linear forwards}
    @keyframes color{from{background:#000}to{background:#00f}}
    </style></head><body><canvas width="120" height="100"></canvas><div id="css"></div><script>
    const c=document.querySelector('canvas').getContext('2d');let frames=0,ticks=0,origin;
    function draw(now){if(origin===undefined){origin=now;setInterval(()=>{c.fillStyle='rgb(0,'+(++ticks*8)+',0)';c.fillRect(40,0,40,100)},40)}
      c.fillStyle='rgb('+(++frames*6)+',0,0)';c.fillRect(0,0,40,100);
      c.fillStyle='rgb(0,0,'+Math.round((now-origin)/4)+')';c.fillRect(80,0,40,100);requestAnimationFrame(draw)}requestAnimationFrame(draw);
    </script></body></html>`;
  const result = await gifs.generate(html, { width: 180, height: 100, durationMs: 500, fps: 25 });
  const gif = await gifs.read(result.id), colors = [];
  for (let at = 13; at < 13 + 3 * 2 ** ((gif[10] & 7) + 1); at += 3) colors.push([...gif.subarray(at, at + 3)]);
  const maximum = channel => Math.max(...colors.map(color => color[channel]));
  // The last capture is at 480 ms: one initial callback plus 28 ticks, not 37 callbacks.
  assert.ok(maximum(0) >= 168 && maximum(0) <= 180, `60 Hz callbacks must not run at each capture remainder (red=${maximum(0)})`);
  assert.ok(maximum(1) >= 88 && maximum(1) <= 104, `Native timers follow virtual time (green=${maximum(1)})`);
  assert.ok(maximum(2) >= 110 && maximum(2) <= 140, `Timestamp and CSS animation colors advance with virtual time (blue=${maximum(2)})`);
  await gifs.remove(result.id);
});

test("GIF cleanup leaves old UUID directories alone unless this service owns them", async t => {
  const dir = await temporary(t), root = join(dir, "gifs"), foreign = join(root, randomUUID());
  await mkdir(foreign, { recursive: true }); await writeFile(join(foreign, "keep.txt"), "not a GIF export");
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000); await utimes(foreign, old, old);
  const gifs = new GIFExports({ root }); await gifs.init();
  assert.equal(await readFile(join(foreign, "keep.txt"), "utf8"), "not a GIF export");
  await gifs.close();
});

test("a restarted service expires individual GIF files even when their session directory was used recently", async t => {
  const dir = await temporary(t), root = join(dir, "gifs"), first = new GIFExports({ root }); await first.init();
  const expired = join(first.session, `${randomUUID()}.gif`), current = join(first.session, `${randomUUID()}.gif`);
  await writeFile(expired, "GIF89a expired");
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000); await utimes(expired, old, old);
  await writeFile(current, "GIF89a current");
  const next = new GIFExports({ root }); await next.init();
  await assert.rejects(() => readFile(expired), { code: "ENOENT" });
  assert.equal(await readFile(current, "utf8"), "GIF89a current");
  await next.close();
});

test("a restarted service can still read a recent retained GIF from its previous session", async t => {
  const dir = await temporary(t), root = join(dir, "gifs"), previous = new GIFExports({ root }); await previous.init();
  const id = randomUUID(), path = join(previous.session, `${id}.gif`), bytes = Buffer.from("GIF89a retained across restart");
  await writeFile(path, bytes); previous.entries.set(id, { path, size: bytes.length, createdAt: Date.now() });
  await previous.close();

  const next = new GIFExports({ root }); await next.init();
  assert.deepEqual(await next.read(id), bytes);
  const emptySession = next.session;
  await next.close();
  assert.deepEqual(await readFile(path), bytes, "Closing a session with retained results must preserve the GIF");
  await assert.rejects(() => readFile(join(emptySession, ".magpie-gif-session.json")), { code: "ENOENT" }, "An empty session created during restart is removed on shutdown");
  const restored = new GIFExports({ root }); await restored.init();
  assert.deepEqual(await restored.read(id), bytes);
  assert.deepEqual(await restored.remove(id), { removed: true });
  await restored.close();
});

test("GIF service startup trims legacy sessions to the five newest files", async t => {
  const dir = await temporary(t), root = join(dir, "gifs"), previous = new GIFExports({ root }); await previous.init();
  const ids = Array.from({ length: 7 }, () => randomUUID()), paths = [];
  for (const [index, id] of ids.entries()) {
    const path = join(previous.session, `${id}.gif`), timestamp = Date.now() - (7 - index) * 10000;
    paths.push(path); await writeFile(path, "GIF89a fixture"); await utimes(path, timestamp / 1000, timestamp / 1000);
  }
  const next = new GIFExports({ root }); await next.init();
  assert.equal((await next.usage()).count, 5);
  for (const path of paths.slice(0, 2)) await assert.rejects(() => readFile(path), { code: "ENOENT" });
  for (const path of paths.slice(2)) await readFile(path);
  await previous.close(); await next.close();
});

test("a successful sixth GIF keeps five files and removes the oldest", { timeout: 60000 }, async t => {
  if (process.platform !== "win32") { t.skip("Windows Edge required"); return; }
  const dir = await temporary(t), root = join(dir, "gifs"), previous = new GIFExports({ root }); await previous.init();
  const gifs = new GIFExports({ root }); t.after(async () => { await previous.close(); await gifs.close(); });
  const ids = Array.from({ length: 5 }, () => randomUUID()), paths = [];
  for (const [index, id] of ids.entries()) {
    const path = join(previous.session, `${id}.gif`), timestamp = Date.now() - (5 - index) * 10000;
    paths.push(path); await writeFile(path, "GIF89a fixture"); await utimes(path, timestamp / 1000, timestamp / 1000);
    previous.entries.set(id, { path, size: 14, createdAt: timestamp });
  }
  const created = await gifs.generate(animation, { width: 180, height: 100, durationMs: 500, fps: 4 });
  assert.equal((await gifs.usage()).count, 5, "The newest result is retained while the oldest result is evicted");
  assert.deepEqual(created.removed, [ids[0]], "The generation response identifies exactly which old file was evicted");
  await assert.rejects(() => readFile(paths[0]), { code: "ENOENT" });
  for (const path of paths.slice(1)) await readFile(path);
  await gifs.read(created.id);
});

test("a cancelled sixth GIF leaves all five older files intact", { timeout: 30000 }, async t => {
  if (process.platform !== "win32") { t.skip("Windows Edge required"); return; }
  const dir = await temporary(t), gifs = new GIFExports({ root: join(dir, "gifs") }); await gifs.init();
  const paths = [];
  for (let index = 0; index < 5; index++) {
    const id = randomUUID(), path = join(gifs.session, `${id}.gif`);
    paths.push(path); await writeFile(path, "GIF89a fixture");
    gifs.entries.set(id, { path, size: 14, createdAt: Date.now() - (5 - index) * 10000 });
  }
  const abort = new AbortController(), pending = gifs.generate(animation, { width: 180, height: 100, durationMs: 4000, fps: 10, signal: abort.signal });
  const timer = setTimeout(() => abort.abort(), 250);
  await assert.rejects(pending, /GIF 生成已取消/); clearTimeout(timer);
  assert.equal((await gifs.usage()).count, 5);
  for (const path of paths) await readFile(path);
});

test("close waits for GIF generation while its initial directory scan is in progress", async t => {
  const dir = await temporary(t), gifs = new GIFExports({ root: join(dir, "gifs") });
  let entered, release;
  const scanning = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const sweep = gifs.sweep.bind(gifs);
  gifs.sweep = async () => { entered(); await gate; return sweep(); };
  const pending = gifs.generate(animation);
  await scanning;
  let closed = false; const closing = gifs.close().then(() => { closed = true; });
  const closedBeforeScan = await Promise.race([closing.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 50))]);
  assert.equal(closedBeforeScan, false, "Shutdown must wait for the registered job before removing its session directory");
  release();
  await assert.rejects(pending, /GIF 生成已取消/);
  await closing;
});

test("a failed ownership marker write removes the new empty GIF session directory", async t => {
  const dir = await temporary(t), gifs = new GIFExports({ root: join(dir, "gifs"), writeSessionMarker: async () => { throw Error("marker write failed"); } });
  await assert.rejects(gifs.initRoot(), /marker write failed/);
  assert.deepEqual(await readdir(gifs.root), [], "A failed marker write must not leave an unowned UUID directory behind");
  await gifs.close();
});
