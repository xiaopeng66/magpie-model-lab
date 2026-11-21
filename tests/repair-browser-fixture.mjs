// RYP: actual UI assets with synthetic in-memory state; no model or account API is connected.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";

const root = resolve(import.meta.dirname, ".."), model = { id: "fixture/one", name: "One", provider: "fixture", providerName: "Fixture", efforts: ["low", "high"] };
const favorite = { id: "repair-favorite", modelId: model.id, modelName: model.name, provider: model.provider, providerName: model.providerName, available: true, effort: "", maxTokens: 1200, prompt: "isolated fixture" };
const plan = { id: "repair-plan", favoriteIds: [favorite.id], kinds: ["candy"], enabled: false, mode: "times", times: ["09:00"], days: [1, 2, 3, 4, 5], timeZone: "UTC", today: { date: "2026-11-21", slots: [] } };
const state = { favorites: [favorite], plans: [plan], concurrency: 3, maxDailySlots: 24 }, requests = [];
let accounts = null, save = null;
const json = (res, data, status = 200) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(data)); };
const assets = new Set(["ui/index.html", "ui/app.js", "ui/favorites.js", "ui/history-preview.mjs", "ui/batch-retest.mjs", "ui/retest.mjs", "ui/result-insights.mjs", "ui/style.css", "ui/polish.css", "ui/enhancements.css", "ui/icon.png", "lib/history-groups.mjs", "lib/diagnostics.mjs", "lib/comparison.mjs"]);
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, "http://127.0.0.1").pathname;
    if (path === "/api/bootstrap") return json(res, { version: "1.0.4 repair fixture", models: [model], runs: [], defaultPrompt: "isolated fixture", dataDir: "(isolated fixture)", favoritesAvailable: true, fingerprintAvailable: true, candyAvailable: true, favorites: state });
    if (path === "/api/events") { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(": fixture\n\n"); return; }
    if (path === "/api/favorites") return json(res, state);
    if (path === "/api/fingerprint/accounts") { accounts = res; requests.push({ path }); return; }
    if (["/api/favorites/manage", "/api/schedules/save"].includes(path) && req.method === "POST") {
      let text = ""; for await (const bytes of req) text += bytes;
      save = { res, path, body: JSON.parse(text) }; requests.push({ path, body: save.body }); return;
    }
    if (path === "/review/release-accounts" && req.method === "POST") { if (accounts) { json(accounts, { accounts: [{ provider: "fixture", id: "cached-account", name: "Cached fixture account" }] }); accounts = null; } return json(res, { released: true }); }
    if (path === "/review/release-save" && req.method === "POST") {
      if (save) {
        if (save.path.endsWith("/manage")) { state.concurrency = save.body.concurrency; json(save.res, state); }
        else { Object.assign(plan, save.body); json(save.res, { plan }); }
        save = null;
      }
      return json(res, { released: true });
    }
    if (path === "/review/state") return json(res, { pendingAccounts: Boolean(accounts), pendingSave: Boolean(save), savedPlan: plan, concurrency: state.concurrency, requests, modelRequests: 0 });
    if (path === "/review/close" && req.method === "POST") { json(res, { closed: true }); server.closeAllConnections(); server.close(); return; }
    const file = path === "/" ? "ui/index.html" : path.slice(1).includes("/") ? path.slice(1) : "ui/" + path.slice(1);
    if (!assets.has(file)) return json(res, { error: "Isolated fixture route unavailable" }, 404);
    let bytes = await readFile(join(root, file));
    if (file === "ui/index.html") bytes = Buffer.from(bytes.toString("utf8").replace("<head>", '<head><meta name="pelican-token" content="isolated-repair-fixture">'));
    const type = file.endsWith(".css") ? "text/css" : file.endsWith(".html") ? "text/html" : /\.(?:js|mjs)$/.test(file) ? "text/javascript" : "image/png";
    res.writeHead(200, { "content-type": type + "; charset=utf-8", "cache-control": "no-store" }); res.end(bytes);
  } catch (error) { json(res, { error: error.message }, 500); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/`, modelRequests: 0 }));
