import test from "node:test";
import assert from "node:assert/strict";
import { Scheduler, occurrence, dailySlots, nextOccurrences } from "../lib/scheduler.mjs";
import { Favorites } from "../lib/favorites.mjs";
import { Runner } from "../lib/runner.mjs";
import { RunStore } from "../lib/store.mjs";
import { Gateway } from "../lib/gateway.mjs";
import { temporary, fakeGateway } from "./helpers.mjs";

const plan = { id: "fixture", revision: 1, enabled: true, mode: "times", times: ["00:00"], days: [0, 1, 2, 3, 4, 5, 6], timeZone: "UTC", favoriteIds: [], kinds: ["candy"] };

test("A100-007: simultaneous schedules reuse timezone/window conversion work before claiming", async t => {
  const original = Intl.DateTimeFormat.prototype.formatToParts; let calls = 0, claims;
  t.mock.method(Intl.DateTimeFormat.prototype, "formatToParts", function (...args) { calls++; return original.apply(this, args); });
  const favorites = { state: { enabled: true, plans: Array.from({ length: 200 }, (_, i) => ({ ...plan, id: String(i) })) }, runner: { pump() {} },
    claim: async due => { claims = due; return []; } };
  const scheduler = new Scheduler(favorites, () => new Date("2026-11-20T23:59:00Z")); t.after(() => scheduler.close());
  await scheduler.tick(new Date("2026-11-21T00:00:04Z"));
  assert.equal(claims.length, 200); assert.equal(new Set(claims.map(item => item.key)).size, 200);
  assert.ok(claims.every(item => item.at === "2026-11-21T00:00:00.000Z" && item.expiresAt === "2026-11-22T00:00:00.000Z"));
  assert.ok(calls < 2000, `Expected shared minute scan; observed ${calls} timezone conversions`);
});

for (const mode of ["times", "interval"]) test(`A100-008: ${mode} rollback slot triggers only at its first UTC mapping`, () => {
  const dst = { ...plan, mode, timeZone: "America/New_York", times: ["01:30"], allDay: false, start: "01:30", end: "02:30", intervalMinutes: 60 };
  assert.equal(occurrence(dst, new Date("2026-11-01T05:30:04Z")).at, "2026-11-01T05:30:00.000Z");
  assert.equal(dailySlots(dst, new Date("2026-11-01T06:00:00Z")).slots[0].state, "missed");
  assert.equal(occurrence(dst, new Date("2026-11-01T06:30:04Z")), null);
  assert.equal(nextOccurrences(dst, new Date("2026-11-01T06:00:00Z"), 1)[0].at, "2026-11-02T06:30:00.000Z");
});

test("A100-008: service restarted after rollback does not claim or execute the missed first slot", async t => {
  const upstream = await fakeGateway(t), dir = await temporary(t), store = new RunStore(dir); await store.init();
  const runner = new Runner({ store, gateway: new Gateway({ url: upstream.url }) }); t.after(() => runner.close());
  const favorites = new Favorites({ dir, runner }); await favorites.init();
  const favorite = await favorites.save({ modelId: "fixture/one" });
  await favorites.savePlan({ ...plan, id: undefined, timeZone: "America/New_York", times: ["01:30"], favoriteIds: [favorite.id] });
  await favorites.settings({ enabled: true });
  const scheduler = new Scheduler(favorites, () => new Date("2026-11-01T06:29:00Z")); t.after(() => scheduler.close());
  await scheduler.tick(new Date("2026-11-01T06:30:04Z"));
  assert.equal(favorites.state.claims.length, 0); assert.equal(runner.list().length, 0); assert.equal(upstream.seen.requests.length, 0);
});

test("A100-007/008: DST transitions and overnight windows retain their actual expiration instants", () => {
  const ny = { ...plan, timeZone: "America/New_York", times: ["01:30", "02:30"] };
  assert.equal(occurrence(ny, new Date("2026-11-01T05:30:00Z")).expiresAt, "2026-11-02T05:00:00.000Z");
  assert.equal(occurrence(ny, new Date("2026-03-08T06:30:00Z")).expiresAt, "2026-03-09T04:00:00.000Z");
  assert.equal(dailySlots(ny, new Date("2026-03-08T12:00:00Z")).slots[1].state, "skipped");
  const overnight = { ...ny, mode: "interval", start: "23:30", end: "02:30", intervalMinutes: 60, allDay: false, days: [6] };
  assert.equal(occurrence(overnight, new Date("2026-11-01T05:30:00Z")).expiresAt, "2026-11-01T07:30:00.000Z");
  assert.equal(occurrence(overnight, new Date("2026-11-01T06:30:00Z")), null);
});
