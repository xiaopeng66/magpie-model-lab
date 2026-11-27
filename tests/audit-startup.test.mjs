import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { randomUUID } from "node:crypto";
import { RunStore } from "../lib/store.mjs";
import { Favorites } from "../lib/favorites.mjs";
import { startTestServer as startServer, temporary, fakeGateway, waitFor } from "./helpers.mjs";
import { uiHarness } from "./ui-harness.mjs";

async function occupied(t) {
  const socket = createServer(); await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => socket.listening ? socket.close(resolve) : resolve()));
  return { socket, port: socket.address().port };
}

test("008: a permanently occupied port rejects ready by its startup deadline", async t => {
  const { port } = await occupied(t), service = await startServer({ port, dataDir: await temporary(t), startupTimeoutMs: 80 });
  t.after(() => service.close());
  let timer;
  try {
    const outcome = await Promise.race([service.ready.then(() => "ready", error => error), new Promise(resolve => { timer = setTimeout(() => resolve("pending"), 350); })]);
    assert.ok(outcome instanceof Error && /端口.*占用/.test(outcome.message), `Expected a port conflict, got ${outcome}`);
    assert.equal(service.listening, false);
  } finally { clearTimeout(timer); }
});

test("008: a temporary port handoff still succeeds and closing cancels future retries", async t => {
  const { socket, port } = await occupied(t), service = await startServer({ port, dataDir: await temporary(t), startupTimeoutMs: 1200 });
  t.after(() => service.close());
  await new Promise(resolve => socket.close(resolve));
  assert.equal(await service.ready, port); assert.equal(service.listening, true);
  await service.close(); assert.equal(service.listening, false);
});

async function entryFixture(spawn) {
  const source = (await readFile(new URL("../index.mjs", import.meta.url), "utf8")).replace(/^import .*;\r?\n/gm, "")
    .replace(/\bimport\.meta\.url\b/g, JSON.stringify(new URL("../index.mjs", import.meta.url).href)).replace("export default", "plugin =");
  const messages = [], context = { join, fileURLToPath, URL, spawn, process: { execPath: process.execPath, platform: process.platform, stdin: new PassThrough(), exit() {} }, setTimeout, clearTimeout,
    plugin: null, console: { log: value => messages.push(value), error: value => messages.push(value) } };
  runInNewContext(source, context); return { plugin: context.plugin, messages };
}

function childFixture() {
  return Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), exitCode: null, signalCode: null });
}

test("008: an immediate failed entry spawn does not poison the cache for the next request", async () => {
  let calls = 0;
  const { plugin } = await entryFixture(() => {
    if (++calls === 1) throw new Error("fixture startup failure");
    const child = childFixture(); queueMicrotask(() => child.stdout.write("Model Lab http://127.0.0.1:54321/\n")); return child;
  });
  await assert.rejects(() => plugin.server({}, { port: 54321 }), /startup failure/);
  await plugin.server({}, { port: 54321 }); assert.equal(calls, 2);
});

test("008: a child exit before readiness closes its input and allows a fresh entry startup", async () => {
  const children = [];
  const { plugin } = await entryFixture(() => {
    const child = childFixture(); children.push(child);
    queueMicrotask(() => {
      if (children.length === 1) { child.exitCode = 1; child.stdout.end(); child.emit("exit", 1); child.emit("close", 1); }
      else child.stdout.write("Model Lab http://127.0.0.1:54321/\n");
    });
    return child;
  });
  await assert.rejects(() => plugin.server({}, { port: 54321 }), /后台已退出/);
  assert.equal(children[0].stdin.writableEnded, true);
  await plugin.server({}, { port: 54321 }); assert.equal(children.length, 2);
});

test("009: damaged favorites retain their bytes, disable writes and automatic tests, and leave healthy history and manual tests available", async t => {
  const dir = await temporary(t), store = new RunStore(dir); await store.init();
  const run = await store.save({ id: randomUUID(), kind: "candy", model: "fixture/one", status: "completed", createdAt: new Date().toISOString(),
    content: "最终答案：21", candy: { verdict: "match", answer: 21 } });
  const statePath = join(dir, ".favorites", "state.json"); await mkdir(join(dir, ".favorites")); await writeFile(statePath, "{}");
  const upstream = await fakeGateway(t, ({ complete }) => complete("最终答案：21"));
  const service = await startServer({ port: 0, dataDir: dir, gatewayUrl: upstream.url }); t.after(() => service.close());
  const ready = await service.ready.then(() => true, () => false); assert.equal(ready, true);
  const token = (await (await fetch(service.url)).text()).match(/name="pelican-token" content="([a-f0-9]+)"/)[1];
  const headers = { "x-pelican-token": token, "content-type": "application/json" };
  const get = async path => (await fetch(service.url + path, { headers })).json();
  const post = (path, body) => fetch(service.url + path, { method: "POST", headers, body: JSON.stringify(body) });
  const boot = await get("api/bootstrap");
  assert.equal(boot.favoritesAvailable, false); assert.match(boot.favoritesError, /收藏配置读取失败/);
  assert.equal(boot.favorites.enabled, false); assert.equal(boot.favorites.readOnly, true); assert.equal(boot.runs[0].id, run.id);
  assert.equal((await post("api/schedules/settings", { enabled: true })).status, 503);
  assert.equal((await post("api/favorites/manage", { removeIds: [], concurrency: 7 })).status, 503);
  assert.equal(await readFile(statePath, "utf8"), "{}"); assert.equal(upstream.seen.requests.length, 0);
  const created = await post("api/runs", { kind: "candy", models: [{ id: "fixture/one" }] }); assert.equal(created.status, 201);
  await waitFor(async () => (await get("api/runs")).runs.some(item => item.id !== run.id && item.status === "completed"));
  assert.equal(upstream.seen.requests.length, 1); assert.equal(await readFile(statePath, "utf8"), "{}");
});

test("009: the page visibly explains that automatic configuration is unavailable while manual controls remain usable", async t => {
  const ui = await uiHarness({ bootstrap: { models: [{ id: "fixture/one", name: "One", provider: "fixture", efforts: [] }], runs: [],
    defaultPrompt: "fixture", favoritesAvailable: false, favoritesError: "收藏配置读取失败：格式无效" } });
  t.after(() => ui.closeStream()); await waitFor(() => ui.descendants(ui.elements.get("model-list"), "input").length);
  assert.equal(ui.elements.get("notice").hidden, false); assert.match(ui.elements.get("notice").textContent, /自动测试.*停用/);
  assert.match(ui.elements.get("notice").textContent, /历史.*手动/);
  assert.equal(ui.elements.get("model-list").hidden, false);
});

test('missing favorites in an existing directory stay unavailable without recreating or replacing configuration', async t => {
  const dir = await temporary(t), statePath = join(dir, '.favorites', 'state.json'), backupPath = join(dir, '.favorites', 'state.previous.json');
  const store = new RunStore(dir); await store.init();
  const run = await store.save({ id: randomUUID(), kind: 'candy', model: 'fixture/one', status: 'completed', createdAt: new Date().toISOString(),
    content: '最终答案：21', candy: { verdict: 'match', answer: 21 } });
  await mkdir(join(dir, '.favorites')); const backup = '{"retained":"recovery evidence"}'; await writeFile(backupPath, backup);
  const upstream = await fakeGateway(t), service = await startServer({ port: 0, dataDir: dir, gatewayUrl: upstream.url }); t.after(() => service.close());
  await service.ready;
  const token = (await (await fetch(service.url)).text()).match(/name="pelican-token" content="([a-f0-9]+)"/)[1];
  const headers = { 'x-pelican-token': token, 'content-type': 'application/json' };
  const boot = await (await fetch(service.url + 'api/bootstrap', { headers })).json();
  assert.equal(boot.favoritesAvailable, false); assert.equal(boot.configAvailable, false);
  assert.equal(boot.favorites.readOnly, true); assert.equal(boot.favorites.enabled, false); assert.ok(boot.favoritesError);
  assert.equal(boot.runs[0].id, run.id);
  for (const [path, input] of [['favorites/save', { modelId: 'fixture/one' }], ['schedules/settings', { enabled: true }], ['config/export', {}]]) {
    assert.equal((await fetch(service.url + 'api/' + path, { method: 'POST', headers, body: JSON.stringify(input) })).status, 503);
  }
  await assert.rejects(readFile(statePath), error => error.code === 'ENOENT');
  assert.equal(await readFile(backupPath, 'utf8'), backup); assert.equal(upstream.seen.requests.length, 0);
});

test("009: a bound port cannot accept configuration writes before recovery finishes", async t => {
  const originalInit = Favorites.prototype.init;
  let release, started;
  const hold = new Promise(resolve => { release = resolve; }), entering = new Promise(resolve => { started = resolve; });
  Favorites.prototype.init = async function () { started(); await hold; return originalInit.call(this); };
  t.after(() => { release(); Favorites.prototype.init = originalInit; });
  const { socket, port } = await occupied(t), dir = await temporary(t);
  await mkdir(join(dir, ".favorites")); await writeFile(join(dir, ".favorites", "state.json"), "{}");
  const service = await startServer({ port, dataDir: dir }); t.after(() => service.close());
  await new Promise(resolve => socket.close(resolve)); await entering;
  const token = (await (await fetch(service.url)).text()).match(/name="pelican-token" content="([a-f0-9]+)"/)[1];
  try {
    const response = await fetch(service.url + "api/schedules/settings", { method: "POST", headers: { "x-pelican-token": token, "content-type": "application/json" }, body: '{"enabled":true}' });
    assert.equal(response.status, 503);
    assert.equal(await readFile(join(dir, ".favorites", "state.json"), "utf8"), "{}");
  } finally { release(); }
  await service.ready;
});

test("009: repairing the retained configuration and restarting restores normal configuration writes", async t => {
  const dir = await temporary(t), statePath = join(dir, ".favorites", "state.json");
  await mkdir(join(dir, ".favorites")); await writeFile(statePath, "{}");
  const upstream = await fakeGateway(t, ({ complete }) => complete("最终答案：21"));
  const degraded = await startServer({ port: 0, dataDir: dir, gatewayUrl: upstream.url });
  t.after(() => degraded.close()); await degraded.ready; await degraded.close();
  const restored = { schema: 2, favorites: [], plans: [], enabled: true, concurrency: 3, claims: [] };
  await writeFile(statePath, JSON.stringify(restored));
  const healthy = await startServer({ port: 0, dataDir: dir, gatewayUrl: upstream.url });
  t.after(() => healthy.close()); await healthy.ready;
  const token = (await (await fetch(healthy.url)).text()).match(/name="pelican-token" content="([a-f0-9]+)"/)[1];
  const headers = { "x-pelican-token": token, "content-type": "application/json" };
  const boot = await (await fetch(healthy.url + "api/bootstrap", { headers })).json();
  assert.equal(boot.favoritesAvailable, true); assert.equal(boot.favoritesError, "");
  assert.equal(boot.favorites.readOnly, undefined); assert.equal(boot.favorites.enabled, true);
  assert.equal((await fetch(healthy.url + "api/favorites/manage", { method: "POST", headers,
    body: JSON.stringify({ edits: [], removeIds: [], concurrency: 5 }) })).status, 200);
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).concurrency, 5);
  assert.equal(upstream.seen.requests.length, 0);
});
