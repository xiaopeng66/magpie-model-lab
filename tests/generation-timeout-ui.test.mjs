import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { uiHarness } from "./ui-harness.mjs";
import { waitFor } from "./helpers.mjs";

const model = { id: "fixture/one", name: "Fixture", provider: "fixture", providerName: "Fixture", efforts: [] };
const favorite = { id: randomUUID(), modelId: model.id, modelName: model.name, provider: model.provider, effort: "", maxTokens: 64000,
  timeoutMs: 1200000, prompt: "animate", available: true, compareKeys: {}, concurrency: { candy: 3, pelican: 2 } };
const boot = () => ({ models: [model], runs: [], defaultPrompt: "animate", dataDir: "fixture", version: "test", candyAvailable: true,
  fingerprintAvailable: true, fingerprint: { state: "ready", meta: {} }, favoritesAvailable: true,
  favorites: { favorites: [favorite], plans: [], enabled: true, concurrency: 3 } });
async function select(ui) {
  await waitFor(() => ui.descendants(ui.elements.get("model-list"), "input").length === 1);
  const pick = ui.descendants(ui.elements.get("model-list"), "input")[0]; pick.checked = true; await pick.fire("change");
}

test("generation timeout field sits beside token settings and sends seconds as milliseconds in all modes", async () => {
  const requests = [], ui = await uiHarness({ bootstrap: boot(), create: body => {
    requests.push(body); const id = randomUUID(); return { runs: [{ id, batchId: id, model: model.id, kind: body.kind || "pelican", createdAt: new Date().toISOString(), status: "queued" }] };
  } });
  await select(ui);
  const timeout = ui.elements.get("generation-timeout"); assert.ok(timeout, "Generation timeout control is missing");
  assert.equal(timeout.value, "600");
  const html = await readFile(new URL("../ui/index.html", import.meta.url), "utf8");
  assert.ok(html.indexOf('id="generation-timeout"') > html.indexOf('id="max-tokens"'));
  assert.ok(html.indexOf('id="generation-timeout"') < html.indexOf('id="concurrency"'));
  for (const [tab, value] of [["current-tab", "1200"], ["candy-tab", "0"], ["fingerprint-tab", "1800"]]) {
    await ui.elements.get(tab).fire("click"); timeout.value = value; await timeout.fire("input"); await ui.elements.get("generate").fire("click");
  }
  assert.deepEqual(requests.map(body => body.timeoutMs), [1200000, 0, 1800000]);
});

test("invalid generation timeout is identified and focused without sending a request", async () => {
  let requests = 0; const ui = await uiHarness({ bootstrap: boot(), create: () => { requests++; return { runs: [] }; } });
  await select(ui);
  const timeout = ui.elements.get("generation-timeout"); assert.ok(timeout, "Generation timeout control is missing");
  for (const value of ["", "-1", "0.0005", "2147483.648", "2147484"]) {
    timeout.value = value; await timeout.fire("input"); await ui.elements.get("generate").fire("click");
    assert.equal(timeout.getAttribute("aria-invalid"), "true"); assert.equal(ui.document.activeElement, timeout);
  }
  assert.equal(requests, 0);
});

test("automatic plan editor restores timeout and saves zero with model parameters", async () => {
  const calls = [], ui = await uiHarness({ bootstrap: boot(), favorites: (path, body) => { calls.push({ path, body }); return boot().favorites; } });
  await select(ui); await ui.elements.get("favorites-tab").fire("click");
  const settings = ui.descendants(ui.elements.get("favorite-candy-grid"), "button").find(button => button.getAttribute("aria-label") === "设置 Fixture 的糖果计划");
  assert.ok(settings); await settings.fire("click");
  const row = ui.descendants(ui.elements.get("drawer-content"), "label").find(label => label.children.some(child => child.textContent === "生成超时 · 秒"));
  const timeout = row && ui.descendants(row, "input")[0];
  assert.ok(timeout, "Plan editor is missing its generation timeout field"); assert.equal(timeout.value, "1200");
  timeout.value = "0"; await timeout.fire("input");
  const save = ui.descendants(ui.elements.get("drawer-footer"), "button").find(button => button.textContent.includes("保存"));
  assert.ok(save); await save.fire("click");
  assert.equal(calls.find(call => call.path === "api/schedules/save")?.body.parameters.timeoutMs, 0);
});
