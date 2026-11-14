import test from "node:test";
import assert from "node:assert/strict";
import { startServer } from "../lib/server.mjs";
import { temporary, waitFor, FIXTURE_HTML } from "./helpers.mjs";
import { fingerprintGateway, referenceFixture, numberReply } from "./fingerprint-helpers.mjs";

test("favorites and pause controls remain accessible when the model gateway is offline", async t => {
  const service = await startServer({ port: 0, dataDir: await temporary(t), gatewayUrl: "http://127.0.0.1:1" }); t.after(() => service.close());
  const token = (await (await fetch(service.url)).text()).match(/name="pelican-token" content="([a-f0-9]+)"/)[1];
  const headers = { "x-pelican-token": token, "content-type": "application/json" };
  const response = await fetch(service.url + "api/favorites", { headers }); assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).plans, []);
  const paused = await fetch(service.url + "api/schedules/settings", { headers, method: "POST", body: JSON.stringify({ enabled: false }) }); assert.equal(paused.status, 200);
});

test("automatic API scopes plans per model, disables manual favorite runs, and retains plans during history cleanup", async t => {
  const upstream = await fingerprintGateway(t, { handler: ({ complete }) => complete("最终答案：21") });
  const service = await startServer({ port: 0, dataDir: await temporary(t), gatewayUrl: upstream.url }); t.after(() => service.close());
  const token = (await (await fetch(service.url)).text()).match(/name="pelican-token" content="([a-f0-9]+)"/)[1];
  const headers = { "x-pelican-token": token, "content-type": "application/json" };
  const call = async (path, body) => {
    const response = await fetch(service.url + "api/" + path, { headers, ...(body ? { method: "POST", body: JSON.stringify(body) } : {}) });
    assert.ok(response.ok, `${path}: ${response.status} ${response.ok ? "" : await response.text()}`); return response.json();
  };
  assert.equal((await fetch(service.url + "api/favorites")).status, 403);
  const { favorite } = await call("favorites/save", { modelId: "fixture/chat" });
  const { plan } = await call("schedules/save", { favoriteIds: [favorite.id], kinds: ["candy"], times: ["09:00", "23:59"], days: [0, 1, 2, 3, 4, 5, 6] });
  assert.equal(plan.enabled, false); assert.equal(upstream.seen.requests.length, 0);
  const manual = await fetch(service.url + "api/favorites/run", { headers, method: "POST", body: JSON.stringify({ ids: [favorite.id], kinds: ["candy"] }) });
  assert.equal(manual.status, 410); assert.equal(upstream.seen.requests.length, 0);
  const snapshot = await call("favorites"); assert.equal(snapshot.plans[0].today.slots.length, 2); assert.equal(snapshot.maxDailySlots, 24);
  const { runs: [created] } = await call("runs", { kind: "candy", models: [{ id: favorite.modelId }] });
  await waitFor(async () => (await call("runs")).runs[0]?.status === "completed");
  const exported = await call(`batches/${created.batchId}/export`); assert.equal(exported.runs.length, 1); assert.equal(exported.runs[0].maxTokens, 64000);
  const cleaned = await call("runs/cleanup", { mode: "batch", batchId: created.batchId }); assert.equal(cleaned.removed.length, 1);
  const retained = await call("favorites"); assert.equal(retained.favorites.length, 1); assert.equal(retained.plans.length, 1);
  await call("schedules/remove", { id: plan.id }); await call("favorites/remove", { id: favorite.id }); assert.equal((await call("favorites")).favorites.length, 0);
});
