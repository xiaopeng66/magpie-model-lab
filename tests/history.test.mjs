import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RunStore } from "../lib/store.mjs";
import { startServer } from "../lib/server.mjs";
import { Runner } from "../lib/runner.mjs";
import { fakeGateway, temporary, FIXTURE_HTML } from "./helpers.mjs";

test("automatic history export and deletion require exactly the displayed daily group", async t => {
  const dir = await temporary(t), store = new RunStore(dir); await store.init();
  const now = new Date(), date = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const [year, month, day] = date.split("-").map(Number);
  const roundId = randomUUID();
  async function record(model, hour, extra = {}) {
    return store.save({ id: randomUUID(), roundId, model: `fixture/${model}`, kind: "candy", source: "automatic", status: "completed",
      createdAt: now.toISOString(), scheduledAt: new Date(year, month - 1, day, hour).toISOString(),
      content: "最终答案：21", candy: { verdict: "match", answer: 21 }, ...extra });
  }
  const selected = [await record("one", 9), await record("one", 11), await record("two", 9), await record("two", 11)];
  const outside = [await record("three", 9), await record("one", 10, { kind: "pelican", html: FIXTURE_HTML }),
    await record("one", 11, { scheduledAt: new Date(year, month - 1, day - 1, 11).toISOString() }),
    await record("one", 9, { source: "manual", roundId: randomUUID() })];
  const upstream = await fakeGateway(t), service = await startServer({ port: 0, dataDir: dir, gatewayUrl: upstream.url });
  t.after(() => service.close());
  const token = (await (await fetch(service.url)).text()).match(/name="pelican-token" content="([a-f0-9]+)"/)[1];
  const headers = { "x-pelican-token": token, "content-type": "application/json", origin: "null" };
  const post = (path, body) => fetch(service.url + path, { method: "POST", headers, body: JSON.stringify(body) });
  const runIds = selected.map(run => run.id), cleanup = "api/runs/cleanup", exportPath = "api/batches/export";
  const exported = await post(exportPath, { runIds: [...runIds].reverse() });
  assert.equal(exported.status, 200);
  const body = await exported.json();
  assert.equal(body.date, date);
  assert.deepEqual(new Set(body.runs.map(run => run.id)), new Set(runIds));
  assert.ok(body.runs.every(run => !Object.hasOwn(run, "previewKey")));
  for (const stale of [runIds.slice(0, -1), [...runIds.slice(0, -1), outside[0].id]]) {
    assert.equal((await post(cleanup, { mode: "daily", runIds: stale })).status, 409);
  }
  const deleted = await post(cleanup, { mode: "daily", runIds });
  assert.equal(deleted.status, 200);
  assert.deepEqual(new Set((await deleted.json()).removed), new Set(runIds));
  assert.equal((await post(exportPath, { runIds })).status, 409);
  const remaining = await (await fetch(service.url + "api/runs", { headers })).json();
  assert.deepEqual(new Set(remaining.runs.map(run => run.id)), new Set(outside.map(run => run.id)));
  const restored = new RunStore(dir); await restored.init();
  assert.deepEqual(new Set(restored.records.keys()), new Set(outside.map(run => run.id)));
  assert.equal(upstream.seen.requests.length, 0);
});

test("daily cleanup is blocked while any run in the group is still active", async t => {
  const store = new RunStore(await temporary(t)); await store.init();
  const at = new Date().toISOString(), base = { source: "automatic", kind: "candy", createdAt: at, scheduledAt: at };
  const done = await store.save({ ...base, id: randomUUID(), model: "fixture/one", status: "completed" });
  const busy = await store.save({ ...base, id: randomUUID(), model: "fixture/two", status: "running" });
  const runner = new Runner({ store, gateway: {} }); t.after(() => runner.close());
  await assert.rejects(runner.cleanup({ mode: "daily", runIds: [done.id, busy.id] }), error => error.status === 409);
  assert.equal((await store.get(done.id)).status, "completed");
  assert.equal((await store.get(busy.id)).status, "running");
});
