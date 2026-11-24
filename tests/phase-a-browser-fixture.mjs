import { pathToFileURL } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RunStore } from "../lib/store.mjs";
import { phaseABoot, PHASE_HTML } from "./phase-a-fixtures.mjs";
import { fakeGateway, startTestServer } from "./helpers.mjs";

// RYP: real authenticated service, isolated records, local synthetic upstream only.
export async function startPhaseAFixture({ dataDir, port = 0, count = 6, active = true } = {}) {
  const ownedDir = !dataDir, dir = dataDir || await mkdtemp(join(tmpdir(), "phase-a-browser-"));
  const cleanups = [], t = { after(fn) { cleanups.push(fn); } };
  let release;
  const upstream = await fakeGateway(t, async ({ req, res, payload, complete }) => {
    if (payload.messages[0].content === "phase-a-hold") {
      res.writeHead(200, { "content-type": "text/event-stream" }); res.write(": fixture heartbeat\n\n");
      const heartbeat = setInterval(() => { if (!res.destroyed) res.write(": fixture heartbeat\n\n"); }, 15000);
      try { await new Promise(resolve => { release = resolve; res.once("close", resolve); }); }
      finally { clearInterval(heartbeat); }
    }
    if (!res.destroyed) complete(payload.messages[0].content.includes("糖果") ? "最终答案是 21" : PHASE_HTML);
  });
  const store = new RunStore(dir); await store.init();
  for (const run of phaseABoot({ count }).runs) await store.save(run);
  const service = await startTestServer({ port, dataDir: dir, gatewayUrl: upstream.url });
  await service.ready;
  const html = await (await fetch(service.url)).text(), token = html.match(/name="pelican-token" content="([^"]+)"/)[1];
  const headers = { "content-type": "application/json", "x-pelican-token": token };
  const call = async (path, body) => (await fetch(service.url + path, { method: "POST", headers, body: JSON.stringify(body) })).json();
  const { favorite } = await call("api/favorites/save", { modelId: "fixture/one", prompt: "合成参数", maxTokens: 1200, timeoutMs: 600000, effort: "high" });
  if (favorite) await call("api/schedules/save", { favoriteIds: [favorite.id], kinds: ["candy"], mode: "times", times: ["09:00", "18:00"], days: [1, 2, 3, 4, 5], enabled: false, timeZone: "Asia/Shanghai" });
  if (active) await call("api/runs", { prompt: "phase-a-hold", maxTokens: 0, timeoutMs: 0, concurrency: 1, models: [{ id: "fixture/one", effort: "high" }] });
  return { url: service.url, dataDir: dir, seen: upstream.seen, service, headers, release: () => release?.(),
    async close() { await service.close(); for (const cleanup of cleanups.reverse()) await cleanup(); if (ownedDir) await rm(dir, { recursive: true, force: true }); } };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const fixture = await startPhaseAFixture();
  console.log(JSON.stringify({ url: fixture.url, dataDir: fixture.dataDir, syntheticModelRequests: fixture.seen.requests.length, realModelRequests: 0 }));
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, async () => { await fixture.close(); process.exit(0); });
}
