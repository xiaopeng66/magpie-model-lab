import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { startTestServer as startServer, temporary, waitFor } from "./helpers.mjs";
import { fingerprintGateway, referenceFixture } from "./fingerprint-helpers.mjs";

async function setup(t, options = {}) {
  const dir = await temporary(t), upstream = await fingerprintGateway(t, { bank: referenceFixture("http-snapshot", true), ...options });
  const service = await startServer({ port: 0, dataDir: dir, gatewayUrl: upstream.url, bankSource: upstream.url + "/data/" }); t.after(() => service.close());
  const page = await (await fetch(service.url)).text(); const token = page.match(/name="pelican-token" content="([a-f0-9]+)"/)[1];
  const headers = { "x-pelican-token": token, "content-type": "application/json", origin: "null" };
  const api = (path, options = {}) => fetch(service.url + "api/" + path, { ...options, headers: { ...headers, ...options.headers } });
  return { service, upstream, api, headers };
}
const request = { kind: "fingerprint", models: [{ id: "fixture/chat", effort: "low" }], maxTokens: 32000, concurrency: 2 };

test("fingerprint APIs require the page token and bootstrap does not download the reference bank", async t => {
  const { service, upstream, api } = await setup(t);
  const boot = await (await api("bootstrap")).json(); assert.equal(boot.fingerprintAvailable, true); assert.equal(boot.bankStatus.state, "missing");
  assert.equal(upstream.seen.downloads.length, 0);
  assert.equal((await fetch(service.url + "api/fingerprint/bank/refresh", { method: "POST" })).status, 403);
  assert.equal((await api("fingerprint/bank/refresh", { method: "POST", headers: { origin: "https://foreign.example" } })).status, 403);
  assert.equal((await api("fingerprint/bank/refresh", { method: "POST" })).status, 200);
  assert.equal((await (await api("fingerprint/bank")).json()).state, "ready"); assert.equal(upstream.seen.downloads.length, 2); assert.equal(upstream.seen.requests.length, 0);
  const accounts = await (await api("fingerprint/accounts")).json(); assert.deepEqual(accounts.accounts, [{ provider: "fixture", id: "北冥", name: "主账号", enabled: null, available: null }]);
});

test("fingerprint batch export preserves raw evidence and history cleanup removes samples but keeps the bank", async t => {
  const { service, upstream, api } = await setup(t);
  const created = await api("runs", { method: "POST", body: JSON.stringify(request) }); assert.equal(created.status, 201);
  const { runs } = await created.json();
  const detail = await waitFor(async () => { const run = await (await api("runs/" + runs[0].id)).json(); return run.status === "completed" && run; });
  assert.equal(detail.previewUrl, ""); assert.equal(detail.analysis.prediction, "reference/a");
  assert.equal((await fetch(service.url + `api/batches/${detail.batchId}/export`)).status, 403);
  const response = await api(`batches/${detail.batchId}/export`); assert.equal(response.status, 200);
  const exported = await response.json(); assert.equal(exported.kind, "fingerprint"); assert.equal(exported.runs[0].samples.length, 3);
  assert.equal(exported.runs[0].samples[0].raw_text, detail.samples[0].raw_text); assert.equal(exported.runs[0].previewKey, undefined);
  assert.equal((await api(`runs/${detail.id}/open`, { method: "POST" })).status, 400, "Fingerprint evidence is not an HTML preview");
  assert.equal(upstream.seen.requests.length, 3, "Export must not sample again");
  const cleaned = await api("runs/cleanup", { method: "POST", body: JSON.stringify({ mode: "batch", batchId: detail.batchId }) });
  assert.deepEqual((await cleaned.json()).removed, [detail.id]);
  await assert.rejects(() => readFile(detail.files.samples), { code: "ENOENT" });
  assert.equal((await (await api("fingerprint/bank")).json()).meta.sha256, detail.bank.sha256);
});

test("retrying a failed manual refresh checks the latest manifest before downloading again", async t => {
  const bank = referenceFixture("2026-11-26T00:00:00Z", true), { api } = await setup(t, { bank });
  assert.equal((await api("fingerprint/bank/refresh", { method: "POST" })).status, 200);
  Object.assign(bank, referenceFixture("2026-11-27T00:00:00Z", true));
  assert.equal((await api("fingerprint/bank/check", { method: "POST" })).status, 200);
  Object.assign(bank, referenceFixture("2026-11-28T00:00:00Z", true));
  assert.equal((await api("fingerprint/bank/refresh", { method: "POST" })).status, 502);
  const retry = await api("fingerprint/bank/refresh", { method: "POST" }); assert.equal(retry.status, 200);
  assert.equal((await retry.json()).meta.builtAt, "2026-11-28T00:00:00Z");
});

test("authenticated batch cancellation stops all scheduled fingerprint calls as one operation", async t => {
  const { service, upstream, api } = await setup(t, { handler: ({ res, chunk }) => {
    res.writeHead(200, { "content-type": "text/event-stream" }); chunk({ choices: [{ delta: { content: "1, 300, " } }] });
  } });
  const { runs } = await (await api("runs", { method: "POST", body: JSON.stringify({ ...request, models: ["chat", "responses", "messages"].map(name => ({ id: "fixture/" + name })) }) })).json();
  await waitFor(() => upstream.seen.requests.length === 2);
  const route = `api/batches/${runs[0].batchId}/cancel`; assert.equal((await fetch(service.url + route, { method: "POST" })).status, 403);
  const cancelled = await api(`batches/${runs[0].batchId}/cancel`, { method: "POST" }); assert.equal(cancelled.status, 200);
  const body = await cancelled.json(); assert.ok(body.runs.every(run => run.status === "cancelled")); assert.equal(upstream.seen.requests.length, 2);
});
