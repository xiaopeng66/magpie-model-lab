import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { temporary, startTestServer, waitFor, fakeGateway, FIXTURE_HTML } from "./helpers.mjs";

test("GIF APIs require the local page token and copy a retained file without chat targets", async t => {
  const dir = await temporary(t), files = new Map(), copies = [], removed = [], generatedHTML = [], gifId = randomUUID(), evictedId = randomUUID();
  const gifService = { async init() {}, async sweep() {}, async close() {},
    async generate(html) { generatedHTML.push(html); assert.equal(html, FIXTURE_HTML); files.set(gifId, Buffer.from("GIF89a fixture")); return { id: gifId, name: "animation.gif", size: 14, removed: [evictedId] }; },
    async read(id) { if (!files.has(id)) { const error = new Error("GIF 临时文件不存在或已过期"); error.status = 404; throw error; } return files.get(id); },
    async copy(id) { assert.ok(files.has(id)); copies.push(id); return { copied: true }; },
    async save(id) { assert.ok(files.has(id)); return { path: "C:\\saved\\animation.gif" }; },
    async remove(id) { removed.push(id); files.delete(id); return { removed: true }; } };
  let finishReason = "stop";
  const upstream = await fakeGateway(t, ({ complete }) => complete(FIXTURE_HTML, finishReason)), service = await startTestServer({ port: 0, dataDir: dir, gatewayUrl: upstream.url, gifService });
  t.after(() => service.close());
  const page = await (await fetch(service.url)).text(), token = /name="pelican-token" content="([a-f0-9]+)"/.exec(page)[1];
  const headers = { "content-type": "application/json", "x-pelican-token": token, origin: "null" };
  const create = await (await fetch(service.url + "api/runs", { method: "POST", headers, body: JSON.stringify({ prompt: "make an animation", models: [{ id: "fixture/one" }] }) })).json();
  await waitFor(async () => (await (await fetch(service.url + `api/runs/${create.runs[0].id}`, { headers })).json()).status === "completed");
  const runId = create.runs[0].id, unauthenticated = await fetch(service.url + `api/runs/${runId}/gif`, { method: "POST", body: "{}" });
  assert.equal(unauthenticated.status, 403, "GIF generation uses the existing page capability token");
  const generated = await (await fetch(service.url + `api/runs/${runId}/gif`, { method: "POST", headers, body: "{}" })).json();
  assert.equal(generated.id, gifId); assert.deepEqual(generated.removed, [evictedId], "The UI receives IDs of old files removed during successful generation");
  const preview = await fetch(service.url + `api/gifs/${gifId}/file`, { headers });
  assert.equal(preview.headers.get("content-type"), "image/gif"); assert.equal(await preview.text(), "GIF89a fixture");
  assert.equal((await fetch(service.url + `api/gifs/${gifId}/copy`, { method: "POST", body: "{}" })).status, 403);
  assert.deepEqual(await (await fetch(service.url + `api/gifs/${gifId}/copy`, { method: "POST", headers, body: "{}" })).json(), { copied: true });
  assert.equal((await fetch(service.url + `api/gifs/${gifId}/copy`, { method: "POST", headers, body: JSON.stringify({ target: "obsolete" }) })).status, 400);
  assert.equal((await fetch(service.url + `api/gifs/${gifId}/share`, { method: "POST", headers, body: "{}" })).status, 404);
  assert.deepEqual(copies, [gifId]); assert.equal(files.has(gifId), true, "The clipboard must keep referencing a valid file until explicit cleanup");
  assert.deepEqual(await (await fetch(service.url + `api/gifs/${gifId}/save`, { method: "POST", headers, body: "{}" })).json(), { path: "C:\\saved\\animation.gif" });
  assert.deepEqual(await (await fetch(service.url + `api/gifs/${gifId}/delete`, { method: "POST", headers, body: "{}" })).json(), { removed: true });
  assert.deepEqual(removed, [gifId]);

  finishReason = "length";
  const truncated = await (await fetch(service.url + "api/runs", { method: "POST", headers, body: JSON.stringify({ prompt: "truncated animation", models: [{ id: "fixture/one" }] }) })).json();
  const failedRun = await waitFor(async () => {
    const value = await (await fetch(service.url + `api/runs/${truncated.runs[0].id}`, { headers })).json();
    return value.status === "truncated" ? value : null;
  });
  assert.equal(failedRun.hasHTML, true, "The negative case retains partial HTML, so the completion-state guard is exercised");
  assert.equal((await fetch(service.url + `api/runs/${failedRun.id}/gif`, { method: "POST", headers, body: "{}" })).status, 409);
  assert.equal(generatedHTML.length, 1, "The exporter must never run for a truncated request, even with saved HTML");
});

test("an unavailable GIF temporary directory does not prevent ordinary plugin startup", async t => {
  const dir = await temporary(t), upstream = await fakeGateway(t);
  const gifService = { async init() { throw new Error("temporary directory unavailable"); }, async sweep() {}, async close() {} };
  const service = await startTestServer({ port: 0, dataDir: dir, gatewayUrl: upstream.url, gifService });
  t.after(() => service.close());
  await service.ready;
  const page = await (await fetch(service.url)).text();
  assert.ok(page.includes('name="pelican-token"'), "GIF availability is independent from the core app and its saved results");
});
