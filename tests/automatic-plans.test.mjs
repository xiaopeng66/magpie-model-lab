import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Gateway } from "../lib/gateway.mjs";
import { Runner } from "../lib/runner.mjs";
import { RunStore } from "../lib/store.mjs";
import { Favorites } from "../lib/favorites.mjs";
import * as scheduling from "../lib/scheduler.mjs";
import { temporary, fakeGateway, waitFor, FIXTURE_HTML } from "./helpers.mjs";

async function setup(t, handler) {
  const dir = await temporary(t), upstream = await fakeGateway(t, handler || (({ complete }) => complete("最终答案：21")));
  const store = new RunStore(dir); await store.init();
  const runner = new Runner({ store, gateway: new Gateway({ url: upstream.url }) }); t.after(() => runner.close());
  const favorites = new Favorites({ dir, runner }); await favorites.init();
  const one = await favorites.save({ modelId: "fixture/one" }), two = await favorites.save({ modelId: "fixture/two" });
  return { dir, upstream, runner, favorites, one, two };
}
const config = { mode: "times", times: ["09:00", "12:00", "18:00"], days: [0, 1, 2, 3, 4, 5, 6], timeZone: "Asia/Shanghai" };

test("plans belong to exactly one model and one supported automatic test, with no duplicate kind", async t => {
  const { favorites, one, two } = await setup(t);
  await assert.rejects(favorites.savePlan({ ...config, favoriteIds: [one.id, two.id], kinds: ["candy"] }), /一个模型/);
  await assert.rejects(favorites.savePlan({ ...config, favoriteIds: [one.id], kinds: ["candy", "pelican"] }), /一种测试/);
  await assert.rejects(favorites.savePlan({ ...config, favoriteIds: [one.id], kinds: ["fingerprint"] }), /糖果.*动画/);
  const first = await favorites.savePlan({ ...config, favoriteIds: [one.id], kinds: ["candy"], enabled: true });
  await assert.rejects(favorites.savePlan({ ...config, favoriteIds: [one.id], kinds: ["candy"] }), /已存在/);
  const second = await favorites.savePlan({ ...config, favoriteIds: [two.id], kinds: ["candy"], times: ["10:00"], enabled: true });
  await favorites.savePlan({ ...first, enabled: false });
  assert.equal(favorites.snapshot().plans.find(p => p.id === second.id).enabled, true);
  assert.deepEqual(favorites.snapshot().plans.find(p => p.id === second.id).times, ["10:00"]);
});

test("both schedule modes enforce 24 actual daily starts and deduplicate explicit times", async t => {
  const { favorites, one } = await setup(t), hours = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0") + ":00");
  const plan = await favorites.savePlan({ ...config, favoriteIds: [one.id], kinds: ["candy"], times: [...hours, "00:00"] });
  assert.equal(plan.times.length, 24);
  await assert.rejects(favorites.savePlan({ ...plan, times: [...hours, "00:30"] }), /24/);
  await assert.rejects(favorites.savePlan({ ...plan, mode: "interval", allDay: true, intervalMinutes: 59 }), /24/);
  await favorites.savePlan({ ...plan, mode: "interval", allDay: true, intervalMinutes: 60 });
  await assert.rejects(favorites.savePlan({ ...plan, mode: "interval", start: "09:00", end: "18:00", intervalMinutes: 20, allDay: false }), /27.*24/);
  const changed = await favorites.savePlan({ ...plan, mode: "interval", start: "09:00", end: "18:00", intervalMinutes: 30, allDay: false });
  assert.equal(scheduling.dailySlots(changed, new Date("2026-11-16T01:00:00Z")).slots.length, 18);
});

test("slots correspond to start-day local times, including midnight and DST", () => {
  assert.equal(typeof scheduling.dailySlots, "function", "Missing daily slot projection");
  const plan = { ...config, id: "p", revision: 2, enabled: true, mode: "interval", intervalMinutes: 30, start: "23:00", end: "01:00", allDay: false, days: [1] };
  const day = scheduling.dailySlots(plan, new Date("2026-11-16T16:30:00Z"));
  assert.equal(day.date, "2026-11-16"); assert.deepEqual(day.slots.map(s => s.label), ["23:00", "23:30", "次日 00:00", "次日 00:30"]);
  assert.equal(day.slots[3].key, scheduling.occurrence(plan, new Date("2026-11-16T16:30:00Z")).key);
  assert.equal(day.slots[3].at, "2026-11-16T16:30:00.000Z");
  assert.equal(scheduling.dailySlots(plan, new Date("2026-11-17T12:00:00Z")).slots.length, 0);
  const dst = { ...config, id: "dst", revision: 1, timeZone: "America/New_York", times: ["01:30", "02:30"], enabled: true };
  const spring = scheduling.dailySlots(dst, new Date("2026-03-08T12:00:00Z"));
  assert.equal(spring.slots[1].at, null); assert.equal(spring.slots[1].state, "skipped");
  const fall = scheduling.dailySlots(dst, new Date("2026-11-01T12:00:00Z"));
  assert.equal(fall.slots.length, 2); assert.equal(fall.slots[0].at, "2026-11-01T05:30:00.000Z");
});

test("legacy shared plans split without enabling paused work; conflicts keep a recoverable backup", async t => {
  const { dir, favorites, runner, one, two } = await setup(t);
  const legacy = { ...favorites.state, schema: 1, enabled: false, plans: [
    { ...config, id: randomUUID(), revision: 1, favoriteIds: [one.id, two.id], kinds: ["candy", "fingerprint"], enabled: true, name: "旧共享" },
    { ...config, id: randomUUID(), revision: 1, favoriteIds: [one.id], kinds: ["candy"], enabled: true, name: "重叠" },
  ] };
  await writeFile(join(dir, ".favorites", "state.json"), JSON.stringify(legacy));
  const migrated = new Favorites({ dir, runner }); await migrated.init();
  assert.equal(migrated.state.schema, 3); assert.equal(migrated.state.plans.length, 2);
  assert.ok(migrated.state.plans.every(p => p.favoriteIds.length === 1 && p.kinds[0] === "candy" && !p.enabled));
  assert.match(migrated.state.plans.find(p => p.favoriteIds[0] === one.id).migrationReason, /重叠/);
  assert.deepEqual(JSON.parse(await readFile(join(dir, ".favorites", "state-v1-backup.json"), "utf8")), legacy);
  const again = new Favorites({ dir, runner }); await again.init(); assert.deepEqual(again.state.plans, migrated.state.plans);
});

for (const kind of ["candy", "pelican"]) for (const concurrency of [1, 2]) test(`${kind} time slots create independent results with automatic concurrency ${concurrency}`, async t => {
  const releases = []; const { favorites, runner, upstream, one } = await setup(t, ({ complete }) => releases.push(complete));
  const now = new Date(), zone = "UTC", start = new Date(Math.floor(now.getTime() / 60000) * 60000);
  const next = new Date(start.getTime() + 60000), clock = date => date.toISOString().slice(11, 16);
  const plan = await favorites.savePlan({ ...config, timeZone: zone, favoriteIds: [one.id], kinds: [kind], times: [clock(start), clock(next)], enabled: true });
  await favorites.settings({ enabled: true, concurrency });
  const scheduler = new scheduling.Scheduler(favorites, () => new Date(start.getTime() - 60000)); t.after(() => scheduler.close());
  await scheduler.tick(start); await waitFor(() => releases.length === 1);
  await favorites.save({ id: one.id, modelId: one.modelId, maxTokens: 0 });
  await scheduler.tick(next);
  assert.equal(runner.list().length, 2, "A new time slot must not reuse an earlier in-flight result");
  const occurrence = scheduling.occurrence(plan, next), claim = favorites.state.claims.find(c => c.key === occurrence.key);
  assert.equal(claim.state, "started"); assert.ok(claim.runId);
  assert.equal(runner.get(claim.runId).maxTokens, 0);
  await waitFor(() => releases.length === concurrency);
  assert.equal(runner.get(claim.runId).status, concurrency === 1 ? "queued" : "running");
  await scheduler.tick(next); assert.equal(runner.list().length, 2);
  const reply = kind === "candy" ? "最终答案：21" : FIXTURE_HTML;
  releases[0](reply); await waitFor(() => releases.length === 2); releases[1](reply);
  await waitFor(() => runner.list().every(run => run.status === "completed"));
  assert.equal(upstream.seen.peak, concurrency); assert.equal(upstream.seen.requests.length, 2);
  assert.equal(new Set(runner.list().flatMap(run => run.plans.map(ref => ref.triggerKey))).size, 2);
  const repeated = await favorites.run({ ids: [one.id], kinds: [kind] }, { source: "automatic", plans: [{ id: plan.id, revision: plan.revision, triggerKey: occurrence.key }], expiresAt: occurrence.expiresAt });
  assert.equal(repeated.runs.length, 0); assert.equal(repeated.linked[0].id, claim.runId, "The same scheduled slot stays idempotent even after completion");
  assert.equal(upstream.seen.requests.length, 2);
});

test("pausing preserves slot identity and a schedule edit starts a new revision", async t => {
  const { favorites, one } = await setup(t);
  const first = await favorites.savePlan({ ...config, favoriteIds: [one.id], kinds: ["candy"], enabled: true });
  const paused = await favorites.savePlan({ ...first, enabled: false }); assert.equal(paused.revision, first.revision);
  const edited = await favorites.savePlan({ ...paused, times: ["10:00"] }); assert.equal(edited.revision, first.revision + 1);
});

test("migration splits enabled legacy combinations into independent candy and animation plans", async t => {
  const { dir, favorites, runner, one, two } = await setup(t);
  const legacy = { ...favorites.state, schema: 1, enabled: true, plans: [{ ...config, id: randomUUID(), revision: 1, favoriteIds: [one.id, two.id],
    kinds: ["candy", "pelican", "fingerprint"], enabled: true, name: "共享", intervalMinutes: 60, start: "09:00", end: "18:00", allDay: false }] };
  legacy.favorites[0].maxTokens = 32000; legacy.favorites[1].maxTokens = 0;
  await writeFile(join(dir, ".favorites", "state.json"), JSON.stringify(legacy));
  const migrated = new Favorites({ dir, runner }); await migrated.init();
  assert.equal(migrated.state.plans.length, 4); assert.ok(migrated.state.plans.every(p => p.enabled));
  assert.deepEqual(migrated.state.favorites.map(f => f.maxTokens), [32000, 0]);
  assert.equal(new Set(migrated.state.plans.map(p => `${p.favoriteIds[0]}:${p.kinds[0]}`)).size, 4);
});
