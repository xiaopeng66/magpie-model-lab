import test from "node:test";
import assert from "node:assert/strict";
import { confirmClick, uiHarness } from "./ui-harness.mjs";
import { waitFor } from "./helpers.mjs";
import { startTestServer as startServer, temporary, FIXTURE_HTML } from "./helpers.mjs";
import { fingerprintGateway, referenceFixture, numberReply } from "./fingerprint-helpers.mjs";
const favorite = { id: "f44a6b2a-416c-497a-af1f-5ba6efa5f9cc", modelId: "fixture/one", modelName: "Fixture · Supplier", provider: "fixture", providerName: "Supplier", available: true,
  effort: "", maxTokens: 32000, prompt: "animate", concurrency: { candy: 3, fingerprint: 3, pelican: 2 }, fingerprint: { api: "auto", strict: false, serviceTier: "default", account: "" }, compareKeys: { candy: "same" } };
const model = { id: favorite.modelId, name: favorite.modelName, provider: favorite.provider, providerName: favorite.providerName, efforts: ["low"] };
const plan = { id: "plan", revision: 1, favoriteIds: [favorite.id], kinds: ["candy"], enabled: true, name: "糖果", mode: "times", times: ["08:00", "08:01", "08:02"], days: [0, 1, 2, 3, 4, 5, 6], timeZone: "Asia/Shanghai",
  today: { date: "2026-11-14", slots: [0, 1, 2].map(i => ({ key: "slot-" + i, label: "08:0" + i, state: "started" })) } };
const runs = [21, 29, null].map((answer, index) => ({ id: `run-${index}`, batchId: `batch-${index}`, favoriteId: favorite.id, compareKey: "same", kind: "candy", model: model.id, modelName: model.name, provider: model.provider, providerName: model.providerName,
  plans: [{ id: plan.id, triggerKey: "slot-" + index }], createdAt: `2026-11-14T00:0${index}:00Z`, status: index === 2 ? "error" : "completed", candy: { answer, verdict: index === 2 ? "incomplete" : answer === 21 ? "match" : "mismatch", version: "shape-choice-v1" } }));
const boot = { models: [model], runs, defaultPrompt: "animate", candyPrompt: "糖果题", candyVersion: "shape-choice-v1", candyAvailable: true, favoritesAvailable: true, fingerprintAvailable: true,
  favorites: { favorites: [favorite], plans: [plan], enabled: true, concurrency: 3 }, batchCleanup: true, version: "test", dataDir: "test-dir" };

for (const cancel of ['button', 'Escape']) test(`canceling plan deletion with ${cancel} returns focus to the enabled delete control`, async t => {
  const calls = [], ui = await uiHarness({ bootstrap: boot, favorites: async (path, body) => { calls.push([path, body]); return boot.favorites; } });
  t.after(() => ui.closeStream());
  await waitFor(() => ui.descendants(ui.elements.get('model-list'), 'input').length);
  await ui.elements.get('favorites-tab').fire('click');
  const settings = ui.descendants(ui.elements.get('favorite-candy-grid'), 'button').find(control => control.getAttribute('aria-label') === '设置 Fixture 的糖果计划');
  await settings.fire('click');
  const removal = ui.descendants(ui.elements.get('drawer-footer'), 'button').find(control => control.textContent === '删除计划');
  removal.focus(); const completion = removal.fire('click');
  assert.equal(ui.elements.get('confirm-dialog').open, true);
  if (cancel === 'button') await ui.elements.get('confirm-cancel').fire('click');
  else await ui.elements.get('confirm-dialog').fire('cancel');
  await completion;
  assert.equal(ui.elements.get('favorite-drawer').hidden, false);
  assert.equal(removal.disabled, false);
  assert.equal(ui.document.activeElement, removal);
  assert.equal(calls.filter(([path]) => path === 'api/schedules/remove').length, 0);
});

test('composition Escape preserves the open plan and draft until an ordinary Escape', async t => {
  const ui = await uiHarness({ bootstrap: boot }); t.after(() => ui.closeStream());
  await waitFor(() => ui.descendants(ui.elements.get('model-list'), 'input').length);
  await ui.elements.get('favorites-tab').fire('click');
  const settings = ui.descendants(ui.elements.get('favorite-candy-grid'), 'button').find(control => control.getAttribute('aria-label') === '设置 Fixture 的糖果计划');
  await settings.fire('click');
  const field = ui.descendants(ui.elements.get('drawer-content'), 'input')[0]; field.value = '10:00'; field.focus();
  for (const event of [{ key: 'Escape', isComposing: true }, { key: 'Escape', keyCode: 229 }]) {
    await ui.elements.get('favorite-drawer').fire('keydown', event);
    assert.equal(ui.elements.get('favorite-drawer').hidden, false);
    assert.equal(field.isConnected, true); assert.equal(field.value, '10:00');
  }
  await ui.elements.get('favorite-drawer').fire('keydown', { key: 'Escape' });
  assert.equal(ui.elements.get('favorite-drawer').hidden, true);
  assert.equal(ui.document.activeElement, settings);
});

test("candy and favorites tabs disable global generation while history stays separate", async () => {
  const requests = [];
  const ui = await uiHarness({ bootstrap: boot, detail: id => ({ ...runs.find(run => run.id === id), content: "最终答案：21" }), create: body => { requests.push(body); return { runs: [{ ...runs[0], id: "new", batchId: "new" }] }; } });
  assert.ok(ui.elements.get("candy-tab"), "Missing candy tab"); assert.ok(ui.elements.get("favorites-tab"), "Missing favorites tab");
  await waitFor(() => ui.descendants(ui.elements.get("model-list"), "input").length);
  const pick = ui.descendants(ui.elements.get("model-list"), "input")[0]; pick.checked = true; await pick.fire("change");
  await ui.elements.get("candy-tab").fire("click"); assert.equal(ui.elements.get("concurrency").value, "3");
  await ui.elements.get("generate").fire("click"); assert.equal(requests[0].kind, "candy"); assert.equal(requests[0].prompt, undefined);
  await ui.elements.get("favorites-tab").fire("click"); assert.equal(ui.elements.get("generate").disabled, true);
  await ui.elements.get("generate").fire("click"); assert.equal(requests.length, 1);
  await ui.elements.get("history-tab").fire("click"); assert.equal(ui.elements.get("generate").disabled, true);
  assert.equal(ui.elements.get("setup-sidebar").hidden, true);
});

test("favorite candy cards exclude failures from success rate and open each recorded answer", async () => {
  const details = [];
  const ui = await uiHarness({ bootstrap: boot, detail: id => { details.push(id); return { ...runs.find(run => run.id === id), content: "最终答案：29", prompt: "糖果题" }; } });
  assert.ok(ui.elements.get("favorites-tab"), "Missing favorites tab");
  await waitFor(() => ui.descendants(ui.elements.get("model-list"), "input").length);
  await ui.elements.get("favorites-tab").fire("click");
  const grid = ui.elements.get("favorite-candy-grid");
  assert.ok(ui.descendants(grid).some(element => element.textContent === "50%"));
  const bars = ui.descendants(grid, "button").filter(button => button.className.includes("candy-bar"));
  assert.equal(bars.length, 3); assert.deepEqual(bars.map(bar => bar.dataset.verdict), ["match", "mismatch", "incomplete"]);
  const headings = ui.descendants(grid, "h3"); assert.equal(headings[0].textContent, "Fixture");
  await bars[1].fire("click"); assert.equal(ui.elements.get("favorite-drawer").hidden, false);
  assert.ok(details.includes("run-1"));
  assert.ok(ui.descendants(ui.elements.get("drawer-content")).some(element => element.textContent === "最终答案：29"));
  await ui.elements.get("drawer-close").fire("click"); assert.equal(ui.elements.get("favorite-drawer").hidden, true);
});

test("each model toggle changes only its own plan and leaves the other enabled", async () => {
  const calls = [], state = structuredClone(boot.favorites), second = { ...favorite, id: "second", modelId: "fixture/two", modelName: "Second" };
  state.favorites.push(second); state.plans.push({ ...plan, id: "plan-two", favoriteIds: [second.id], times: ["10:00"] });
  const ui = await uiHarness({ bootstrap: { ...boot, runs: [], favorites: state }, favorites: async (path, body) => {
    calls.push([path, body]); if (path.endsWith("save")) { state.plans = state.plans.map(p => p.id === body.id ? { ...p, ...body } : p); return { plan: body }; } return state;
  } });
  await waitFor(() => ui.descendants(ui.elements.get("model-list"), "input").length); await ui.elements.get("favorites-tab").fire("click");
  const toggle = ui.descendants(ui.elements.get("favorite-candy-grid"), "button").find(e => e.attributes["aria-label"] === "暂停 Fixture 的糖果计划");
  await toggle.fire("click"); assert.equal(state.plans[0].enabled, false); assert.equal(state.plans[1].enabled, true);
  assert.equal(calls.filter(([path]) => path.endsWith("save")).length, 1);
});

test("the animation gallery keeps the plan entry but hides empty lanes and timing controls", async t => {
  const ui = await uiHarness({ bootstrap: { ...boot, runs: [], favorites: { ...boot.favorites, plans: [] } } });
  t.after(() => ui.closeStream());
  await waitFor(() => ui.descendants(ui.elements.get("model-list"), "input").length);
  await ui.elements.get("favorites-tab").fire("click");
  await ui.elements.get("favorite-pelican").fire("click");
  const gallery = ui.elements.get("favorite-results");
  assert.equal(ui.elements.get("gallery-navigation").hidden, true);
  assert.ok(ui.descendants(gallery, "button").some(control => control.getAttribute("aria-label") === "设置 Fixture 的动画计划"));
  assert.equal(ui.descendants(gallery).filter(element => element.textContent === "暂无计划").length, 1);
});

test("automatic models paginate without a model ceiling and preserve cards during unrelated updates", async () => {
  const favorites = Array.from({ length: 61 }, (_, index) => ({ ...favorite, id: `favorite-${index}`, modelId: `fixture/${index}`, modelName: `Model ${index}` }));
  const ui = await uiHarness({ bootstrap: { ...boot, runs: [], favorites: { ...boot.favorites, favorites } } });
  await waitFor(() => ui.descendants(ui.elements.get("model-list"), "input").length);
  await ui.elements.get("favorites-tab").fire("click");
  const grid = ui.elements.get("favorite-candy-grid"), first = ui.descendants(grid, "article")[0];
  assert.equal(ui.descendants(grid, "article").length, 24);
  ui.event("run", { run: { ...runs[0], favoriteId: "unrelated", id: "unrelated" } }); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(ui.descendants(grid, "article")[0] === first, true, "Unrelated work must keep focus targets stable");
  await ui.elements.get("favorite-next").fire("click"); await ui.elements.get("favorite-next").fire("click");
  assert.equal(ui.descendants(grid, "article").length, 13); assert.match(ui.elements.get("favorite-page-info").textContent, /61 个模型/);
});

test("offscreen animations load on demand, unload when hidden, and replay the same saved URL", async () => {
  let calls = 0;
  const animation = { ...runs[0], kind: "pelican", hasHTML: true };
  const ui = await uiHarness({ bootstrap: { ...boot, runs: [animation] }, intersection: true, detail: () => { calls++; return { ...animation, html: FIXTURE_HTML, previewUrl: "preview/test?key=saved" }; } });
  await waitFor(() => ui.descendants(ui.elements.get("results"), "article").length);
  const zone = ui.descendants(ui.elements.get("results")).find(element => element.className === "preview-zone");
  assert.equal(calls, 0); ui.intersect(zone, true);
  await waitFor(() => ui.descendants(zone, "iframe").length === 1); const url = ui.descendants(zone, "iframe")[0].src;
  ui.intersect(zone, false); assert.equal(ui.descendants(zone, "iframe").length, 0);
  ui.intersect(zone, true); assert.equal(ui.descendants(zone, "iframe")[0].src, url); assert.equal(calls, 1);
  await ui.elements.get("favorites-tab").fire("click"); assert.equal(ui.descendants(zone, "iframe").length, 0);
});

test("canceling a slot from its detail drawer does not cancel another model", async () => {
  const second = { ...favorite, id: "second", modelId: "fixture/two", modelName: "Second" };
  const working = [{ ...runs[0], status: "running", roundId: "shared" }, { ...runs[1], favoriteId: second.id, model: second.modelId, plans: [{ triggerKey: "second-slot" }], status: "running", roundId: "shared" }];
  const calls = [];
  const ui = await uiHarness({ bootstrap: { ...boot, runs: working, favorites: { ...boot.favorites, favorites: [favorite, second] } }, detail: id => { calls.push(id); return { ...working.find(run => run.id === id), status: calls.length === 1 ? "running" : "cancelled" }; } });
  await waitFor(() => ui.descendants(ui.elements.get("model-list"), "input").length);
  await ui.elements.get("favorites-tab").fire("click");
  const bar = ui.descendants(ui.elements.get("favorite-candy-grid"), "button").find(e => e.className === "candy-bar");
  await bar.fire("click");
  const cancel = ui.descendants(ui.elements.get("drawer-footer"), "button").find(e => e.textContent === "取消本次");
  assert.ok(cancel); await cancel.fire("click"); assert.ok(calls.every(id => id === working[0].id));
});

test("a delayed plan save cannot replace a result drawer opened more recently", async t => {
  let release; const pending = new Promise(resolve => { release = resolve; }); t.after(() => release({ plan: {} }));
  const ui = await uiHarness({ bootstrap: boot, detail: id => ({ ...runs.find(run => run.id === id), content: "保存期间打开的回答" }), favorites: async path => path === "api/schedules/save" ? pending : boot.favorites });
  await waitFor(() => ui.descendants(ui.elements.get("model-list"), "input").length);
  await ui.elements.get("favorites-tab").fire("click"); await ui.descendants(ui.elements.get("favorite-candy-grid"), "button").find(e => e.attributes["aria-label"] === "设置 Fixture 的糖果计划").fire("click");
  const times = ui.descendants(ui.elements.get("drawer-content"), "label").find(row => row.children[0]?.textContent === "每天这些时刻 · 逗号分隔").children[1];
  times.value = "10:00"; await times.fire("input");
  const saving = ui.descendants(ui.elements.get("drawer-footer"), "button").find(button => button.textContent === "保存计划").fire("click");
  await ui.elements.get("drawer-close").fire("click");
  await ui.descendants(ui.elements.get("favorite-candy-grid"), "button").find(button => button.className === "candy-bar").fire("click");
  release({ plan: {} }); await saving;
  assert.equal(ui.elements.get("drawer-title").textContent, "糖果结果");
  assert.ok(ui.descendants(ui.elements.get("drawer-content")).some(element => element.textContent === "保存期间打开的回答"));
});

test("automatic UI adds models, saves independent disabled plans without invoking models, and removes their plans", async t => {
  let service; t.after(() => service?.close());
  const upstream = await fingerprintGateway(t, { models: ["chat"] });
  service = await startServer({ port: 0, dataDir: await temporary(t), gatewayUrl: upstream.url });
  const token = (await (await fetch(service.url)).text()).match(/name="pelican-token" content="([a-f0-9]+)"/)[1];
  const ui = await uiHarness({ token, request: (path, options) => fetch(new URL(path, service.url), options) });
  const drawer = () => ui.elements.get("drawer-content"), findButton = label => [drawer(), ui.elements.get("drawer-footer")].flatMap(root => ui.descendants(root, "button")).find(button => button.textContent === label);
  const findField = label => ui.descendants(drawer(), "label").find(row => row.children[0]?.textContent === label)?.children[1];
  await waitFor(() => ui.descendants(ui.elements.get("model-list"), "input").length === 1);
  const pick = ui.descendants(ui.elements.get("model-list"), "input")[0]; pick.checked = true; await pick.fire("change");
  ui.elements.get("generation-timeout").value = "1200";
  await ui.elements.get("favorite-selected").fire("click"); assert.equal(ui.elements.get("favorites-tab").attributes["aria-selected"], "true");
  await ui.descendants(ui.elements.get("favorite-candy-grid"), "button").find(e => e.attributes["aria-label"] === "设置 chat 的糖果计划").fire("click");
  findField("每天这些时刻 · 逗号分隔").value = "18:00,09:00,18:00"; await findField("每天这些时刻 · 逗号分隔").fire("input");
  await findButton("保存计划").fire("click");
  const headers = { "x-pelican-token": token }, config = await (await fetch(service.url + "api/favorites", { headers })).json();
  assert.deepEqual(config.plans[0].times, ["09:00", "18:00"]); assert.equal(config.plans[0].enabled, false); assert.equal(config.favorites[0].maxTokens, 64000);
  assert.equal(config.favorites[0].timeoutMs, 1200000);
  assert.equal(upstream.seen.requests.length, 0, "Adding or saving a disabled plan must never invoke the model");
  await ui.elements.get("favorite-manage").fire("click"); await findButton("编辑").fire("click");
  const tokens = findField("输出上限 · Token"); tokens.value = "0"; await tokens.fire("input");
  const timeout = findField("生成超时 · 秒"); assert.equal(timeout.value, "1200"); timeout.value = "0"; await timeout.fire("input");
  await findButton("完成编辑").fire("click"); await findButton("保存设置").fire("click");
  const changed = await (await fetch(service.url + "api/favorites", { headers })).json(); assert.equal(changed.favorites[0].maxTokens, 0);
  assert.equal(changed.favorites[0].timeoutMs, 0);
  await ui.elements.get("favorite-manage").fire("click");
  await (await confirmClick(ui, findButton("移除模型"))).completion; await findButton("保存设置").fire("click");
  const final = await (await fetch(service.url + "api/favorites", { headers })).json(); assert.equal(final.favorites.length, 0); assert.equal(final.plans.length, 0);
});
