import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { startServer } from "../lib/server.mjs";
import { confirmClick, uiHarness } from "./ui-harness.mjs";
import { waitFor, fakeGateway, temporary, FIXTURE_HTML } from "./helpers.mjs";

const id = "70158f4b-7844-459d-85dc-3c1cdd0d0164";
const run = { id, batchId: id, model: "fixture/one", modelName: "Fixture", prompt: "test", maxTokens: 1024, effort: "",
  createdAt: "2026-11-12T00:00:00Z", startedAt: "2026-11-12T00:00:00Z", status: "completed", hasHTML: true };
const model = { id: "fixture/one", name: "Fixture", provider: "fixture", providerName: "Fixture Provider", efforts: ["low"], maxOutputTokens: 4096 };
const boot = (runs) => ({ models: [model], runs, defaultPrompt: "test", dataDir: "test-dir", version: "test", batchCleanup: true });
const control = (ui, label) => ui.descendants(ui.elements.get("results"), "button")
  .find((element) => element.attributes["aria-label"] === label || element.textContent === label);
const drawerControl = (ui, label) => ["drawer-content", "drawer-tools"].flatMap(id => ui.descendants(ui.elements.get(id), "button"))
  .find(element => element.getAttribute("aria-label") === label || element.textContent === label);
const historyRows = ui => ui.descendants(ui.elements.get("history-list"), "button").filter(element => element.className === "history-row");
const historyDeletes = ui => ui.descendants(ui.elements.get("history-list"), "button").filter(element => element.className === "history-delete");

async function chooseProvider(ui, id = "fixture") {
  const control = ui.elements.get("provider");
  assert.ok(control, "Model selection needs a provider control");
  await waitFor(() => ui.descendants(control, "option").some((option) => option.value === id));
  control.value = id; await control.fire("change");
}

test("a manually selected theme survives refresh without dropping the current view", async () => {
  const ui = await uiHarness({ bootstrap: boot([]), search: "?theme=dark&view=history&provider=fixture" });
  await chooseProvider(ui);
  await ui.elements.get("theme").fire("click");
  assert.equal(ui.document.documentElement.dataset.theme, "light");
  const reloaded = await uiHarness({ bootstrap: boot([]), search: ui.location.search });
  await chooseProvider(reloaded);
  assert.equal(reloaded.document.documentElement.dataset.theme, "light");
  assert.equal(reloaded.elements.get("history-tab").getAttribute("aria-selected"), "true");
  assert.equal(new URLSearchParams(reloaded.location.search).get("provider"), "fixture");
});

test("history detail still mounts preview when the SSE ready snapshot arrives during loading", async () => {
  let resolveDetail, requested = false;
  const ui = await uiHarness({ bootstrap: boot([run]), detail: () => { requested = true; return new Promise((resolve) => { resolveDetail = resolve; }); } });
  await waitFor(() => requested);
  ui.event("hello", { runs: [run] });
  await new Promise((resolve) => setTimeout(resolve, 10));
  resolveDetail({ ...run, html: FIXTURE_HTML, content: FIXTURE_HTML, previewUrl: `preview/${id}?key=test` });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(ui.descendants(ui.elements.get("results"), "iframe").length, 1, "The current run object must receive the loaded detail");
});

test("late create response does not regress a live generation from running to queued", async () => {
  const ui = await uiHarness({ bootstrap: boot([]), detail: () => run, create: async (_body, event) => {
    event("run", { run: { ...run, status: "running", hasHTML: false } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { runs: [{ ...run, status: "queued", startedAt: null, hasHTML: false }] };
  } });
  await chooseProvider(ui);
  await waitFor(() => ui.descendants(ui.elements.get("model-list"), "input").length === 1);
  const input = ui.descendants(ui.elements.get("model-list"), "input")[0];
  input.checked = true; await input.fire("change");
  await ui.elements.get("generate").fire("click");
  const badges = ui.descendants(ui.elements.get("results"), "span").filter((element) => element.className.includes("badge"));
  assert.equal(badges.length, 1, "Clicking Generate must create a result without a native form submission");
  assert.equal(badges[0].textContent, "生成中");
});

test("Generate button sends the selected model and prompt without a submit event", async () => {
  const requests = [];
  const ui = await uiHarness({ bootstrap: boot([]), detail: () => run, create: async (body) => {
    requests.push(body);
    return { runs: [{ ...run, status: "queued", startedAt: null, hasHTML: false }] };
  } });
  await chooseProvider(ui);
  await waitFor(() => ui.descendants(ui.elements.get("model-list"), "input").length === 1);
  const input = ui.descendants(ui.elements.get("model-list"), "input")[0];
  input.checked = true; await input.fire("change");
  await ui.elements.get("generate").fire("click");
  assert.equal(requests.length, 1, "The sandbox blocks native submission, so a button click must send the request itself");
  assert.deepEqual(requests[0], { prompt: "test", maxTokens: 64000, concurrency: 2, models: [{ id: "fixture/one", effort: "" }] });
});

test("all providers are shown by default and model search still respects a chosen provider", async () => {
  const other = { ...model, id: "other/one", provider: "other", providerName: "Other Provider", name: "Other Fixture" };
  const ui = await uiHarness({ bootstrap: { ...boot([]), models: [model, other] }, detail: () => run });
  const inputs = () => ui.descendants(ui.elements.get("model-list"), "input");
  const provider = ui.elements.get("provider");
  assert.ok(provider, "Model selection needs a provider control");
  await waitFor(() => ui.descendants(provider, "option").some((option) => option.value === "fixture"));
  assert.equal(inputs().length, 2, "The initial list must include every provider");
  assert.equal(ui.elements.get("model-search").disabled, false);
  await chooseProvider(ui);
  assert.equal(inputs().length, 1, "Other providers must stay out of this model list");
  assert.equal(inputs()[0].value, "fixture/one");
  ui.elements.get("model-search").value = "Other";
  await ui.elements.get("model-search").fire("input");
  assert.equal(inputs().length, 0, "Searching cannot leak models from a different provider");
  await chooseProvider(ui, "other");
  assert.equal(inputs().length, 1);
  assert.equal(inputs()[0].value, "other/one");
  provider.value = ""; await provider.fire("change");
  assert.equal(inputs().length, 2);
  assert.equal(ui.elements.get("model-search").disabled, false);
});

test("choosing a provider shows only model names while all providers remain distinguishable", async () => {
  const labelled = { ...model, name: "Coder · v2 · Fixture Provider" };
  const ui = await uiHarness({ bootstrap: { ...boot([]), models: [labelled] }, detail: () => run });
  await waitFor(() => ui.descendants(ui.elements.get("model-list"), "strong").length === 1);
  assert.equal(ui.descendants(ui.elements.get("model-list"), "strong")[0].textContent, "Coder · v2");
  assert.equal(ui.descendants(ui.elements.get("model-list"), "small")[0].textContent, "Fixture Provider");
  await chooseProvider(ui);
  assert.equal(ui.descendants(ui.elements.get("model-list"), "strong")[0].textContent, "Coder · v2", "Only the known provider suffix should be removed");
  assert.equal(ui.descendants(ui.elements.get("model-list"), "small").length, 0, "A selected provider must not be repeated as a model-ID subtitle");
  const input = ui.descendants(ui.elements.get("model-list"), "input")[0];
  input.checked = true; await input.fire("change");
  const selected = ui.descendants(ui.elements.get("selected-models")).find((element) => element.className === "selected-name");
  assert.equal(ui.descendants(selected).find(element => element.className === "selected-model-title")?.textContent, "Coder · v2");
  assert.equal(ui.descendants(selected).find(element => element.className === "selected-provider")?.textContent, "Fixture Provider", "The provider needs a separate visible label beside effort selection");
  assert.equal(ui.descendants(ui.elements.get("selected-models"), "select")[0].attributes["aria-label"], "Coder · v2 · Fixture Provider 的思考档位");
  assert.equal(input.value, "fixture/one", "The submitted model identifier must stay intact");
  ui.elements.get("provider").value = ""; await ui.elements.get("provider").fire("change");
  assert.equal(ui.descendants(ui.elements.get("model-list"), "strong")[0].textContent, "Coder · v2");
  assert.equal(ui.descendants(ui.elements.get("model-list"), "small")[0].textContent, "Fixture Provider");
});

test("prompt is collapsed by default and editing it preserves the value when collapsed again", async () => {
  const ui = await uiHarness({ bootstrap: boot([]), detail: () => run });
  await waitFor(() => ui.elements.get("prompt").value === "test");
  const editor = ui.elements.get("prompt-editor"), toggle = ui.elements.get("edit-prompt");
  assert.ok(editor && toggle, "Prompt editing needs an explicit collapsed panel");
  assert.equal(editor.hidden, true);
  await toggle.fire("click");
  assert.equal(editor.hidden, false);
  assert.equal(toggle.attributes["aria-expanded"], "true");
  ui.elements.get("prompt").value = "edited prompt";
  await ui.elements.get("prompt").fire("input");
  await toggle.fire("click");
  assert.equal(editor.hidden, true);
  assert.equal(toggle.attributes["aria-expanded"], "false");
  assert.equal(ui.elements.get("prompt").value, "edited prompt");
});

test("restoring the default prompt clears its validation error and allows generation", async () => {
  let sent;
  const ui = await uiHarness({ bootstrap: { models: [model], runs: [], defaultPrompt: "default animation", dataDir: "fixture-dir" }, detail: () => ({}),
    create: async body => { sent = body; return { runs: [{ id, batchId: id, model: model.id, status: "queued", createdAt: "2026-11-13T00:00:00Z" }] }; } });
  await waitFor(() => ui.descendants(ui.elements.get("model-list"), "input").length);
  const pick = ui.descendants(ui.elements.get("model-list"), "input")[0]; pick.checked = true; await pick.fire("change");
  ui.elements.get("prompt").value = ""; await ui.elements.get("generate").fire("click");
  assert.equal(ui.elements.get("prompt").attributes["aria-invalid"], "true");
  await ui.elements.get("reset-prompt").fire("click");
  assert.equal(ui.elements.get("prompt").attributes["aria-invalid"], undefined); assert.equal(ui.elements.get("form-error").hidden, true);
  await ui.elements.get("generate").fire("click"); assert.equal(sent.prompt, "default animation");
});

test("host selects light or dark without mixing incomplete host colors into the local palette", async () => {
  const tokens = { bg: "#141720", card: "#1d222e", fg: "#ecf0fa", muted: "#aab5ca", line: "#374154", accent: "#b5c4ff", "accent-soft": "#2b385b", "accent-fg": "#1b294e", green: "#a0dcc2", red: "#ffb0be", amber: "#f3cb89", font: "ignored" };
  const search = `?theme=dark&tokens=${encodeURIComponent(JSON.stringify(tokens))}`;
  const ui = await uiHarness({ bootstrap: boot([]), detail: () => run, search });
  const style = ui.document.documentElement.style;
  assert.equal(ui.document.documentElement.dataset.theme, "dark");
  assert.ok(!Object.keys(style).some(key => key.startsWith("--")), "Keep paired surfaces, text and state colors in the tested local palette");
  await ui.elements.get("theme").fire("click");
  assert.equal(ui.document.documentElement.dataset.theme, "light");
  await ui.elements.get("theme").fire("click");
  assert.equal(ui.document.documentElement.dataset.theme, "dark");
});

test("cleanup removes displayed cards and history, and a deleted preview detail cannot reappear", async () => {
  let resolveDetail, requested = false;
  const ui = await uiHarness({ bootstrap: boot([run]), detail: () => { requested = true; return new Promise((resolve) => { resolveDetail = resolve; }); } });
  await waitFor(() => requested);
  ui.event("removed", { ids: [id] });
  await waitFor(() => ui.elements.get("history-count").textContent === "0 批");
  assert.equal(ui.descendants(ui.elements.get("results"), "article").length, 0);
  resolveDetail({ ...run, html: FIXTURE_HTML, previewUrl: `preview/${id}?key=test` });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(ui.descendants(ui.elements.get("results"), "iframe").length, 0);
  ui.event("hello", { runs: [run] });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(ui.elements.get("history-count").textContent, "0 批", "A late snapshot cannot restore deleted records");
});

test("cleanup controls send all or a UTC cutoff and update history after the response", async () => {
  const calls = [];
  const ui = await uiHarness({ bootstrap: boot([run]), detail: () => ({ ...run, html: FIXTURE_HTML, previewUrl: `preview/${id}?key=test` }), cleanup: async (body) => {
    calls.push(body); return { removed: [id], skippedActive: 0, errors: [] };
  } });
  await waitFor(() => ui.elements.get("history-count").textContent === "1 批");
  const all = ui.elements.get("clear-all"), before = ui.elements.get("clear-before"), time = ui.elements.get("cleanup-before");
  assert.ok(all && before && time, "History needs both cleanup actions");
  await (await confirmClick(ui, all, false)).completion;
  assert.equal(calls.length, 0);
  assert.equal(ui.elements.get("history-count").textContent, "1 批");
  await (await confirmClick(ui, all)).completion;
  assert.deepEqual(calls[0], { mode: "all" });
  assert.equal(ui.elements.get("history-count").textContent, "0 批");
  time.value = "2026-11-13T08:30";
  await (await confirmClick(ui, before)).completion;
  assert.deepEqual(calls[1], { mode: "before", before: new Date("2026-11-13T08:30").toISOString() });
});

test("bulk cleanup toggles to Close, preserves its cutoff and restores focus when closed", async () => {
  const ui = await uiHarness({ bootstrap: boot([]), detail: () => run });
  await waitFor(() => ui.elements.get("prompt").value === "test");
  const toggle = ui.elements.get("manage-history"), panel = ui.elements.get("cleanup-panel"), input = ui.elements.get("cleanup-before");
  assert.equal(panel.hidden, true); await toggle.fire("click");
  assert.equal(panel.hidden, false); assert.equal(toggle.textContent, "关闭"); assert.equal(toggle.attributes["aria-expanded"], "true");
  input.value = "2026-11-13 08:30"; await toggle.fire("click");
  assert.equal(panel.hidden, true); assert.equal(toggle.textContent, "批量清理"); assert.equal(toggle.attributes["aria-expanded"], "false");
  assert.equal(input.value, "2026-11-13 08:30"); assert.equal(toggle.focused, true);
});

test("folder control uses the fixed storage endpoint, prevents duplicate clicks and allows a failed launch to retry", async () => {
  let attempts = 0, release;
  const ui = await uiHarness({ bootstrap: { ...boot([]), openDataDir: true }, detail: () => run, openStorage: options => {
    assert.equal(options.body, undefined, "Only the server chooses a folder path"); attempts++;
    if (attempts === 1) return new Promise((_, reject) => { release = () => reject(new Error("Fixture launch failure")); });
    return { opened: true };
  } });
  await waitFor(() => ui.elements.get("prompt").value === "test");
  const button = ui.elements.get("open-data-dir"); assert.ok(button, "Saving needs a folder action"); assert.equal(button.disabled, false);
  const opening = button.fire("click"); await waitFor(() => attempts === 1);
  assert.equal(button.disabled, true); await button.fire("click"); assert.equal(attempts, 1);
  release(); await opening; assert.equal(button.disabled, false); assert.equal(ui.elements.get("storage-status").textContent, "Fixture launch failure");
  await button.fire("click"); assert.equal(attempts, 2); assert.equal(ui.elements.get("storage-status").hidden, true);
  assert.equal(ui.elements.get("storage-status").textContent, ""); assert.equal(button.disabled, false);
});

test("an older backend leaves the storage path readable and does not send unsupported folder-open requests", async () => {
  let calls = 0;
  const ui = await uiHarness({ bootstrap: boot([]), detail: () => run, openStorage: () => { calls++; return {}; } });
  await waitFor(() => ui.elements.get("prompt").value === "test");
  const button = ui.elements.get("open-data-dir"); assert.ok(button); assert.equal(button.disabled, true);
  assert.match(button.title, /重新开启插件/); assert.equal(ui.elements.get("data-dir").textContent, "test-dir");
  await button.fire("click"); assert.equal(calls, 0);
});

test("cleanup rejects nonexistent local calendar dates and prevents overlapping deletion requests", async () => {
  let calls = 0, release;
  const ui = await uiHarness({ bootstrap: boot([run]), detail: () => ({ ...run, html: FIXTURE_HTML, previewUrl: `preview/${id}?key=test` }), cleanup: body => {
    calls++;
    if (body.before !== new Date("2026-11-13T08:30").toISOString()) return { removed: [], errors: [], skippedActive: 0 };
    return new Promise(resolve => { release = () => resolve({ removed: [], errors: [], skippedActive: 0 }); });
  } });
  await waitFor(() => ui.elements.get("history-count").textContent === "1 批");
  const input = ui.elements.get("cleanup-before"), before = ui.elements.get("clear-before"), all = ui.elements.get("clear-all");
  input.value = "2026-02-31 08:30"; await before.fire("click");
  assert.equal(calls, 0); assert.match(ui.elements.get("cleanup-status").textContent, /有效/); assert.equal(input.attributes["aria-invalid"], "true");
  input.value = "2026-11-13 08:30"; const { completion: clearing } = await confirmClick(ui, before); await waitFor(() => calls === 1);
  assert.equal(before.disabled, true); assert.equal(all.disabled, true);
  await all.fire("click"); await before.fire("click"); assert.equal(calls, 1);
  release(); await clearing; assert.equal(all.disabled, false); assert.equal(before.disabled, false); assert.equal(input.attributes["aria-invalid"], undefined);
});

test("the page calendar aligns selected dates, changes months and retains the chosen local time", async () => {
  const ui = await uiHarness({ bootstrap: boot([]), detail: () => run });
  await waitFor(() => ui.elements.get("prompt").value === "test");
  const input = ui.elements.get("cleanup-before"), toggle = ui.elements.get("choose-date"), popup = ui.elements.get("cleanup-calendar");
  assert.ok(toggle && popup, "Use a page-controlled calendar rather than browser popup styling");
  input.value = "2026-11-13 08:30"; await toggle.fire("click");
  assert.equal(popup.hidden, false); assert.equal(toggle.attributes["aria-expanded"], "true");
  const day = ui.descendants(ui.elements.get("calendar-days"), "button").find(button => button.attributes["aria-label"] === "2026年11月13日");
  assert.ok(day); assert.equal(day.attributes["aria-pressed"], "true");
  await ui.elements.get("calendar-next").fire("click"); assert.equal(ui.elements.get("calendar-month").textContent, "2026年12月");
  const selected = ui.descendants(ui.elements.get("calendar-days"), "button").find(button => button.attributes["aria-label"] === "2026年12月15日");
  await selected.fire("click"); assert.equal(input.value, "2026-12-15 08:30"); assert.equal(popup.hidden, true); assert.equal(input.focused, true);
  await toggle.fire("click"); await popup.fire("keydown", { key: "Escape" });
  assert.equal(popup.hidden, true); assert.equal(toggle.attributes["aria-expanded"], "false"); assert.equal(toggle.focused, true);
});

test("history updates retain the existing row, buttons and focus rather than rebuilding the list", async () => {
  const ui = await uiHarness({ bootstrap: boot([run]), detail: () => ({ ...run, html: FIXTURE_HTML, previewUrl: `preview/${id}?key=test` }) });
  await waitFor(() => ui.descendants(ui.elements.get("results"), "iframe").length === 1);
  const row = historyRows(ui)[0], remove = historyDeletes(ui)[0], list = ui.elements.get("history-list"); remove.focus();
  const replacements = list.replacements;
  ui.event("run", { run: { ...run, usage: { total_tokens: 1234 } } });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(historyRows(ui)[0], row); assert.equal(historyDeletes(ui)[0], remove); assert.equal(remove.focused, true);
  assert.equal(list.replacements, replacements, "A metric-only event does not rebuild historical navigation");
  const earlierId = "828715f8-bf8c-4669-a027-66b13e432291";
  ui.event("run", { run: { ...run, id: earlierId, batchId: earlierId, createdAt: "2026-11-11T00:00:00Z" } });
  await waitFor(() => ui.elements.get("history-count").textContent === "2 批");
  assert.equal(historyRows(ui)[0], row); assert.equal(historyDeletes(ui)[0], remove);
});

test("streaming bursts refresh once per animation frame and leave closed details and icons untouched", async () => {
  const pending = { ...run, status: "running", hasHTML: false };
  const ui = await uiHarness({ bootstrap: boot([pending]), detail: () => pending });
  await waitFor(() => ui.descendants(ui.elements.get("results"), "article").length === 1);
  const panel = ui.elements.get("drawer-content"), badge = ui.descendants(ui.elements.get("results"), "span").find(element => element.className === "badge running");
  const toggle = control(ui, "源码与详情"), replay = control(ui, "重播");
  const progress = ui.descendants(ui.elements.get("results")).find(element => element.className === "progress-line");
  const writes = { badge: badge.textWrites, replay: replay.replacements };
  for (let index = 0; index < 100; index++) ui.event("delta", { id, content: "鹈", contentChars: index + 1, reasoningChars: 0 });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(ui.pendingFrames(), 1, "One render is scheduled for the whole burst");
  assert.equal(badge.textWrites, writes.badge); assert.equal(replay.replacements, writes.replay);
  ui.flushFrames(); assert.equal(ui.pendingFrames(), 0);
  assert.equal(ui.descendants(ui.elements.get("results")).find(element => element.className === "progress-line"), progress, "Refreshing character counts must not restart the progress animation");
  assert.equal(ui.descendants(panel, "pre").length, 0, "Closed details do not copy streaming output into the DOM");
  await toggle.fire("click"); await drawerControl(ui, "原始输出").fire("click");
  assert.equal(ui.descendants(panel, "pre")[0].textContent, "鹈".repeat(100));
});

test("a late active detail cannot regress a completed run and the current terminal detail is loaded", async () => {
  const pending = { ...run, status: "running", hasHTML: false, contentChars: 0 };
  let release, loads = 0; const ui = await uiHarness({ bootstrap: boot([pending]), detail: () => ++loads === 1 ? new Promise(resolve => { release = resolve; }) : ({ ...run, content: FIXTURE_HTML, html: FIXTURE_HTML, previewUrl: `preview/${id}?key=test` }) });
  await waitFor(() => ui.descendants(ui.elements.get("results"), "article").length === 1);
  await control(ui, "源码与详情").fire("click");
  await waitFor(() => typeof release === "function");
  ui.event("delta", { id, content: "正文", contentChars: 2, reasoningChars: 0 });
  ui.event("run", { run: { ...run, contentChars: 2 } }); await new Promise(resolve => setTimeout(resolve, 20));
  release({ ...pending, content: "旧", contentChars: 1 }); await new Promise(resolve => setTimeout(resolve, 20));
  const badge = ui.descendants(ui.elements.get("results"), "span").find(element => element.className.includes("badge"));
  assert.equal(badge.textContent, "已完成", "A late active snapshot cannot overwrite a terminal status");
  assert.equal(loads, 2); assert.equal(ui.descendants(ui.elements.get("results"), "iframe").length, 1);
});

test("an active detail snapshot already containing a queued SSE chunk does not duplicate the original output", async () => {
  const pending = { ...run, status: "running", hasHTML: false, contentChars: 0 };
  let release; const ui = await uiHarness({ bootstrap: boot([pending]), detail: () => new Promise(resolve => { release = resolve; }) });
  await waitFor(() => ui.descendants(ui.elements.get("results"), "article").length === 1);
  await control(ui, "源码与详情").fire("click"); await drawerControl(ui, "原始输出").fire("click");
  release({ ...pending, contentChars: undefined, content: "鹈鹕" }); await new Promise(resolve => setTimeout(resolve, 20));
  ui.event("delta", { id, content: "鹈鹕", contentChars: 2, reasoningChars: 0 }); await new Promise(resolve => setTimeout(resolve, 20)); ui.flushFrames();
  assert.equal(ui.descendants(ui.elements.get("drawer-content"), "pre")[0].textContent, "鹈鹕");
});

test("a queued detail arriving after generation starts preserves its live running status", async () => {
  const pending = { ...run, status: "queued", startedAt: null, hasHTML: false, contentChars: 0 };
  let release; const ui = await uiHarness({ bootstrap: boot([pending]), detail: () => new Promise(resolve => { release = resolve; }) });
  await waitFor(() => ui.descendants(ui.elements.get("results"), "article").length === 1);
  await control(ui, "源码与详情").fire("click");
  ui.event("run", { run: { ...pending, status: "running", startedAt: new Date().toISOString() } }); await new Promise(resolve => setTimeout(resolve, 20));
  release({ ...pending, content: "" }); await new Promise(resolve => setTimeout(resolve, 20));
  const badge = ui.descendants(ui.elements.get("results"), "span").find(element => element.className.includes("badge"));
  assert.equal(badge.textContent, "生成中");
  const elapsed = ui.descendants(ui.elements.get("drawer-content"), "span").find(element => element.className === "stat-value");
  assert.match(elapsed.textContent, / s$/, "The late queued detail must also preserve the start time");
});

test("a delayed detail snapshot restores the output prefix while preserving later streaming text", async () => {
  const pending = { ...run, status: "running", hasHTML: false, contentChars: 2 };
  let release; const ui = await uiHarness({ bootstrap: boot([pending]), detail: () => new Promise(resolve => { release = resolve; }) });
  await waitFor(() => ui.descendants(ui.elements.get("results"), "article").length === 1);
  await control(ui, "源码与详情").fire("click"); await drawerControl(ui, "原始输出").fire("click");
  ui.event("delta", { id, content: "骑车", contentChars: 4, reasoningChars: 0 }); await new Promise(resolve => setTimeout(resolve, 20));
  release({ ...pending, content: "鹈鹕" }); await new Promise(resolve => setTimeout(resolve, 20)); ui.flushFrames();
  assert.equal(ui.descendants(ui.elements.get("drawer-content"), "pre")[0].textContent, "鹈鹕骑车");
});

test("calendar keyboard navigation crosses a month and closing cleanup restores keyboard focus", async () => {
  const ui = await uiHarness({ bootstrap: boot([]), detail: () => run });
  await waitFor(() => ui.elements.get("prompt").value === "test");
  const input = ui.elements.get("cleanup-before"), popup = ui.elements.get("cleanup-calendar");
  input.value = "2026-11-30 08:30"; await ui.elements.get("manage-history").fire("click"); await ui.elements.get("choose-date").fire("click");
  const day = ui.descendants(ui.elements.get("calendar-days"), "button").find(button => button.attributes["aria-label"] === "2026年11月30日");
  await day.fire("keydown", { key: "ArrowRight" });
  const next = ui.descendants(ui.elements.get("calendar-days"), "button").find(button => button.attributes["aria-label"] === "2026年12月1日");
  assert.equal(next.focused, true); assert.equal(next.attributes.tabindex, "0");
  await next.fire("click"); assert.equal(input.value, "2026-12-01 08:30");
  await ui.elements.get("choose-date").fire("click"); await ui.elements.get("manage-history").fire("click");
  assert.equal(popup.hidden, true); assert.equal(ui.elements.get("manage-history").focused, true);
});

test("a calendar near the viewport edge stays on screen and closes when the page scrolls", async () => {
  const ui = await uiHarness({ bootstrap: boot([]), detail: () => run, viewport: { width: 375, height: 360 } });
  await waitFor(() => ui.elements.get("prompt").value === "test");
  const popup = ui.elements.get("cleanup-calendar"); popup.rect = { width: 256, height: 270 };
  ui.elements.get("cleanup-before").rect = { left: 250, bottom: 330, top: 300 };
  await ui.elements.get("choose-date").fire("click");
  assert.equal(popup.style.left, "107px"); assert.equal(popup.style.top, "22px");
  assert.equal(popup.style.maxHeight, "336px");
  ui.dispatch("scroll", {}); assert.equal(popup.hidden, true);
});

test("invalid hidden numeric settings are revealed and focused without sending a generation request", async () => {
  let calls = 0; const ui = await uiHarness({ bootstrap: boot([]), detail: () => run, create: () => { calls++; return { runs: [run] }; } });
  await chooseProvider(ui); const modelInput = ui.descendants(ui.elements.get("model-list"), "input")[0]; modelInput.checked = true; await modelInput.fire("change");
  const maxTokens = ui.elements.get("max-tokens"), concurrency = ui.elements.get("concurrency");
  maxTokens.value = "-1"; await ui.elements.get("generate").fire("click");
  assert.equal(calls, 0); assert.equal(ui.elements.get("advanced-settings").open, true); assert.equal(maxTokens.focused, true); assert.equal(maxTokens.attributes["aria-invalid"], "true");
  maxTokens.value = "32000"; concurrency.value = "1.5"; await ui.elements.get("generate").fire("click");
  assert.equal(calls, 0); assert.equal(concurrency.focused, true); assert.equal(concurrency.attributes["aria-invalid"], "true");
});

test("switching provider keeps model picks and efforts for a comparison request", async () => {
  const other = { ...model, id: "other/one", provider: "other", providerName: "Other Provider" };
  const requests = [];
  const ui = await uiHarness({ bootstrap: { ...boot([]), models: [model, other] }, detail: () => run, create: async (body) => {
    requests.push(body); return { runs: [{ ...run, status: "queued", startedAt: null }] };
  } });
  await chooseProvider(ui);
  let input = ui.descendants(ui.elements.get("model-list"), "input")[0];
  input.checked = true; await input.fire("change");
  const effort = ui.descendants(ui.elements.get("selected-models"), "select")[0];
  effort.value = "low"; await effort.fire("change");
  await chooseProvider(ui, "other");
  input = ui.descendants(ui.elements.get("model-list"), "input")[0];
  input.checked = true; await input.fire("change");
  await ui.elements.get("generate").fire("click");
  assert.deepEqual(requests[0].models, [{ id: "fixture/one", effort: "low" }, { id: "other/one", effort: "" }]);
  const remove = ui.descendants(ui.elements.get("selected-models"), "button").find((button) => button.attributes["aria-label"] === "移除 fixture/one");
  assert.ok(remove, "A pick from another provider must be removable without changing provider again");
  await remove.fire("click");
  assert.equal(ui.descendants(ui.elements.get("selected-models"), "select").length, 1);
});

test("model selection has no four-model ceiling and sends freely chosen generation parameters", async () => {
  const models = Array.from({ length: 9 }, (_, index) => ({ ...model, id: `fixture/model-${index}`, name: `Model ${index}` }));
  let sent;
  const ui = await uiHarness({ bootstrap: { ...boot([]), models }, detail: () => run, create: async (body) => {
    sent = body; return { runs: [{ ...run, status: "queued", hasHTML: false }] };
  } });
  await chooseProvider(ui);
  for (const input of ui.descendants(ui.elements.get("model-list"), "input")) { input.checked = true; await input.fire("change"); }
  assert.equal(ui.descendants(ui.elements.get("selected-models"), "select").length, 9);
  const concurrency = ui.elements.get("concurrency"); assert.ok(concurrency, "The batch needs a concurrency setting");
  concurrency.value = "12"; ui.elements.get("max-tokens").value = "131072";
  await ui.elements.get("generate").fire("click");
  assert.equal(sent.models.length, 9);
  assert.equal(sent.concurrency, 12);
  assert.equal(sent.maxTokens, 131072);
});

test("history has its own tab and historical previews do not replace the current batch", async () => {
  const earlierId = "828715f8-bf8c-4669-a027-66b13e432291";
  const earlier = { ...run, id: earlierId, batchId: earlierId, createdAt: "2026-11-11T00:00:00Z" };
  const ui = await uiHarness({ bootstrap: boot([run, earlier]), detail: async value => ({ ...(value === earlierId ? earlier : run), html: FIXTURE_HTML, previewUrl: `preview/${value}?key=test` }) });
  await waitFor(() => ui.descendants(ui.elements.get("results"), "iframe").length === 1);
  const current = ui.elements.get("current-tab"), history = ui.elements.get("history-tab");
  assert.ok(current && history, "Current and history need separate tabs");
  const frame = ui.descendants(ui.elements.get("results"), "iframe")[0];
  assert.equal(ui.elements.get("current-panel").hidden, false);
  assert.equal(ui.elements.get("history-panel").hidden, true);
  await history.fire("click");
  assert.equal(ui.descendants(ui.elements.get("results"), "iframe").length, 0, "Hidden animations release their frame");
  assert.equal(ui.elements.get("current-panel").hidden, true);
  assert.equal(ui.elements.get("history-panel").hidden, false);
  assert.equal(history.attributes["aria-selected"], "true");
  await historyRows(ui)[1].fire("click");
  await waitFor(() => ui.descendants(ui.elements.get("history-results"), "iframe").length === 1);
  assert.equal(ui.descendants(ui.elements.get("history-results"), "article")[0].dataset.runId, earlierId);
  assert.equal(ui.descendants(ui.elements.get("results"), "article")[0].dataset.runId, id);
  await current.fire("click");
  assert.equal(ui.elements.get("current-panel").hidden, false);
  assert.equal(ui.elements.get("history-panel").hidden, true);
  assert.equal(ui.descendants(ui.elements.get("results"), "iframe")[0].src, frame.src, "Returning reloads the same saved preview without generating again");
});

test("tab keyboard navigation disables generation in history until a test tab is chosen", async () => {
  const ui = await uiHarness({ bootstrap: boot([]), detail: () => run, create: async () => ({ runs: [{ ...run, status: "queued", hasHTML: false }] }) });
  await chooseProvider(ui);
  const current = ui.elements.get("current-tab"), history = ui.elements.get("history-tab");
  assert.ok(current && history, "The views must be keyboard operable tabs");
  await current.fire("keydown", { key: "ArrowRight" });
  assert.equal(ui.elements.get("fingerprint-tab").attributes["aria-selected"], "true");
  await ui.elements.get("fingerprint-tab").fire("keydown", { key: "ArrowRight" });
  assert.equal(ui.elements.get("candy-tab").attributes["aria-selected"], "true");
  await ui.elements.get("candy-tab").fire("keydown", { key: "ArrowRight" });
  assert.equal(ui.elements.get("favorites-tab").attributes["aria-selected"], "true");
  await ui.elements.get("favorites-tab").fire("keydown", { key: "ArrowRight" });
  assert.equal(history.attributes["aria-selected"], "true"); assert.equal(history.focused, true);
  await history.fire("keydown", { key: "Home" }); assert.equal(current.attributes["aria-selected"], "true");
  await current.fire("keydown", { key: "End" }); assert.equal(history.attributes["aria-selected"], "true");
  const input = ui.descendants(ui.elements.get("model-list"), "input")[0]; input.checked = true; await input.fire("change");
  await ui.elements.get("generate").fire("click");
  assert.equal(history.attributes["aria-selected"], "true"); assert.equal(ui.elements.get("generate").disabled, true);
  assert.equal(ui.descendants(ui.elements.get("results"), "article").length, 0);
  await history.fire("keydown", { key: "Home" }); await ui.elements.get("generate").fire("click");
  assert.equal(current.attributes["aria-selected"], "true");
  assert.equal(ui.elements.get("current-panel").hidden, false);
  assert.equal(ui.descendants(ui.elements.get("results"), "article")[0].dataset.runId, id);
});

test("history selection stays identified during updates and closes when pressed again", async () => {
  const earlierId = "828715f8-bf8c-4669-a027-66b13e432291";
  const earlier = { ...run, id: earlierId, batchId: earlierId, createdAt: "2026-11-11T00:00:00Z" };
  const ui = await uiHarness({ bootstrap: boot([run, earlier]), detail: async value => ({ ...(value === earlierId ? earlier : run), html: FIXTURE_HTML, previewUrl: `preview/${value}?key=test` }) });
  await waitFor(() => historyRows(ui).length === 2);
  await historyRows(ui)[1].fire("click");
  await waitFor(() => ui.descendants(ui.elements.get("history-results"), "iframe").length === 1);
  const frame = ui.descendants(ui.elements.get("history-results"), "iframe")[0];
  assert.equal(historyRows(ui)[1].attributes["aria-pressed"], "true", "The selected historical batch must be identified to keyboard and screen-reader users");
  assert.equal(historyRows(ui)[0].attributes["aria-pressed"], "false");
  ui.event("run", { run: { ...run, elapsedMs: 2000 } });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(historyRows(ui)[1].attributes["aria-pressed"], "true", "Live updates must keep the historical selection identified");
  assert.equal(ui.descendants(ui.elements.get("history-results"), "iframe")[0], frame);
  await historyRows(ui)[1].fire("click");
  assert.equal(ui.elements.get("history-detail").hidden, true);
  assert.equal(historyRows(ui)[1].attributes["aria-pressed"], "false");
  await historyRows(ui)[0].fire("click");
  assert.equal(historyRows(ui)[0].attributes["aria-pressed"], "true");
  assert.equal(historyRows(ui)[1].attributes["aria-pressed"], "false");
});

test("each history batch can be deleted while the current preview and other batches remain", async () => {
  const earlierId = "828715f8-bf8c-4669-a027-66b13e432291", secondId = "5aa8298a-5c64-4c90-aa42-dbe23c659b78";
  const earlier = { ...run, id: earlierId, batchId: earlierId, createdAt: "2026-11-11T00:00:00Z" };
  const second = { ...earlier, id: secondId }, calls = [];
  let release;
  const ui = await uiHarness({ bootstrap: boot([run, earlier, second]), detail: async value => ({ ...(value === id ? run : value === earlierId ? earlier : second), html: FIXTURE_HTML, previewUrl: `preview/${value}?key=test` }), cleanup: async body => {
    calls.push(body); return new Promise(resolve => { release = () => resolve({ removed: [earlierId, secondId], skippedActive: 0, errors: [] }); });
  } });
  await waitFor(() => ui.descendants(ui.elements.get("results"), "iframe").length === 1);
  const frame = ui.descendants(ui.elements.get("results"), "iframe")[0];
  assert.equal(historyDeletes(ui).length, 2, "Every batch needs its own delete button");
  const remove = historyDeletes(ui)[1];
  const { completion: deleting } = await confirmClick(ui, remove); await waitFor(() => calls.length === 1);
  await remove.fire("click"); assert.equal(calls.length, 1, "A pending deletion must not be submitted twice");
  assert.deepEqual(calls[0], { mode: "batch", batchId: earlierId });
  release(); await deleting;
  assert.equal(ui.elements.get("history-count").textContent, "1 批");
  assert.equal(historyDeletes(ui).length, 1);
  assert.equal(ui.descendants(ui.elements.get("results"), "iframe")[0], frame);
  ui.event("hello", { runs: [run, earlier, second] });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(ui.elements.get("history-count").textContent, "1 批", "A late snapshot cannot revive a deleted batch");
});

test("active history batches keep a disabled delete button until all members finish", async () => {
  const working = { ...run, status: "running", hasHTML: false };
  const ui = await uiHarness({ bootstrap: boot([working]), detail: async () => ({ ...run, html: FIXTURE_HTML, previewUrl: `preview/${id}?key=test` }) });
  await waitFor(() => ui.elements.get("history-count").textContent === "1 批");
  assert.equal(historyDeletes(ui).length, 1);
  assert.equal(historyDeletes(ui)[0].disabled, true);
  ui.event("run", { run });
  await waitFor(() => historyDeletes(ui)[0]?.disabled === false);
});

test("failed batch deletion keeps its row and exposes a retryable error", async () => {
  let calls = 0;
  const ui = await uiHarness({ bootstrap: boot([run]), detail: async () => ({ ...run, html: FIXTURE_HTML, previewUrl: `preview/${id}?key=test` }), cleanup: async () => {
    if (++calls === 1) throw new Error("disk unavailable");
    return { removed: [id], skippedActive: 0, errors: [] };
  } });
  await waitFor(() => ui.elements.get("history-count").textContent === "1 批");
  assert.equal(historyDeletes(ui).length, 1);
  await (await confirmClick(ui, historyDeletes(ui)[0])).completion;
  assert.equal(ui.elements.get("history-count").textContent, "1 批");
  assert.equal(ui.elements.get("history-status").textContent, "disk unavailable");
  assert.equal(historyDeletes(ui)[0].disabled, false);
  await (await confirmClick(ui, historyDeletes(ui)[0])).completion;
  assert.equal(ui.elements.get("history-count").textContent, "0 批");
  assert.equal(ui.descendants(ui.elements.get("results"), "article").length, 0);
});

test("a service without batch cleanup support shows delete controls without sending unsupported requests", async () => {
  let calls = 0;
  const ui = await uiHarness({ bootstrap: { ...boot([run]), batchCleanup: undefined }, detail: async () => ({ ...run, html: FIXTURE_HTML, previewUrl: `preview/${id}?key=test` }), cleanup: async () => { calls++; throw new Error("unsupported"); } });
  await waitFor(() => ui.elements.get("history-count").textContent === "1 批");
  assert.equal(historyDeletes(ui).length, 1);
  assert.equal(historyDeletes(ui)[0].disabled, true);
  await historyDeletes(ui)[0].fire("click");
  assert.equal(calls, 0);
  assert.match(ui.elements.get("history-status").textContent, /重新开启插件/);
});

test("history groups models into one row per batch and opens the whole batch", async () => {
  const otherId = "5aa8298a-5c64-4c90-aa42-dbe23c659b78", earlierId = "828715f8-bf8c-4669-a027-66b13e432291";
  const second = { ...run, id: otherId, model: "other/one", status: "running" };
  const earlier = { ...run, id: earlierId, batchId: earlierId, createdAt: "2026-11-11T00:00:00Z" };
  const ui = await uiHarness({ bootstrap: boot([run, second, earlier]), detail: async (id) => ({ ...(id === earlierId ? earlier : run), id, html: FIXTURE_HTML, previewUrl: `preview/${id}?key=test` }) });
  await waitFor(() => ui.elements.get("history-count").textContent === "2 批");
  const rows = historyRows(ui);
  assert.equal(rows.length, 2, "Each batch should appear once rather than once per model");
  assert.ok(ui.descendants(rows[0], "span").some(element => element.textContent.endsWith("2 个模型")));
  await rows[1].fire("click");
  assert.equal(ui.descendants(ui.elements.get("history-results"), "article").length, 1);
  await rows[0].fire("click");
  assert.equal(ui.descendants(ui.elements.get("history-results"), "article").length, 2);
});

test("switching a history batch returns the animation scroller to its beginning", async () => {
  const earlierId = "828715f8-bf8c-4669-a027-66b13e432291";
  const earlier = { ...run, id: earlierId, batchId: earlierId, createdAt: "2026-11-11T00:00:00Z" };
  const ui = await uiHarness({ bootstrap: boot([run, earlier]), detail: async (value) => ({ ...(value === earlierId ? earlier : run), html: FIXTURE_HTML, previewUrl: `preview/${value}?key=test` }) });
  await waitFor(() => ui.elements.get("history-count").textContent === "2 批");
  const viewport = ui.elements.get("history-preview-scroll");
  assert.ok(viewport, "Historical previews need their own scroll position");
  viewport.scrollTop = 540;
  await historyRows(ui)[1].fire("click");
  assert.equal(viewport.scrollTop, 0, "A new batch must open at its first model rather than an earlier batch's scroll position");
  assert.equal(ui.descendants(ui.elements.get("history-results"), "article")[0].dataset.runId, earlierId);
  assert.equal(historyRows(ui).length, 2);
});

test("later batch members appear without restarting previews already displayed", async () => {
  const otherId = "5aa8298a-5c64-4c90-aa42-dbe23c659b78";
  const ui = await uiHarness({ bootstrap: boot([run]), detail: async (value) => ({ ...run, id: value, html: FIXTURE_HTML, previewUrl: `preview/${value}?key=test` }) });
  await waitFor(() => ui.descendants(ui.elements.get("results"), "iframe").length === 1);
  const original = ui.descendants(ui.elements.get("results"), "iframe")[0];
  ui.event("run", { run: { ...run, id: otherId, model: "other/one", status: "queued", hasHTML: false } });
  await waitFor(() => ui.descendants(ui.elements.get("history-list"), "span").some(element => element.textContent.endsWith("2 个模型")));
  assert.equal(ui.descendants(ui.elements.get("results"), "article").length, 2, "The displayed batch must include members received after it was opened");
  assert.match(ui.elements.get("batch-note").textContent, /2 个模型 · 2 份结果$/);
  assert.equal(ui.descendants(ui.elements.get("results"), "iframe")[0], original);
});

test("a newly received member does not restart the selected history animation", async () => {
  const other = { ...run, id: "5aa8298a-5c64-4c90-aa42-dbe23c659b78", model: "other/two", status: "queued", hasHTML: false };
  const ui = await uiHarness({ bootstrap: boot([run]), search: "?view=history", detail: () => ({ ...run, html: FIXTURE_HTML, previewUrl: `preview/${id}?key=test` }) });
  await waitFor(() => historyRows(ui).length === 1);
  await historyRows(ui)[0].fire("click");
  const results = ui.elements.get("history-results"), scroll = ui.elements.get("history-preview-scroll");
  const original = await waitFor(() => ui.descendants(results, "iframe")[0]);
  scroll.scrollTop = 80;
  ui.event("run", { run: other });
  await waitFor(() => ui.descendants(results, "article").length === 2);
  assert.equal(ui.descendants(results, "iframe")[0], original);
  assert.equal(scroll.scrollTop, 80);
});

test("switching history batches releases old observers and deleting records releases both views", async () => {
  const earlierId = "828715f8-bf8c-4669-a027-66b13e432291";
  const earlier = { ...run, id: earlierId, batchId: earlierId, createdAt: "2026-11-11T00:00:00Z" };
  const ui = await uiHarness({ bootstrap: boot([run, earlier]), detail: async (value) => ({ ...(value === earlierId ? earlier : run), html: FIXTURE_HTML, previewUrl: `preview/${value}?key=test` }) });
  await waitFor(() => ui.descendants(ui.elements.get("results"), "iframe").length === 1);
  await historyRows(ui)[1].fire("click");
  await waitFor(() => ui.descendants(ui.elements.get("history-results"), "iframe").length === 1);
  const oldZone = ui.descendants(ui.elements.get("history-results")).find(element => element.className === "preview-zone");
  assert.equal(ui.observed.has(oldZone), true);
  await historyRows(ui)[0].fire("click");
  await waitFor(() => ui.descendants(ui.elements.get("history-results"), "iframe").length === 1);
  assert.equal(ui.observed.has(oldZone), false, "Detached cards must stop retaining observer references");
  assert.equal(ui.observed.size, 3, "Current, recent, and selected history cards each retain their own observer");
  ui.event("removed", { ids: [earlierId, id] });
  await waitFor(() => ui.descendants(ui.elements.get("results"), "article").length === 0);
  assert.equal(ui.descendants(ui.elements.get("history-results"), "article").length, 0);
  assert.equal(ui.observed.size, 0);
});

test("legacy results restore on startup and remain in history when the current batch is deleted", async () => {
  const earlierId = "828715f8-bf8c-4669-a027-66b13e432291", legacy = { ...run, batchId: undefined };
  const earlier = { ...legacy, id: earlierId, createdAt: "2026-11-11T00:00:00Z" };
  const ui = await uiHarness({ bootstrap: boot([legacy, earlier]), detail: async (value) => ({ ...(value === earlierId ? earlier : legacy), html: FIXTURE_HTML, previewUrl: `preview/${value}?key=test` }) });
  await waitFor(() => ui.elements.get("history-count").textContent === "2 批");
  assert.equal(ui.descendants(ui.elements.get("results"), "article").length, 1, "Legacy records still need to open automatically");
  ui.event("removed", { ids: [id] });
  await waitFor(() => ui.elements.get("history-count").textContent === "1 批");
  assert.equal(ui.descendants(ui.elements.get("results"), "article").length, 0, "An older result must not silently become the current batch");
  await historyRows(ui)[0].fire("click");
  const card = ui.descendants(ui.elements.get("history-results"), "article")[0];
  assert.equal(card?.dataset.runId, earlierId, "The remaining legacy batch must stay accessible in history");
});

test("browser-open control sends only the saved result ID and keeps the preview running", async () => {
  const opened = [];
  const ui = await uiHarness({ bootstrap: boot([run]), detail: async () => ({ ...run, html: FIXTURE_HTML, previewUrl: `preview/${id}?key=test` }),
    open: async (value) => { opened.push(value); return { opened: true }; } });
  await waitFor(() => ui.descendants(ui.elements.get("results"), "iframe").length === 1);
  const frame = ui.descendants(ui.elements.get("results"), "iframe")[0];
  const button = control(ui, "在浏览器打开"); assert.ok(button, "Every completed animation needs a browser-open action");
  await button.fire("click");
  assert.deepEqual(opened, [id]);
  assert.equal(ui.descendants(ui.elements.get("results"), "iframe")[0], frame);
});

test("a delayed browser-open response cannot recreate a card after switching the historical batch", async () => {
  const earlierId = "828715f8-bf8c-4669-a027-66b13e432291", earlier = { ...run, id: earlierId, batchId: earlierId, createdAt: "2026-11-11T00:00:00Z" };
  let release; const ui = await uiHarness({ bootstrap: boot([run, earlier]), detail: value => ({ ...(value === earlierId ? earlier : run), html: FIXTURE_HTML, previewUrl: `preview/${value}?key=test` }),
    open: () => new Promise(resolve => { release = () => resolve({ opened: true }); }) });
  await waitFor(() => historyRows(ui).length === 2); await historyRows(ui)[1].fire("click");
  await waitFor(() => ui.descendants(ui.elements.get("history-results"), "iframe").length === 1);
  const button = ui.descendants(ui.elements.get("history-results"), "button").find(element => element.attributes["aria-label"] === "在浏览器打开");
  const opening = button.fire("click"); await waitFor(() => Boolean(release));
  await historyRows(ui)[0].fire("click"); release(); await opening;
  const cards = ui.descendants(ui.elements.get("history-results"), "article"); assert.equal(cards.length, 1); assert.equal(cards[0].dataset.runId, id);
});

test("catalog refresh resets unsupported effort while preserving the selected model", async () => {
  const stream = new ReadableStream();
  const ui = await uiHarness({ request: (path, options = {}) => {
    if (path === "api/bootstrap") return Response.json(boot([]));
    if (path === "api/events") return new Response(stream);
    if (path === "api/models") return Response.json({ models: [{ ...model, efforts: [] }] });
    if (path === "api/runs" && options.method === "POST") { assert.equal(JSON.parse(options.body).models[0].effort, ""); return Response.json({ runs: [{ ...run, status: "queued" }] }); }
    throw new Error(path);
  } });
  await chooseProvider(ui); const input = ui.descendants(ui.elements.get("model-list"), "input")[0]; input.checked = true; await input.fire("change");
  const effort = ui.descendants(ui.elements.get("selected-models"), "select")[0]; effort.value = "low"; await effort.fire("change");
  await ui.elements.get("refresh-models").fire("click"); assert.equal(ui.descendants(ui.elements.get("selected-models"), "select")[0].value, "");
  await ui.elements.get("generate").fire("click"); assert.equal(ui.descendants(ui.elements.get("results"), "article").length, 1);
});

test("thumbnail scales a full logical viewport instead of cropping a fixed-size animation", async () => {
  const ui = await uiHarness({ bootstrap: boot([run]), detail: async () => ({ ...run, html: FIXTURE_HTML, previewUrl: `preview/${id}?key=test` }) });
  await waitFor(() => ui.descendants(ui.elements.get("results"), "iframe").length === 1);
  const frame = ui.descendants(ui.elements.get("results"), "iframe")[0];
  assert.equal(frame.style.width, "960px");
  assert.equal(frame.style.height, "600px");
  assert.equal(frame.style.transform, "translate(-50%, -50%) scale(0.2)", "A 200×120 card must contain the full 960×600 viewport");
  ui.message({ source: {}, data: { type: "pelican-preview", id, kind: "size", width: 2000, height: 1000 } });
  assert.equal(frame.style.width, "960px", "Other frames cannot change an animation's preview size");
  ui.message({ source: frame.contentWindow, data: { type: "pelican-preview", id, kind: "size", width: 2000, height: 1000 } });
  assert.equal(frame.style.width, "2000px");
  assert.equal(frame.style.transform, "translate(-50%, -50%) scale(0.1)");
});

test("preview controls unload the frame and reload without a new model request", async () => {
  const ui = await uiHarness({ bootstrap: boot([run]), detail: async () => ({ ...run, html: FIXTURE_HTML, content: FIXTURE_HTML, previewUrl: `preview/${id}?key=test` }) });
  await waitFor(() => ui.descendants(ui.elements.get("results"), "iframe").length === 1);
  await control(ui, "源码与详情").fire("click");
  const panel = ui.elements.get("drawer-content");
  const stop = ui.descendants(ui.elements.get("drawer-footer"), "button").find(button => button.getAttribute("aria-label") === "停止预览");
  assert.equal(ui.descendants(panel, "iframe").length, 1);
  await stop.fire("click");
  assert.equal(ui.descendants(ui.elements.get("results"), "iframe").length, 0);
  assert.equal(ui.descendants(panel, "iframe").length, 0);
  assert.equal(stop.attributes["aria-label"] || stop.textContent, "播放预览");
  await stop.fire("click");
  assert.equal(ui.descendants(ui.elements.get("results"), "iframe").length, 1);
  assert.equal(ui.descendants(panel, "iframe").length, 1);
});

test("replay obtains a current preview link instead of reusing the cached one", async () => {
  let details = 0;
  const ui = await uiHarness({ bootstrap: boot([run]), detail: async () => ({ ...run, html: FIXTURE_HTML, content: FIXTURE_HTML,
    previewUrl: `preview/${id}?key=${++details === 1 ? "old" : "current"}` }) });
  await waitFor(() => ui.descendants(ui.elements.get("results"), "iframe").length === 1);
  await control(ui, "重播").fire("click");
  await waitFor(() => ui.descendants(ui.elements.get("results"), "iframe").length === 1);
  assert.equal(ui.descendants(ui.elements.get("results"), "iframe")[0].src, `preview/${id}?key=current`);
});

test("failed replay shows a recoverable error and a later replay loads the saved result", async () => {
  let attempts = 0;
  const ui = await uiHarness({ bootstrap: boot([run]), detail: async () => {
    if (++attempts === 2) throw new Error("temporary preview failure");
    return { ...run, html: FIXTURE_HTML, previewUrl: `preview/${id}?key=test` };
  } });
  await waitFor(() => ui.descendants(ui.elements.get("results"), "iframe").length === 1);
  const replay = control(ui, "重播");
  await replay.fire("click");
  assert.equal(ui.descendants(ui.elements.get("results"), "iframe").length, 0);
  const error = ui.descendants(ui.elements.get("results")).find(element => element.className === "error-summary");
  const errorDetail = control(ui, "查看错误详情");
  assert.ok(errorDetail);
  assert.equal(error.hidden, false);
  assert.equal(replay.disabled, false);
  assert.equal(attempts, 2, "A failed detail request must not trigger a render/request loop");
  await errorDetail.fire("click");
  assert.ok(ui.descendants(ui.elements.get("drawer-content")).some(element => element.textContent === "temporary preview failure"));
  await ui.elements.get("drawer-close").fire("click");
  await replay.fire("click");
  assert.equal(ui.descendants(ui.elements.get("results"), "iframe").length, 1);
  assert.equal(error.hidden, true);
});

test("opening saved animation details retries an earlier failed read", async () => {
  let reads = 0;
  const ui = await uiHarness({ bootstrap: boot([run]), detail: () => {
    if (++reads === 1) throw new Error("Temporary read failure");
    return { ...run, html: FIXTURE_HTML, previewUrl: `preview/${id}?key=fixture` };
  } });
  await waitFor(() => control(ui, "查看错误详情")?.getClientRects().length);
  assert.equal(reads, 1);
  await control(ui, "源码与详情").fire("click");
  await waitFor(() => ui.descendants(ui.elements.get("results"), "iframe").length === 1);
  assert.equal(reads, 2);
});

test("animation details use the shared right drawer with preview, source and original output", async () => {
  const ui = await uiHarness({ bootstrap: boot([run]), detail: async () => ({ ...run, html: FIXTURE_HTML, content: "original response",
    usage: { total_tokens: 160 }, elapsedMs: 2000, previewUrl: `preview/${id}?key=test` }) });
  await waitFor(() => ui.descendants(ui.elements.get("results"), "iframe").length === 1);
  const toggle = control(ui, "源码与详情");
  assert.ok(toggle, "Secondary result actions need one disclosure control");
  const drawer = ui.elements.get("favorite-drawer"), panel = ui.elements.get("drawer-content");
  assert.equal(drawer.hidden, true);
  toggle.focus();
  await toggle.fire("click");
  assert.equal(drawer.hidden, false);
  assert.equal(drawer.dataset.mode, "reading");
  assert.equal(ui.elements.get("drawer-title").textContent, "动画详情");
  assert.equal(ui.descendants(panel, "iframe")[0].getAttribute("sandbox"), "allow-scripts");
  await drawerControl(ui, "HTML 源码").fire("click");
  assert.equal(ui.descendants(panel, "pre")[0].textContent, FIXTURE_HTML);
  assert.ok(ui.descendants(panel, "span").some((element) => element.textContent === "160"));
  await drawerControl(ui, "复制源码").fire("click");
  assert.deepEqual(ui.copied, [FIXTURE_HTML]);
  await drawerControl(ui, "原始输出").fire("click");
  assert.equal(ui.descendants(panel, "pre")[0].textContent, "original response");
  assert.equal(ui.descendants(panel, "iframe").length, 0, "The large preview unloads when reading output");
  assert.equal(ui.descendants(ui.elements.get("results"), "iframe").length, 1, "Inspecting source must keep the existing preview mounted");
  await drawer.fire("keydown", { key: "Escape" });
  assert.equal(drawer.hidden, true);
  assert.equal(ui.document.activeElement, toggle);
});

test("animation details collapse the raw error unless opened from the error button", async () => {
  const raw = "Fixture: upstream request failed (HTTP 502)", failed = { ...run, status: "error", hasHTML: false, error: raw };
  const ui = await uiHarness({ bootstrap: boot([failed]), detail: () => failed });
  const drawer = ui.elements.get("favorite-drawer"), panel = ui.elements.get("drawer-content");
  const disclosure = () => ui.descendants(panel, "summary").find(item => item.textContent === "原始错误详情");
  await waitFor(() => control(ui, "查看错误详情")?.getClientRects().length);
  const errorButton = control(ui, "查看错误详情");
  await control(ui, "源码与详情").fire("click");
  assert.ok(disclosure(), "The raw error must have a disclosure");
  assert.equal(disclosure().parentElement.open, false);
  const errorText = ui.descendants(disclosure().parentElement, "pre")[0];
  assert.equal(errorText.textContent, raw);
  assert.equal(errorText.getClientRects().length, 0);
  await drawer.fire("keydown", { key: "Escape" });
  await errorButton.fire("click");
  assert.equal(disclosure().parentElement.open, true);
  assert.equal(ui.document.activeElement, disclosure());
  await drawer.fire("keydown", { key: "Escape" });
  assert.equal(ui.document.activeElement, errorButton);
});

test("replay after a host restart reloads the expired page and resumes its saved result without a model request", async (t) => {
  const upstream = await fakeGateway(t), dir = await temporary(t);
  let service = await startServer({ port: 0, dataDir: dir, gatewayUrl: upstream.url });
  t.after(() => service.close());
  const html = await (await fetch(service.url)).text();
  const token = html.match(/name="pelican-token" content="([a-f0-9]+)"/)[1];
  let sessionReloads = 0, expiredRequests = 0, resumedUI, navigation;
  const request = async (path, options) => {
    if (path === "./") throw new Error("The opaque Magpie sandbox cannot read the public page through fetch");
    const response = await fetch(new URL(path, service.url), { ...options, headers: { ...options.headers, origin: "null" } });
    if (path.startsWith("api/") && response.status === 403) expiredRequests++;
    return response;
  };
  const ui = await uiHarness({ token, request, navigate: (target) => {
    sessionReloads++;
    navigation = (async () => {
      const url = new URL(target, service.url);
      const page = await (await fetch(url)).text();
      const currentToken = page.match(/name="pelican-token" content="([a-f0-9]+)"/)[1];
      resumedUI = await uiHarness({ token: currentToken, request, search: url.search });
    })();
  } });
  await chooseProvider(ui);
  const input = ui.descendants(ui.elements.get("model-list"), "input")[0];
  input.checked = true; await input.fire("change");
  await ui.elements.get("generate").fire("click");
  await waitFor(() => ui.descendants(ui.elements.get("results"), "iframe").length === 1);
  const originalUrl = ui.descendants(ui.elements.get("results"), "iframe")[0].src;
  const port = service.port;
  await service.close();
  service = await startServer({ port, dataDir: dir, gatewayUrl: upstream.url });
  await service.ready;
  await control(ui, "重播").fire("click");
  assert.equal(sessionReloads, 1, "An opaque sandbox must navigate to get a new session");
  await navigation;
  await waitFor(() => resumedUI.descendants(resumedUI.elements.get("results"), "iframe").length === 1);
  const frame = resumedUI.descendants(resumedUI.elements.get("results"), "iframe")[0];
  assert.equal((await fetch(new URL(frame.src, service.url))).status, 200);
  assert.equal(frame.src, originalUrl, "Saved preview capabilities should survive a restart");
  assert.equal(expiredRequests, 1, "The former API session must be rejected before it is renewed");
  assert.equal(upstream.seen.requests.length, 1);
});

test("history batch deletion through the UI removes stored files and keeps the current result available", async (t) => {
  const upstream = await fakeGateway(t), dir = await temporary(t);
  const service = await startServer({ port: 0, dataDir: dir, gatewayUrl: upstream.url }); t.after(() => service.close());
  const page = await (await fetch(service.url)).text(), token = page.match(/name="pelican-token" content="([a-f0-9]+)"/)[1];
  const headers = { "x-pelican-token": token };
  const ui = await uiHarness({ token, request: (path, options) => fetch(new URL(path, service.url), { ...options, headers: { ...options.headers, origin: "null" } }) });
  await chooseProvider(ui);
  const input = ui.descendants(ui.elements.get("model-list"), "input")[0]; input.checked = true; await input.fire("change");
  await ui.elements.get("generate").fire("click");
  await waitFor(() => ui.descendants(ui.elements.get("results"), "iframe").length === 1);
  const first = (await (await fetch(service.url + "api/runs", { headers })).json()).runs[0];
  await ui.elements.get("generate").fire("click");
  await waitFor(() => ui.descendants(ui.elements.get("results"), "iframe").length === 1);
  await waitFor(() => ui.elements.get("history-count").textContent === "2 批");
  const frame = ui.descendants(ui.elements.get("results"), "iframe")[0];
  await ui.elements.get("history-tab").fire("click");
  await historyRows(ui)[1].fire("click");
  await waitFor(() => ui.descendants(ui.elements.get("history-results"), "iframe").length === 1);
  assert.equal(ui.descendants(ui.elements.get("history-results"), "article")[0].dataset.runId, first.id);
  assert.ok(await readFile(first.files.html, "utf8"));
  await ui.elements.get("manage-history").fire("click");
  await (await confirmClick(ui, historyDeletes(ui)[1], false)).completion;
  assert.equal(ui.elements.get("history-count").textContent, "2 批");
  assert.ok(await readFile(first.files.html, "utf8"));
  await (await confirmClick(ui, historyDeletes(ui)[1])).completion;
  assert.equal(ui.elements.get("history-count").textContent, "1 批");
  await assert.rejects(() => readFile(first.files.html), error => error.code === "ENOENT");
  await assert.rejects(() => readFile(first.files.metadata), error => error.code === "ENOENT");
  assert.equal(ui.descendants(ui.elements.get("history-results"), "article").length, 0);
  await ui.elements.get("current-tab").fire("click");
  assert.equal(ui.descendants(ui.elements.get("results"), "iframe")[0].src, frame.src);
  assert.equal((await fetch(new URL(frame.src, service.url))).status, 200);
  assert.equal((await fetch(service.url + "api/runs/" + first.id, { headers })).status, 404);
  assert.equal(upstream.seen.requests.length, 2, "History operations must not invoke another model request");
});

test("provider selection and Generate click reach the HTTP service, save HTML and offer a protected preview", async (t) => {
  const upstream = await fakeGateway(t);
  const service = await startServer({ port: 0, dataDir: await temporary(t), gatewayUrl: upstream.url });
  t.after(() => service.close());
  const html = await (await fetch(service.url)).text();
  const token = html.match(/name="pelican-token" content="([a-f0-9]+)"/)[1];
  const ui = await uiHarness({ token, request: (path, options) => fetch(new URL(path, service.url), {
    ...options, headers: { ...options.headers, origin: "null" },
  }) });
  await chooseProvider(ui);
  const input = ui.descendants(ui.elements.get("model-list"), "input")[0];
  input.checked = true; await input.fire("change");
  await ui.elements.get("generate").fire("click");
  await waitFor(() => ui.descendants(ui.elements.get("results"), "iframe").length === 1);
  assert.equal(upstream.seen.requests.length, 1);
  assert.equal(upstream.seen.requests[0].model, "fixture/one");
  const headers = { "x-pelican-token": token };
  const { runs } = await (await fetch(service.url + "api/runs", { headers })).json();
  assert.equal(runs[0].status, "completed");
  assert.equal(await readFile(runs[0].files.html, "utf8"), FIXTURE_HTML);
  const frame = ui.descendants(ui.elements.get("results"), "iframe")[0];
  const preview = await fetch(new URL(frame.src, service.url));
  assert.equal(preview.status, 200);
  assert.ok(preview.headers.get("content-security-policy").includes("connect-src 'none'"));
  assert.ok((await preview.text()).includes("pelican-preview"));
});
