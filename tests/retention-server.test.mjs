import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Settings } from "../lib/settings.mjs";
import { Annotations } from "../lib/annotations.mjs";
import { RunStore } from "../lib/store.mjs";
import { temporary, fakeGateway, startTestServer } from "./helpers.mjs";

async function fixture(t, days = 30) {
  const dir = await temporary(t), store = new RunStore(dir); await store.init(); let now = Date.now();
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  for (const [index, id] of ids.entries()) { const at = new Date(now - [8, 8, 7 - .001][index] * 86400000).toISOString(); await store.save({ id, batchId: id, kind: "candy", model: "fixture/one", createdAt: at, finishedAt: at, status: "completed", content: "21", reasoning: "", html: "" }); }
  const settings = new Settings(dir, { capabilities: { retention: true } }); await settings.init(); await settings.save({ expectedRevision: 0, patch: { retention: { days } } }, { authorizeRetentionChange: () => {} }); await settings.close();
  const annotations = new Annotations(dir); await annotations.init(); await annotations.save({ runId: ids[1], expectedRevision: 0, protected: true }); await annotations.close();
  const upstream = await fakeGateway(t); let service;
  const start = async () => { service = await startTestServer({ port: 0, dataDir: dir, gatewayUrl: upstream.url, retentionNow: () => now }); await service.ready;
    const html = await (await fetch(service.url)).text(), headers = { "x-pelican-token": html.match(/name="pelican-token" content="([^"]+)"/)[1], "content-type": "application/json" };
    return { get: path => fetch(service.url + path, { headers }), post: (path, body) => fetch(service.url + path, { method: "POST", headers, body: JSON.stringify(body) }) };
  };
  t.after(() => service?.close()); return { dir, ids, upstream, start, advance(ms) { now += ms; }, close: () => service.close() };
}
test("shortening requires a fixed-time preview, save does not delete, and restart applies the live cutoff", async t => {
  const f = await fixture(t), api = await f.start();
  assert.equal((await api.post("api/settings/save", { expectedRevision: 1, patch: { retention: { days: 7 } } })).status, 409);
  const preview = await (await api.post("api/retention/preview", { days: 7 })).json(); assert.equal(preview.candidateCount, 1); assert.equal(preview.skippedProtected, 1);
  assert.ok(preview.measuredFileBytes >= preview.estimatedMetadataBytes); f.advance(120000);
  const save = await api.post("api/settings/save", { expectedRevision: 1, patch: { retention: { days: 7 } }, previewToken: preview.previewToken }); assert.equal(save.status, 200);
  assert.ok(await readFile(join(f.dir, f.ids[0], "run.json"))); assert.ok(await readFile(join(f.dir, f.ids[2], "run.json")));
  await f.close(); const again = await f.start(); const boot = await (await again.get("api/bootstrap")).json();
  assert.deepEqual(boot.runs.map(run => run.id), [f.ids[1]]); assert.equal(boot.retentionDays, 7); assert.equal(f.upstream.seen.requests.length, 0);
});
test("protection or setting changes invalidate the preview; permanent survives restart", async t => {
  const f = await fixture(t), api = await f.start(), preview = await (await api.post("api/retention/preview", { days: 7 })).json();
  assert.equal((await api.post("api/runs/annotations", { runId: f.ids[0], expectedRevision: 1, protected: true })).status, 200);
  assert.equal((await api.post("api/settings/save", { expectedRevision: 1, patch: { retention: { days: 7 } }, previewToken: preview.previewToken })).status, 409);
  assert.equal((await api.post("api/settings/save", { expectedRevision: 1, patch: { retention: { days: null } } })).status, 200);
  await f.close(); f.advance(100 * 86400000); const again = await f.start(), boot = await (await again.get("api/bootstrap")).json();
  assert.equal(boot.retentionDays, null); assert.equal(boot.runs.length, 3);
  assert.equal((await again.post("api/settings/save", { expectedRevision: 2, patch: { retention: { days: 7 } } })).status, 409);
});
test("broken settings or protection pause startup and manual cleanup while healthy history remains readable", async t => {
  for (const name of [".settings", ".annotations"]) {
    const f = await fixture(t), api = await f.start(); await f.close(); const path = join(f.dir, name, "state.json"); await writeFile(path, "broken");
    f.advance(100 * 86400000); const again = await f.start(), boot = await (await again.get("api/bootstrap")).json();
    assert.equal(boot.runs.length, 3); assert.equal(boot.cleanupPaused, true);
    assert.equal((await again.post("api/runs/cleanup", { mode: "all" })).status, 503);
    assert.equal(await readFile(path, "utf8"), "broken"); await f.close();
  }
});
