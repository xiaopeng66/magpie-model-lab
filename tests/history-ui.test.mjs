import test from "node:test";
import assert from "node:assert/strict";
import { uiHarness } from "./ui-harness.mjs";
import { waitFor } from "./helpers.mjs";

const model = id => ({ id, name: id, provider: "fixture", providerName: "Fixture", efforts: [] });
const record = (id, batchId, kind, status, at, name = "one") => ({ id, batchId, kind, status, createdAt: at, model: `fixture/${name}`, modelName: name, provider: "fixture" });
const at = "2026-11-17T09:00:00.000Z";
const bootstrap = runs => ({ models: [model("fixture/one"), model("fixture/two")], runs, defaultPrompt: "prompt", candyAvailable: true, historyTimeZone: "UTC" });
const childrenWith = (ui, id, name) => ui.descendants(ui.elements.get(id)).filter(element => element.className === name);

test("a history row closes its result when pressed again", async () => {
  const run = record("manual-run", "manual-batch", "candy", "completed", at);
  const ui = await uiHarness({ bootstrap: bootstrap([run]), detail: async () => run, search: "?view=history" });
  const row = await waitFor(() => childrenWith(ui, "history-list", "history-row")[0]);
  await row.fire("click");
  assert.equal(ui.elements.get("history-detail").hidden, false);
  assert.equal(row.getAttribute("aria-pressed"), "true");
  await row.fire("click");
  assert.equal(ui.elements.get("history-detail").hidden, true);
  assert.equal(row.getAttribute("aria-pressed"), "false");
});

test("an older active manual batch stays reachable and joins the three recent batches when it finishes", async () => {
  const current = [record("new", "new-batch", "candy", "running", "2026-11-17T11:00:00Z", "two"), record("new-2", "new-batch", "candy", "running", "2026-11-17T11:00:00Z")];
  const running = record("older", "older-batch", "candy", "running", "2026-11-17T10:00:00Z");
  const finished = Array.from({ length: 4 }, (_, index) => [record(`one-${index}`, `batch-${index}`, "candy", "completed", `2026-11-17T09:0${4 - index}:00Z`),
    record(`two-${index}`, `batch-${index}`, "candy", "completed", `2026-11-17T09:0${4 - index}:00Z`, "two")]).flat();
  const runs = [...current, running, ...finished];
  const ui = await uiHarness({ bootstrap: bootstrap(runs), detail: async id => runs.find(run => run.id === id), search: "?view=candy" });
  const queue = () => childrenWith(ui, "running-batch-list", "running-batch");
  await waitFor(() => ui.elements.get("candy-tab").getAttribute("aria-selected") === "true");
  assert.deepEqual(queue().map(entry => entry.dataset.batchId), ["new-batch", "older-batch"]);
  const recent = () => childrenWith(ui, "candy-recent", "recent-batch");
  assert.deepEqual(recent().map(entry => entry.dataset.batchId), ["batch-0", "batch-1", "batch-2"]);
  assert.deepEqual(recent()[0].children[1].children.map(card => card.dataset.runId), ["two-0", "one-0"]);
  ui.event("run", { run: { ...running, status: "completed" } });
  await waitFor(() => recent()[0].dataset.batchId === "older-batch");
  assert.deepEqual(queue().map(entry => entry.dataset.batchId), ["new-batch"]);
  assert.equal(recent().length, 3);
});
