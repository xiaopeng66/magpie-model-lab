import test from "node:test";
import assert from "node:assert/strict";
import { pruneSmokeRuns } from "../tools/smoke-retention.mjs";

test("default smoke retention keeps five finished runs and never removes active work", async () => {
  const finished = Array.from({ length: 8 }, (_, index) => ({ id: `finished-${index}`, status: "completed", createdAt: String(index).padStart(3, "0") }));
  const active = { id: "active", status: "running", createdAt: "999" }, runs = [...finished, active], deleted = [];
  const runner = { list: () => [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), runs: new Map(runs.map(run => [run.id, run])) };
  const store = { async remove(id) { deleted.push(id); } };
  assert.deepEqual(await pruneSmokeRuns(store, runner), ["finished-2", "finished-1", "finished-0"]);
  assert.deepEqual(deleted, ["finished-2", "finished-1", "finished-0"]);
  assert.equal(runner.runs.has("active"), true);
  for (const run of finished.slice(3)) assert.equal(runner.runs.has(run.id), true);
});
