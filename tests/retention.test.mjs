import test from "node:test";
import assert from "node:assert/strict";
import { retentionCandidates, RetentionPreviews, measureRunFiles } from "../lib/retention.mjs";

test("elapsed-day retention uses finished time and strictly excludes its boundary, protection and active records", () => {
  const now = Date.parse("2026-11-22T12:00:00Z"), old = "2026-11-14T12:00:00Z", boundary = "2026-11-15T12:00:00Z";
  const runs = [{ id: "expired", status: "completed", createdAt: old, finishedAt: old }, { id: "protected", status: "error", createdAt: old }, { id: "active", status: "running", createdAt: old }, { id: "boundary", status: "completed", createdAt: old, finishedAt: boundary }];
  const options = { now, days: 7, isBusy: () => false, isProtected: id => id === "protected" };
  assert.deepEqual(retentionCandidates(runs, options).candidateIds, ["expired"]); assert.deepEqual(retentionCandidates(runs, { ...options, days: null }).candidateIds, []);
  for (const days of [0, -1, "7", 1.5, 36501]) assert.throws(() => retentionCandidates(runs, { ...options, days }), e => e.status === 400);
});
test("preview is tied to fixed time, revisions and candidates, expires after five minutes and cannot be consumed twice", () => {
  let now = 1000; const previews = new RetentionPreviews({ now: () => now });
  const context = { days: 7, previewAt: 1000, settingsRevision: 2, annotationsRevision: 4, candidateIds: ["b", "a"] };
  const token = previews.issue(context).previewToken; now = 3000;
  previews.verify(token, { ...context, candidateIds: ["a", "b"] });
  for (const change of [{ days: 1 }, { settingsRevision: 3 }, { annotationsRevision: 5 }, { candidateIds: ["b"] }]) assert.throws(() => previews.verify(token, { ...context, ...change }), e => e.status === 409);
  previews.consume(token); assert.throws(() => previews.verify(token, context), e => e.status === 409);
  const late = previews.issue(context).previewToken; now += 300000; assert.throws(() => previews.verify(late, context), e => e.status === 409);
});
test("file measurement returns partial at its deadline without waiting for stalled stat calls", async () => {
  const result = await measureRunFiles({ path: id => id }, ["a", "b", "c"], { deadlineMs: 20, readDirectory: async () => ["run.json"], stat: () => new Promise(() => {}) });
  assert.equal(result.partial, true); assert.equal(result.measuredFileBytes, 0);
});
