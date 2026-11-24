import test from "node:test";
import assert from "node:assert/strict";
import { uiHarness, confirmClick } from "./ui-harness.mjs";
import { waitFor } from "./helpers.mjs";
import { parameterDefaults } from "../lib/test-parameters.mjs";

test("permanent and paused policies are displayed without falling back to seven days", async () => {
  for (const paused of [false, true]) {
    const ui = await uiHarness({ bootstrap: { version: "retention-fixture", models: [], runs: [], defaultPrompt: "test", retentionDays: null, cleanupPaused: paused } });
    await waitFor(() => ui.elements.get("version").textContent === "retention-fixture");
    assert.equal(ui.elements.get("retention-note").textContent, paused ? "清理已暂停" : "永久保留");
  }
});
test("retention drawer previews shortening and saves only after explicit confirmation", async () => {
  const state = { revision: 0, manual: Object.fromEntries(["pelican", "candy", "fingerprint"].map(k => [k, parameterDefaults(k, "test")])), retention: { days: 30 }, progressNotice: { enabled: true }, presets: [] };
  const calls = []; const ui = await uiHarness({ bootstrap: { models: [], runs: [], defaultPrompt: "test", settings: state, settingsCapabilities: { memory: true, retention: true } }, retention: async (_path, options) => { calls.push(["preview", JSON.parse(options.body)]); return { days: 7, candidateCount: 2, skippedActive: 1, skippedProtected: 1, estimatedMetadataBytes: 100, measuredFileBytes: 500, previewToken: "fixture-token" }; }, settings: async (_path, options) => { const body = JSON.parse(options.body); calls.push(["save", body]); state.revision++; state.retention = body.patch.retention; return { revision: state.revision, changed: { retention: state.retention } }; } });
  await waitFor(() => !ui.elements.get("history-retention").disabled); await ui.elements.get("history-retention").fire("click");
  const controls = () => ui.descendants(ui.elements.get("drawer-content"));
  const days = controls().find(e => e.getAttribute("aria-label") === "保留策略"); days.value = "7"; await days.fire("change");
  await controls().find(e => e.textContent === "预览影响").fire("click"); assert.equal(calls.length, 1);
  const save = controls().find(e => e.textContent === "保存保留策略"); const { completion } = await confirmClick(ui, save); await completion;
  assert.equal(calls[1][1].previewToken, "fixture-token"); assert.equal(calls[1][1].patch.retention.days, 7);
});
