import test from "node:test";
import assert from "node:assert/strict";
import { newProgress, advanceProgress } from "../lib/progress.mjs";
import { describeProgress, mergeProgress, createRuntimeClock } from "../ui/run-progress.mjs";
import { uiHarness } from "./ui-harness.mjs";
import { waitFor } from "./helpers.mjs";

const progress = (event = "start", at = "2026-11-22T01:00:00Z") => advanceProgress(newProgress(), event, { at });
const run = extra => ({ id: "one", batchId: "one", model: "fixture/one", kind: "candy", status: "running", createdAt: "2026-11-22T01:00:00Z", timeoutMs: 600000, progress: progress(), ...extra });
const timing = (revision, elapsedMs, silenceMs = elapsedMs, remainingMs = 600000 - elapsedMs) => ({ progressRevision: revision, elapsedMs, silenceMs, remainingMs });

test("120 seconds without valid model data only adds a notice and respects queue, terminal and disabled states", () => {
  const current = run({ timeoutMs: 0 });
  assert.equal(describeProgress(current, { timings: timing(1, 119999, 119999, null) }).stalled, false);
  const shown = describeProgress(current, { timings: timing(1, 120000, 120000, null) }); assert.equal(shown.stalled, true); assert.equal(shown.remainingMs, null); assert.equal(current.status, "running");
  assert.equal(describeProgress(current, { timings: timing(1, 120000), noticesEnabled: false }).stalled, false);
  assert.equal(describeProgress(run({ status: "queued", progress: newProgress() }), { timings: timing(0, 120000) }).elapsedMs, null);
  assert.equal(describeProgress(run({ status: "completed", progress: progress("end"), elapsedMs: 120000 }), { timings: timing(1, 120000) }).stalled, false);
  assert.equal(describeProgress(current, {}).synchronized, false);
  assert.match(describeProgress(run(), { timings: timing(1, 700000, 1, 0) }).limitLabel, /等待服务端/);
});
test("each sample has its own timer, queued samples have no elapsed time or timeout budget", () => {
  const p = progress(), queued = newProgress(), ended = progress("end");
  const current = run({ kind: "fingerprint", fingerprint: { samples: [{ progress: p, state: "waiting" }, { progress: queued, state: "queued" }, { progress: ended, state: "complete", elapsedMs: 1000 }] } });
  const shown = describeProgress(current, { timings: [timing(p.revision, 120000), null, null] });
  assert.equal(shown.samples[0].stalled, true); assert.equal(shown.samples[1].elapsedMs, null); assert.equal(shown.samples[1].remainingMs, null); assert.equal(shown.samples[2].elapsedMs, 1000);
  assert.deepEqual(shown.counts, { ended: 1, inFlight: 1, queued: 1 });
});
test("local monotonic timing cannot move elapsed backwards or let old revisions reset silence", () => {
  let mono = 100; const clock = createRuntimeClock({ now: () => mono }), current = run();
  clock.observe(current, timing(1, 1000, 100)); mono += 120000; assert.equal(clock.read(current).elapsedMs, 121000);
  clock.observe(current, timing(1, 1000, 100)); assert.equal(clock.read(current).silenceMs, 120100);
  current.progress = advanceProgress(current.progress, "output", { at: "2020-01-01T00:00:00Z" }); clock.observe(current, timing(current.progress.revision, 500, 0));
  assert.equal(clock.read(current).elapsedMs, 121000); assert.equal(clock.read(current).silenceMs, 0);
  clock.observe(current, timing(1, 999999, 0)); assert.equal(clock.read(current).silenceMs, 0);
  assert.equal(mergeProgress(current.progress, progress()).phase, "output");
});
test("the shared drawer shows concise live progress and disposes its visible timer on close", async () => {
  let mono = 100; const current = run({ runtimeTiming: timing(1, 119000) });
  const ui = await uiHarness({ bootstrap: { models: [], runs: [current], defaultPrompt: "animate", candyAvailable: true }, detail: () => current, monotonicNow: () => mono });
  const control = await waitFor(() => ui.descendants(ui.elements.get("candy-results"), "button").find(e => e.textContent === "查看详情"));
  await control.fire("click"); const notice = ui.descendants(ui.elements.get("drawer-content")).find(e => e.className === "phase-progress-notice");
  assert.ok(notice); assert.equal(notice.hidden, true); assert.equal(ui.timers.size, 1);
  mono += 1000; ui.runTimer([...ui.timers.keys()][0]); assert.equal(notice.hidden, false); assert.match(notice.textContent, /120 秒/);
  await ui.elements.get("drawer-close").fire("click"); assert.equal(ui.timers.size, 0);
});
test("a late detail response cannot replace newer progress while its valid body is retained", async () => {
  let release; const old = run({ runtimeTiming: timing(1, 10), content: "21" }), newest = advanceProgress(old.progress, "output", { at: "2026-11-22T01:00:01Z" });
  const ui = await uiHarness({ bootstrap: { models: [], runs: [old], defaultPrompt: "animate", candyAvailable: true }, detail: () => new Promise(resolve => { release = () => resolve(old); }), monotonicNow: () => 10 });
  const control = await waitFor(() => ui.descendants(ui.elements.get("candy-results"), "button").find(e => e.textContent === "查看详情"));
  const loading = control.fire("click"); await waitFor(() => release); ui.event("delta", { id: old.id, progress: newest, runtimeTiming: timing(newest.revision, 1000, 0), contentChars: 2 });
  await new Promise(resolve => setTimeout(resolve, 10)); release(); await loading; ui.flushFrames();
  const labels = ui.descendants(ui.elements.get("drawer-content")).map(e => e.textContent); assert.ok(labels.some(value => value.includes("返回正文"))); assert.ok(labels.includes("21"));
  await ui.elements.get("drawer-close").fire("click");
});
