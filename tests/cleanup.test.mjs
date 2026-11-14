import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RunStore } from "../lib/store.mjs";
import { Runner } from "../lib/runner.mjs";
import { startServer } from "../lib/server.mjs";
import { Gateway } from "../lib/gateway.mjs";
import { fakeGateway, temporary, waitFor, FIXTURE_HTML } from "./helpers.mjs";

const ids = ["f5b84bbd-e8c0-4a9e-a8d6-7909341f0a71", "b3b7d251-f3e5-4f3f-8756-333402c97068", "37cf158d-aa10-4c43-bdd0-c5b107c1b68e"];
const record = (id, time, status = "completed") => ({ id, batchId: id, model: "fixture/one", modelName: "Fixture", status,
  createdAt: time, finishedAt: time, content: FIXTURE_HTML, html: FIXTURE_HTML, reasoning: "reasoning" });
const exists = async (path) => access(path).then(() => true, () => false);

test("cutoff cleanup removes old records and every file while keeping the exact boundary", async (t) => {
  const dir = await temporary(t), store = new RunStore(dir);
  await store.init();
  await store.save(record(ids[0], "2026-11-12T23:59:59.000Z"));
  await store.save(record(ids[1], "2026-11-13T00:00:00.000Z"));
  await writeFile(join(dir, ids[0], "response.extra.tmp"), "unfinished write");
  await writeFile(join(dir, "keep.txt"), "unrelated file");
  const runner = new Runner({ store, gateway: {} });
  t.after(() => runner.close());
  assert.equal(typeof runner.cleanup, "function", "History cleanup is missing");
  const outcome = await runner.cleanup({ mode: "before", before: "2026-11-13T00:00:00.000Z" });
  assert.deepEqual(outcome.removed, [ids[0]]);
  assert.equal(await exists(join(dir, ids[0])), false);
  assert.equal(runner.get(ids[0]), null);
  assert.equal(await readFile(join(dir, ids[1], "result.html"), "utf8"), FIXTURE_HTML);
  assert.equal(await readFile(join(dir, "keep.txt"), "utf8"), "unrelated file");
  const restored = new RunStore(dir); await restored.init();
  assert.equal((await restored.get(ids[1])).status, "completed");
  assert.equal(await restored.get(ids[0]), null);
});

test("clear all keeps active and queued generations and reports removed IDs to subscribers", async (t) => {
  const dir = await temporary(t), store = new RunStore(dir);
  await store.init();
  await store.save(record(ids[0], "2026-11-12T00:00:00.000Z"));
  const upstream = await fakeGateway(t, ({ res }) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders(); });
  const runner = new Runner({ store, gateway: new Gateway({ url: upstream.url }) });
  t.after(() => runner.close());
  assert.equal(typeof runner.cleanup, "function", "History cleanup is missing");
  const runs = await runner.submit({ prompt: "test", maxTokens: 1024, models: ["one", "two", "three"].map((id) => ({ id: "fixture/" + id })) });
  await waitFor(() => upstream.seen.requests.length === 2);
  const events = []; runner.subscribe((event) => events.push(event));
  const outcome = await runner.cleanup({ mode: "all" });
  assert.deepEqual(outcome.removed, [ids[0]]);
  assert.equal(outcome.skippedActive, 3);
  assert.equal(upstream.seen.aborted, 0);
  assert.ok(runs.every((run) => runner.get(run.id)));
  assert.equal(runner.get(runs[2].id).status, "queued");
  assert.ok(events.some((event) => event.type === "removed" && event.ids.includes(ids[0])));
});

test("cleanup rejects invalid modes and times without removing anything", async (t) => {
  const store = new RunStore(await temporary(t)); await store.init();
  await store.save(record(ids[0], "2026-11-12T00:00:00.000Z"));
  const runner = new Runner({ store, gateway: {} }); t.after(() => runner.close());
  assert.equal(typeof runner.cleanup, "function", "History cleanup is missing");
  for (const request of [{}, { mode: "before", before: "not-a-time" }, { mode: "before", before: "2026-11-13T00:00" },
    { mode: "before", before: "2026-02-31T00:00:00.000Z" }, { mode: "../" }]) {
    await assert.rejects(() => runner.cleanup(request), /清理|时间/);
  }
  assert.equal(await exists(join(store.dir, ids[0], "run.json")), true);
});

test("cleanup refuses a run-directory junction and leaves its external target intact", async (t) => {
  const store = new RunStore(await temporary(t)); await store.init();
  const external = await temporary(t); await writeFile(join(external, "keep.txt"), "keep");
  await symlink(external, join(store.dir, ids[0]), process.platform === "win32" ? "junction" : "dir");
  store.records.set(ids[0], record(ids[0], "2026-11-12T00:00:00.000Z"));
  const runner = new Runner({ store, gateway: {} }); t.after(() => runner.close());
  assert.equal(typeof runner.cleanup, "function", "History cleanup is missing");
  const outcome = await runner.cleanup({ mode: "all" });
  assert.equal(outcome.removed.length, 0);
  assert.equal(outcome.errors.length, 1);
  assert.equal(await readFile(join(external, "keep.txt"), "utf8"), "keep");
  assert.ok(runner.get(ids[0]));
});

test("storage refuses a linked output root before reading or writing external records", async (t) => {
  const external = await temporary(t), root = await temporary(t), linked = join(root, "runs");
  await writeFile(join(external, "keep.txt"), "keep");
  await symlink(external, linked, process.platform === "win32" ? "junction" : "dir");
  const store = new RunStore(linked);
  await assert.rejects(() => store.init(), /目录/);
  await assert.rejects(() => store.save(record(ids[0], new Date().toISOString())), /目录/);
  assert.equal(await exists(join(external, ids[0])), false);
  assert.equal(await readFile(join(external, "keep.txt"), "utf8"), "keep");
});

test("cleanup removes a nested link without deleting files in the directory it points to", async (t) => {
  const store = new RunStore(await temporary(t)); await store.init();
  await store.save(record(ids[0], "2026-11-12T00:00:00.000Z"));
  const external = await temporary(t); await writeFile(join(external, "keep.txt"), "keep");
  await symlink(external, join(store.dir, ids[0], "linked"), process.platform === "win32" ? "junction" : "dir");
  const runner = new Runner({ store, gateway: {} }); t.after(() => runner.close());
  const outcome = await runner.cleanup({ mode: "all" });
  assert.deepEqual(outcome.removed, [ids[0]]);
  assert.equal(await exists(join(store.dir, ids[0])), false);
  assert.equal(await readFile(join(external, "keep.txt"), "utf8"), "keep");
});

test("batch cleanup deletes only that batch's records and files, including its temporary files", async (t) => {
  const store = new RunStore(await temporary(t)); await store.init();
  await store.save(record(ids[0], "2026-11-13T00:00:00.000Z"));
  await store.save({ ...record(ids[1], "2026-11-13T00:00:00.000Z"), batchId: ids[0], status: "truncated" });
  await store.save(record(ids[2], "2026-11-13T00:00:00.000Z"));
  await writeFile(join(store.dir, ids[1], "extra.tmp"), "temporary file");
  const runner = new Runner({ store, gateway: {} }); t.after(() => runner.close());
  const events = []; runner.subscribe(event => events.push(event));
  const outcome = await runner.cleanup({ mode: "batch", batchId: ids[0] });
  assert.deepEqual(outcome, { removed: [ids[0], ids[1]], skippedActive: 0, errors: [] });
  assert.equal(await exists(join(store.dir, ids[0])), false);
  assert.equal(await exists(join(store.dir, ids[1])), false);
  assert.equal(runner.get(ids[0]), null);
  assert.equal(runner.get(ids[1]), null);
  assert.equal(await readFile(join(store.dir, ids[2], "result.html"), "utf8"), FIXTURE_HTML, "Another batch with the same timestamp must stay intact");
  assert.deepEqual(events.find(event => event.type === "removed")?.ids, [ids[0], ids[1]]);
});

test("batch cleanup supports legacy IDs and rejects malformed or unknown batches", async (t) => {
  const store = new RunStore(await temporary(t)); await store.init();
  await store.save({ ...record(ids[0], "2026-11-13T00:00:00.000Z"), batchId: undefined });
  const runner = new Runner({ store, gateway: {} }); t.after(() => runner.close());
  for (const batchId of [undefined, "", "../", 1]) await assert.rejects(() => runner.cleanup({ mode: "batch", batchId }), error => error.status === 400);
  await assert.rejects(() => runner.cleanup({ mode: "batch", batchId: ids[1] }), error => error.status === 404);
  assert.equal(await exists(join(store.dir, ids[0], "run.json")), true);
  assert.deepEqual((await runner.cleanup({ mode: "batch", batchId: ids[0] })).removed, [ids[0]]);
});

test("batch cleanup refuses the whole batch when any member is unfinished", async (t) => {
  const store = new RunStore(await temporary(t)); await store.init();
  await store.save(record(ids[0], "2026-11-13T00:00:00.000Z"));
  await store.save({ ...record(ids[1], "2026-11-13T00:00:00.000Z", "queued"), batchId: ids[0] });
  const runner = new Runner({ store, gateway: {} }); t.after(() => runner.close());
  await assert.rejects(() => runner.cleanup({ mode: "batch", batchId: ids[0] }), error => error.status === 409);
  assert.equal(await exists(join(store.dir, ids[0], "result.html")), true, "Completed members must not be partially deleted from an active batch");
  assert.equal(runner.get(ids[1]).status, "queued");
  runner.get(ids[1]).status = "completed";
  runner.active.set(ids[1], { abort: new AbortController(), promise: Promise.resolve() });
  await assert.rejects(() => runner.cleanup({ mode: "batch", batchId: ids[0] }), error => error.status === 409, "A task still saving its terminal record is active");
  runner.active.delete(ids[1]);
  assert.deepEqual((await runner.cleanup({ mode: "batch", batchId: ids[0] })).removed, [ids[0], ids[1]]);
});

test("authenticated batch cleanup revokes its preview without deleting another batch", async (t) => {
  const dir = await temporary(t), store = new RunStore(dir); await store.init();
  const time = new Date().toISOString();
  await store.save(record(ids[0], time));
  await store.save({ ...record(ids[1], time), batchId: ids[0] });
  await store.save(record(ids[2], time));
  const upstream = await fakeGateway(t);
  const service = await startServer({ port: 0, dataDir: dir, gatewayUrl: upstream.url }); t.after(() => service.close());
  const page = await (await fetch(service.url)).text(), token = page.match(/name="pelican-token" content="([a-f0-9]+)"/)[1];
  const headers = { "x-pelican-token": token, "content-type": "application/json", origin: "null" };
  const boot = await (await fetch(service.url + "api/bootstrap", { headers })).json();
  assert.equal(boot.batchCleanup, true, "The UI must know whether the running service supports deleting a batch");
  const details = await Promise.all([ids[0], ids[2]].map(async id => (await fetch(service.url + "api/runs/" + id, { headers })).json()));
  const endpoint = service.url + "api/runs/cleanup", body = JSON.stringify({ mode: "batch", batchId: ids[0] });
  assert.equal((await fetch(endpoint, { method: "POST", body })).status, 403);
  assert.equal((await fetch(endpoint, { method: "POST", headers: { ...headers, origin: "https://other.example" }, body })).status, 403);
  assert.equal(await exists(join(dir, ids[0], "result.html")), true);
  const response = await fetch(endpoint, { method: "POST", headers, body }); assert.equal(response.status, 200);
  assert.deepEqual(new Set((await response.json()).removed), new Set([ids[0], ids[1]]));
  assert.equal((await fetch(service.url + details[0].previewUrl)).status, 403);
  assert.equal((await fetch(service.url + details[1].previewUrl)).status, 200);
  assert.equal(await exists(join(dir, ids[1])), false);
  assert.equal(upstream.seen.requests.length, 0);
});

test("server startup applies seven-day retention and manual cleanup uses the authenticated API", async (t) => {
  const dir = await temporary(t), store = new RunStore(dir); await store.init();
  const old = new Date(Date.now() - 8 * 86400000).toISOString();
  const recent = new Date(Date.now() - 6 * 86400000).toISOString();
  await store.save(record(ids[0], old)); await store.save(record(ids[1], recent));
  const upstream = await fakeGateway(t);
  const service = await startServer({ port: 0, dataDir: dir, gatewayUrl: upstream.url });
  t.after(() => service.close());
  const html = await (await fetch(service.url)).text();
  const token = html.match(/name="pelican-token" content="([a-f0-9]+)"/)[1];
  const headers = { "x-pelican-token": token, "content-type": "application/json", origin: "null" };
  const boot = await (await fetch(service.url + "api/bootstrap", { headers })).json();
  assert.equal(boot.retentionDays, 7, "The service must expose the default retention policy");
  assert.equal(await exists(join(dir, ids[0])), false, "Expired files must be deleted on startup");
  assert.equal(boot.runs.length, 1);
  const detail = await (await fetch(service.url + "api/runs/" + ids[1], { headers })).json();
  assert.equal((await fetch(service.url + detail.previewUrl)).status, 200);
  const endpoint = service.url + "api/runs/cleanup";
  assert.equal((await fetch(endpoint, { method: "POST", body: '{"mode":"all"}' })).status, 403);
  assert.equal((await fetch(endpoint, { method: "POST", headers, body: '{"mode":"before","before":"bad"}' })).status, 400);
  const cleared = await fetch(endpoint, { method: "POST", headers, body: '{"mode":"all"}' });
  assert.equal(cleared.status, 200);
  assert.deepEqual((await cleared.json()).removed, [ids[1]]);
  assert.equal(await exists(join(dir, ids[1])), false);
  assert.equal((await fetch(service.url + "api/runs/" + ids[1], { headers })).status, 404);
  assert.equal((await fetch(service.url + detail.previewUrl)).status, 403, "Cleanup revokes preview links");
  assert.equal(upstream.seen.requests.length, 0);
});
