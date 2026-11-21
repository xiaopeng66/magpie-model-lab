import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Gateway } from "../lib/gateway.mjs";
import { Runner } from "../lib/runner.mjs";
import { RunStore } from "../lib/store.mjs";
import { Favorites, comparisonKey } from "../lib/favorites.mjs";
import { FingerprintBank } from "../lib/fingerprint-bank.mjs";
import { originalConditions } from "../lib/retest.mjs";
import { conditionProfile, recentTrend } from "../lib/comparison.mjs";
import { fakeGateway, temporary, waitFor } from "./helpers.mjs";
import { fingerprintGateway, referenceFixture } from "./fingerprint-helpers.mjs";

const request = extra => ({ kind: "candy", models: [{ id: "fixture/one" }], maxTokens: 1024, ...extra });
async function setup(t, handler, timeoutMs = 600000) {
  const dir = await temporary(t), upstream = await fakeGateway(t, handler || (({ complete }) => complete("最终答案：21")));
  const store = new RunStore(dir); await store.init();
  const runner = new Runner({ store, gateway: new Gateway({ url: upstream.url }), timeoutMs });
  t.after(() => runner.close());
  return { dir, store, runner, upstream };
}

test("generation timeout defaults to 600 seconds and survives saved history reload", async t => {
  const { runner, dir, upstream } = await setup(t);
  const [run] = await runner.submit(request());
  assert.equal(run.timeoutMs, 600000);
  await waitFor(() => runner.get(run.id)?.status === "completed" && !runner.busy(run.id));
  const restored = new RunStore(dir); await restored.init();
  assert.equal((await restored.get(run.id)).timeoutMs, 600000);
  assert.equal(upstream.seen.requests[0].timeoutMs, undefined, "Local timeout is not a model payload parameter");
});

test("each generation uses its requested timeout instead of the server default", async t => {
  const { runner, upstream } = await setup(t, ({ res }) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders(); }, 1000);
  const [run] = await runner.submit(request({ timeoutMs: 80 }));
  await waitFor(() => runner.get(run.id)?.status === "error");
  assert.equal(runner.get(run.id).timeoutMs, 80);
  assert.match(runner.get(run.id).error, /超时/);
  await waitFor(() => upstream.seen.aborted === 1);
  await waitFor(() => !runner.busy(run.id));
});

test("zero timeout keeps generation alive past the default and still allows cancellation", async t => {
  const { runner, upstream } = await setup(t, ({ res }) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders(); }, 100);
  const [run] = await runner.submit(request({ timeoutMs: 0 }));
  await waitFor(() => upstream.seen.requests.length === 1);
  await new Promise(resolve => setTimeout(resolve, 160));
  assert.equal(runner.get(run.id).status, "running");
  assert.equal(runner.get(run.id).timeoutMs, 0);
  await runner.cancel(run.id);
  assert.equal(runner.get(run.id).status, "cancelled");
  await waitFor(() => upstream.seen.aborted === 1);
});

test("invalid and overflowing timeouts are rejected before generation or persistence", async t => {
  const { runner, upstream } = await setup(t);
  for (const timeoutMs of [-1, 1.5, "600000", Infinity, 2147483648]) {
    await assert.rejects(() => runner.submit(request({ timeoutMs })), /超时/);
  }
  assert.equal(runner.list().length, 0);
  assert.equal(upstream.seen.requests.length, 0);
});

test("fingerprint samples honor their saved per-request timeout", async t => {
  const dir = await temporary(t), upstream = await fingerprintGateway(t, { bank: referenceFixture(), handler: ({ res }) => {
    res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders();
  } });
  const store = new RunStore(join(dir, "runs")); await store.init();
  const bank = new FingerprintBank({ dir: join(dir, "bank"), source: upstream.url + "/data/" }); await bank.init();
  const runner = new Runner({ store, bank, gateway: new Gateway({ url: upstream.url }), timeoutMs: 1000 });
  t.after(async () => { await runner.close(); await bank.close(); });
  const [run] = await runner.submit({ kind: "fingerprint", models: [{ id: "fixture/chat" }], timeoutMs: 80, concurrency: 3 });
  await waitFor(() => runner.get(run.id)?.samples?.every(sample => sample.state === "failed"));
  assert.equal(runner.get(run.id).timeoutMs, 80);
  assert.ok(runner.get(run.id).samples.every(sample => /超时/.test(sample.error)));
  await waitFor(() => !runner.busy(run.id));
});

test("automatic model timeout persists, separates batches, and is editable with plan parameters", async t => {
  const { runner, dir } = await setup(t), favorites = new Favorites({ dir, runner }); await favorites.init();
  const first = await favorites.save({ modelId: "fixture/one", timeoutMs: 1200000 });
  const second = await favorites.save({ modelId: "fixture/two", timeoutMs: 0 });
  assert.equal(first.timeoutMs, 1200000); assert.equal(second.timeoutMs, 0);
  const restored = new Favorites({ dir, runner }); await restored.init();
  assert.deepEqual(restored.snapshot().favorites.map(item => item.timeoutMs), [1200000, 0]);
  const result = await restored.run({ ids: [first.id, second.id], kinds: ["candy"] });
  assert.equal(new Set(result.runs.map(run => run.batchId)).size, 2);
  assert.deepEqual(result.runs.map(run => run.timeoutMs), [1200000, 0]);
  const before = restored.snapshot().favorites[0].compareKeys.candy;
  await restored.savePlan({ favoriteIds: [first.id], kinds: ["candy"], parameters: { timeoutMs: 0 } });
  assert.equal(restored.snapshot().favorites[0].timeoutMs, 0);
  assert.notEqual(restored.snapshot().favorites[0].compareKeys.candy, before);
  await assert.rejects(() => restored.save({ id: first.id, modelId: first.modelId, timeoutMs: -1 }), /超时/);
  await waitFor(() => result.runs.every(run => runner.get(run.id)?.status === "completed" && !runner.busy(run.id)));
});

test("original-condition retest preserves timeout including zero and supplies legacy 600 second default", async t => {
  const { runner, dir } = await setup(t);
  const runs = await runner.submit(request({ models: [{ id: "fixture/one" }, { id: "fixture/two" }], timeoutMs: 0 }));
  await waitFor(() => runs.every(run => runner.get(run.id)?.status === "completed" && !runner.busy(run.id)));
  const restoredStore = new RunStore(dir); await restoredStore.init();
  const restored = new Runner({ store: restoredStore, gateway: runner.gateway }); t.after(() => restored.close());
  const preview = await restored.previewRetest({ runIds: runs.map(run => run.id) });
  assert.ok(preview.items.every(item => item.conditions.timeoutMs === 0));
  const retried = await restored.retest({ runIds: runs.map(run => run.id), operationId: randomUUID() });
  assert.ok(retried.runs.every(run => run.timeoutMs === 0));
  const source = await restored.read(runs[0].id), { timeoutMs, ...legacy } = source;
  const catalog = await restored.models();
  assert.equal(originalConditions(legacy, catalog.find(model => model.id === source.model)).timeoutMs, 600000);
  await waitFor(() => retried.runs.every(run => restored.get(run.id)?.status === "completed" && !restored.busy(run.id)));
});

test("recent comparisons separate timeout conditions while legacy records retain the old default", () => {
  const record = { id: "one", model: "fixture/one", kind: "pelican", prompt: "animate", effort: "", maxTokens: 1024, concurrency: 2,
    status: "completed", createdAt: "2026-11-22T00:00:00Z", elapsedMs: 20 };
  assert.equal(conditionProfile(record).timeoutMs, 600000);
  const current = { ...record, id: "two", timeoutMs: 0 };
  assert.equal(recentTrend(current, [record, current]).attempts, 1);
  assert.equal(recentTrend({ ...record, timeoutMs: 600000 }, [record, current]).attempts, 1);
});

test("default automatic timeout keeps legacy comparison keys while zero changes conditions", () => {
  const legacy = { modelId: "fixture/one", effort: "", maxTokens: 64000, prompt: "animate", fingerprint: { api: "auto" } };
  for (const kind of ["pelican", "candy", "fingerprint"]) {
    assert.equal(comparisonKey(legacy, kind), comparisonKey({ ...legacy, timeoutMs: 600000 }, kind));
    assert.notEqual(comparisonKey(legacy, kind), comparisonKey({ ...legacy, timeoutMs: 0 }, kind));
  }
});
