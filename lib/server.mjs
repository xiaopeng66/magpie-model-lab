import { createServer } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { Gateway, DEFAULT_PROMPT, invalid, safeError } from "./gateway.mjs";
import { RunStore, UUID, ACTIVE } from "./store.mjs";
import { Runner, RETENTION_DAYS, HISTORY_TIME_ZONE } from "./runner.mjs";
import { batchKey } from "./history-groups.mjs";
import { previewDocument, summary } from "./result.mjs";
import { openBrowser, openDirectory } from "./browser.mjs";
import { saveJSON } from "./export.mjs";
import { FingerprintBank } from "./fingerprint-bank.mjs";
import { Favorites } from "./favorites.mjs";
import { Scheduler } from "./scheduler.mjs";
import { CANDY_PROMPT, CANDY_VERSION } from "./candy.mjs";
import metadata from "../package.json" with { type: "json" };

const UI = fileURLToPath(new URL("../ui/", import.meta.url));
const PREVIEW_POLICY = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
const JAVASCRIPT = "text/javascript; charset=utf-8";
const MIME = { "index.html": "text/html; charset=utf-8", "app.js": JAVASCRIPT, "favorites.js": JAVASCRIPT, "history-preview.mjs": JAVASCRIPT, "style.css": "text/css; charset=utf-8", "polish.css": "text/css; charset=utf-8", "icon.png": "image/png" };
const HISTORY_GROUPS = fileURLToPath(new URL("./history-groups.mjs", import.meta.url));
const SECRET_HEADER = "x-pelican-token";

async function jsonBody(req) {
  let size = 0; const chunks = [];
  for await (const bytes of req) {
    size += bytes.length;
    if (size > 65536) throw invalid("请求体超过 64 KiB", 413);
    chunks.push(bytes);
  }
  let body;
  try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size))); }
  catch { throw invalid("请求不是有效 UTF-8 JSON"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid("请求 JSON 需为对象");
  return body;
}

function batchExport(id, members, extra = {}) {
  const kinds = [...new Set(members.map(run => run.kind || "pelican"))];
  return { schema: "pelican-batch-v1", batchId: id, kind: kinds[0], kinds, exportedAt: new Date().toISOString(), ...extra,
    runs: members.map(({ previewKey, ...run }) => run) };
}

function equalSecret(got, want) {
  const value = Buffer.from(typeof got === "string" ? got : "");
  const secret = Buffer.from(want);
  return value.length === secret.length && timingSafeEqual(value, secret);
}

export async function startServer({ port = 3489, dataDir, gatewayUrl, gatewayKey, bankSource, bankDir, timeoutMs = 600000, openPreview = openBrowser, openStorage = openDirectory, saveExport = saveJSON } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw invalid("服务端口需为 1–65535 的整数");
  const addr = process.env.MAGPIE_ADDR;
  const defaultURL = addr ? (/^https?:\/\//.test(addr) ? addr : `http://${addr}`) : "http://127.0.0.1:3425";
  const gateway = new Gateway({ url: gatewayUrl || defaultURL, key: gatewayKey || process.env.MAGPIE_GATEWAY_KEY || "magpie" });
  const dir = dataDir || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "magpie", "magpie-pelican-bench", "runs");
  const store = new RunStore(dir);
  const bank = new FingerprintBank({ dir: bankDir || join(store.dir, ".fingerprint-bank"), source: bankSource || process.env.MAGPIE_PELICAN_BANK_SOURCE });
  let recovery = null, runner = null, favorites = null, scheduler = null, unsubscribe = () => {};
  const favoriteSnapshot = () => favorites.snapshot();
  const token = randomBytes(32).toString("hex");
  const saveController = new AbortController(); let savingExport = false;
  async function saveBatch(snapshot) {
    if (savingExport) throw invalid("已有 JSON 保存窗口，请先完成或取消后再试", 409);
    savingExport = true;
    try {
      const date = snapshot.date || new Intl.DateTimeFormat("en-CA", { timeZone: HISTORY_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(snapshot.runs[0].createdAt));
      const key = createHash("sha256").update(snapshot.batchId).digest("hex").slice(0, 8);
      const filename = `magpie-model-lab-${date}-${snapshot.kinds.length === 1 ? snapshot.kind : "batch"}-${key}.json`;
      return await saveExport(snapshot, filename, { signal: saveController.signal });
    } finally { savingExport = false; }
  }
  const clients = new Set();
  let actualPort = port, closed = false, retry = null, retention = null, listening = false;
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  ready.catch(() => {});
  const hosts = () => new Set([`127.0.0.1:${actualPort}`, `localhost:${actualPort}`]);
  const origins = () => new Set([`http://127.0.0.1:${actualPort}`, `http://localhost:${actualPort}`]);
  const cors = (req) => ({
    "access-control-allow-origin": req.headers.origin === "null" ? "null" : (origins().has(req.headers.origin) ? req.headers.origin : "null"),
    "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type, x-pelican-token", vary: "Origin",
  });
  const baseHeaders = { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };
  const send = (req, res, status, body, type = "application/json; charset=utf-8", extra = {}, api = false) => {
    if (res.destroyed) return;
    res.writeHead(status, { ...baseHeaders, ...(api ? cors(req) : {}), "content-type": type, ...extra });
    res.end(typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body));
  };
  const emit = (res, event, value) => {
    if (res.destroyed || res.writableEnded) return;
    if (res.writableLength > 1024 * 1024) { res.destroy(); return; }
    res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
  };
  const heartbeat = setInterval(() => { for (const client of clients) emit(client, "heartbeat", {}); }, 15000);
  heartbeat.unref?.();

  const server = createServer(async (req, res) => {
    try {
      if (!hosts().has(String(req.headers.host || "").toLowerCase())) return send(req, res, 403, { error: "Host 不属于本地插件服务" });
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== "null" && !origins().has(origin)) return send(req, res, 403, { error: "请求来源不属于插件页面" });
      const url = new URL(req.url, `http://127.0.0.1:${actualPort}`);
      const path = url.pathname;
      const api = path.startsWith("/api/");
      if (api && req.method === "OPTIONS") return send(req, res, 204, "", undefined, {}, true);
      if (api && !equalSecret(req.headers[SECRET_HEADER], token)) return send(req, res, 403, { error: "页面口令失效，请重新打开模型实验室", reload: true }, undefined, {}, true);
      if ((api || path.startsWith("/preview/")) && !runner) return send(req, res, 503, { error: "服务正在恢复历史，请稍后重试" }, undefined, {}, api);
      if (api) {
        if (path === "/api/events" && req.method === "GET") {
          res.writeHead(200, { ...baseHeaders, ...cors(req), "content-type": "text/event-stream; charset=utf-8", connection: "keep-alive", "x-accel-buffering": "no" });
          emit(res, "hello", { runs: runner.list() });
          clients.add(res); res.on("close", () => clients.delete(res));
          return;
        }
        if (path === "/api/bootstrap" && req.method === "GET") {
          let models = [], error = "";
          try { models = await runner.models(); } catch (err) { error = safeError(err); }
          return send(req, res, 200, { version: metadata.version, models, runs: runner.list(), defaultPrompt: DEFAULT_PROMPT, candyPrompt: CANDY_PROMPT, candyVersion: CANDY_VERSION, favorites: favoriteSnapshot(), favoritesAvailable: true, candyAvailable: true, dataDir: store.dir, retentionDays: RETENTION_DAYS, historyTimeZone: HISTORY_TIME_ZONE,
            batchCleanup: true, openDataDir: true, batchCancel: true, batchExport: true, fingerprintAvailable: true, bankStatus: bank.status(), error, recovery }, undefined, {}, true);
        }
        if (path === "/api/fingerprint/bank" && req.method === "GET") return send(req, res, 200, bank.status(), undefined, {}, true);
        if (path === "/api/fingerprint/bank/refresh" && req.method === "POST") {
          await bank.refresh(); return send(req, res, 200, bank.status(), undefined, {}, true);
        }
        if (path === "/api/fingerprint/accounts" && req.method === "GET") {
          return send(req, res, 200, { accounts: await gateway.accounts() }, undefined, {}, true);
        }
        if (path === "/api/storage/open" && req.method === "POST") {
          await openStorage(store.dir);
          return send(req, res, 200, { opened: true }, undefined, {}, true);
        }
        if (path === "/api/models" && req.method === "GET") return send(req, res, 200, { models: await runner.models(true) }, undefined, {}, true);
        if (path === "/api/runs" && req.method === "GET") return send(req, res, 200, { runs: runner.list() }, undefined, {}, true);
        if (path === "/api/runs" && req.method === "POST") return send(req, res, 201, { runs: await runner.submit(await jsonBody(req)) }, undefined, {}, true);
        if (path === "/api/runs/cleanup" && req.method === "POST") return send(req, res, 200, await runner.cleanup(await jsonBody(req)), undefined, {}, true);
        if (path === "/api/favorites" && req.method === "GET") return send(req, res, 200, favoriteSnapshot(), undefined, {}, true);
        const favoriteAction = /^\/api\/(favorites|schedules)\/(save|remove|run|settings)$/.exec(path);
        if (favoriteAction && req.method === "POST") {
          const body = await jsonBody(req), action = `${favoriteAction[1]}/${favoriteAction[2]}`;
          if (action === "favorites/save") return send(req, res, 200, { favorite: await favorites.save(body) }, undefined, {}, true);
          if (action === "favorites/remove") return send(req, res, 200, await favorites.remove(body), undefined, {}, true);
          if (action === "favorites/run") throw invalid("自动测试页仅按模型计划运行；手动测试请使用独立测试页", 410);
          if (action === "schedules/save") return send(req, res, 200, { plan: await favorites.savePlan(body) }, undefined, {}, true);
          if (action === "schedules/remove") return send(req, res, 200, await favorites.removePlan(body), undefined, {}, true);
          if (action === "schedules/settings") return send(req, res, 200, await favorites.settings(body), undefined, {}, true);
        }
        if (["/api/batches/export", "/api/batches/save"].includes(path) && req.method === "POST") {
          const group = runner.dailyGroup((await jsonBody(req)).runIds);
          if (group.runs.some(run => ACTIVE.has(run.status) || runner.busy(run.id))) throw invalid("本批仍有任务未完成，请结束后再导出", 409);
          const snapshot = batchExport(group.id, group.runs, { source: group.source, date: group.date, timeZone: HISTORY_TIME_ZONE });
          return send(req, res, 200, path.endsWith("/save") ? await saveBatch(snapshot) : snapshot, undefined, {}, true);
        }
        const batchRoute = /^\/api\/batches\/([^/]+)\/(cancel|export|save)$/.exec(path);
        if (batchRoute) {
          const id = batchRoute[1]; if (!UUID.test(id)) throw invalid("批次 ID 无效");
          if (batchRoute[2] === "cancel" && req.method === "POST") return send(req, res, 200, { runs: await runner.cancelBatch(id) }, undefined, {}, true);
          if ((batchRoute[2] === "export" && req.method === "GET") || (batchRoute[2] === "save" && req.method === "POST")) {
            const save = batchRoute[2] === "save";
            if (save) await jsonBody(req);
            const members = [...runner.runs.values()].filter(run => batchKey(run) === id);
            if (!members.length) throw invalid("没有找到这个批次", 404);
            if (save && members.some(run => ACTIVE.has(run.status) || runner.busy(run.id))) throw invalid("本批仍有任务未完成，请结束后再导出", 409);
            const snapshot = batchExport(id, members);
            return send(req, res, 200, save ? await saveBatch(snapshot) : snapshot, undefined, {}, true);
          }
        }
        const runRoute = /^\/api\/runs\/([^/]+)(\/(?:cancel|open))?$/.exec(path);
        if (runRoute) {
          const id = runRoute[1];
          if (!UUID.test(id)) throw invalid("运行 ID 无效");
          const run = runner.get(id);
          if (!run) throw invalid("没有找到这个运行结果", 404);
          if (runRoute[2] === "/cancel" && req.method === "POST") return send(req, res, 200, await runner.cancel(id), undefined, {}, true);
          if (runRoute[2] === "/open" && req.method === "POST") {
            if (run.status !== "completed" || !run.html || !run.previewKey) throw invalid("本次结果尚不可预览");
            await openPreview(`http://127.0.0.1:${actualPort}/preview/${id}?key=${run.previewKey}`);
            return send(req, res, 200, { opened: true }, undefined, {}, true);
          }
          if (!runRoute[2] && req.method === "GET") {
            let previewUrl = "";
            if (run.status === "completed" && run.html) {
              previewUrl = `preview/${id}?key=${run.previewKey}`;
            }
            const { previewKey, ...detail } = run;
            return send(req, res, 200, { ...detail, ...summary(run), previewUrl }, undefined, {}, true);
          }
        }
        return send(req, res, 404, { error: "没有这个接口" }, undefined, {}, true);
      }
      const preview = /^\/preview\/([a-f0-9-]+)$/.exec(path);
      if (preview && req.method === "GET") {
        const id = preview[1];
        const run = runner.get(id);
        if (!run?.previewKey || !equalSecret(url.searchParams.get("key"), run.previewKey)) return send(req, res, 403, "预览链接无效", "text/plain; charset=utf-8");
        if (run?.status !== "completed" || !run.html) return send(req, res, 404, "本次结果不可预览", "text/plain; charset=utf-8");
        return send(req, res, 200, previewDocument(run), "text/html; charset=utf-8", { "content-security-policy": PREVIEW_POLICY });
      }
      const file = path === "/" ? "index.html" : path.slice(1);
      if (req.method === "GET" && (file === "lib/history-groups.mjs" || Object.hasOwn(MIME, file))) {
        const type = file === "lib/history-groups.mjs" ? JAVASCRIPT : MIME[file];
        let data = await readFile(file === "lib/history-groups.mjs" ? HISTORY_GROUPS : join(UI, file));
        if (file === "index.html") data = data.toString("utf8").replace("<head>", `<head>\n<meta name="pelican-token" content="${token}">`);
        const own = `http://127.0.0.1:${actualPort} http://localhost:${actualPort}`;
        const policy = `default-src 'none'; script-src 'self' ${own}; style-src 'self' ${own} 'unsafe-inline'; img-src 'self' ${own} data:; connect-src 'self' ${own}; frame-src 'self' ${own}; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
        return send(req, res, 200, data, type, { "content-security-policy": policy }, type === JAVASCRIPT);
      }
      return send(req, res, 404, "没有这个文件", "text/plain; charset=utf-8");
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      send(req, res, error.status || 500, { error: safeError(error) }, undefined, {}, (req.url || "").startsWith("/api/"));
    }
  });
  server.requestTimeout = 30000;

  const attempt = () => new Promise((resolve) => {
    const failed = (error) => {
      server.off("listening", bound);
      if (error.code === "EADDRINUSE" && !closed) { retry = setTimeout(bind, 500); resolve(false); }
      else { readyReject(error); resolve(false); }
    };
    const bound = async () => {
      server.off("error", failed); listening = true; actualPort = server.address().port;
      try {
        // Recover only after owning the port: the previous host may still be saving its final reply.
        recovery = await store.init();
        await bank.init();
        runner = new Runner({ store, gateway, bank, timeoutMs });
        favorites = new Favorites({ dir: store.dir, runner }); await favorites.init();
        scheduler = new Scheduler(favorites); scheduler.start();
        const expire = () => runner.cleanup({ mode: "before", before: new Date(Date.now() - RETENTION_DAYS * 86400000).toISOString() });
        const cleanup = await expire();
        recovery.expiredRemoved = cleanup.removed.length; recovery.cleanupErrors = cleanup.errors;
        unsubscribe = runner.subscribe((event) => {
          for (const client of clients) emit(client, event.type, event);
        });
        retention = setInterval(() => { expire().then((result) => {
          for (const error of result.errors) console.error(`[pelican-bench] cleanup: ${error.error}`);
        }).catch((error) => console.error(`[pelican-bench] cleanup: ${safeError(error)}`)); }, 3600000);
        retention.unref?.();
        readyResolve(actualPort); resolve(true);
      } catch (error) { readyReject(error); server.close(); listening = false; resolve(false); }
    };
    server.once("error", failed); server.once("listening", bound);
    server.listen(port, "127.0.0.1");
  });
  const bind = () => { if (!closed) attempt(); };
  await attempt();
  return {
    get port() { return actualPort; }, get url() { return `http://127.0.0.1:${actualPort}/`; },
    get listening() { return listening; }, dataDir: store.dir, ready,
    async close() {
      if (closed) return;
      closed = true; saveController.abort(); clearTimeout(retry); clearInterval(heartbeat); clearInterval(retention); unsubscribe(); readyResolve(0);
      for (const client of clients) client.end();
      await scheduler?.close(); await favorites?.close(); await runner?.close();
      await bank.close();
      if (listening) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    },
  };
}
