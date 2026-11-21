import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RunStore } from "../lib/store.mjs";
import { Runner } from "../lib/runner.mjs";
import { Gateway } from "../lib/gateway.mjs";
import { temporary, fakeGateway, startTestServer, waitFor } from "./helpers.mjs";

const record = (batchId, content, extra = {}) => ({ id: randomUUID(), batchId, kind: "pelican", model: "fixture/one", status: "completed", createdAt: new Date().toISOString(),
  content, html: content, reasoning: "saved reasoning", prompt: "Animate fixture", maxTokens: 0, concurrency: 1, ...extra });

test("A100-003: completed historical bodies are loaded on demand while every list entry remains available", async t => {
  const dir = await temporary(t), store = new RunStore(dir); await store.init();
  const html = '<html><body>' + 'x'.repeat(512 * 1024) + '</body></html>', records = [];
  for (let i = 0; i < 24; i++) records.push(await store.save(record(randomUUID(), html)));
  const residentChars = JSON.stringify([...store.records.values()]).length;
  assert.ok(residentChars < 256 * 1024, `Completed body strings remain resident: ${residentChars} chars`);
  const restored = new RunStore(dir); assert.equal((await restored.init()).unreadable, 0);
  const runner = new Runner({ store: restored, gateway: {} }); t.after(() => runner.close());
  assert.equal(runner.list().length, 24); assert.ok(runner.list().every(run => run.hasHTML && run.contentChars === html.length));
  assert.ok(JSON.stringify([...runner.runs.values()]).length < 256 * 1024);
  assert.equal((await restored.get(records[0].id)).content, html);
  assert.equal(runner.get(records[1].id).html, html);
  assert.ok(JSON.stringify([...runner.runs.values()]).length < 256 * 1024, "Detail reads must not repopulate the whole resident history");
});

test("A100-003: oversized manual and automatic exports fail clearly before opening a native picker; details survive", async t => {
  const dir = await temporary(t), store = new RunStore(dir); await store.init();
  const batchId = randomUUID(), html = '<html><body>' + 'x'.repeat(1024 * 1024) + '</body></html>', runs = [];
  for (const source of ["manual", "automatic"]) for (let i = 0; i < 9; i++) runs.push(await store.save(record(batchId, html, { source, scheduledAt: new Date().toISOString() })));
  const upstream = await fakeGateway(t); let saves = 0;
  const service = await startTestServer({ port: 0, dataDir: dir, gatewayUrl: upstream.url, saveExport: async () => { saves++; return { cancelled: true }; } }); t.after(() => service.close());
  const token = (await (await fetch(service.url)).text()).match(/name="pelican-token" content="([a-f0-9]+)"/)[1], headers = { "x-pelican-token": token, "content-type": "application/json" };
  const automaticIds = runs.filter(run => run.source === "automatic").map(run => run.id);
  for (const [path, body] of [[`api/batches/${batchId}/export`, null], [`api/batches/${batchId}/save`, {}], ["api/batches/export", { runIds: automaticIds }], ["api/batches/save", { runIds: automaticIds }]]) {
    const response = await fetch(service.url + path, { method: body ? "POST" : "GET", headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal(response.status, 413, path); assert.match((await response.json()).error, /批次|导出|MiB/);
  }
  assert.equal(saves, 0);
  const detail = await (await fetch(service.url + "api/runs/" + runs[0].id, { headers })).json();
  assert.equal(detail.content, html); assert.ok(detail.previewUrl);
  assert.equal((await fetch(service.url + detail.previewUrl)).status, 200);
  assert.equal((await (await fetch(service.url + "api/runs", { headers })).json()).runs.length, 18);
  assert.equal(upstream.seen.requests.length, 0);
});

test("A100-003: newly completed runs release body residency and retain original-condition retesting after restart", async t => {
  const dir = await temporary(t), store = new RunStore(dir); await store.init();
  const html = '<html><body>' + 'y'.repeat(256 * 1024) + '</body></html>', upstream = await fakeGateway(t, ({ complete }) => complete(html));
  const runner = new Runner({ store, gateway: new Gateway({ url: upstream.url }) }); t.after(() => runner.close());
  const [created] = await runner.submit({ models: [{ id: "fixture/one" }], prompt: "Animate fixture", maxTokens: 0, concurrency: 1 });
  await waitFor(() => runner.list()[0]?.status === "completed");
  assert.ok(JSON.stringify([...runner.runs.values()]).length < 32768);
  assert.equal(runner.get(created.id).content, html);
  const before = await readFile(join(dir, created.id, "run.json"), "utf8");
  const restored = new RunStore(dir); await restored.init();
  const next = new Runner({ store: restored, gateway: new Gateway({ url: upstream.url }) }); t.after(() => next.close());
  assert.equal((await next.previewRetest({ runIds: [created.id] })).items[0].available, true);
  const rerun = await next.retest({ runIds: [created.id], operationId: randomUUID() });
  await waitFor(() => next.get(rerun.runs[0].id).status === "completed");
  assert.equal(next.get(rerun.runs[0].id).html, html); assert.equal(upstream.seen.requests.length, 2);
  assert.equal(await readFile(join(dir, created.id, "run.json"), "utf8"), before);
  await writeFile(join(dir, created.id, "run.json"), "{}");
  await assert.rejects(() => restored.get(created.id), /记录|读取|saved/i);
});

test("A100-003: an invalid preview capability is rejected before reading a historical body", async t => {
  const dir = await temporary(t), store = new RunStore(dir); await store.init();
  const saved = await store.save(record(randomUUID(), '<html><body>fixture</body></html>'));
  const service = await startTestServer({ port: 0, dataDir: dir, gatewayUrl: "http://127.0.0.1:1" }); t.after(() => service.close());
  await service.ready; await writeFile(join(dir, saved.id, "run.json"), "corrupted body");
  const response = await fetch(service.url + `preview/${saved.id}?key=wrong`);
  assert.equal(response.status, 403); assert.match(await response.text(), /预览链接无效/);
});

test("A100-003: 24 two-MiB outputs start within a 64-MiB old-space budget and expired records are removed", async t => {
  const parent = await temporary(t), html = '<html><body>' + 'z'.repeat(2 * 1024 * 1024 - 26) + '</body></html>';
  for (const expired of [false, true]) {
    const dir = join(parent, expired ? "expired" : "recent"); await mkdir(dir);
    for (let i = 0; i < 24; i++) {
      const run = record(randomUUID(), html, { previewKey: "a".repeat(64), createdAt: new Date(Date.now() - (expired ? 8 : 0) * 86400000).toISOString() });
      await mkdir(join(dir, run.id)); await writeFile(join(dir, run.id, "run.json"), JSON.stringify(run));
    }
    const code = `import { startServer } from ${JSON.stringify(new URL("../lib/server.mjs", import.meta.url).href)};
      const service = await startServer({ port: 0, dataDir: process.argv[1], gatewayUrl: "http://127.0.0.1:1" });
      try { await service.ready; globalThis.gc(); console.log(JSON.stringify({ ready: true, heapUsed: process.memoryUsage().heapUsed })); } finally { await service.close(); }`;
    const { stdout } = await promisify(execFile)(process.execPath, ["--expose-gc", "--max-old-space-size=64", "--input-type=module", "--eval", code, dir], { timeout: 30000, windowsHide: true });
    const result = JSON.parse(stdout); assert.equal(result.ready, true); assert.ok(result.heapUsed < 32 * 1024 * 1024, stdout);
    assert.equal((await readdir(dir)).filter(name => /^[0-9a-f-]{36}$/.test(name)).length, expired ? 0 : 24);
  }
});
