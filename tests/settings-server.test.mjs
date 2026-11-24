import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, fakeGateway, temporary } from "./helpers.mjs";

test("settings API requires page auth, enforces CAS and 64 KiB, and never generates", async t => {
  const upstream = await fakeGateway(t), service = await startTestServer({ port: 0, dataDir: await temporary(t), gatewayUrl: upstream.url }); t.after(() => service.close());
  const html = await (await fetch(service.url)).text(), token = html.match(/name="pelican-token" content="([^"]+)"/)[1], headers = { "x-pelican-token": token, "content-type": "application/json" };
  assert.equal((await fetch(service.url + "api/settings")).status, 403);
  assert.equal((await fetch(service.url + "api/settings", { headers: { ...headers, origin: "https://elsewhere.example" } })).status, 403);
  const snapshot = await (await fetch(service.url + "api/settings", { headers })).json(); assert.equal(snapshot.settings.revision, 0);
  const post = body => fetch(service.url + "api/settings/save", { method: "POST", headers, body: JSON.stringify(body) });
  assert.equal((await post({ expectedRevision: 0, patch: { manual: { candy: { timeoutMs: 0, concurrency: 0, maxTokens: 0 } } } })).status, 200);
  assert.equal((await post({ expectedRevision: 0, patch: { progressNotice: { enabled: false } } })).status, 409);
  assert.equal((await post({ expectedRevision: 1, patch: { mystery: 1 } })).status, 400);
  assert.equal((await post({ expectedRevision: 1, patch: { mystery: "x".repeat(65536) } })).status, 413);
  const module = await fetch(service.url + "lib/test-parameters.mjs"); assert.equal(module.status, 200); assert.match(module.headers.get("content-type"), /javascript/);
  assert.equal(upstream.seen.requests.length, 0);
});
