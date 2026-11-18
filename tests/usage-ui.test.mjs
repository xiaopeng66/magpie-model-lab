import test from "node:test";
import assert from "node:assert/strict";
import { uiHarness } from "./ui-harness.mjs";
import { waitFor } from "./helpers.mjs";

const model = { id: "fixture/one", name: "Fixture", provider: "fixture", providerName: "Supplier", efforts: [] };
const runs = ["pelican", "fingerprint", "candy"].map((kind, index) => ({ id: "run-" + index, batchId: "batch-" + index, kind, model: model.id, modelName: model.name,
  createdAt: "2026-11-14T01:00:00Z", status: "running", contentChars: 12, reasoningChars: 34,
  fingerprint: kind === "fingerprint" ? { completed: 0, valid: 0, samples: [125, 80, 0].map(count => ({ state: count ? "streaming" : "queued", count, expectedCount: 300 })) } : undefined }));
const boot = { models: [model], runs, defaultPrompt: "animate", dataDir: "test", fingerprintAvailable: true, candyAvailable: true, favoritesAvailable: true,
  favorites: { favorites: [], plans: [], enabled: false, concurrency: 3 } };
const area = { pelican: "results", fingerprint: "fingerprint-results", candy: "candy-results" };
const row = (ui, container) => ui.descendants(ui.elements.get(container)).find(item => item.className === "usage-strip");
const values = (ui, root) => {
  const unit = ui.descendants(root).find(item => item.className === "usage-unit" && !item.hidden);
  return ui.descendants(root).filter(item => item.className === "usage-value").map(item => unit && /^≥?[\d,.]/.test(item.textContent) && !item.textContent.endsWith(" 字") ? `${item.textContent} ${unit.textContent}` : item.textContent);
};

test("three test cards show both progress channels and retain reported tokens in history", async () => {
  const details = new Map(runs.map(run => [run.id, run]));
  const ui = await uiHarness({ bootstrap: boot, detail: id => ({ ...details.get(id) }) });
  await waitFor(() => ui.descendants(ui.elements.get("candy-results"), "article").length);
  for (const run of runs) {
    const strip = row(ui, area[run.kind]); assert.ok(strip, `${run.kind} must show usage outside collapsed details`);
    assert.deepEqual(values(ui, strip), ["34 字", "12 字"]);
    const ended = { ...run, status: "cancelled", tokens: { reasoning: 0, output: 120, total: 160, partial: [] } }; details.set(run.id, ended);
    ui.event("run", { run: ended });
  }
  await new Promise(resolve => setTimeout(resolve, 20));
  for (const run of runs) {
    assert.deepEqual(values(ui, row(ui, area[run.kind])), ["0 Token", "120 Token"]);
    const history = ui.descendants(ui.elements.get("history-list"), "button").find(item => item.className === "history-row" && item.parent.dataset.batchId === run.batchId);
    assert.ok(history); await history.fire("click");
    assert.deepEqual(values(ui, row(ui, "history-results")), ["0 Token", "120 Token"]);
  }
});

test("fingerprint card exposes each sample count without hovering and updates it in place", async () => {
  const ui = await uiHarness({ bootstrap: boot });
  await waitFor(() => ui.descendants(ui.elements.get("fingerprint-results"), "article").length);
  const dots = ui.descendants(ui.elements.get("fingerprint-results")).filter(item => item.className === "sample-dot");
  assert.deepEqual(dots.map(dot => dot.textContent), ["125/300", "80/300", "0/300"]);
  ui.event("run", { run: { ...runs[1], fingerprint: { ...runs[1].fingerprint, samples: [{ state: "complete", count: 300, expectedCount: 300 }, ...runs[1].fingerprint.samples.slice(1)] } } });
  await waitFor(() => dots[0].textContent === "300/300");
  assert.equal(dots[0].dataset.state, "complete");
});

test("candy stream refreshes both counts and usage-only metadata without rebuilding the card", async () => {
  const ui = await uiHarness({ bootstrap: boot });
  await waitFor(() => ui.descendants(ui.elements.get("candy-results"), "article").length);
  const card = ui.descendants(ui.elements.get("candy-results"), "article")[0], strip = row(ui, "candy-results"); assert.ok(strip);
  const progress = ui.descendants(card).find(item => item.className === "progress-line");
  assert.ok(progress, "Candy generation uses the same progress indicator as animation generation");
  assert.equal(progress.hidden, false); assert.equal(progress.parent.hidden, false);
  for (let i = 1; i <= 50; i++) ui.event("delta", { id: runs[2].id, content: "a", reasoning: "b", contentChars: 12 + i, reasoningChars: 34 + i });
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(ui.pendingFrames(), 1); ui.flushFrames();
  assert.deepEqual(values(ui, strip), ["84 字", "62 字"]);
  ui.event("delta", { id: runs[2].id, usageRevision: 1, tokens: { reasoning: 25, output: 60, total: 100, partial: [] }, usage: { completion_tokens: 60 } });
  await new Promise(resolve => setTimeout(resolve, 20)); ui.flushFrames();
  assert.deepEqual(values(ui, strip), ["25 Token", "60 Token"]); assert.equal(ui.descendants(ui.elements.get("candy-results"), "article")[0], card);
  assert.equal(ui.descendants(card).find(item => item.className === "progress-line"), progress, "Streaming updates must not restart the loading animation");
});

test("candy queue and generation indicators clear for completed and failed results in current and history views", async () => {
  for (const status of ["completed", "error"]) {
    const run = { ...runs[2], status: "queued" };
    const ui = await uiHarness({ bootstrap: { ...boot, runs: [run] } });
    await waitFor(() => ui.descendants(ui.elements.get("candy-results"), "article").length);
    const card = ui.descendants(ui.elements.get("candy-results"), "article")[0];
    const answer = ui.descendants(card).find(item => item.className === "candy-answer");
    const progress = ui.descendants(card).find(item => item.className === "progress-line");
    assert.ok(progress); assert.equal(progress.hidden, true); assert.equal(answer.hidden, true);
    assert.equal(progress.parent.hidden, false);
    assert.ok(ui.descendants(progress.parent).some(item => item.textContent === "排队中"));
    ui.event("run", { run: { ...run, status: "running" } });
    await waitFor(() => progress.hidden === false);
    assert.ok(ui.descendants(progress.parent).some(item => item.textContent === "生成中"));
    ui.event("run", { run: { ...run, status, candy: status === "completed" ? { answer: 21, verdict: "match" } : undefined } });
    await waitFor(() => progress.parent.hidden === true);
    assert.equal(answer.hidden, false); assert.equal(answer.textContent, status === "completed" ? "21" : "—");
    const history = ui.descendants(ui.elements.get("history-list"), "button").find(item => item.className === "history-row");
    await history.fire("click");
    const historyProgress = ui.descendants(ui.elements.get("history-results")).find(item => item.className === "progress-line");
    assert.equal(historyProgress.parent.hidden, true);
    assert.ok(ui.descendants(ui.elements.get("history-results")).some(item => item.textContent === (status === "completed" ? "答案匹配" : "请求失败")));
  }
});

test("favorite candy progress updates in place while the record drawer uses the same usage row", async () => {
  const favorite = { id: "fav", modelId: model.id, modelName: model.name, provider: model.provider, available: true, compareKeys: { candy: "same" } };
  const run = { ...runs[2], favoriteId: "fav", compareKey: "same", plans: [{ id: "plan", triggerKey: "slot" }] };
  const plan = { id: "plan", revision: 1, favoriteIds: ["fav"], kinds: ["candy"], times: ["09:00"], mode: "times", days: [1], timeZone: "UTC", enabled: true,
    today: { date: "2026-11-14", slots: [{ key: "slot", label: "09:00", state: "started" }] } };
  const ui = await uiHarness({ bootstrap: { ...boot, runs: [run], favorites: { ...boot.favorites, favorites: [favorite], plans: [plan] } }, detail: () => ({ ...run, content: "答案", tokens: { reasoning: 40, output: 60, total: 100, partial: [] } }) });
  await waitFor(() => ui.descendants(ui.elements.get("candy-results"), "article").length); await ui.elements.get("favorites-tab").fire("click");
  const container = "favorite-candy-grid", strip = row(ui, container); assert.ok(strip);
  const bar = ui.descendants(ui.elements.get(container), "button").find(item => item.className === "candy-bar"); bar.focus();
  ui.event("delta", { id: run.id, reasoning: "more", reasoningChars: 38, contentChars: 12 });
  await new Promise(resolve => setTimeout(resolve, 20)); ui.flushFrames();
  assert.deepEqual(values(ui, strip), ["38 字", "12 字"]);
  assert.equal(ui.descendants(ui.elements.get(container), "button").find(item => item.className === "candy-bar"), bar); assert.ok(bar.focused);
  await bar.fire("click"); assert.deepEqual(values(ui, row(ui, "drawer-content")), ["40 Token", "60 Token"]);
});

test("a delayed detail snapshot cannot replace more recent usage-only updates", async () => {
  let release;
  const ui = await uiHarness({ bootstrap: boot, detail: () => new Promise(resolve => { release = resolve; }) });
  await waitFor(() => ui.descendants(ui.elements.get("candy-results"), "article").length);
  await ui.descendants(ui.elements.get("candy-results"), "button").find(button => button.attributes["aria-label"] === "糖果详情").fire("click");
  await waitFor(() => release);
  ui.event("delta", { id: runs[2].id, usageRevision: 2, tokens: { reasoning: 20, output: 60, total: 100, partial: [] }, usage: { completion_tokens: 60 } });
  await new Promise(resolve => setTimeout(resolve, 20)); ui.flushFrames();
  release({ ...runs[2], content: "", usageRevision: 1, tokens: { reasoning: 10, output: 30, total: 70, partial: [] }, usage: { completion_tokens: 30 } });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(values(ui, row(ui, "candy-results")), ["20 Token", "60 Token"]);
});

test("missing token counts stay distinct from zero and partial fingerprint totals are marked", async () => {
  const partial = { ...runs[1], tokens: { reasoning: 0, output: 400, total: 420, partial: ["reasoning", "output", "total"] } };
  const unknown = { ...runs[2], status: "cancelled", reasoningChars: 0, contentChars: 0 };
  const ui = await uiHarness({ bootstrap: { ...boot, runs: [partial, unknown] } });
  await waitFor(() => row(ui, "candy-results"));
  assert.deepEqual(values(ui, row(ui, "candy-results")), ["—", "—"]);
  assert.deepEqual(values(ui, row(ui, "fingerprint-results")), ["≥0 Token", "≥400 Token"]);
  const output = row(ui, "fingerprint-results").children[1];
  assert.match(output.title, /仅汇总已返回/); assert.match(output.title, /可能包含思考/);
});
