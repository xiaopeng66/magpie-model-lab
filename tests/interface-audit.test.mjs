import test from "node:test";
import assert from "node:assert/strict";
import { uiHarness } from "./ui-harness.mjs";
import { waitFor } from "./helpers.mjs";

const model = { id: "fixture/one", name: "One · Supplier", provider: "fixture", providerName: "Supplier", efforts: ["low"] };
const favorite = { id: "f-one", modelId: model.id, modelName: model.name, provider: model.provider, providerName: model.providerName, available: true, effort: "", maxTokens: 64000, prompt: "animate" };
const plan = { id: "p-one", revision: 1, favoriteIds: [favorite.id], kinds: ["candy"], enabled: true, name: "糖果", mode: "times", times: ["09:00", "12:00"],
  days: [1, 2, 3, 4, 5], timeZone: "Asia/Shanghai", intervalMinutes: 60, start: "09:00", end: "18:00", allDay: false,
  today: { date: "2026-11-14", slots: ["09:00", "12:00"].map(time => ({ key: `slot-${time}`, label: time, state: "waiting" })) } };
const run = { id: "one", batchId: "batch-one", kind: "candy", model: model.id, modelName: model.name, provider: model.provider, providerName: model.providerName,
  favoriteId: favorite.id, source: "automatic", plans: [{ id: plan.id, triggerKey: "slot-09:00" }], createdAt: "2026-11-14T01:00:00Z", status: "running" };
const boot = { models: [model], runs: [run], defaultPrompt: "animate", favoritesAvailable: true, candyAvailable: true, fingerprintAvailable: true, batchCleanup: true,
  favorites: { favorites: [favorite], plans: [plan], concurrency: 3, maxDailySlots: 24 } };
const drawer = ui => ui.elements.get("drawer-content");
const footer = ui => ui.elements.get("drawer-footer");
const grid = ui => ui.elements.get("favorite-candy-grid");
const buttons = (ui, root) => ui.descendants(root, "button");
const label = (ui, root, value) => buttons(ui, root).find(item => item.textContent === value || item.getAttribute("aria-label") === value);
const field = (ui, value) => ui.descendants(drawer(ui), "label").find(row => row.children[0]?.textContent === value)?.children[1];
const bars = ui => buttons(ui, grid(ui)).filter(item => item.className === "candy-bar");
async function ready(ui, tab = "favorites") { await waitFor(() => ui.descendants(ui.elements.get("model-list"), "input").length); await ui.elements.get(tab + "-tab").fire("click"); }
async function settings(ui) { const control = label(ui, grid(ui), "设置 One 的糖果计划"); control.focus(); await control.fire("click"); return control; }
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };

test("automatic state transitions preserve card, slot buttons and keyboard focus", async () => {
  const ui = await uiHarness({ bootstrap: boot }); await ready(ui);
  const card = ui.descendants(grid(ui), "article")[0], bar = bars(ui)[0], settings = label(ui, card, "设置 One 的糖果计划"); bar.focus();
  ui.event("run", { run: { ...run, status: "completed", candy: { verdict: "match", answer: 21 } } });
  await waitFor(() => bars(ui)[0].dataset.verdict === "match");
  assert.ok(ui.descendants(grid(ui), "article")[0] === card);
  assert.ok(bars(ui)[0] === bar); assert.equal(bar.isConnected, true); assert.ok(ui.document.activeElement === bar);
  assert.ok(label(ui, card, "设置 One 的糖果计划") === settings);
});

test("saving a plan stays locked while input changes and cannot submit twice", async t => {
  const waiting = deferred(), calls = []; t.after(() => waiting.resolve({ plan }));
  const ui = await uiHarness({ bootstrap: boot, favorites: (path, body) => { if (path.endsWith("save")) { calls.push(body); return waiting.promise; } return boot.favorites; } });
  await ready(ui); await settings(ui);
  field(ui, "每天这些时刻 · 逗号分隔").value = "10:30"; await field(ui, "每天这些时刻 · 逗号分隔").fire("input");
  const save = label(ui, footer(ui), "保存计划"), saving = save.fire("click");
  field(ui, "每天这些时刻 · 逗号分隔").value = "10:00"; await field(ui, "每天这些时刻 · 逗号分隔").fire("input");
  assert.equal(save.disabled, true); await save.fire("click"); assert.equal(calls.length, 1);
  waiting.resolve({ plan }); await saving;
});

test("inactive interval drafts do not block a valid specified-time plan", async () => {
  let sent;
  const ui = await uiHarness({ bootstrap: boot, favorites: (path, body) => { if (path.endsWith("save")) { sent = body; return { plan }; } return boot.favorites; } });
  await ready(ui); await settings(ui);
  field(ui, "执行方式").value = "interval"; await field(ui, "执行方式").fire("change");
  field(ui, "间隔 · 分钟").value = ""; field(ui, "开始时间").value = "";
  field(ui, "执行方式").value = "times"; await field(ui, "执行方式").fire("change");
  field(ui, "每天这些时刻 · 逗号分隔").value = "10:30"; await field(ui, "每天这些时刻 · 逗号分隔").fire("input");
  await label(ui, footer(ui), "保存计划").fire("click");
  assert.equal(sent.mode, "times");
  assert.equal(sent.intervalMinutes, undefined, "Inactive inputs must be omitted so valid server defaults/prior values apply");
  assert.equal(sent.start, undefined);
});

test("invalid timezone is shown before saving and correcting it restores save", async () => {
  const ui = await uiHarness({ bootstrap: boot }); await ready(ui); await settings(ui);
  field(ui, "时区").value = "invalid/nowhere"; await field(ui, "时区").fire("input");
  assert.equal(label(ui, footer(ui), "保存计划").disabled, true);
  field(ui, "时区").value = "UTC"; await field(ui, "时区").fire("input");
  assert.equal(label(ui, footer(ui), "保存计划").disabled, false);
});

test("plan parameters are visible without a nested editor and closing restores focus", async () => {
  const ui = await uiHarness({ bootstrap: boot }); await ready(ui);
  drawer(ui).scrollTop = 500; const opener = await settings(ui);
  assert.equal(drawer(ui).scrollTop, 0); assert.ok(field(ui, "输出上限 · Token").getClientRects().length);
  await ui.elements.get("drawer-close").fire("click");
  assert.ok(ui.document.activeElement === opener); assert.equal(opener.isConnected, true);
});

test("a late slot cancellation cannot close a newer settings drawer", async t => {
  const waiting = deferred(); t.after(() => waiting.resolve({ ...run, status: "cancelled" })); let count = 0;
  const ui = await uiHarness({ bootstrap: boot, detail: () => ++count === 1 ? { ...run, content: "" } : waiting.promise }); await ready(ui);
  await bars(ui)[0].fire("click"); const cancelling = label(ui, footer(ui), "取消本次").fire("click");
  await ui.elements.get("drawer-close").fire("click"); await settings(ui);
  waiting.resolve({ ...run, status: "cancelled" }); await cancelling;
  assert.equal(ui.elements.get("favorite-drawer").hidden, false); assert.equal(ui.elements.get("drawer-title").textContent, "糖果计划");
});

test("copy waits for an actual reply; finished record details include the final reasoning", async () => {
  let detail = { ...run, content: "", reasoning: "" };
  const ui = await uiHarness({ bootstrap: boot, detail: () => structuredClone(detail) }); await ready(ui); await bars(ui)[0].fire("click");
  const copy = label(ui, ui.elements.get("drawer-tools"), "复制回答"); assert.equal(copy.disabled, true);
  detail = { ...run, status: "completed", content: "最终答案：21", reasoning: "最终推理", candy: { verdict: "match", answer: 21 }, usage: { total_tokens: 120 } };
  ui.event("run", { run: detail }); await waitFor(() => ui.descendants(drawer(ui)).some(e => e.textContent === "最终答案：21"));
  assert.equal(copy.disabled, false);
  await copy.fire("click"); assert.equal(ui.copied.at(-1), "最终答案：21");
  await label(ui, drawer(ui), "思考").fire("click"); assert.ok(ui.descendants(drawer(ui)).some(e => e.textContent === "最终推理"));
});

test("switching history source excludes automatic runs from legacy favorites and hides mismatched preview", async () => {
  const records = [run, { ...run, id: "old", batchId: "old-batch", source: "manual" }, { ...run, id: "manual", batchId: "manual-batch", favoriteId: undefined, source: "manual" }];
  const ui = await uiHarness({ bootstrap: { ...boot, runs: records } }); await ready(ui, "history");
  await buttons(ui, ui.elements.get("history-list")).find(e => e.className === "history-row").fire("click");
  ui.elements.get("history-source").value = "favorites"; await ui.elements.get("history-source").fire("change");
  const rows = ui.descendants(ui.elements.get("history-list")).filter(e => e.className === "history-item");
  assert.equal(rows.length, 1); assert.equal(rows[0].dataset.batchId, "old-batch"); assert.equal(ui.elements.get("history-detail").hidden, true);
  ui.elements.get("history-source").value = "manual"; await ui.elements.get("history-source").fire("change");
  assert.deepEqual(ui.descendants(ui.elements.get("history-list")).filter(e => e.className === "history-item").map(e => e.dataset.batchId), ["manual-batch"]);
});

test("an SSE snapshot removes records deleted while disconnected; clean EOF shows disconnected", async () => {
  const ui = await uiHarness({ bootstrap: boot }); await ready(ui, "history");
  ui.event("hello", { runs: [] }); await waitFor(() => ui.elements.get("history-count").textContent === "0 批");
  assert.equal(ui.elements.get("history-detail").hidden, true);
  ui.closeStream(); await waitFor(() => !ui.elements.get("connection").className.includes("online"));
  assert.equal(ui.elements.get("connection").title, "连接中断");
  await waitFor(() => ui.timers.size > 0); ui.runTimer([...ui.timers.keys()][0]);
  await waitFor(() => ui.elements.get("connection").className.includes("online"));
  assert.equal(ui.elements.get("notice").hidden, true, "Recovered connection must clear its own obsolete error");
});

test("adding selected models rejects an empty token limit and stays locked during selection changes", async t => {
  const waiting = deferred(); t.after(() => waiting.resolve({ favorite })); let saves = 0;
  const ui = await uiHarness({ bootstrap: { ...boot, runs: [] }, favorites: path => { if (path.endsWith("save")) { saves++; return waiting.promise; } return boot.favorites; } }); await ready(ui, "candy");
  const pick = ui.descendants(ui.elements.get("model-list"), "input")[0]; pick.checked = true; await pick.fire("change");
  const add = ui.elements.get("favorite-selected"); ui.elements.get("max-tokens").value = ""; await add.fire("click"); assert.equal(saves, 0);
  ui.elements.get("max-tokens").value = "64000"; const adding = add.fire("click");
  await pick.fire("change"); assert.equal(add.disabled, true); await add.fire("click"); assert.equal(saves, 1);
  await ui.elements.get("history-tab").fire("click"); waiting.resolve({ favorite }); await adding;
  assert.equal(ui.elements.get("history-tab").getAttribute("aria-selected"), "true");
});

test("animation plan toggles preserve their scroll container and send only the switch change", async () => {
  const state = structuredClone(boot.favorites); state.plans[0].kinds = ["pelican"]; let sent;
  const ui = await uiHarness({ bootstrap: { ...boot, runs: [], favorites: state }, favorites: (path, body) => {
    if (path.endsWith("save")) { sent = body; Object.assign(state.plans[0], body); return { plan: state.plans[0] }; } return state;
  } }); await ready(ui); await ui.elements.get("favorite-pelican").fire("click");
  const root = ui.elements.get("favorite-results"), lane = ui.descendants(root).find(item => item.className === "animation-lane"); lane.scrollLeft = 180;
  const toggle = label(ui, root, "暂停 One 的动画计划"); toggle.focus(); await toggle.fire("click");
  assert.deepEqual(sent, { id: plan.id, enabled: false });
  assert.ok(ui.descendants(root).includes(lane)); assert.equal(lane.scrollLeft, 180); assert.equal(toggle.isConnected, true);
});

test("slot keyboard navigation and drawer focus loop include expanded source panels", async () => {
  const ui = await uiHarness({ bootstrap: boot, detail: () => ({ ...run, content: "partial answer" }) }); await ready(ui);
  const [first, last] = bars(ui); first.focus(); await first.fire("keydown", { key: "End" }); assert.ok(ui.document.activeElement === last);
  await last.fire("keydown", { key: "Home" }); assert.ok(ui.document.activeElement === first);
  await first.fire("click"); const lastControl = label(ui, footer(ui), "关闭详情"); lastControl.focus();
  await ui.elements.get("favorite-drawer").fire("keydown", { key: "Tab" }); assert.ok(ui.document.activeElement === label(ui, ui.elements.get("drawer-tools"), "复制回答"));
  await ui.elements.get("favorite-drawer").fire("keydown", { key: "Tab", shiftKey: true }); assert.ok(ui.document.activeElement === lastControl);
});

test("late create failure remains visible after switching from a test to history", async t => {
  const waiting = deferred(); t.after(() => waiting.resolve(null));
  const ui = await uiHarness({ bootstrap: { ...boot, runs: [] }, create: async () => { await waiting.promise; throw new Error("测试网络失败"); } }); await ready(ui, "candy");
  const pick = ui.descendants(ui.elements.get("model-list"), "input")[0]; pick.checked = true; await pick.fire("change");
  const creating = ui.elements.get("generate").fire("click"); await ui.elements.get("history-tab").fire("click"); waiting.resolve(); await creating;
  assert.equal(ui.elements.get("notice").hidden, false); assert.match(ui.elements.get("notice").textContent, /测试网络失败/);
});

test("model labels handle unprefixed IDs and legacy records without a model ID", async () => {
  const plain = { ...model, id: "plain-model", name: "plain-model", provider: "plain-model", providerName: "" };
  const ui = await uiHarness({ bootstrap: { ...boot, models: [plain], runs: [{ ...run, model: undefined, modelName: "旧记录", provider: undefined, providerName: undefined, favoriteId: undefined, source: undefined }] } });
  await ready(ui, "candy");
  assert.equal(ui.descendants(ui.elements.get("model-list"), "strong")[0].textContent, "plain-model");
  assert.equal(ui.descendants(ui.elements.get("candy-results"), "h3")[0]?.textContent, "旧记录");
});

test("initial connection failure can retry bootstrap without creating a model request", async () => {
  let attempts = 0; const calls = [];
  const ui = await uiHarness({ request: (path) => {
    calls.push(path);
    if (path === "api/bootstrap") return ++attempts === 1 ? Response.json({ error: "服务正在恢复历史" }, { status: 503 }) : Response.json({ ...boot, runs: [] });
    if (path === "api/events") return new Response(new ReadableStream());
    throw new Error("unexpected " + path);
  } });
  await waitFor(() => !ui.elements.get("notice").hidden);
  const retry = label(ui, ui.elements.get("notice"), "重试连接"); assert.ok(retry); await retry.fire("click");
  await waitFor(() => ui.descendants(ui.elements.get("model-list"), "input").length === 1);
  assert.equal(ui.elements.get("notice").hidden, true); assert.equal(attempts, 2); assert.ok(!calls.includes("api/runs"));
});

test("provider and type changes start automatic results at the top", async () => {
  const ui = await uiHarness({ bootstrap: boot }); await ready(ui);
  const scroll = ui.elements.get("favorite-scroll"); scroll.scrollTop = 420;
  await ui.elements.get("favorite-pelican").fire("click"); assert.equal(scroll.scrollTop, 0);
  scroll.scrollTop = 420; ui.elements.get("favorite-provider").value = model.provider;
  await ui.elements.get("favorite-provider").fire("change"); assert.equal(scroll.scrollTop, 0);
});

test("model selections made while adding an earlier selection are kept in the drawer", async t => {
  const waiting = deferred(); t.after(() => waiting.resolve({ favorite }));
  const two = { ...model, id: "fixture/two", name: "Two" }, state = { ...boot.favorites, favorites: [], plans: [] };
  let calls = 0;
  const ui = await uiHarness({ bootstrap: { ...boot, models: [model, two], runs: [], favorites: state }, favorites: async (path, body) => {
    if (path.endsWith("save")) {
      calls++; if (calls === 1) await waiting.promise;
      state.favorites.push({ ...favorite, id: body.modelId, modelId: body.modelId }); return { favorite: state.favorites.at(-1) };
    }
    return state;
  } }); await ready(ui); await ui.elements.get("favorite-add").fire("click");
  const choices = ui.descendants(drawer(ui), "input").filter(item => item.type === "checkbox");
  choices[0].checked = true; await choices[0].fire("change");
  const adding = label(ui, footer(ui), "添加模型 · 1").fire("click");
  choices[1].checked = true; await choices[1].fire("change");
  waiting.resolve({ favorite }); await adding;
  assert.equal(ui.elements.get("favorite-drawer").hidden, false, "Do not discard selections that were not in the submitted snapshot");
  assert.equal(ui.descendants(drawer(ui), "input").find(item => item.getAttribute("aria-label")?.startsWith("Two"))?.checked, true);
  await label(ui, footer(ui), "添加模型 · 1").fire("click");
  assert.equal(calls, 2); assert.equal(ui.elements.get("favorite-drawer").hidden, true);
});

test("removing a selected model keeps keyboard navigation on the next model, then the previous model, then search", async () => {
  const models = [model, { ...model, id: "fixture/two", name: "Two" }, { ...model, id: "fixture/three", name: "Three" }];
  const ui = await uiHarness({ bootstrap: { ...boot, models, runs: [] } }); await ready(ui, "candy");
  for (const pick of ui.descendants(ui.elements.get("model-list"), "input")) { pick.checked = true; await pick.fire("change"); }
  const remove = id => label(ui, ui.elements.get("selected-models"), `移除 ${id}`);
  const middle = remove("fixture/two"); middle.focus(); await middle.fire("click");
  assert.ok(ui.document.activeElement === remove("fixture/three"));
  const last = remove("fixture/three"); last.focus(); await last.fire("click");
  assert.ok(ui.document.activeElement === remove(model.id));
  const final = remove(model.id); final.focus(); await final.fire("click");
  assert.ok(ui.document.activeElement === ui.elements.get("model-search"));
  assert.equal(ui.elements.get("selection-count").textContent, "已选 0");
});
