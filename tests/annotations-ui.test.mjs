import test from "node:test";
import assert from "node:assert/strict";
import { uiHarness } from "./ui-harness.mjs";
import { waitFor } from "./helpers.mjs";

test("local annotation events merge by run ID; a higher revision on another run does not hide valid details", async () => {
  const records = ["a", "b"].map(id => ({ id, batchId: "batch", kind: "candy", status: "completed", model: "fixture/one", createdAt: "2026-11-22T00:00:00Z", content: "21" }));
  const ui = await uiHarness({ bootstrap: { models: [], runs: records, defaultPrompt: "test", annotationsAvailable: true, annotations: { revision: 0, scopeRunIds: ["a", "b"], byRunId: {} } }, detail: id => ({ ...records.find(r => r.id === id), annotation: { runId: id, revision: id === "b" ? 7 : 0, annotation: id === "b" ? { protected: true } : null } }), search: "?view=candy" });
  await waitFor(() => ui.elements.get("candy-panel").hidden === false);
  ui.event("annotation", { runId: "a", revision: 8, annotation: { protected: true } }); await new Promise(resolve => setTimeout(resolve, 10));
  const buttons = ui.descendants(ui.elements.get("candy-results"), "button").filter(b => b.textContent === "查看详情"); await buttons[1].fire("click");
  const protect = await waitFor(() => ui.descendants(ui.elements.get("drawer-tools"), "button").find(b => b.textContent === "解除记录保护"));
  ui.event("annotation", { runId: "b", revision: 6, annotation: null }); await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(protect.textContent, "解除记录保护");
  ui.event("hello", { runs: records, annotations: { revision: 9, scopeRunIds: ["a"], byRunId: {} } }); await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(protect.textContent, "解除记录保护");
  ui.event("annotation", { runId: "b", revision: 10, annotation: null }); await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(protect.textContent, "保护此记录");
});
test("an annotation reply lost after commit is reconciled by reading details instead of toggled again", async () => {
  let protectedValue = false, writes = 0;
  const run = { id: "run", batchId: "run", kind: "candy", status: "completed", model: "fixture/one", createdAt: "2026-11-22T00:00:00Z", content: "21" };
  const ui = await uiHarness({ bootstrap: { models: [], runs: [run], defaultPrompt: "test", annotationsAvailable: true }, detail: () => ({ ...run, annotation: { runId: run.id, revision: protectedValue ? 1 : 0, annotation: protectedValue ? { protected: true } : null } }), annotations: () => { writes++; protectedValue = true; throw new Error("reply lost"); }, search: "?view=candy" });
  const open = await waitFor(() => ui.descendants(ui.elements.get("candy-results"), "button").find(b => b.textContent === "查看详情")); await open.fire("click");
  const protect = await waitFor(() => ui.descendants(ui.elements.get("drawer-tools"), "button").find(b => b.textContent === "保护此记录")); await protect.fire("click");
  assert.equal(writes, 1); assert.equal(protect.textContent, "解除记录保护");
});
