import test from "node:test";
import assert from "node:assert/strict";
import { newProgress, advanceProgress, readRuntimeTiming, isModelEvent } from "../lib/progress.mjs";

test("progress records only observed phases, preserves first timestamps and ignores terminal late data", () => {
  let p = newProgress(); assert.equal(p.phase, "queued"); assert.equal(p.revision, 0);
  p = advanceProgress(p, "start", { at: "2026-11-22T01:00:00.000Z" }); assert.equal(p.phase, "waiting_response"); assert.equal(p.firstEventAt, null);
  p = advanceProgress(p, "model_event", { at: "2026-11-22T01:00:01.000Z" });
  p = advanceProgress(p, "reasoning", { at: "2026-11-22T01:00:02.000Z" });
  p = advanceProgress(p, "output", { at: "2026-11-22T01:00:03.000Z" }); const first = p.firstOutputAt;
  p = advanceProgress(p, "reasoning", { at: "2026-11-22T00:00:04.000Z" });
  assert.equal(p.phase, "output"); assert.equal(p.firstOutputAt, first); assert.equal(p.lastDataAt, "2026-11-22T00:00:04.000Z");
  p = advanceProgress(p, "saving", { at: "2026-11-22T01:00:05.000Z" });
  const saving = p; assert.deepEqual(advanceProgress(p, "output", { at: "2026-11-22T01:00:06.000Z" }), saving);
  p = advanceProgress(p, "end", { at: "2026-11-22T01:00:07.000Z" });
  assert.deepEqual(advanceProgress(p, "reasoning", { at: "2026-11-22T01:00:08.000Z" }), p);
});
test("runtime timing uses only the monotonic control clock and zero timeout has no remaining limit", () => {
  const control = { startedMonoMs: 100, lastDataMonoMs: 500, timeoutMs: 600000, progressRevision: 4 };
  assert.deepEqual(readRuntimeTiming(control, { monoNow: 1500 }), { progressRevision: 4, elapsedMs: 1400, silenceMs: 1000, remainingMs: 598600 });
  assert.equal(readRuntimeTiming({ ...control, timeoutMs: 0 }, { monoNow: 999999 }).remainingMs, null);
  assert.equal(readRuntimeTiming(control, { monoNow: 999999 }).remainingMs, 0);
});
test("parsed unknown JSON, ping and malformed usage do not count as model events", () => {
  for (const api of ["chat_completions", "messages", "responses"]) {
    for (const body of [{ type: "ping" }, { type: "unknown", delta: "noise" }, { usage: { arbitrary: 2 } }, { usage: { output_tokens: "2" } }]) assert.equal(isModelEvent(body, api), false);
  }
  assert.equal(isModelEvent({ choices: [{ delta: { role: "assistant" } }] }, "chat_completions"), true);
  assert.equal(isModelEvent({ choices: [], usage: { completion_tokens: 0 } }, "chat_completions"), true);
  assert.equal(isModelEvent({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "reason" } }, "messages"), true);
  assert.equal(isModelEvent({ type: "response.in_progress", response: { status: "in_progress" } }, "responses"), true);
});
