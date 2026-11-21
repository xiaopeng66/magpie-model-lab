import test from "node:test";
import assert from "node:assert/strict";
import { uiHarness } from "./ui-harness.mjs";
import { waitFor } from "./helpers.mjs";
import { summary } from "../lib/result.mjs";

const record = (id, kind, fields = {}) => ({ id, batchId: "current-batch", kind, model: "fixture/one", modelName: "one",
  provider: "fixture", providerName: "Fixture", createdAt: "2026-11-20T02:00:00Z", status: "completed", prompt: "布局验证题面",
  effort: "", maxTokens: 1200, concurrency: 3, candy: kind === "candy" ? { version: "shape-choice-v1", expected: 21, answer: 21, verdict: "match" } : undefined,
  ...fields });
const boot = runs => ({ runs: runs.map(summary), models: ["one", "two"].map(name => ({ id: `fixture/${name}`, name, provider: "fixture", efforts: [] })),
  retestAvailable: true, candyAvailable: true, fingerprintAvailable: true, defaultPrompt: "默认题面", historyTimeZone: "UTC" });
const descendantsWith = (ui, root, name) => ui.descendants(root).filter(element => element.className.split(/\s+/).includes(name));

for (const [kind, view] of [["pelican", "current"], ["fingerprint", "fingerprint"], ["candy", "candy"]]) {
  test(`${kind} history batches keep the retest entry in their title row and submit only that batch`, async () => {
    const current = record("current", kind), older = ["one", "two"].map(name => record(`older-${name}`, kind, { batchId: "older-batch",
      model: `fixture/${name}`, modelName: name, createdAt: "2026-11-20T01:00:00Z", effort: "high" }));
    const records = [current, ...older], requests = [];
    const ui = await uiHarness({ bootstrap: boot(records), detail: id => records.find(run => run.id === id), search: `?view=${view}`, retests: async (path, body) => {
      requests.push({ path, body });
      return { items: older.map(run => ({ id: run.id, kind, run: summary(run), available: true, abnormal: false,
        conditions: { kind, prompt: run.prompt, effort: run.effort, maxTokens: run.maxTokens, concurrency: run.concurrency } })) };
    } });
    const recent = ui.elements.get(`${view}-recent`);
    const heading = await waitFor(() => descendantsWith(ui, recent, "recent-batch-heading")[0]);
    const retest = ui.descendants(heading, "button").find(button => button.textContent === "原条件复测");
    assert.ok(retest, "Retest must remain available alongside the history batch title");
    assert.equal(retest.parentElement, heading);
    assert.equal(ui.descendants(heading, "h3")[0].textContent, "历史批次 1");
    assert.equal(descendantsWith(ui, recent, "batch-summary").length, 0);
    assert.equal(descendantsWith(ui, recent, "batch-condition-warning").length, 0);
    await retest.fire("click");
    assert.equal(requests.length, 1, "Opening the entry only checks saved conditions");
    assert.ok(requests[0].path.endsWith("preview"));
    assert.deepEqual([...requests[0].body.runIds].sort(), older.map(run => run.id).sort());
    assert.ok(ui.descendants(ui.elements.get("drawer-content")).some(element => element.textContent === "查看原题面与条件"),
      "Removing comparison warnings must preserve the original-condition review");
  });
}

test("the current batch retest entry follows streaming completion and survives further updates", async () => {
  const source = record("streaming", "candy", { status: "running", startedAt: "2026-11-20T02:00:00Z" });
  const ui = await uiHarness({ bootstrap: boot([source]), detail: () => source, search: "?view=candy" });
  const actions = ui.elements.get("candy-batch-actions");
  assert.ok(actions, "Current batch actions need a title-row host");
  const retest = await waitFor(() => ui.descendants(actions, "button").find(button => button.textContent === "原条件复测"));
  assert.equal(retest.disabled, true, "A batch with no ended records cannot be retested yet");
  ui.event("run", { run: summary({ ...source, status: "completed", elapsedMs: 1000 }) });
  await waitFor(() => !retest.disabled);
  ui.event("run", { run: summary({ ...source, status: "completed", elapsedMs: 1500 }) });
  assert.equal(ui.descendants(actions, "button").find(button => button.textContent === "原条件复测"), retest);
  assert.equal(retest.hidden, false);
});
