import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RunStore } from "../lib/store.mjs";
import { Runner } from "../lib/runner.mjs";
import { Annotations } from "../lib/annotations.mjs";
import { temporary } from "./helpers.mjs";

async function setup(t, automatic = false) {
  const dir = await temporary(t), store = new RunStore(dir); await store.init();
  const first = randomUUID(), second = randomUUID(), batchId = randomUUID();
  for (const id of [first, second]) await store.save({ id, batchId, source: automatic ? "automatic" : "manual", kind: "pelican", model: "fixture/one", createdAt: "2026-11-12T00:00:00Z", finishedAt: "2026-11-12T01:00:00Z", status: "completed", content: "fixture", reasoning: "", html: "" });
  const annotations = new Annotations(dir); await annotations.init(); const runner = new Runner({ store, gateway: {}, annotations });
  t.after(async () => { await runner.close(); await annotations.close(); }); return { runner, annotations, first, second, batchId };
}
for (const mode of ["all", "before", "batch", "daily"]) test(`${mode} cleanup skips committed protection and removes the other saved directory`, async t => {
  const { runner, annotations, first, second, batchId } = await setup(t, mode === "daily");
  await runner.annotate({ runId: first, expectedRevision: 0, protected: true });
  const result = await runner.cleanup({ mode, before: "2026-11-22T00:00:00Z", batchId, runIds: [first, second] });
  assert.deepEqual(result.removed, [second]); assert.equal(result.skippedProtected, 1); assert.ok(await runner.read(first)); assert.equal(await runner.read(second), null); assert.equal(annotations.isProtected(first), true);
});
test("cleanup completed before annotation returns 404; broken annotations block all destructive cleanup", async t => {
  const { runner, annotations, first } = await setup(t);
  await runner.cleanup({ mode: "all" }); await assert.rejects(() => runner.annotate({ runId: first, expectedRevision: 0, protected: true }), e => e.status === 404);
  annotations.file.recoveryError = "broken index"; await assert.rejects(() => runner.cleanup({ mode: "all" }), e => e.status === 503);
});
