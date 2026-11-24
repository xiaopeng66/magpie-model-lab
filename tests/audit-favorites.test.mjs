import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Gateway } from "../lib/gateway.mjs";
import { RunStore } from "../lib/store.mjs";
import { Runner } from "../lib/runner.mjs";
import { Favorites } from "../lib/favorites.mjs";
import { fakeGateway, temporary, waitFor, startTestServer } from "./helpers.mjs";
import { uiHarness, confirmClick } from "./ui-harness.mjs";

async function setup(t) {
  const store = new RunStore(await temporary(t)); await store.init();
  const upstream = await fakeGateway(t), gateway = new Gateway({ url: upstream.url });
  const runner = new Runner({ store, gateway }); t.after(() => runner.close());
  const favorites = new Favorites({ dir: store.dir, runner }); await favorites.init();
  const one = await favorites.save({ modelId: "fixture/one" }), two = await favorites.save({ modelId: "fixture/two" });
  const plan = await favorites.savePlan({ favoriteIds: [one.id], kinds: ["candy"], timeZone: "UTC" });
  return { favorites, one, two, plan, store, runner, upstream };
}

test("007: manager edits, removals, plans and concurrency commit in one atomic configuration write", async t => {
  const { favorites, one, two } = await setup(t), replace = favorites.file.replace;
  let writes = 0;
  t.mock.method(favorites.file, "replace", async function (...args) { if (args[0] === favorites.path) writes++; return replace.apply(this, args); });
  await favorites.manage({ edits: [{ id: two.id, modelId: two.modelId, maxTokens: 1200 }], removeIds: [one.id], concurrency: 7 });
  const saved = JSON.parse(await readFile(favorites.path, "utf8"));
  assert.equal(writes, 1); assert.equal(saved.favorites.length, 1); assert.equal(saved.favorites[0].id, two.id);
  assert.equal(saved.favorites[0].maxTokens, 1200); assert.equal(saved.plans.length, 0); assert.equal(saved.concurrency, 7);
  assert.deepEqual(saved, favorites.state);
});

test("007: a missing later removal cannot partially delete an earlier favorite or block a corrected retry", async t => {
  const { favorites, one, two } = await setup(t), before = await readFile(favorites.path, "utf8"), state = structuredClone(favorites.state);
  await assert.rejects(() => favorites.manage({ edits: [], removeIds: [one.id, randomUUID()], concurrency: 7 }), error => error.status === 404);
  assert.equal(await readFile(favorites.path, "utf8"), before); assert.deepEqual(favorites.state, state);
  await favorites.manage({ edits: [], removeIds: [one.id, two.id], concurrency: 7 });
  assert.equal(favorites.state.favorites.length, 0); assert.equal(favorites.state.concurrency, 7);
});

test("007: manager disk failure preserves every setting and the same operation can be retried", async t => {
  const { favorites, one, two, store } = await setup(t), before = await readFile(favorites.path, "utf8"), state = structuredClone(favorites.state);
  const operation = { edits: [{ id: two.id, modelId: two.modelId, maxTokens: 0 }], removeIds: [one.id], concurrency: 0 };
  t.mock.method(favorites.file, "replace", async () => { throw new Error("fixture disk unavailable"); });
  await assert.rejects(() => favorites.manage(operation), /disk unavailable/);
  assert.equal(await readFile(favorites.path, "utf8"), before); assert.deepEqual(favorites.state, state);
  t.mock.restoreAll(); await favorites.manage(operation);
  assert.equal(favorites.state.favorites[0].maxTokens, 0); assert.equal(favorites.state.concurrency, 0);
});

test("007: schedule and model parameters persist together, and invalid parameters cannot create a plan revision", async t => {
  const { favorites, one, plan } = await setup(t);
  await favorites.savePlan({ ...plan, times: ["10:00"], parameters: { maxTokens: 1200 } });
  const saved = JSON.parse(await readFile(favorites.path, "utf8"));
  assert.equal(saved.favorites.find(item => item.id === one.id).maxTokens, 1200);
  assert.deepEqual(saved.plans[0].times, ["10:00"]);
  const before = await readFile(favorites.path, "utf8");
  await assert.rejects(() => favorites.savePlan({ ...saved.plans[0], times: ["11:00"], parameters: { maxTokens: -1 } }), /输出上限/);
  assert.equal(await readFile(favorites.path, "utf8"), before);
  await assert.rejects(() => favorites.savePlan({ ...saved.plans[0], times: ["99:00"], parameters: { maxTokens: 2400 } }), /时间/);
  assert.equal(await readFile(favorites.path, "utf8"), before);
});

test("007: management API requires authentication and reports validation failure without partial effects", async t => {
  const upstream = await fakeGateway(t), service = await startTestServer({ port: 0, dataDir: await temporary(t), gatewayUrl: upstream.url });
  t.after(() => service.close());
  const token = (await (await fetch(service.url)).text()).match(/name="pelican-token" content="([a-f0-9]+)"/)[1];
  const headers = { "x-pelican-token": token, "content-type": "application/json" };
  const post = (path, body, authorized = true) => fetch(service.url + path, { method: "POST", headers: authorized ? headers : { "content-type": "application/json" }, body: JSON.stringify(body) });
  const one = (await (await post("api/favorites/save", { modelId: "fixture/one" })).json()).favorite;
  assert.equal((await post("api/favorites/manage", { removeIds: [one.id] }, false)).status, 403);
  assert.equal((await post("api/favorites/manage", { removeIds: [one.id, randomUUID()], concurrency: 7 })).status, 404);
  const snapshot = await (await fetch(service.url + "api/favorites", { headers })).json();
  assert.equal(snapshot.favorites[0].id, one.id); assert.equal(snapshot.concurrency, 3);
  assert.equal((await post("api/favorites/manage", { removeIds: [one.id], concurrency: 7 })).status, 200);
  assert.equal(upstream.seen.requests.length, 0);
});

async function managerUI(t, fixture, handler) {
  const { favorites, runner } = fixture;
  const ui = await uiHarness({ bootstrap: { models: runner.catalog, runs: [], defaultPrompt: "fixture", favoritesAvailable: true,
    candyAvailable: true, favorites: favorites.snapshot() }, favorites: handler });
  t.after(() => ui.closeStream());
  await waitFor(() => ui.descendants(ui.elements.get("model-list"), "input").length > 0);
  await ui.elements.get("favorites-tab").fire("click"); return ui;
}
const controls = ui => ["drawer-content", "drawer-footer"].flatMap(id => ui.descendants(ui.elements.get(id), "button"));

test("007: manager UI retains all favorites on failed save and retries the same complete draft", async t => {
  const fixture = await setup(t), { favorites, one, two } = fixture, originalReplace = favorites.file.replace;
  let failurePending = true, failingWrite = false;
  t.mock.method(favorites.file, "replace", async function (...args) { if (failingWrite) throw new Error("fixture disk unavailable"); return originalReplace.apply(this, args); });
  const ui = await managerUI(t, fixture, async (path, body) => {
    if (path === "api/favorites") return favorites.snapshot();
    failingWrite = failurePending && (path === "api/favorites/manage" || path === "api/favorites/remove" && body.id === two.id);
    if (failingWrite) failurePending = false;
    try {
      if (path === "api/favorites/manage") return await favorites.manage(body);
      if (path === "api/favorites/remove") return await favorites.remove(body);
      if (path === "api/schedules/settings") return await favorites.settings(body);
      throw new Error("Unexpected fixture request " + path);
    } finally { failingWrite = false; }
  });
  await ui.elements.get("favorite-manage").fire("click");
  const limit = ui.descendants(ui.elements.get("drawer-content"), "input").find(item => item.getAttribute("aria-label") === "自动请求并行数");
  limit.value = "7"; await limit.fire("input");
  for (let count = 0; count < 2; count++) await (await confirmClick(ui, controls(ui).find(item => item.textContent === "移除模型"))).completion;
  await controls(ui).find(item => item.textContent === "保存设置").fire("click");
  assert.deepEqual(favorites.state.favorites.map(item => item.id), [one.id, two.id]); assert.equal(favorites.state.concurrency, 3);
  assert.match(ui.elements.get("drawer-status").textContent, /disk unavailable/);
  await controls(ui).find(item => item.textContent === "保存设置").fire("click");
  assert.equal(favorites.state.favorites.length, 0); assert.equal(favorites.state.concurrency, 7);
  assert.equal(ui.elements.get("favorite-drawer").hidden, true);
});

test("007: plan UI does not commit parameters before a failed schedule write and can retry", async t => {
  const fixture = await setup(t), { favorites, one } = fixture, originalReplace = favorites.file.replace;
  let failurePending = true, failingWrite = false;
  t.mock.method(favorites.file, "replace", async function (...args) { if (failingWrite) throw new Error("fixture schedule disk failure"); return originalReplace.apply(this, args); });
  const ui = await managerUI(t, fixture, async (path, body) => {
    if (path === "api/favorites") return favorites.snapshot();
    failingWrite = failurePending && path === "api/schedules/save"; if (failingWrite) failurePending = false;
    try {
      if (path === "api/favorites/save") return { favorite: await favorites.save(body) };
      if (path === "api/schedules/save") return { plan: await favorites.savePlan(body) };
      throw new Error("Unexpected fixture request " + path);
    } finally { failingWrite = false; }
  });
  const opener = ui.descendants(ui.elements.get("favorite-candy-grid"), "button").find(item => item.getAttribute("aria-label")?.startsWith("设置 ") && item.getAttribute("aria-label").endsWith("的糖果计划"));
  await opener.fire("click");
  const parameters = ui.descendants(ui.elements.get("drawer-content")).find(item => item.className === "plan-parameters");
  const tokens = ui.descendants(parameters, "input")[0]; tokens.value = "1200"; await tokens.fire("input");
  await controls(ui).find(item => item.textContent === "保存计划").fire("click");
  assert.equal(favorites.state.favorites.find(item => item.id === one.id).maxTokens, 64000);
  assert.match(ui.elements.get("drawer-status").textContent, /schedule disk failure/);
  await controls(ui).find(item => item.textContent === "保存计划").fire("click");
  assert.equal(favorites.state.favorites.find(item => item.id === one.id).maxTokens, 1200);
  assert.equal(ui.elements.get("favorite-drawer").hidden, true);
});
