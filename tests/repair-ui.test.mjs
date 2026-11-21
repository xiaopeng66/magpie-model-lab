import test from "node:test";
import assert from "node:assert/strict";
import { uiHarness } from "./ui-harness.mjs";
import { waitFor } from "./helpers.mjs";

const model = { id: "fixture/one", name: "One", provider: "fixture", providerName: "Fixture", efforts: ["low", "high"] };
const favorite = { id: "favorite-one", modelId: model.id, modelName: model.name, provider: model.provider, providerName: model.providerName, maxTokens: 64000, available: true };
const state = { favorites: [favorite], plans: [{ id: "plan-one", favoriteIds: [favorite.id], kinds: ["candy"], mode: "times", times: ["09:00"], days: [1, 2, 3, 4, 5], timeZone: "UTC", enabled: true }], enabled: true, concurrency: 3 };
const boot = { models: [model], runs: [], defaultPrompt: "fixture", favoritesAvailable: true, candyAvailable: true, fingerprintAvailable: true, favorites: state };
const controls = (ui, tag) => ["drawer-content", "drawer-footer"].flatMap(id => ui.descendants(ui.elements.get(id), tag));

for (const kind of ["manager", "plan"]) for (const success of [true, false]) test(`A100-005: ${kind} save locks its form until ${success ? "success" : "failure"} and retains the draft on failure`, async t => {
  let release, entered, savedBody;
  const started = new Promise(resolve => { entered = resolve; }), pending = new Promise((resolve, reject) => { release = () => success ? resolve({}) : reject(new Error("fixture save failed")); });
  t.after(() => release?.());
  const ui = await uiHarness({ bootstrap: boot, favorites: async (path, body) => {
    if (path === "api/favorites") return state;
    savedBody = body; entered(); return pending;
  } });
  t.after(() => ui.closeStream()); await waitFor(() => ui.descendants(ui.elements.get("model-list"), "input").length);
  await ui.elements.get("favorites-tab").fire("click");
  if (kind === "manager") await ui.elements.get("favorite-manage").fire("click");
  else await ui.descendants(ui.elements.get("favorite-candy-grid"), "button").find(control => control.getAttribute("aria-label")?.startsWith("设置 ")).fire("click");
  const input = controls(ui, "input").find(control => kind === "manager" ? control.getAttribute("aria-label") === "自动请求并行数" : control.placeholder === "09:00, 12:30, 18:00");
  input.value = kind === "manager" ? "4" : "10:00"; await input.fire("input");
  const save = controls(ui, "button").find(control => control.textContent === (kind === "manager" ? "保存设置" : "保存计划"));
  const saving = save.fire("click"); await started;
  assert.equal(input.disabled, true, "A user must not create a newer draft during an outstanding save");
  assert.ok(controls(ui, "input").every(control => control.disabled));
  assert.equal(save.disabled, true); assert.equal(save.getAttribute("aria-busy"), "true");
  assert.equal(kind === "manager" ? savedBody.concurrency : savedBody.times[0], kind === "manager" ? 4 : "10:00");
  release(); await saving;
  assert.equal(ui.elements.get("favorite-drawer").hidden, success);
  if (!success) {
    assert.equal(input.disabled, false); assert.equal(input.value, kind === "manager" ? "4" : "10:00");
    assert.equal(save.disabled, false); assert.match(ui.elements.get("drawer-status").textContent, /fixture save failed/);
  }
});

test("A100-006: cached accounts update options without replacing a focused account input or its selection", async t => {
  let release; const pending = new Promise(resolve => { release = resolve; }); t.after(() => release?.([]));
  const ui = await uiHarness({ bootstrap: boot, accounts: () => pending }); t.after(() => ui.closeStream());
  await waitFor(() => ui.descendants(ui.elements.get("model-list"), "input").length);
  await ui.elements.get("fingerprint-tab").fire("click");
  const pick = ui.descendants(ui.elements.get("model-list"), "input")[0]; pick.checked = true; await pick.fire("change");
  const pin = ui.elements.get("fp-pin"); pin.checked = true; const loading = pin.fire("change");
  const input = ui.descendants(ui.elements.get("selected-models"), "input")[0];
  input.value = "review-account-"; await input.fire("input"); input.focus(); input.selectionStart = 7; input.selectionEnd = 14;
  release([{ provider: "fixture", id: "cached", name: "Cached account" }]); await loading;
  assert.equal(ui.descendants(ui.elements.get("selected-models"), "input")[0], input);
  assert.equal(input.isConnected, true); assert.equal(ui.document.activeElement, input);
  assert.equal(input.value, "review-account-"); assert.equal(input.selectionStart, 7); assert.equal(input.selectionEnd, 14);
  assert.equal(ui.descendants(ui.elements.get("selected-models"), "option").some(option => option.value === "cached"), true);
});

test("A100-006: a late add-favorite list refresh retains focus on a newly selected model", async t => {
  let release, entered; const started = new Promise(resolve => { entered = resolve; }), pending = new Promise(resolve => { release = resolve; });
  t.after(() => release?.({}));
  const empty = { ...state, favorites: [], plans: [] }, models = [model, { ...model, id: "fixture/two", name: "Two" }];
  const ui = await uiHarness({ bootstrap: { ...boot, models, favorites: empty }, favorites: async (path) => {
    if (path === "api/favorites") return { ...empty, favorites: [favorite] };
    entered(); return pending;
  } }); t.after(() => ui.closeStream());
  await waitFor(() => ui.descendants(ui.elements.get("model-list"), "input").length === 2);
  await ui.elements.get("favorites-tab").fire("click"); await ui.elements.get("favorite-add").fire("click");
  const boxes = controls(ui, "input").filter(input => input.type === "checkbox");
  boxes[0].checked = true; await boxes[0].fire("change");
  const saving = controls(ui, "button").find(control => control.textContent.startsWith("添加模型")).fire("click"); await started;
  boxes[1].checked = true; await boxes[1].fire("change"); boxes[1].focus();
  release({}); await saving;
  assert.equal(ui.elements.get("favorite-drawer").hidden, false);
  assert.equal(ui.document.activeElement.isConnected, true);
  assert.equal(ui.document.activeElement.getAttribute("aria-label"), "Two · Fixture");
  assert.equal(ui.document.activeElement.checked, true); assert.equal(ui.document.activeElement.disabled, false);
});
