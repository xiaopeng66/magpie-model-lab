import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Gateway } from "../lib/gateway.mjs";
import { Runner } from "../lib/runner.mjs";
import { RunStore } from "../lib/store.mjs";
import { Favorites } from "../lib/favorites.mjs";
import { Scheduler } from "../lib/scheduler.mjs";
import { temporary, fakeGateway, waitFor, FIXTURE_HTML } from "./helpers.mjs";

const config = { mode: "times", times: ["09:00", "10:00", "11:00"], days: [0, 1, 2, 3, 4, 5, 6], timeZone: "UTC", enabled: true };
const slotAt = (favorites, plan, at, time) => favorites.snapshot(at).plans.find(p => p.id === plan.id).today.slots.find(slot => slot.time === time);
async function setup(t, handler) {
  const dir = await temporary(t), upstream = await fakeGateway(t, handler), store = new RunStore(dir); await store.init();
  const runner = new Runner({ store, gateway: new Gateway({ url: upstream.url }) }); t.after(() => runner.close());
  const favorites = new Favorites({ dir, runner }); await favorites.init();
  const favorite = await favorites.save({ modelId: "fixture/one" });
  return { dir, upstream, store, runner, favorites, favorite };
}
async function saveRecord(runner, favorite, overrides = {}) {
  const run = await runner.store.save({ id: randomUUID(), batchId: randomUUID(), roundId: randomUUID(), kind: "candy", source: "automatic",
    favoriteId: favorite.id, model: favorite.modelId, modelName: favorite.modelName, provider: favorite.provider, providerName: favorite.providerName,
    status: "completed", createdAt: "2026-11-16T09:05:00.000Z", scheduledAt: "2026-11-16T09:00:04.000Z", startedAt: "2026-11-16T09:05:00.000Z",
    finishedAt: "2026-11-16T09:06:00.000Z", maxTokens: 64000, content: "最终答案：21", reasoning: "检查数值", html: "",
    candy: { answer: 21, expected: 21, verdict: "match", version: "shape-choice-v1" }, plans: [{ id: randomUUID(), revision: 1, triggerKey: "old-slot" }], ...overrides });
  runner.runs.set(run.id, run); return run;
}

for (const kind of ["candy", "pelican"]) test(`${kind} results survive schedule mode changes, recreation and restart without another request`, async t => {
  const { dir, upstream, runner, favorites, favorite } = await setup(t, ({ complete }) => complete(kind === "candy" ? "最终答案：21" : FIXTURE_HTML));
  const start = new Date(); start.setUTCDate(start.getUTCDate() + 1); start.setUTCHours(9, 0, 0, 0);
  const first = await favorites.savePlan({ ...config, favoriteIds: [favorite.id], kinds: [kind] });
  const scheduler = new Scheduler(favorites, () => new Date(start.getTime() - 60000)); t.after(() => scheduler.close());
  await scheduler.tick(new Date(start.getTime() + 4000));
  await waitFor(() => runner.list()[0]?.status === "completed");
  const original = runner.list()[0], saved = await readFile(join(dir, original.id, "run.json"), "utf8");
  await favorites.save({ id: favorite.id, modelId: favorite.modelId, maxTokens: 0 });
  let edited = await favorites.savePlan({ ...first, mode: "interval", start: "09:00", end: "12:00", intervalMinutes: 60, allDay: false });
  assert.equal(slotAt(favorites, edited, start, "09:00").runId, original.id, "Changing revision/mode must preserve the matching result");
  assert.equal(slotAt(favorites, edited, start, "10:00").runId, undefined, "Other times must remain separate");
  const repeated = new Scheduler(favorites, () => new Date(start.getTime() - 60000)); t.after(() => repeated.close());
  await repeated.tick(new Date(start.getTime() + 8000));
  assert.equal(runner.list().length, 1, "An edited plan cannot charge again for the same scheduled minute");
  assert.equal(slotAt(favorites, edited, start, "09:00").runId, original.id);
  edited = await favorites.savePlan({ ...edited, mode: "times", times: ["08:00", "09:00", "11:00"] });
  assert.equal(slotAt(favorites, edited, start, "09:00").runId, original.id, "Interval-to-times must also reuse results");
  edited = await favorites.savePlan({ ...edited, times: ["10:00"] });
  edited = await favorites.savePlan({ ...edited, times: ["09:00", "10:00"] });
  assert.equal(slotAt(favorites, edited, start, "09:00").runId, original.id, "Search all saved revisions, not just the previous one");
  await favorites.removePlan({ id: edited.id });
  edited = await favorites.savePlan({ ...config, favoriteIds: [favorite.id], kinds: [kind] });
  const restoredStore = new RunStore(dir); await restoredStore.init();
  const restoredRunner = new Runner({ store: restoredStore, gateway: new Gateway({ url: upstream.url }) }); t.after(() => restoredRunner.close());
  const restored = new Favorites({ dir, runner: restoredRunner }); await restored.init();
  assert.equal(slotAt(restored, edited, start, "09:00").runId, original.id);
  assert.equal(restoredRunner.get(original.id).maxTokens, 64000, "A reused result retains its original request parameters");
  assert.equal(await readFile(join(dir, original.id, "run.json"), "utf8"), saved, "Reusing does not rewrite the old record or its batch");
  assert.equal(upstream.seen.requests.length, 1);
  await restoredRunner.cleanup({ mode: "all" });
  assert.equal(slotAt(restored, edited, start, "09:00").runId, undefined, "Deleting results must not resurrect a cached record");
});

test("result reuse matches the scheduled date/minute and isolates model, provider, kind and manual tests", async t => {
  const { favorites, favorite, runner } = await setup(t);
  const plan = await favorites.savePlan({ ...config, favoriteIds: [favorite.id], kinds: ["candy"], times: ["09:00", "09:01", "09:05"] });
  for (const overrides of [
    { scheduledAt: "2026-11-15T09:00:00Z" }, { scheduledAt: "2026-11-16T09:02:00Z" },
    { model: "other-provider/one" }, { model: "fixture/two" }, { favoriteId: randomUUID() },
    { kind: "pelican", html: FIXTURE_HTML }, { source: "manual" }, { scheduledAt: undefined }, { scheduledAt: "bad-date" },
  ]) await saveRecord(runner, favorite, overrides);
  const at = new Date("2026-11-16T12:00:00Z");
  assert.equal(slotAt(favorites, plan, at, "09:00").runId, undefined);
  const matching = await saveRecord(runner, favorite);
  assert.equal(slotAt(favorites, plan, at, "09:00").runId, matching.id, "A delayed start belongs to its original scheduled minute");
  assert.equal(slotAt(favorites, plan, at, "09:01").runId, undefined);
  assert.equal(slotAt(favorites, plan, at, "09:05").runId, undefined, "Creation/start time is not a substitute for the scheduled time");
});

test("an existing completed result wins over empty attempts and newer completed results win ties", async t => {
  const { favorites, favorite, runner } = await setup(t);
  const plan = await favorites.savePlan({ ...config, favoriteIds: [favorite.id], kinds: ["candy"] });
  const first = await saveRecord(runner, favorite);
  const latest = await saveRecord(runner, favorite, { createdAt: "2026-11-16T09:06:00Z", candy: { answer: 29, verdict: "mismatch" } });
  await saveRecord(runner, favorite, { status: "cancelled", startedAt: null, createdAt: "2026-11-16T09:07:00Z", content: "", candy: { answer: null, verdict: "incomplete" },
    plans: [{ id: plan.id, revision: plan.revision, triggerKey: `${plan.id}:${plan.revision}:2026-11-16:09:00` }] });
  const at = new Date("2026-11-16T12:00:00Z");
  assert.equal(slotAt(favorites, plan, at, "09:00").runId, latest.id);
  runner.runs = new Map([...runner.runs].reverse());
  assert.equal(slotAt(favorites, plan, at, "09:00").runId, latest.id, "File enumeration order cannot change the chosen answer");
  await runner.cleanup({ mode: "batch", batchId: latest.roundId });
  assert.equal(slotAt(favorites, plan, at, "09:00").runId, first.id, "A remaining result at that time is still available");
});

test("overnight and timezone edits reuse matching actual times without mixing equal clock labels", async t => {
  const { favorites, favorite, runner } = await setup(t);
  const old = await saveRecord(runner, favorite, { scheduledAt: "2026-11-16T16:30:04Z" });
  const plan = await favorites.savePlan({ ...config, timeZone: "Asia/Shanghai", favoriteIds: [favorite.id], kinds: ["candy"], times: ["00:30"] });
  let at = new Date("2026-11-16T16:45:00Z");
  assert.equal(slotAt(favorites, plan, at, "00:30").runId, old.id);
  let edited = await favorites.savePlan({ ...plan, mode: "interval", start: "23:30", end: "01:00", intervalMinutes: 30, allDay: false });
  assert.equal(favorites.snapshot(at).plans[0].today.date, "2026-11-16");
  assert.equal(slotAt(favorites, edited, at, "00:30").runId, old.id);
  edited = await favorites.savePlan({ ...edited, mode: "times", times: ["00:30"], timeZone: "UTC" });
  at = new Date("2026-11-17T01:00:00Z");
  assert.equal(slotAt(favorites, edited, at, "00:30").runId, undefined, "The same clock label in another zone is a different instant");
});

test("editing a plan keeps its in-flight record visible through completion", async t => {
  let complete;
  const { favorites, favorite, runner, upstream } = await setup(t, request => { complete = request.complete; });
  const start = new Date(); start.setUTCDate(start.getUTCDate() + 1); start.setUTCHours(9, 0, 0, 0);
  const plan = await favorites.savePlan({ ...config, favoriteIds: [favorite.id], kinds: ["candy"] });
  const scheduler = new Scheduler(favorites, () => new Date(start.getTime() - 60000)); t.after(() => scheduler.close());
  await scheduler.tick(start); await waitFor(() => complete);
  const run = runner.list()[0];
  const edited = await favorites.savePlan({ ...plan, times: ["08:00", "09:00", "10:00"] });
  assert.equal(slotAt(favorites, edited, start, "09:00").runId, run.id);
  assert.equal(runner.get(run.id).status, "running");
  complete("最终答案：21"); await waitFor(() => runner.get(run.id).status === "completed");
  assert.equal(slotAt(favorites, edited, start, "09:00").runId, run.id);
  assert.equal(runner.list()[0].tokens.output, 120); assert.equal(upstream.seen.requests.length, 1);
});

test("editing during a repeated DST clock time cannot create a second result for that slot", async t => {
  const { favorites, favorite, runner, upstream } = await setup(t, ({ complete }) => complete("最终答案：21"));
  const fall = new Date(Date.UTC(new Date().getUTCFullYear() + 1, 10, 1, 5, 30));
  fall.setUTCDate(1 + (7 - fall.getUTCDay()) % 7);
  const repeated = new Date(fall.getTime() + 3600000);
  const plan = await favorites.savePlan({ ...config, timeZone: "America/New_York", favoriteIds: [favorite.id], kinds: ["candy"], times: ["01:30"] });
  const first = new Scheduler(favorites, () => new Date(fall.getTime() - 60000)); t.after(() => first.close());
  await first.tick(fall); await waitFor(() => runner.list()[0]?.status === "completed");
  const original = runner.list()[0];
  const edited = await favorites.savePlan({ ...plan, mode: "interval", start: "01:30", end: "02:30", intervalMinutes: 60, allDay: false });
  const second = new Scheduler(favorites, () => new Date(repeated.getTime() - 60000)); t.after(() => second.close());
  await second.tick(repeated);
  assert.equal(runner.list().length, 1, "One local clock slot stays idempotent across schedule revisions during DST fall-back");
  assert.equal(slotAt(favorites, edited, repeated, "01:30").runId, original.id);
  assert.equal(upstream.seen.requests.length, 1);
});
