import test from "node:test";
import assert from "node:assert/strict";
import { uiHarness } from "./ui-harness.mjs";
import { waitFor, FIXTURE_HTML } from "./helpers.mjs";

const favorite = { id: "f-one", modelId: "fixture/one", modelName: "Fixture · Supplier", provider: "fixture", providerName: "Supplier", available: true,
  lastRunAt: "2026-11-14T01:00:00Z", effort: "", maxTokens: 64000, prompt: "animate", concurrency: { candy: 3, pelican: 2 }, compareKeys: { candy: "same" } };
const model = { id: favorite.modelId, name: favorite.modelName, provider: favorite.provider, providerName: favorite.providerName, efforts: ["low"] };
const plan = { id: "p-one", revision: 1, favoriteIds: [favorite.id], kinds: ["candy"], enabled: true, name: "糖果", mode: "times", times: ["09:00", "12:00", "18:00"],
  days: [0, 1, 2, 3, 4, 5, 6], timeZone: "Asia/Shanghai", intervalMinutes: 60, start: "09:00", end: "18:00", allDay: false,
  today: { date: "2026-11-14", timeZone: "Asia/Shanghai", slots: ["09:00", "12:00", "18:00"].map(time => ({ key: `p-one:1:2026-11-14:${time}`, label: time, state: "waiting", time, at: `2026-11-14T${time}:00Z` })) } };
const run = { id: "run-one", batchId: "batch-one", kind: "candy", model: model.id, modelName: model.name, provider: model.provider, providerName: model.providerName,
  favoriteId: favorite.id, compareKey: "same", source: "automatic", plans: [{ id: plan.id, revision: 1, triggerKey: plan.today.slots[0].key }], createdAt: "2026-11-14T01:00:00Z", status: "running", reasoningChars: 8, contentChars: 4 };
const boot = { models: [model], runs: [run], defaultPrompt: "animate", favoritesAvailable: true, candyAvailable: true, fingerprintAvailable: true,
  favorites: { schema: 2, favorites: [favorite], plans: [plan], enabled: true, concurrency: 3, maxDailySlots: 24 } };
const find = (ui, root, text) => ui.descendants(root).find(e => e.textContent === text);
const buttons = (ui, root) => ui.descendants(root, "button");
const drawer = ui => ui.elements.get("drawer-content");
const field = (ui, label) => ui.descendants(drawer(ui), "label").find(row => row.children[0]?.textContent === label)?.children[1];
async function open(ui) { await waitFor(() => ui.descendants(ui.elements.get("model-list"), "input").length); await ui.elements.get("favorites-tab").fire("click"); }

test("automatic plan summaries are read-only and each model opens settings from its header", async () => {
  const two = { ...favorite, id: "f-two", modelId: "fixture/two", modelName: "Second" };
  const ui = await uiHarness({ bootstrap: { ...boot, runs: [], favorites: { ...boot.favorites, favorites: [favorite, two] } } }); await open(ui);
  const grid = ui.elements.get("favorite-candy-grid"), cards = ui.descendants(grid, "article");
  const summaries = cards.map(card => ui.descendants(card).find(item => item.className === "card-plan-summary"));
  assert.ok(summaries.every(item => item?.tagName === "SPAN"));
  assert.deepEqual(summaries.map(item => item.textContent), ["09:00 · 12:00 · 18:00", "暂无计划"]);
  assert.ok(summaries.every(item => !item.handlers.click));
  for (const card of cards) {
    assert.ok(ui.descendants(card).find(item => item.className === "candy-bars"));
    assert.ok(ui.descendants(card).find(item => item.className === "favorite-card-foot"));
    const settings = buttons(ui, card).filter(item => item.attributes["aria-label"]?.startsWith("设置 "));
    assert.equal(settings.length, 1); await settings[0].fire("click");
    assert.equal(ui.elements.get("drawer-title").textContent, "糖果计划"); await ui.elements.get("drawer-close").fire("click");
  }
});

test("automatic candy shows generating before any verdict and exactly the planned slots", async () => {
  const ui = await uiHarness({ bootstrap: boot, detail: () => ({ ...run, content: "thinking" }) }); await open(ui);
  const grid = ui.elements.get("favorite-candy-grid");
  assert.equal(ui.elements.get("favorites-tab").textContent, "自动测试");
  assert.ok(find(ui, grid, "生成中")); assert.equal(find(ui, grid, "结果已过期或参数已变更"), undefined);
  const slots = buttons(ui, grid).filter(e => e.className === "candy-bar");
  assert.equal(slots.length, 3); assert.equal(slots[0].dataset.verdict, "running");
  assert.equal(slots[1].dataset.verdict, "waiting"); assert.equal(find(ui, grid, "1 次未判定"), undefined);
  assert.equal(ui.elements.get("generate").hidden, true);
  assert.equal(ui.elements.has("favorite-run"), false); assert.equal(ui.elements.has("favorite-fingerprint"), false);
  assert.equal(ui.descendants(grid, "input").length, 0);
  await slots[0].fire("click"); assert.ok(find(ui, drawer(ui), "生成中"));
});

test("candy success rate excludes in-flight work and opens the matching slot record", async () => {
  const records = [21, 29, null].map((answer, i) => ({ ...run, id: `r${i}`, plans: [{ id: plan.id, triggerKey: plan.today.slots[i].key }],
    status: i === 2 ? "running" : "completed", candy: { answer, verdict: answer === 21 ? "match" : "mismatch" } }));
  const opened = [];
  const ui = await uiHarness({ bootstrap: { ...boot, runs: records }, detail: id => { opened.push(id); return { ...records.find(r => r.id === id), content: "最终答案：29" }; } }); await open(ui);
  const grid = ui.elements.get("favorite-candy-grid"), slots = buttons(ui, grid).filter(e => e.className === "candy-bar");
  assert.ok(find(ui, grid, "50%")); assert.ok(find(ui, grid, "生成中"));
  assert.deepEqual(slots.map(e => e.dataset.verdict), ["match", "mismatch", "running"]);
  await slots[1].fire("click"); assert.equal(opened.at(-1), "r1"); assert.ok(find(ui, drawer(ui), "最终答案：29"));
});

test("resolved old results beat empty current-revision records in candy and animation views", async () => {
  const completed = { ...run, status: "completed", candy: { answer: 21, verdict: "match" } };
  const changed = { ...plan, revision: 2, today: { ...plan.today, slots: plan.today.slots.map((slot, i) => ({ ...slot,
    key: slot.key.replace(":1:", ":2:"), ...(i === 0 ? { runId: completed.id, state: "started" } : {}) })) } };
  const empty = { ...run, id: "empty-attempt", status: "cancelled", plans: [{ id: plan.id, revision: 2, triggerKey: changed.today.slots[0].key }] };
  const animation = { ...completed, id: "saved-animation", kind: "pelican", hasHTML: true };
  const animationPlan = { ...changed, id: "animation-plan", kinds: ["pelican"], today: { ...changed.today,
    slots: changed.today.slots.map((slot, i) => ({ ...slot, key: `animation-${i}`, ...(i === 0 ? { runId: animation.id } : {}) })) } };
  const opened = [];
  const state = { ...boot.favorites, plans: [changed, animationPlan] };
  const ui = await uiHarness({ bootstrap: { ...boot, favorites: state, runs: [completed, empty, animation] }, favorites: () => state,
    detail: id => { opened.push(id); return id === animation.id ? { ...animation, html: FIXTURE_HTML, previewUrl: "preview/saved-animation" } : { ...completed, content: "最终答案：21" }; } });
  await open(ui);
  const grid = ui.elements.get("favorite-candy-grid"), slots = buttons(ui, grid).filter(item => item.className === "candy-bar");
  assert.equal(slots[0].dataset.verdict, "match"); assert.ok(find(ui, grid, "100%"));
  await slots[0].fire("click"); assert.equal(opened.at(-1), completed.id);
  await ui.elements.get("drawer-close").fire("click"); await ui.elements.get("favorite-pelican").fire("click");
  const gallery = ui.elements.get("favorite-results");
  await waitFor(() => ui.descendants(gallery, "iframe").length === 1);
  assert.ok(opened.includes(animation.id));
  assert.match(ui.descendants(gallery, "iframe")[0].src, /preview\/saved-animation/);
});

test("completion and cleanup immediately refresh the resolved result for a revised slot", async () => {
  const older = { ...run, status: "completed", candy: { answer: 29, verdict: "mismatch" } };
  const newer = { ...run, id: "newer-attempt", plans: [{ id: plan.id, revision: 2, triggerKey: "old-revision-slot" }] };
  const changed = { ...plan, revision: 3, today: { ...plan.today, slots: plan.today.slots.map((slot, i) => ({ ...slot,
    key: slot.key.replace(":1:", ":3:"), ...(i === 0 ? { runId: older.id, state: "started" } : {}) })) } };
  const state = { ...boot.favorites, plans: [changed] };
  const ui = await uiHarness({ bootstrap: { ...boot, favorites: state, runs: [older, newer] }, favorites: () => state }); await open(ui);
  const grid = ui.elements.get("favorite-candy-grid");
  assert.ok(find(ui, grid, "0%"));
  changed.today.slots[0].runId = newer.id;
  ui.event("run", { run: { ...newer, status: "completed", candy: { answer: 21, verdict: "match" } } });
  await waitFor(() => find(ui, grid, "100%"));
  changed.today.slots[0].runId = older.id;
  ui.event("removed", { ids: [newer.id] });
  await waitFor(() => find(ui, grid, "0%"));
  assert.equal(buttons(ui, grid).filter(item => item.className === "candy-bar")[0].dataset.verdict, "mismatch");
});

test("one model plan editor saves only that model and rejects an interval above 24 daily slots", async () => {
  const calls = [], state = structuredClone(boot.favorites);
  const ui = await uiHarness({ bootstrap: { ...boot, runs: [] }, favorites: (path, body) => { calls.push([path, body]); return path.endsWith("save") ? { plan: body } : state; } }); await open(ui);
  const grid = ui.elements.get("favorite-candy-grid");
  await buttons(ui, grid).find(e => e.attributes["aria-label"] === "设置 Fixture 的糖果计划").fire("click");
  assert.ok(find(ui, drawer(ui), "Supplier")); assert.equal(field(ui, "目标模型"), undefined);
  field(ui, "执行方式").value = "interval"; await field(ui, "执行方式").fire("change");
  field(ui, "间隔 · 分钟").value = "20"; await field(ui, "间隔 · 分钟").fire("input");
  let save = buttons(ui, drawer(ui)).find(e => e.textContent === "保存计划");
  assert.equal(save.disabled, true); assert.ok(ui.descendants(drawer(ui)).some(e => /27.*24/.test(e.textContent)));
  field(ui, "间隔 · 分钟").value = "30"; await field(ui, "间隔 · 分钟").fire("input"); assert.equal(save.disabled, false);
  await save.fire("click"); const sent = calls.find(([path]) => path === "api/schedules/save")[1];
  assert.deepEqual(sent.favoriteIds, [favorite.id]); assert.deepEqual(sent.kinds, ["candy"]); assert.equal(sent.intervalMinutes, 30);
});

test("animation gallery groups every daily time in the same model row and preserves row scroll containers", async () => {
  const two = { ...favorite, id: "f-two", modelId: "fixture/two", modelName: "Second" };
  const plans = [favorite, two].map((f, i) => ({ ...plan, id: "p" + i, kinds: ["pelican"], favoriteIds: [f.id], today: { ...plan.today,
    slots: plan.today.slots.map((slot, n) => ({ ...slot, key: `${i}:${n}` })) } }));
  const records = [favorite, two].flatMap((f, i) => [0, 1].map(n => ({ ...run, id: `anim-${i}-${n}`, kind: "pelican", favoriteId: f.id, modelName: f.modelName,
    status: "completed", hasHTML: true, plans: [{ id: plans[i].id, triggerKey: `${i}:${n}` }] })));
  const state = { ...boot.favorites, favorites: [favorite, two], plans };
  const ui = await uiHarness({ bootstrap: { ...boot, runs: records, favorites: state }, favorites: () => state,
    intersection: true, detail: id => ({ ...records.find(r => r.id === id), html: FIXTURE_HTML, previewUrl: "preview/saved" }) });
  await open(ui); await ui.elements.get("favorite-pelican").fire("click");
  const rows = ui.descendants(ui.elements.get("favorite-results")).filter(e => e.className === "animation-row");
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(ui.descendants(row).filter(e => e.className === "animation-slot").length, 3);
    assert.equal(ui.descendants(row).filter(e => e.className === "preview-zone").length, 2);
  }
  const lane = ui.descendants(rows[0]).find(e => e.className === "animation-lane"); lane.scrollLeft = 180;
  ui.event("run", { run: { ...records[0], usageRevision: 2, tokens: { reasoning: 0, output: 100 } } });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(ui.descendants(ui.elements.get("favorite-results")).find(e => e.className === "animation-lane") === lane, "stream updates must preserve the lane"); assert.equal(lane.scrollLeft, 180);
  state.favorites = state.favorites.map(f => ({ ...f, lastRunAt: "2026-11-14T06:00:00Z" })); ui.event("favorites", {});
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(ui.descendants(ui.elements.get("favorite-results")).find(e => e.className === "animation-lane") === lane, "last-run metadata must preserve the lane"); assert.equal(lane.scrollLeft, 180);
});

test("zero token setting submits in all three normal modes and negative input is rejected", async () => {
  const sent = []; const ui = await uiHarness({ bootstrap: { ...boot, runs: [] }, create: body => { sent.push(body); return { runs: [{ ...run, id: "new-" + sent.length, batchId: "batch-" + sent.length, kind: body.kind || "pelican" }] }; } });
  await waitFor(() => ui.descendants(ui.elements.get("model-list"), "input").length);
  const input = ui.descendants(ui.elements.get("model-list"), "input")[0]; input.checked = true; await input.fire("change");
  assert.equal(ui.elements.get("max-tokens").value, "64000"); ui.elements.get("max-tokens").value = "0";
  for (const tab of ["current", "candy", "fingerprint"]) { await ui.elements.get(tab + "-tab").fire("click"); await ui.elements.get("generate").fire("click"); }
  assert.equal(sent.length, 3); assert.ok(sent.every(body => body.maxTokens === 0));
  ui.elements.get("max-tokens").value = "-1"; await ui.elements.get("generate").fire("click"); assert.equal(sent.length, 3);
});

test("an open automatic candy record updates answer and copy text when generation finishes", async () => {
  let detail = { ...run, content: "", candy: { answer: null, verdict: "incomplete" } };
  const ui = await uiHarness({ bootstrap: boot, detail: () => structuredClone(detail) }); await open(ui);
  await buttons(ui, ui.elements.get("favorite-candy-grid")).find(e => e.className === "candy-bar").fire("click");
  const copy = buttons(ui, drawer(ui)).find(e => e.textContent === "复制回答"); copy.focus();
  detail = { ...run, status: "completed", content: "最终答案：21", candy: { answer: 21, verdict: "match" } };
  ui.event("run", { run: detail }); await waitFor(() => find(ui, drawer(ui), "最终答案：21"));
  assert.ok(find(ui, drawer(ui), "21")); assert.ok(copy.focused); await copy.fire("click"); assert.equal(ui.copied.at(-1), "最终答案：21");
});
