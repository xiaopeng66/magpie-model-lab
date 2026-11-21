import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { uiHarness } from "./ui-harness.mjs";
import { waitFor } from "./helpers.mjs";

const batchId = randomUUID();
const record = (model, status, verdict = "match") => ({ id: randomUUID(), batchId, model: `fixture/${model}`, modelName: model, provider: "fixture", providerName: "Fixture",
  kind: "candy", createdAt: "2026-11-20T01:00:00Z", status, prompt: "历史糖果题面", effort: "high", maxTokens: 345, concurrency: 3,
  candy: { version: "shape-choice-v1", expected: 21, answer: verdict === "mismatch" ? 20 : 21, verdict } });
const boot = runs => ({ models: runs.map(run => ({ id: run.model, name: run.modelName, provider: "fixture", efforts: ["low", "high"] })), runs,
  defaultPrompt: "默认题面", candyAvailable: true, retestAvailable: true, historyTimeZone: "UTC" });
const control = (ui, id, label) => ui.descendants(ui.elements.get(id), "button").find(item => item.textContent === label);
const preview = sources => ({ items: sources.map(run => ({ id: run.id, run, kind: run.kind, available: run.status !== "running", reason: run.status === "running" ? "原测试尚未结束" : "",
  abnormal: ["error", "invalid", "truncated", "interrupted"].includes(run.status), conditions: { kind: run.kind, prompt: run.prompt, effort: run.effort, maxTokens: run.maxTokens, concurrency: run.concurrency } })) });

test("manual retest selects originals, skips cancelled defaults and can choose only anomalies", async () => {
  const sources = [record("one", "completed", "mismatch"), record("two", "error"), record("three", "cancelled"), record("four", "running")];
  const calls = []; let release;
  const ui = await uiHarness({ bootstrap: boot(sources), detail: id => sources.find(run => run.id === id), search: "?view=candy", retests: async (path, body) => {
    calls.push({ path, body });
    if (path.endsWith("preview")) return preview(sources);
    await new Promise(resolve => { release = resolve; });
    return { batchId: "new-batch", runs: [{ ...sources[1], id: "new-run", batchId: "new-batch", source: "manual", status: "queued", retest: { sourceRunId: sources[1].id, sourceTime: sources[1].createdAt } }] };
  } });
  await waitFor(() => ui.descendants(ui.elements.get("candy-results"), "article").length === 4);
  const host = ui.elements.get("candy-batch-actions"); assert.ok(host, "Manual batches need an original-condition retest entry");
  const opener = control(ui, "candy-batch-actions", "原条件复测"); assert.ok(opener);
  ui.elements.get("prompt").value = "尚未提交的草稿"; ui.elements.get("max-tokens").value = "987";
  await opener.fire("click");
  const inputs = ui.descendants(ui.elements.get("drawer-content"), "input").filter(item => item.type === "checkbox");
  assert.deepEqual(inputs.map(input => input.checked), [true, true, false, false]); assert.equal(inputs[3].disabled, true);
  assert.equal(calls.length, 1, "Opening the drawer must only preview");
  assert.equal(ui.descendants(ui.elements.get("drawer-content"), "textarea").length, 0, "Original conditions stay read-only");
  await control(ui, "drawer-content", "全部可复测").fire("click");
  assert.deepEqual(inputs.map(input => input.checked), [true, true, true, false], "An explicit all selection can include eligible cancelled records");
  await control(ui, "drawer-content", "仅选异常").fire("click");
  assert.deepEqual(inputs.map(input => input.checked), [false, true, false, false]);
  const start = ui.descendants(ui.elements.get("drawer-footer"), "button").find(item => item.textContent.startsWith("开始复测"));
  const first = start.fire("click"); await waitFor(() => release); await start.fire("click");
  assert.equal(calls.length, 2); assert.deepEqual(calls[1].body.runIds, [sources[1].id]); assert.ok(calls[1].body.operationId);
  release(); await first;
  assert.equal(ui.elements.get("favorite-drawer").hidden, true); assert.equal(ui.elements.get("candy-panel").hidden, false);
  assert.equal(ui.elements.get("prompt").value, "尚未提交的草稿"); assert.equal(ui.elements.get("max-tokens").value, "987");
  assert.ok(ui.descendants(ui.elements.get("candy-results"), "article").some(card => card.dataset.runId === "new-run"));
});

test("automatic history retest entry targets only the selected model and time", async () => {
  const sources = [record("one", "completed"), record("one", "completed")];
  sources.forEach((run, index) => { run.source = "automatic"; run.batchId = randomUUID(); run.scheduledAt = `2026-11-20T0${index + 1}:00:00Z`; });
  const calls = [];
  const ui = await uiHarness({ bootstrap: boot(sources), detail: id => sources.find(run => run.id === id), search: "?view=history", retests: async (path, body) => { calls.push({ path, body }); return preview(sources.filter(run => body.runIds.includes(run.id))); } });
  const row = await waitFor(() => ui.descendants(ui.elements.get("history-list"), "button").find(item => item.className === "history-row"));
  await row.fire("click");
  const bar = ui.descendants(ui.elements.get("history-results"), "button").find(item => item.title.includes("02:00")); await bar.fire("click");
  const detail = ui.descendants(ui.elements.get("history-results"), "button").find(item => item.textContent === "查看详情"); await detail.fire("click");
  const retest = control(ui, "drawer-footer", "复测此条"); assert.ok(retest, "Selected automatic results need a single-record retest entry");
  await retest.fire("click"); assert.deepEqual(calls[0].body.runIds, [sources[1].id]);
});

test("a retest response arriving after the drawer closes preserves the user's current page", async () => {
  const source = record("one", "completed"); let release;
  const ui = await uiHarness({ bootstrap: boot([source]), detail: () => source, search: "?view=candy", retests: async path => {
    if (path.endsWith("preview")) return preview([source]);
    await new Promise(resolve => { release = resolve; });
    return { batchId: "late-batch", runs: [{ ...source, id: "late-run", batchId: "late-batch", source: "manual", status: "queued",
      retest: { sourceRunId: source.id, sourceTime: source.createdAt } }] };
  } });
  await waitFor(() => control(ui, "candy-batch-actions", "原条件复测"));
  await control(ui, "candy-batch-actions", "原条件复测").fire("click");
  const start = ui.descendants(ui.elements.get("drawer-footer"), "button").find(item => item.textContent.startsWith("开始复测"));
  const completion = start.fire("click"); await waitFor(() => release);
  await ui.elements.get("drawer-close").fire("click");
  await ui.elements.get("history-tab").fire("click");
  release(); await completion;
  assert.equal(ui.elements.get("favorite-drawer").hidden, true);
  assert.equal(ui.elements.get("history-panel").hidden, false);
  assert.equal(ui.elements.get("candy-panel").hidden, true);
  assert.ok(ui.descendants(ui.elements.get("history-list"), "div").some(row => row.dataset.batchId === "late-batch"));
});

test("batch retest entries stay disabled while an earlier retest is still being created", async () => {
  const source = record("one", "completed"); let release;
  const ui = await uiHarness({ bootstrap: boot([source]), detail: () => source, search: "?view=candy", retests: async path => {
    if (path.endsWith("preview")) return preview([source]);
    await new Promise(resolve => { release = resolve; });
    return { batchId: "pending-batch", runs: [{ ...source, id: "pending-run", batchId: "pending-batch", source: "manual", status: "queued" }] };
  } });
  const opener = await waitFor(() => control(ui, "candy-batch-actions", "原条件复测"));
  await opener.fire("click");
  const start = ui.descendants(ui.elements.get("drawer-footer"), "button").find(item => item.textContent.startsWith("开始复测"));
  const completion = start.fire("click"); await waitFor(() => release);
  await ui.elements.get("drawer-close").fire("click");
  assert.equal(opener.disabled, true, "An entry that cannot accept a click must not look available");
  release(); await completion;
  assert.equal(opener.disabled, false);
});

test("a different result's retest button recovers when a pending creation finishes", async () => {
  const sources = [record("one", "completed"), record("two", "completed")]; let release;
  const ui = await uiHarness({ bootstrap: boot(sources), detail: id => sources.find(run => run.id === id), search: "?view=candy", retests: async path => {
    if (path.endsWith("preview")) return preview(sources);
    await new Promise(resolve => { release = resolve; });
    return { batchId: "pending-batch", runs: [{ ...sources[0], id: "pending-run", batchId: "pending-batch", source: "manual", status: "queued" }] };
  } });
  await waitFor(() => control(ui, "candy-batch-actions", "原条件复测"));
  await control(ui, "candy-batch-actions", "原条件复测").fire("click");
  const start = ui.descendants(ui.elements.get("drawer-footer"), "button").find(item => item.textContent.startsWith("开始复测"));
  const completion = start.fire("click"); await waitFor(() => release);
  await ui.elements.get("drawer-close").fire("click");
  const other = ui.descendants(ui.elements.get("candy-results"), "article").find(card => card.dataset.runId === sources[1].id);
  await ui.descendants(other, "button").find(button => button.textContent === "查看详情").fire("click");
  const retest = control(ui, "drawer-footer", "复测此条"); assert.equal(retest.disabled, true);
  release(); await completion;
  assert.equal(ui.elements.get("favorite-drawer").hidden, false);
  assert.equal(retest.disabled, false, "A completed record must become available again without reopening its details");
});

test("a saved automatic candy source link restores the selected model and time on reload", async () => {
  const sources = [record("one", "completed"), record("one", "completed"), record("two", "completed")];
  sources.forEach((run, index) => { run.source = "automatic"; run.batchId = randomUUID(); run.scheduledAt = `2026-11-20T0${index ? 2 : 1}:00:00Z`; });
  const ui = await uiHarness({ bootstrap: boot(sources), detail: id => sources.find(run => run.id === id), search: `?view=history&history=${sources[1].id}` });
  await waitFor(() => ui.elements.get("history-panel").hidden === false && ui.elements.get("history-detail").hidden === false);
  const selected = ui.descendants(ui.elements.get("history-results"), "button").filter(item => item.className === "candy-bar" && item.getAttribute("aria-pressed") === "true");
  assert.equal(selected.length, 1);
  assert.match(selected[0].title, /^one · 02:00/);
  assert.deepEqual(ui.descendants(ui.elements.get("history-results"), "article").filter(card => card.dataset.runId).map(card => card.dataset.runId), [sources[1].id]);
});

test("following an automatic candy source selects its exact model and original time", async () => {
  const sources = [record("one", "completed"), record("one", "completed"), record("two", "completed")];
  sources.forEach((run, index) => { run.source = "automatic"; run.batchId = randomUUID(); run.scheduledAt = `2026-11-20T0${index ? 2 : 1}:00:00Z`; });
  const retested = { ...record("one", "completed"), createdAt: "2026-11-20T03:00:00Z", source: "manual",
    retest: { sourceRunId: sources[1].id, sourceTime: sources[1].scheduledAt, sourceMode: "automatic" } };
  const runs = [...sources, retested];
  const ui = await uiHarness({ bootstrap: boot(runs), detail: id => runs.find(run => run.id === id), search: "?view=candy" });
  const source = await waitFor(() => control(ui, "candy-batch-source", "查看原记录"));
  await source.fire("click");
  assert.equal(ui.elements.get("history-panel").hidden, false);
  assert.equal(ui.elements.get("history-filter").value, "candy");
  assert.equal(ui.elements.get("history-source").value, "automatic");
  const selected = ui.descendants(ui.elements.get("history-results"), "button").filter(item => item.className === "candy-bar" && item.getAttribute("aria-pressed") === "true");
  assert.equal(selected.length, 1); assert.match(selected[0].title, /^one · 02:00/);
  const cards = ui.descendants(ui.elements.get("history-results"), "article").filter(item => item.dataset.runId);
  assert.deepEqual(cards.map(card => card.dataset.runId), [sources[1].id]);
  assert.equal(ui.document.activeElement, cards[0]);
});

test("following an older automatic animation source reveals its slot and focuses the card", async () => {
  const sources = [record("one", "completed"), record("one", "completed")];
  sources.forEach((run, index) => { run.kind = "pelican"; run.source = "automatic"; run.batchId = randomUUID(); run.scheduledAt = `2026-11-20T0${index + 1}:00:00Z`; });
  const retested = { ...record("one", "completed"), kind: "pelican", createdAt: "2026-11-20T03:00:00Z", source: "manual",
    retest: { sourceRunId: sources[0].id, sourceTime: sources[0].scheduledAt, sourceMode: "automatic" } };
  const runs = [...sources, retested];
  const ui = await uiHarness({ bootstrap: boot(runs), detail: id => runs.find(run => run.id === id), search: "?view=history" });
  const daily = await waitFor(() => ui.descendants(ui.elements.get("history-list"), "button").find(item => item.className === "history-row" && item.getAttribute("aria-label").includes("每日")));
  await daily.fire("click");
  const original = ui.descendants(ui.elements.get("history-results"), "article").find(card => card.dataset.runId === sources[0].id);
  const slot = original.parentElement.parentElement, lane = slot.parentElement;
  slot.rect = { left: 420, top: 0 }; lane.rect = { left: 20, top: 0 }; lane.scrollLeft = 0;
  await ui.elements.get("current-tab").fire("click");
  const source = await waitFor(() => control(ui, "current-batch-source", "查看原记录"));
  await source.fire("click");
  assert.equal(lane.scrollLeft, 392);
  assert.equal(ui.document.activeElement, original);
  assert.equal(ui.elements.get("history-source").value, "automatic");
});
