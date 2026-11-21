import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startTestServer as startServer, fakeGateway, temporary, waitFor } from "./helpers.mjs";

test("authenticated preview and retest APIs retain original conditions and expose their new batch", { timeout: 15000 }, async t => {
  let service;
  // Node runs after hooks in registration order: stop the runner before its gateway and storage.
  t.after(() => service?.close());
  const upstream = await fakeGateway(t);
  service = await startServer({ port: 0, dataDir: await temporary(t), gatewayUrl: upstream.url });
  const page = await (await fetch(service.url)).text(), token = page.match(/name="pelican-token" content="([a-f0-9]+)"/)[1];
  const headers = { "x-pelican-token": token, "content-type": "application/json" };
  const post = (path, body, auth = headers) => fetch(service.url + path, { method: "POST", headers: auth, body: JSON.stringify(body) });
  assert.equal((await post("api/retests/preview", { runIds: [randomUUID()] }, {})).status, 403);
  assert.equal((await post("api/retests", { runIds: [randomUUID()], operationId: randomUUID() }, { ...headers, origin: "https://example.org" })).status, 403);
  const original = await (await post("api/runs", { models: [{ id: "fixture/one", effort: "low" }], prompt: "原题面", maxTokens: 456 })).json();
  const source = original.runs[0];
  await waitFor(async () => (await (await fetch(service.url + `api/runs/${source.id}`, { headers })).json()).status === "completed");
  const previewResponse = await post("api/retests/preview", { runIds: [source.id] });
  assert.equal(previewResponse.status, 200, "The original-condition preview API must exist");
  const preview = await previewResponse.json();
  assert.equal(preview.items[0].conditions.maxTokens, 456); assert.equal(preview.items[0].available, true);
  assert.equal(upstream.seen.requests.length, 1, "Preview must not generate");
  const request = { runIds: [source.id], operationId: randomUUID(), prompt: "不得被采纳", maxTokens: 999 };
  const response = await post("api/retests", request); assert.equal(response.status, 201);
  const created = await response.json(); assert.equal(created.runs[0].retest.sourceRunId, source.id);
  await waitFor(() => upstream.seen.requests.length === 2);
  assert.equal(upstream.seen.requests[1].messages[0].content, "原题面"); assert.equal(upstream.seen.requests[1].max_tokens, 456);
  await waitFor(async () => (await (await fetch(service.url + `api/runs/${created.runs[0].id}`, { headers })).json()).status === "completed");
  const duplicate = await (await post("api/retests", request)).json(); assert.equal(duplicate.batchId, created.batchId);
  const module = await fetch(service.url + "batch-retest.mjs"); assert.equal(module.status, 200);
  assert.match(module.headers.get("content-type"), /javascript/);
  const bootstrap = await (await fetch(service.url + "api/bootstrap", { headers })).json(); assert.equal(bootstrap.retestAvailable, true);
});
