import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Gateway } from "../lib/gateway.mjs";
import { RunStore } from "../lib/store.mjs";
import { Runner } from "../lib/runner.mjs";
import { Favorites } from "../lib/favorites.mjs";
import { historyBatches } from "../lib/history-groups.mjs";
import { temporary, fakeGateway, waitFor } from "./helpers.mjs";

for (const transport of ["http", "stream"]) test(`${transport} generation errors never persist an echoed gateway credential`, async t => {
  const key = "local-fixture-credential", dir = await temporary(t);
  const upstream = await fakeGateway(t, ({ res, chunk }) => {
    const error = { message: `Credential ${key} was rejected` };
    if (transport === "http") { res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ error })); }
    else { res.writeHead(200, { "content-type": "text/event-stream" }); chunk({ error }); res.end(); }
  });
  const store = new RunStore(dir); await store.init();
  const runner = new Runner({ store, gateway: new Gateway({ url: upstream.url, key }) }); t.after(() => runner.close());
  const [created] = await runner.submit({ kind: "candy", models: [{ id: "fixture/one" }] });
  const failed = await waitFor(() => runner.get(created.id)?.status === "error" && runner.get(created.id));
  assert.equal(failed.error.includes(key), false, "Upstream errors are displayed and exported, so redact before saving them");
  assert.match(failed.error, /隐藏凭据/);
  assert.equal((await readFile(join(dir, created.id, "run.json"), "utf8")).includes(key), false);
});

test("failed atomic replacement cleans temporary text and preserves the previous target", async t => {
  const dir = await temporary(t), store = new RunStore(dir); await store.init();
  const target = join(dir, "occupied"); await mkdir(target); await writeFile(join(target, "keep.txt"), "keep");
  await assert.rejects(() => store.atomic(target, "partial private output"));
  assert.deepEqual(await readdir(dir), ["occupied"], "Failed writes must not leave private .tmp files behind");
  assert.equal(await readFile(join(target, "keep.txt"), "utf8"), "keep");
});

async function savedState(t) {
  const dir = await temporary(t), upstream = await fakeGateway(t), store = new RunStore(dir); await store.init();
  const runner = new Runner({ store, gateway: new Gateway({ url: upstream.url }) }); t.after(() => runner.close());
  const favorites = new Favorites({ dir, runner }); await favorites.init();
  const favorite = await favorites.save({ modelId: "fixture/one" });
  await favorites.savePlan({ favoriteIds: [favorite.id], kinds: ["candy"], enabled: true, timeZone: "UTC" });
  return { dir, runner, upstream, saved: structuredClone(favorites.state), path: join(dir, ".favorites", "state.json") };
}

test("persisted plans are validated before they can become executable", async t => {
  const fixture = await savedState(t);
  const cases = [
    state => { state.plans[0].enabled = "false"; },
    state => { state.plans[0].days = [8]; },
    state => { state.plans[0].timeZone = "invalid/zone"; },
    state => { state.plans[0].times = ["24:00"]; },
    state => { state.plans[0].revision = -1; },
    state => { state.plans[0].favoriteIds = []; },
    state => { delete state.plans[0].times; },
    state => { delete state.plans[0].days; },
    state => { state.plans[0].kinds = ["fingerprint"]; },
    state => { state.plans.push(structuredClone(state.plans[0])); },
    state => { state.favorites[0].concurrency.candy = "3"; },
    state => { state.favorites[0].maxTokens = -1; },
    state => { state.claims = [null]; },
    state => { state.claims = [{ key: "claim", at: "invalid" }]; },
  ];
  for (const change of cases) {
    const saved = structuredClone(fixture.saved); change(saved); const bytes = JSON.stringify(saved);
    await writeFile(fixture.path, bytes);
    const restored = new Favorites({ dir: fixture.dir, runner: fixture.runner });
    await assert.rejects(() => restored.init(), /收藏配置读取失败/);
    assert.equal(restored.state.plans.length, 0, "Invalid config must not be installed for the scheduler");
    assert.equal(await readFile(fixture.path, "utf8"), bytes, "Keep invalid data available for recovery");
  }
  assert.equal(fixture.upstream.seen.requests.length, 0);
});

test("older favorites with missing optional parameters can be viewed and edited after recovery", async t => {
  const fixture = await savedState(t), favorite = fixture.saved.favorites[0];
  delete favorite.concurrency; delete favorite.fingerprint;
  await writeFile(fixture.path, JSON.stringify(fixture.saved));
  const restored = new Favorites({ dir: fixture.dir, runner: fixture.runner }); await restored.init();
  const edited = await restored.save({ id: favorite.id, modelId: favorite.modelId, maxTokens: 0 });
  assert.equal(edited.maxTokens, 0); assert.deepEqual(edited.concurrency, { candy: 3, pelican: 2, fingerprint: 3 });
  assert.equal(edited.fingerprint.account, ""); assert.equal(restored.snapshot().plans.length, 1);
});

test("corrupt automatic history cannot break healthy history or be rewritten during recovery", async t => {
  const dir = await temporary(t), store = new RunStore(dir); await store.init();
  const good = { id: randomUUID(), kind: "candy", model: "fixture/one", status: "completed", createdAt: new Date().toISOString(), content: "最终答案：21", candy: { answer: 21, verdict: "match" } };
  await store.save(good);
  for (const patch of [{ plans: {} }, { plans: [null] }, { plans: [{ id: "../invalid" }] }, { candy: { answer: {}, verdict: "match" } }, { modelName: [] }]) {
    const id = randomUUID(), path = join(dir, id); await mkdir(path);
    await writeFile(join(path, "run.json"), JSON.stringify({ ...good, id, status: "running", source: "automatic", favoriteId: randomUUID(), ...patch }));
  }
  const restored = new RunStore(dir), recovery = await restored.init();
  assert.equal(recovery.unreadable, 5, "Invalid nested UI metadata must be rejected at the storage boundary");
  assert.equal(recovery.interrupted, 0); assert.deepEqual(restored.list().map(run => run.id), [good.id]);
  for (const id of await readdir(dir)) if (id !== good.id) {
    assert.deepEqual(await readdir(join(dir, id)), ["run.json"], "Recovery must keep damaged records untouched");
  }
});

test("UUID arrays in saved batch identifiers cannot split healthy history into unexportable groups", async t => {
  const dir = await temporary(t), store = new RunStore(dir); await store.init();
  const good = { id: randomUUID(), batchId: randomUUID(), kind: "candy", model: "fixture/one", status: "completed",
    createdAt: new Date().toISOString(), content: "最终答案：21", candy: { answer: 21, verdict: "match" } };
  await store.save(good);
  const damaged = [];
  for (const patch of [{ batchId: [good.batchId] }, { roundId: [good.batchId] }]) {
    const id = randomUUID(), path = join(dir, id, "run.json"), bytes = JSON.stringify({ ...good, id, ...patch });
    await mkdir(join(dir, id)); await writeFile(path, bytes); damaged.push({ path, bytes });
  }
  const restored = new RunStore(dir), recovery = await restored.init();
  assert.equal(recovery.unreadable, 2, "A coercible UUID value is not a string batch identifier");
  assert.deepEqual(restored.list().map(run => run.id), [good.id]);
  const groups = historyBatches(restored.list());
  assert.equal(groups.length, 1); assert.equal(groups[0].id, good.batchId);
  for (const item of damaged) assert.equal(await readFile(item.path, "utf8"), item.bytes, "Keep damaged metadata available for recovery");
});
