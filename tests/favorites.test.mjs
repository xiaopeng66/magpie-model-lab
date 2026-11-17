import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Gateway } from "../lib/gateway.mjs";
import { Runner } from "../lib/runner.mjs";
import { RunStore } from "../lib/store.mjs";
import { temporary, fakeGateway, waitFor } from "./helpers.mjs";
const favoritesModule = await import("../lib/favorites.mjs").catch(() => ({}));
const scheduling = await import("../lib/scheduler.mjs").catch(() => ({}));

async function setup(t, handler) {
  assert.equal(typeof favoritesModule.Favorites, "function", "Missing favorites service");
  const dir = await temporary(t), upstream = await fakeGateway(t, handler || (({ complete }) => complete("最终答案：21")));
  const store = new RunStore(dir); await store.init();
  const runner = new Runner({ store, gateway: new Gateway({ url: upstream.url }) });
  const favorites = new favoritesModule.Favorites({ dir, runner }); await favorites.init();
  t.after(() => runner.close());
  return { dir, runner, favorites, upstream };
}

test("favorites deduplicate stable model IDs, persist settings, and survive result cleanup", async t => {
  const { dir, favorites, runner } = await setup(t);
  const one = await favorites.save({ modelId: "fixture/one" });
  assert.equal((await favorites.save({ modelId: "fixture/one" })).id, one.id);
  assert.equal(favorites.snapshot().favorites.length, 1);
  await assert.rejects(favorites.save({ modelId: "missing/model" }), /模型/);
  await assert.rejects(favorites.save({ id: one.id, modelId: one.modelId, maxTokens: -1 }), /整数/);
  const result = await favorites.run({ ids: [one.id], kinds: ["candy"] });
  await waitFor(() => runner.get(result.runs[0].id)?.status === "completed");
  await runner.cleanup({ mode: "all" });
  const saved = JSON.parse(await readFile(join(dir, ".favorites", "state.json"), "utf8"));
  assert.equal(saved.favorites[0].id, one.id); assert.ok(saved.favorites[0].lastRunAt);
  const reloaded = new favoritesModule.Favorites({ dir, runner }); await reloaded.init();
  assert.equal(reloaded.snapshot().favorites[0].id, one.id);
  assert.equal(reloaded.snapshot().enabled, true);
});

test("favorite runs share a round, deduplicate in-flight work, and use shared automatic concurrency", async t => {
  const releases = [];
  const { favorites, runner, upstream } = await setup(t, ({ complete }) => releases.push(complete));
  const one = await favorites.save({ modelId: "fixture/one" }), two = await favorites.save({ modelId: "fixture/two" });
  await favorites.settings({ enabled: true, concurrency: 1 });
  const plans = [];
  for (const id of [one.id, two.id]) for (const kind of ["candy", "pelican"]) plans.push(await favorites.savePlan({ favoriteIds: [id], kinds: [kind], times: ["09:00"], days: [1, 2, 3, 4, 5], timeZone: "Asia/Shanghai", enabled: true }));
  const context = { source: "automatic", plans: plans.map(plan => ({ id: plan.id, revision: plan.revision })), expiresAt: new Date(Date.now() + 60000).toISOString() };
  const first = await favorites.run({ ids: [one.id, two.id], kinds: ["candy", "pelican"] }, context);
  assert.equal(first.runs.length, 4); assert.equal(new Set(first.runs.map(run => run.roundId)).size, 1);
  const second = await favorites.run({ ids: [one.id], kinds: ["candy"] });
  assert.equal(second.linked.length, 1); assert.equal(second.runs.length, 0);
  await waitFor(() => releases.length === 1); assert.equal(upstream.seen.peak, 1);
  await favorites.settings({ enabled: false });
  releases[0]("最终答案：21");
  await waitFor(() => first.runs.every(run => !["running", "queued"].includes(runner.get(run.id).status)));
  assert.equal(upstream.seen.requests.length, 1);
  assert.equal(runner.get(first.runs[0].id).status, "completed");
  assert.ok(first.runs.slice(1).every(run => runner.get(run.id).status === "cancelled"));
});

test("removing a favorite unlinks plans without removing completed history", async t => {
  const { favorites, runner } = await setup(t), one = await favorites.save({ modelId: "fixture/one" });
  const plan = await favorites.savePlan({ favoriteIds: [one.id], kinds: ["candy"], times: ["09:00", "09:00", "08:00"], days: [0, 6], timeZone: "Asia/Shanghai" });
  assert.equal(plan.enabled, false); assert.deepEqual(plan.times, ["08:00", "09:00"]);
  const result = await favorites.run({ ids: [one.id], kinds: ["candy"] });
  await waitFor(() => runner.get(result.runs[0].id)?.status === "completed");
  await favorites.remove({ id: one.id });
  assert.equal(favorites.snapshot().favorites.length, 0); assert.equal(runner.list().length, 1);
  assert.equal(favorites.snapshot().plans.length, 0);
});

test("zero automatic concurrency releases queued work and persists through restart", async t => {
  const { dir, favorites, runner, upstream } = await setup(t, ({ res }) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders(); });
  const members = [], plans = [];
  for (const modelId of ["fixture/one", "fixture/two", "fixture/three", "fixture/four"]) {
    const favorite = await favorites.save({ modelId, maxTokens: 0, concurrency: { candy: 0, pelican: 0, fingerprint: 0 } });
    members.push(favorite.id);
    plans.push(await favorites.savePlan({ favoriteIds: [favorite.id], kinds: ["candy"], enabled: true }));
  }
  await favorites.settings({ concurrency: 1 });
  const result = await favorites.run({ ids: members, kinds: ["candy"] }, { source: "automatic", plans: plans.map(plan => ({ id: plan.id, revision: plan.revision })), expiresAt: new Date(Date.now() + 60000).toISOString() });
  assert.equal(result.errors.length, 0); assert.equal(result.runs.length, 4);
  await waitFor(() => upstream.seen.requests.length === 1);
  assert.equal(runner.queue.length, 3);
  await favorites.settings({ concurrency: 0 });
  await waitFor(() => upstream.seen.requests.length === 4);
  assert.equal(upstream.seen.peak, 4);
  assert.ok(upstream.seen.requests.every(payload => !Object.hasOwn(payload, "max_tokens")));
  const restored = new favoritesModule.Favorites({ dir, runner }); await restored.init();
  assert.equal(restored.state.concurrency, 0);
  assert.ok(restored.state.favorites.every(favorite => favorite.maxTokens === 0 && Object.values(favorite.concurrency).every(value => value === 0)));
  for (const concurrency of [-1, 1.5, "0", Infinity]) await assert.rejects(() => restored.settings({ concurrency }), /并行/);
});

test("schedule occurrences honor local weekdays, interval boundaries and overnight start days", () => {
  assert.equal(typeof scheduling.occurrence, "function", "Missing schedule calculation");
  const base = { id: "p", revision: 1, enabled: true, mode: "times", times: ["09:00", "18:00"], days: [1], timeZone: "Asia/Shanghai" };
  assert.ok(scheduling.occurrence(base, new Date("2026-11-16T01:00:00Z")));
  assert.equal(scheduling.occurrence(base, new Date("2026-11-17T01:00:00Z")), null);
  const night = { ...base, mode: "interval", intervalMinutes: 30, start: "23:00", end: "01:00", allDay: false };
  assert.ok(scheduling.occurrence(night, new Date("2026-11-16T15:00:00Z")));
  assert.ok(scheduling.occurrence(night, new Date("2026-11-16T16:30:00Z")));
  assert.equal(scheduling.occurrence(night, new Date("2026-11-16T17:00:00Z")), null);
  assert.equal(scheduling.occurrence(night, new Date("2026-11-16T16:45:00Z")), null);
  const dst = { ...base, timeZone: "America/New_York", days: [0], times: ["01:30"] };
  assert.equal(scheduling.occurrence(dst, new Date("2026-11-01T05:30:00Z")).key, scheduling.occurrence(dst, new Date("2026-11-01T06:30:00Z")).key);
  const future = scheduling.nextOccurrences({ ...dst, times: ["02:30"] }, new Date("2026-03-08T06:00:00Z"), 1);
  assert.equal(future[0].at, "2026-03-15T06:30:00.000Z");
});

test("automatic windows end at the local wall clock across DST and expired or stale plan references cannot start work", async t => {
  const plan = { id: "p", revision: 1, enabled: true, mode: "interval", intervalMinutes: 30, start: "01:30", end: "03:00", allDay: false, days: [0], timeZone: "America/New_York" };
  assert.equal(scheduling.occurrence(plan, new Date("2026-03-08T06:30:00Z")).expiresAt, "2026-03-08T07:00:00.000Z");
  assert.equal(scheduling.occurrence(plan, new Date("2026-11-01T05:30:00Z")).expiresAt, "2026-11-01T08:00:00.000Z");
  const { favorites } = await setup(t), one = await favorites.save({ modelId: "fixture/one" });
  const short = await favorites.savePlan({ favoriteIds: [one.id], kinds: ["candy"], enabled: true });
  const long = await favorites.savePlan({ ...short, name: "更新后的计划", enabled: true });
  await favorites.settings({ enabled: true });
  const future = new Date(Date.now() + 60000).toISOString(), past = new Date(Date.now() - 1000).toISOString();
  const run = { kind: "candy", favoriteId: one.id, expiresAt: future, plans: [{ id: short.id, revision: short.revision, expiresAt: past }, { id: long.id, revision: long.revision, expiresAt: future }] };
  assert.equal(favorites.eligible(run), true); await favorites.savePlan({ ...long, enabled: false });
  assert.equal(favorites.eligible(run), false);
});

test("scheduler claims before dispatch, skips missed minutes and restart duplicates", async t => {
  const { favorites, runner, dir } = await setup(t);
  assert.equal(typeof scheduling.Scheduler, "function");
  const one = await favorites.save({ modelId: "fixture/one" });
  await favorites.savePlan({ name: "上午", favoriteIds: [one.id], kinds: ["candy"], times: ["09:00", "09:10"], days: [1], timeZone: "Asia/Shanghai", enabled: true });
  await favorites.settings({ enabled: true });
  const upcomingMonday = new Date(); upcomingMonday.setUTCHours(0, 0, 0, 0); upcomingMonday.setUTCDate(upcomingMonday.getUTCDate() + ((8 - upcomingMonday.getUTCDay()) % 7 || 7));
  const dueAt = new Date(upcomingMonday); dueAt.setUTCHours(1);
  const beforeDue = new Date(dueAt.getTime() - 60000), afterMissed = new Date(dueAt.getTime() + 11 * 60000);
  let now = beforeDue;
  const scheduler = new scheduling.Scheduler(favorites, () => now); t.after(() => scheduler.close());
  now = dueAt; await scheduler.tick(); await scheduler.tick();
  await waitFor(() => runner.list().length === 1 && runner.list()[0].status === "completed");
  assert.equal(runner.list()[0].plans.length, 1);
  const restarted = new scheduling.Scheduler(favorites, () => beforeDue);
  await restarted.tick(dueAt); assert.equal(runner.list().length, 1);
  now = afterMissed; await scheduler.tick(); assert.equal(runner.list().length, 1);
  assert.ok(JSON.parse(await readFile(join(dir, ".favorites", "state.json"), "utf8")).claims.length);
  await restarted.close();
});

test("automatic cancellation is saved before shutdown returns and configuration write failure leaves memory unchanged", async t => {
  const { favorites, runner, dir } = await setup(t);
  const one = await favorites.save({ modelId: "fixture/one" });
  const result = await favorites.run({ ids: [one.id], kinds: ["candy"] }, { source: "automatic", plans: [], expiresAt: new Date(Date.now() + 60000).toISOString() });
  await runner.close();
  const saved = JSON.parse(await readFile(join(dir, result.runs[0].id, "run.json"), "utf8")); assert.equal(saved.status, "cancelled");
  const atomic = runner.store.atomic;
  runner.store.atomic = async () => { throw new Error("disk full"); };
  await assert.rejects(favorites.settings({ enabled: false }), /disk full/);
  assert.equal(favorites.snapshot().enabled, true); runner.store.atomic = atomic;
});
