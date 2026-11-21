import test from "node:test";
import assert from "node:assert/strict";
import { uiHarness } from "./ui-harness.mjs";
import { waitFor, FIXTURE_HTML } from "./helpers.mjs";
import { previewDocument, summary } from "../lib/result.mjs";
import { createResultInsights } from "../ui/result-insights.mjs";

const id = "70158f4b-7844-459d-85dc-3c1cdd0d0164";
const completed = { id, batchId: id, model: "fixture/one", modelName: "One", kind: "pelican", prompt: "fixture", maxTokens: 1000, concurrency: 1, effort: "",
  createdAt: "2026-11-20T01:00:00Z", startedAt: "2026-11-20T01:00:00Z", status: "completed", content: FIXTURE_HTML, html: FIXTURE_HTML,
  previewUrl: `preview/${id}?key=fixture` };
const boot = runs => ({ models: [{ id: "fixture/one", name: "One", provider: "fixture", efforts: [] }], defaultPrompt: "fixture", runs });
const controls = (ui, host) => ui.descendants(host, "button");
const openDetails = async ui => {
  const control = await waitFor(() => controls(ui, ui.elements.get("results")).find(element => element.getAttribute("aria-label") === "源码与详情"));
  return control.fire("click");
};

test("006: a finished result automatically clears a failed active read and loads its saved preview", async t => {
  const pending = { ...summary(completed), status: "running", hasHTML: false };
  let reads = 0;
  const ui = await uiHarness({ bootstrap: boot([pending]), detail: () => { if (++reads === 1) throw new Error("fixture temporary read failure"); return completed; } });
  t.after(() => ui.closeStream()); await openDetails(ui); assert.equal(reads, 1);
  ui.event("run", { run: summary(completed) });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(reads, 2); assert.equal(ui.descendants(ui.elements.get("results"), "iframe").length, 1);
  assert.equal(controls(ui, ui.elements.get("drawer-content")).find(element => element.textContent === "重试读取").hidden, true);
});

test("006: an active read failing after the terminal event is stale and retries once", async t => {
  let rejectRead, reads = 0;
  const ui = await uiHarness({ bootstrap: boot([{ ...summary(completed), status: "running", hasHTML: false }]), detail: () => ++reads === 1
    ? new Promise((_resolve, reject) => { rejectRead = reject; }) : completed });
  t.after(() => ui.closeStream()); const opened = openDetails(ui); await waitFor(() => rejectRead);
  ui.event("run", { run: summary(completed) }); await new Promise(resolve => setTimeout(resolve, 20));
  rejectRead(new Error("fixture late active failure")); await opened; await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(reads, 2); assert.equal(ui.descendants(ui.elements.get("drawer-content"), "iframe").length, 1);
});

test("006: a failed terminal refresh stops automatic retrying and leaves the manual read entry", async t => {
  let reads = 0;
  const ui = await uiHarness({ bootstrap: boot([{ ...summary(completed), status: "running", hasHTML: false }]), detail: () => { reads++; throw new Error("fixture read unavailable"); } });
  t.after(() => ui.closeStream()); await openDetails(ui); ui.event("run", { run: summary(completed) });
  await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(reads, 2);
  const retry = controls(ui, ui.elements.get("drawer-content")).find(element => element.textContent === "重试读取");
  assert.equal(retry.hidden, false);
  for (let index = 0; index < 5; index++) ui.event("run", { run: summary(completed) });
  await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(reads, 2);
  await retry.fire("click"); assert.equal(reads, 3);
});

test("012: preview diagnostics follow the real quoted head and skip comments and raw text", () => {
  const fake = '<!-- <head> --><script>const example="<head>";</script><style>/* <head> */</style><textarea><head></textarea><title>example <head></title>';
  const html = `<!doctype html><html>${fake}<HEAD data-hint="a > b"><meta charset="utf-8"></HEAD><body>fixture</body></html>`;
  const output = previewDocument({ id, html });
  assert.ok(output.startsWith(`<!doctype html><html>${fake}<HEAD data-hint="a > b"><script>(()=>`));
  assert.ok(output.endsWith('<meta charset="utf-8"></HEAD><body>fixture</body></html>'));
});

test("012: a missing head is created after the actual html root rather than a comment example", () => {
  const html = '<!doctype html><!-- root example: <html> --><html data-hint="a > b"><body>fixture</body></html>';
  const output = previewDocument({ id, html });
  assert.ok(output.startsWith('<!doctype html><!-- root example: <html> --><html data-hint="a > b"><head><script>(()=>'));
  assert.ok(output.endsWith('</script></head><body>fixture</body></html>'));
});

test("018: trend refresh retains each surviving button and returns a removed focus to its summary", async t => {
  const ui = await uiHarness({ bootstrap: boot([]) }); t.after(() => ui.closeStream());
  await waitFor(() => ui.descendants(ui.elements.get("model-list"), "input").length);
  const records = ["older", "middle", "anchor"].map((name, index) => ({ ...completed, id: name, createdAt: `2026-11-20T0${index + 1}:00:00Z` }));
  const insights = createResultInsights(ui.document, { timeZone: "UTC", onSource() {} });
  ui.elements.get("drawer-content").append(insights.root); insights.update(records[2], records);
  const point = name => controls(ui, insights.root).find(element => element.dataset.runId === name);
  const older = point("older"), anchor = point("anchor"), disclosure = ui.descendants(insights.root, "details")[0];
  disclosure.open = true; older.focus();
  insights.update(records[2], [records[0], records[2]]);
  assert.ok(point("older") === older, "The surviving older record must retain its button");
  assert.ok(point("anchor") === anchor, "The surviving anchor must retain its button"); assert.equal(disclosure.open, true);
  insights.update(records[2], [records[2]]);
  assert.ok(ui.document.activeElement === ui.descendants(insights.root, "summary")[0], "A removed focused record returns focus to the trend summary");
});
