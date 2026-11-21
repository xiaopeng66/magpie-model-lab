import test from "node:test";
import assert from "node:assert/strict";
import { uiHarness } from "./ui-harness.mjs";
import { waitFor } from "./helpers.mjs";
import { summary } from "../lib/result.mjs";
import { abnormalRetest } from "../lib/retest.mjs";

const record = (id, fields = {}) => ({ id, batchId: "batch", kind: "candy", model: "fixture/one", modelName: "one", provider: "fixture", providerName: "Fixture",
  createdAt: "2026-11-20T01:00:00Z", status: "completed", effort: "", maxTokens: 1200, concurrency: 3, prompt: "原题面 A", content: "最终答案：21",
  candy: { version: "shape-choice-v1", expected: 21, answer: 21, verdict: "match" }, ...fields });
const boot = runs => ({ runs: runs.map(summary), models: ["one", "two"].map(name => ({ id: `fixture/${name}`, name, provider: "fixture", efforts: [] })),
  candyAvailable: true, retestAvailable: true, defaultPrompt: "默认题面", historyTimeZone: "UTC" });
const elementsWith = (ui, host, name) => ui.descendants(host).filter(element => element.className.split(/\s+/).includes(name));
const controls = (ui, host) => ui.descendants(host, "button");
const openCard = async (ui, id, host = "candy-results") => {
  const card = await waitFor(() => ui.descendants(ui.elements.get(host), "article").find(element => element.dataset.runId === id));
  await controls(ui, card).find(button => button.textContent === "查看详情").fire("click");
  return card;
};

test("failed candy cards and detail explain the timeout and preserve the original-condition retest entry", async () => {
  const source = record("timeout", { status: "error", error: "生成超时，已终止上游请求", candy: { version: "shape-choice-v1", expected: 21, verdict: "incomplete", answer: null } });
  const ui = await uiHarness({ bootstrap: boot([source]), detail: () => ({ ...source, ...summary(source) }), search: "?view=candy" });
  const card = await openCard(ui, source.id);
  assert.ok(ui.descendants(card).some(element => /超时/.test(element.textContent)), "The card must distinguish timeout from a generic error");
  const diagnosis = elementsWith(ui, ui.elements.get("drawer-content"), "result-diagnosis")[0];
  assert.ok(diagnosis, "Result detail needs a specific cause and a recovery explanation");
  assert.equal(diagnosis.hidden, false); assert.equal(diagnosis.dataset.cause, "timeout");
  assert.ok(elementsWith(ui, diagnosis, "diagnosis-advice")[0].textContent.length > 5);
  assert.ok(controls(ui, ui.elements.get("drawer-footer")).some(button => button.textContent === "复测此条"));
  assert.ok(ui.descendants(ui.elements.get("drawer-content")).some(element => element.textContent === source.error), "The original error remains available");
});

test("the collapsed detail trend only includes matching conditions and can open a specific original history record", async () => {
  const sources = [record("current", { createdAt: "2026-11-20T03:00:00Z", elapsedMs: 1000, usage: { total_tokens: 100 } }),
    record("previous", { batchId: "old-batch", createdAt: "2026-11-20T02:00:00Z", elapsedMs: 2000, usage: { total_tokens: 200 } }),
    record("wrong", { batchId: "wrong-batch", createdAt: "2026-11-20T01:00:00Z", elapsedMs: 3000, usage: { total_tokens: 300 },
      candy: { version: "shape-choice-v1", expected: 21, verdict: "mismatch", answer: 20 } }),
    record("different", { batchId: "different-batch", createdAt: "2026-11-20T00:00:00Z", maxTokens: 0 })];
  const ui = await uiHarness({ bootstrap: boot(sources), detail: id => { const run = sources.find(item => item.id === id); return { ...run, ...summary(run) }; }, search: "?view=candy" });
  await openCard(ui, "current");
  const trend = elementsWith(ui, ui.elements.get("drawer-content"), "result-trend")[0];
  assert.ok(trend, "Same-model recent evidence needs a disclosure in the result detail");
  assert.equal(trend.open, false); trend.open = true;
  assert.equal(elementsWith(ui, trend, "trend-rate")[0].textContent, "67%");
  assert.match(elementsWith(ui, trend, "trend-note")[0].textContent, /可判定 3 条（含不匹配）/,
    "A parsed wrong answer belongs to the numerical denominator; make that distinction explicit");
  const points = elementsWith(ui, trend, "trend-point");
  assert.deepEqual(points.map(point => point.dataset.runId), ["wrong", "previous", "current"]);
  ui.event("removed", { ids: ["wrong"] });
  await waitFor(() => elementsWith(ui, trend, "trend-rate")[0].textContent === "100%");
  assert.equal(trend.open, true, "Refreshing evidence must preserve the user's disclosure state");
  const previous = elementsWith(ui, trend, "trend-point").find(point => point.dataset.runId === "previous");
  await previous.fire("click");
  assert.equal(ui.elements.get("history-tab").getAttribute("aria-selected"), "true");
  assert.equal(ui.elements.get("history-filter").value, "candy"); assert.equal(ui.elements.get("history-source").value, "manual");
  assert.equal(ui.elements.get("favorite-drawer").hidden, true);
});

test("choosing a failure category only submits those eligible original records after explicit start", async () => {
  const sources = [record("timeout", { status: "error", error: "生成超时" }), record("limited", { status: "error", error: "生成失败（HTTP 429）：Too many requests" }),
    record("ok"), record("unavailable", { status: "error", error: "生成超时" })];
  const requests = [];
  const ui = await uiHarness({ bootstrap: boot(sources), detail: id => sources.find(run => run.id === id), search: "?view=candy", retests: async (path, body) => {
    requests.push({ path, body });
    if (path.endsWith("preview")) return { items: sources.map(run => ({ id: run.id, kind: run.kind, run: summary(run), abnormal: abnormalRetest(run),
      available: run.id !== "unavailable", reason: run.id === "unavailable" ? "原模型不可用" : "", conditions: { kind: run.kind, prompt: run.prompt, maxTokens: run.maxTokens, concurrency: run.concurrency, effort: run.effort } })) };
    return { batchId: "new-batch", runs: [summary(record("new", { batchId: "new-batch", status: "queued" }))] };
  } });
  const opener = await waitFor(() => controls(ui, ui.elements.get("candy-batch-actions")).find(button => button.textContent === "原条件复测"));
  await opener.fire("click");
  const choices = elementsWith(ui, ui.elements.get("drawer-content"), "retest-causes")[0];
  assert.ok(choices, "Retest needs selection by the actual failure cause");
  const timeout = controls(ui, choices).find(button => button.dataset.cause === "timeout");
  assert.ok(timeout); await timeout.fire("click");
  const checkboxes = ui.descendants(ui.elements.get("drawer-content"), "input");
  assert.deepEqual(checkboxes.map(input => input.checked), [true, false, false, false]);
  assert.equal(requests.length, 1, "Selecting a cause must not trigger generation");
  const start = controls(ui, ui.elements.get("drawer-footer")).find(button => button.textContent.startsWith("开始复测"));
  await start.fire("click"); assert.deepEqual(requests[1].body.runIds, ["timeout"]);
});

test("animation preview diagnosis remains visible while switching to the saved source or output", async () => {
  const source = record("animation", { kind: "pelican", candy: undefined, html: "<!doctype html><html><body>saved animation</body></html>" });
  const ui = await uiHarness({ bootstrap: boot([source]), detail: () => ({ ...source, ...summary(source), previewUrl: "preview/animation?key=fixture" }) });
  const card = await waitFor(() => ui.descendants(ui.elements.get("results"), "article").find(element => element.dataset.runId === source.id));
  const opener = controls(ui, card).find(button => button.getAttribute("aria-label") === "源码与详情");
  await opener.fire("click");
  const panel = ui.elements.get("drawer-content"), frame = await waitFor(() => ui.descendants(panel, "iframe")[0]);
  ui.message({ source: frame.contentWindow, data: { type: "pelican-preview", id: source.id, kind: "error", message: "fixture script failed" } });
  const diagnosis = elementsWith(ui, panel, "result-diagnosis")[0];
  assert.equal(diagnosis.hidden, false); assert.equal(diagnosis.dataset.cause, "preview");
  for (const name of ["HTML 源码", "原始输出", "动画预览"]) {
    await controls(ui, panel).find(button => button.textContent === name).fire("click");
    assert.equal(diagnosis.hidden, false, "Opening saved evidence must not hide the observed preview failure");
    assert.equal(diagnosis.dataset.cause, "preview");
  }
  assert.equal(source.status, "completed", "Preview diagnosis must preserve the generation outcome");
});
