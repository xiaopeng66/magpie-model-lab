import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Gateway } from "../lib/gateway.mjs";
import { fakeGateway, temporary, waitFor, FIXTURE_HTML } from "./helpers.mjs";

const storage = await import("../lib/store.mjs").catch(() => ({}));
const execution = await import("../lib/runner.mjs").catch(() => ({}));

async function setup(t, handler, opts = {}) {
  assert.equal(typeof storage.RunStore, "function", "Persistent run store is missing");
  assert.equal(typeof execution.Runner, "function", "Generation queue is missing");
  const dir = await temporary(t);
  const { modelIds, ...runnerOptions } = opts;
  const upstream = await fakeGateway(t, handler, { modelIds });
  const store = new storage.RunStore(dir);
  await store.init();
  const runner = new execution.Runner({ store, gateway: new Gateway({ url: upstream.url }), ...runnerOptions });
  t.after(() => runner.close());
  return { store, runner, upstream, dir };
}

const request = (ids = ["one"]) => ({ prompt: "生成鹈鹕", models: ids.map((id) => ({ id: "fixture/" + id, effort: "low" })), maxTokens: 1024 });

test("completed HTML, original output and real usage survive a service restart", async (t) => {
  const { runner, store, dir } = await setup(t);
  const [created] = await runner.submit(request());
  await waitFor(() => runner.get(created.id)?.status === "completed");
  const run = await store.get(created.id);
  assert.equal(run.html, FIXTURE_HTML);
  assert.equal(run.content, FIXTURE_HTML);
  assert.equal(run.usage.total_tokens, 160);
  assert.equal(run.requestId, "fixture-request");
  assert.equal(typeof run.firstContentMs, "number");
  assert.equal(await readFile(run.files.html, "utf8"), FIXTURE_HTML);
  assert.equal(await readFile(run.files.response, "utf8"), FIXTURE_HTML);
  const restored = new storage.RunStore(dir);
  await restored.init();
  assert.equal((await restored.get(created.id)).status, "completed");
});

test("queue starts only two generations and comparison requests carry independent context", async (t) => {
  const releases = [];
  const { runner, upstream } = await setup(t, ({ complete }) => new Promise((resolve) => releases.push(() => { complete(); resolve(); })));
  const runs = await runner.submit(request(["one", "two", "three"]));
  await waitFor(() => releases.length === 2);
  assert.equal(upstream.seen.requests.length, 2);
  assert.equal(runner.get(runs[2].id).status, "queued");
  releases[0]();
  await waitFor(() => releases.length === 3);
  releases[1](); releases[2]();
  await waitFor(() => runs.every((r) => runner.get(r.id).status === "completed"));
  assert.equal(upstream.seen.peak, 2);
  for (const payload of upstream.seen.requests) assert.deepEqual(payload.messages, [{ role: "user", content: "生成鹈鹕" }]);
});

test("cancel closes the upstream connection and preserves partial content", async (t) => {
  const { runner, upstream, store } = await setup(t, ({ res, chunk }) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    chunk({ choices: [{ delta: { content: "<html><body>进行中" } }] });
  });
  const [run] = await runner.submit(request());
  await waitFor(() => runner.get(run.id)?.content);
  await runner.cancel(run.id);
  await waitFor(() => runner.get(run.id)?.status === "cancelled");
  await waitFor(() => upstream.seen.aborted === 1);
  assert.equal((await store.get(run.id)).content, "<html><body>进行中");
});

test("cancelled queued run is never sent to the gateway", async (t) => {
  const { runner, upstream } = await setup(t, ({ res }) => res.writeHead(200, { "content-type": "text/event-stream" }));
  const runs = await runner.submit(request(["one", "two", "three"]));
  await waitFor(() => upstream.seen.requests.length === 2);
  await runner.cancel(runs[2].id);
  assert.equal(runner.get(runs[2].id).status, "cancelled");
  assert.equal(upstream.seen.requests.length, 2);
});

test("timeout aborts an unfinished generation with a clear error", async (t) => {
  const { runner, upstream } = await setup(t, ({ res }) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders(); }, { timeoutMs: 80 });
  const [run] = await runner.submit(request());
  await waitFor(() => runner.get(run.id)?.status === "error");
  assert.match(runner.get(run.id).error, /超时/);
  await waitFor(() => upstream.seen.aborted === 1);
});

test("length-limited HTML is saved with truncated status and not offered as completed", async (t) => {
  const { runner } = await setup(t, ({ complete }) => complete(FIXTURE_HTML, "length"));
  const [run] = await runner.submit(request());
  await waitFor(() => runner.get(run.id)?.status === "truncated");
  assert.equal(runner.get(run.id).html, FIXTURE_HTML);
});

test("invalid and upstream error responses retain truthful terminal statuses", async (t) => {
  const { runner } = await setup(t, ({ res, payload, complete }) => {
    if (payload.model.endsWith("one")) complete("This is not HTML");
    else { res.writeHead(429); res.end('{"error":{"message":"Quota reached"}}'); }
  });
  const runs = await runner.submit(request(["one", "two"]));
  await waitFor(() => ["invalid", "error"].every((state, i) => runner.get(runs[i].id)?.status === state));
  assert.equal(runner.get(runs[0].id).content, "This is not HTML");
  assert.match(runner.get(runs[1].id).error, /429/);
});

test("startup marks unfinished runs interrupted and rejects non-UUID file paths", async (t) => {
  assert.equal(typeof storage.RunStore, "function", "Persistent run store is missing");
  const dir = await temporary(t);
  const id = "82b2d14a-d15b-4e0e-8b77-ab801c7c32ae";
  await mkdir(join(dir, id));
  await writeFile(join(dir, id, "run.json"), JSON.stringify({ id, status: "running", createdAt: new Date().toISOString(), content: "partial", reasoning: "", html: "" }));
  const store = new storage.RunStore(dir);
  const info = await store.init();
  assert.equal(info.interrupted, 1);
  assert.equal((await store.get(id)).status, "interrupted");
  assert.equal(await readFile((await store.get(id)).files.response, "utf8"), "partial", "Recovered records expose their real saved output paths");
  await assert.rejects(() => store.get("../settings.json"), /运行 ID/);
});

test("batch rejects duplicates, unknown models and invalid concurrency before generating", async (t) => {
  const { runner, upstream } = await setup(t);
  await assert.rejects(() => runner.submit(request(["one", "one"])), /重复/);
  await assert.rejects(() => runner.submit(request(["missing"])), /模型/);
  await assert.rejects(() => runner.submit(request(["one", "two", "three", "four", "missing"])), /模型/);
  for (const concurrency of [-1, 1.5, "three", Infinity]) await assert.rejects(() => runner.submit({ ...request(), concurrency }), /并行/);
  assert.equal(upstream.seen.requests.length, 0);
});

test("a batch can contain more than eight models and start all with its requested concurrency", async (t) => {
  const modelIds = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
  const { runner, upstream } = await setup(t, ({ res }) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders(); }, { modelIds });
  const runs = await runner.submit({ ...request(modelIds), maxTokens: 131072, concurrency: 9 });
  await waitFor(() => upstream.seen.requests.length === 9);
  assert.equal(runs.length, 9);
  assert.equal(upstream.seen.peak, 9);
  assert.ok(runs.every(run => run.concurrency === 9 && run.maxTokens === 131072));
  assert.equal(new Set(runs.map(run => run.batchId)).size, 1);
  assert.equal(new Set(runs.map(run => run.createdAt)).size, 1, "A batch has one creation time");
});

test("concurrency is enforced per batch without changing another batch's setting", async (t) => {
  const modelIds = ["one", "two", "three", "four", "five", "six"];
  const releases = new Map();
  const { runner, upstream } = await setup(t, ({ payload, complete }) => {
    releases.set(payload.model, () => complete());
  }, { modelIds });
  const first = await runner.submit({ ...request(["one", "two"]), concurrency: 1 });
  const second = await runner.submit({ ...request(["three", "four", "five", "six"]), concurrency: 3 });
  await waitFor(() => releases.size === 4);
  assert.equal(runner.get(first[1].id).status, "queued");
  assert.equal(runner.get(second[3].id).status, "queued");
  releases.get("fixture/three")();
  await waitFor(() => releases.has("fixture/six"));
  assert.equal(runner.get(first[1].id).status, "queued", "The second batch cannot raise the first batch's concurrency");
  releases.get("fixture/one")();
  await waitFor(() => releases.has("fixture/two"));
  for (const id of ["two", "four", "five", "six"]) releases.get("fixture/" + id)();
  await waitFor(() => [...first, ...second].every(run => runner.get(run.id).status === "completed"));
  assert.ok(upstream.seen.peak <= 4);
});

for (const kind of ["pelican", "candy"]) test(`${kind} zero concurrency starts every request without waiting for completion`, async t => {
  const { runner, upstream } = await setup(t, ({ res }) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders(); });
  const created = await runner.submit({ ...request(["one", "two", "three", "four"]), kind, concurrency: 0, maxTokens: 0 });
  await waitFor(() => upstream.seen.requests.length === 4);
  assert.equal(upstream.seen.peak, 4);
  assert.ok(created.every(run => run.concurrency === 0 && runner.get(run.id).status === "running"));
  assert.ok(upstream.seen.requests.every(payload => !Object.hasOwn(payload, "max_tokens")));
  await runner.cancelBatch(created[0].batchId);
  assert.ok(created.every(run => runner.get(run.id).status === "cancelled"));
});

test("history summaries retain every member of a batch larger than one hundred models", () => {
  const batchId = "03d7ddac-4618-4052-8af9-177b7148f3d3";
  const records = new Map(Array.from({ length: 105 }, (_, index) => [`run-${index}`, {
    id: `run-${index}`, batchId, createdAt: "2026-11-13T00:00:00Z", status: "completed", model: `fixture/${index}`, content: "test", html: FIXTURE_HTML,
  }]));
  const runner = new execution.Runner({ store: { records }, gateway: {} });
  const summaries = runner.list();
  assert.equal(summaries.length, 105, "Large batches must not lose members when history is loaded");
  assert.ok(summaries.every(run => run.batchId === batchId && run.content === undefined));
});

test("a failed batch creation removes its partially written runs without leaving phantom queued tasks", async (t) => {
  const { runner, store, upstream, dir } = await setup(t);
  const save = store.save.bind(store); let writes = 0;
  store.save = async run => { const result = await save(run); if (++writes === 2) throw new Error("Disk fixture failure"); return result; };
  await assert.rejects(() => runner.submit(request(["one", "two", "three"])), /Disk fixture failure/);
  assert.equal(runner.list().length, 0, "A rejected batch must not leave records permanently queued");
  assert.equal(store.list().length, 0); assert.equal(runner.queue.length, 0); assert.equal(upstream.seen.requests.length, 0);
  assert.deepEqual(await readdir(dir), [], "Rollback includes the directory of the failed write");
  store.save = save;
  const [next] = await runner.submit(request()); await waitFor(() => runner.get(next.id)?.status === "completed");
  assert.equal(upstream.seen.requests.length, 1, "A failed submission must not block subsequent batches");
});

test("queued runs retain their validated model and effort even if the catalog refresh removes them", async (t) => {
  const { runner, upstream } = await setup(t, ({ payload, res, complete }) => {
    if (payload.model.endsWith("one")) { res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders(); }
    else complete();
  });
  const runs = await runner.submit({ ...request(["one", "two"]), concurrency: 1 });
  await waitFor(() => upstream.seen.requests.length === 1);
  runner.gateway.models = async () => [{ id: "fixture/one", name: "one", efforts: [] }];
  await runner.models(true); await runner.cancel(runs[0].id);
  await waitFor(() => !["queued", "running"].includes(runner.get(runs[1].id).status));
  assert.equal(runner.get(runs[1].id).status, "completed");
  assert.equal(upstream.seen.requests[1].model, "fixture/two"); assert.equal(upstream.seen.requests[1].reasoning_effort, "low");
});

test("startup skips malformed history metadata while restoring healthy saved results", async (t) => {
  const dir = await temporary(t), store = new storage.RunStore(dir); await store.init();
  const healthyId = "7f0d3edb-a975-4240-806c-6a95b1c9c4f8", badId = "952a3b18-97ba-4c74-953a-acbce61a4d42";
  await store.save({ id: healthyId, status: "completed", createdAt: new Date().toISOString(), content: FIXTURE_HTML, html: FIXTURE_HTML });
  await mkdir(join(dir, badId)); const path = join(dir, badId, "run.json");
  for (const patch of [{ createdAt: null }, { status: "mystery" }, { content: { length: 12 } }, { html: true }, { batchId: "../" }]) {
    await writeFile(path, JSON.stringify({ id: badId, status: "completed", createdAt: new Date().toISOString(), ...patch }));
    const restored = new storage.RunStore(dir), recovery = await restored.init();
    assert.equal(recovery.unreadable, 1); assert.equal(await restored.get(badId), null);
    assert.equal(restored.list().length, 1); assert.equal((await restored.get(healthyId)).status, "completed");
    assert.ok(await readFile(path), "Unreadable metadata must be left intact for recovery");
  }
});
