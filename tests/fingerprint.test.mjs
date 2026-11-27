import test from "node:test";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, readdir, symlink, utimes } from "node:fs/promises";
import { join } from "node:path";
import { Gateway } from "../lib/gateway.mjs";
import { Runner } from "../lib/runner.mjs";
import { RunStore } from "../lib/store.mjs";
import { temporary, waitFor } from "./helpers.mjs";
import { fingerprintGateway, referenceFixture, numberReply } from "./fingerprint-helpers.mjs";

const sampling = await import("../lib/fingerprint-sample.mjs").catch(() => ({}));
const banks = await import("../lib/fingerprint-bank.mjs").catch(() => ({}));
const challenge = { id: "challenge-one", expected_count: 300, prompt: "choose 300 numbers" };

test("fingerprint sampler sends the chosen protocol, independent prompt, effort and unlimited token parameter", async t => {
  assert.equal(typeof sampling.sampleFingerprint, "function", "Fingerprint sampling is missing");
  const upstream = await fingerprintGateway(t);
  const gateway = new Gateway({ url: upstream.url });
  for (const api of ["responses", "chat_completions", "messages"]) {
    const model = api === "chat_completions" ? "chat" : api;
    const sample = await sampling.sampleFingerprint(gateway, { model: "fixture/" + model, api, effort: "high", maxTokens: 131072, strict: false, account: "北冥" }, challenge, { signal: new AbortController().signal });
    assert.equal(sample.state, "truncated"); assert.equal(sample.count, 300); assert.equal(sample.raw_text, numberReply());
    assert.equal(sample.response_model, "fixture/" + model); assert.equal(sample.usage.output_tokens || sample.usage.completion_tokens, 400);
    assert.equal(sample.provenance.verified, false, "A response alias alone is not a verified gateway route");
  }
  const requests = upstream.seen.requests;
  assert.deepEqual(requests.map(item => item.path), ["/v1/responses", "/v1/chat/completions", "/v1/messages"]);
  assert.equal(requests[0].payload.max_output_tokens, 131072); assert.equal(requests[1].payload.max_tokens, 131072); assert.equal(requests[2].payload.max_tokens, 131072);
  assert.deepEqual(requests[0].payload.input, [{ role: "user", content: "choose 300 numbers" }]);
  assert.deepEqual(requests[1].payload.messages, [{ role: "user", content: "choose 300 numbers" }]);
  assert.equal(requests[0].payload.reasoning.effort, "high"); assert.equal(requests[1].payload.reasoning_effort, "high"); assert.equal(requests[2].payload.output_config.effort, "high");
  assert.ok(requests.every(item => item.headers["x-magpie-account"] === encodeURIComponent("北冥")));
  assert.equal(new Set(requests.map(item => item.headers["x-magpie-session"])).size, 3);
});

test("fingerprint sampler retains partial output on cancellation and releases upstream", async t => {
  assert.equal(typeof sampling.sampleFingerprint, "function");
  const upstream = await fingerprintGateway(t, { handler: ({ res, chunk }) => {
    res.writeHead(200, { "content-type": "text/event-stream" }); chunk({ choices: [{ delta: { content: "12, 340, 14, " } }] });
  } });
  const abort = new AbortController(); let progress = "";
  const task = sampling.sampleFingerprint(new Gateway({ url: upstream.url }), { model: "fixture/chat", api: "chat_completions", maxTokens: 32000, strict: false }, challenge,
    { signal: abort.signal, onUpdate: sample => { progress = sample.raw_text; } });
  await waitFor(() => progress); abort.abort(); const sample = await task;
  assert.equal(sample.state, "cancelled"); assert.equal(sample.raw_text, "12, 340, 14, ");
  await waitFor(() => upstream.seen.aborted === 1);
});

test("strict sampling accepts complete JSON and records gateway route mismatches without treating aliases as route identities", async t => {
  assert.equal(typeof sampling.sampleFingerprint, "function");
  const upstream = await fingerprintGateway(t, { handler: ({ complete }) => complete(numberReply(300), "stop", true), route: () => ({ route: { model: "fixture/replaced", provider: "fixture" } }) });
  const sample = await sampling.sampleFingerprint(new Gateway({ url: upstream.url }), { model: "fixture/chat", api: "chat_completions", maxTokens: 32000, strict: true }, challenge,
    { signal: new AbortController().signal });
  assert.equal(sample.state, "complete"); assert.equal(sample.count, 300); assert.equal(sample.provenance.mismatch, true); assert.equal(sample.provenance.model, "fixture/replaced");
});

test("fingerprint Chat JSON and SSE select candidate zero without mixing other candidate output", async t => {
  const expected = numberReply(300);
  for (const json of [false, true]) for (const reversed of [false, true]) {
    const upstream = await fingerprintGateway(t, { handler: ({ res, chunk }) => {
      res.writeHead(200, { "content-type": json ? "application/json" : "text/event-stream" });
      const key = json ? "message" : "delta";
      const choices = [
        { index: 0, [key]: { content: expected, reasoning_content: "零" }, finish_reason: "stop" },
        { index: 1, [key]: { content: numberReply(320), reasoning_content: "不要采用此候选" }, finish_reason: "length" },
      ];
      if (json) res.end(JSON.stringify({ choices: reversed ? choices.reverse() : choices }));
      else {
        chunk({ choices: [{ index: 1, delta: { content: "999, ", reasoning_content: "忽略" }, finish_reason: "length" }] });
        chunk({ choices: reversed ? choices.reverse() : choices });
        res.end("data: [DONE]\n\n");
      }
    } });
    const sample = await sampling.sampleFingerprint(new Gateway({ url: upstream.url }),
      { model: "fixture/chat", api: "chat_completions", maxTokens: 32000, strict: true }, challenge);
    assert.equal(sample.state, "complete", sample.error); assert.equal(sample.raw_text, expected);
    assert.equal(sample.count, 300); assert.equal(sample.reasoningChars, 1); assert.equal(sample.finishReason, "stop");
  }
});

test("cached account labels are projected without credentials or balances", async t => {
  const upstream = await fingerprintGateway(t); const gateway = new Gateway({ url: upstream.url });
  assert.equal(typeof gateway.accounts, "function", "Cached account projection is missing");
  assert.deepEqual(await gateway.accounts(), [{ provider: "fixture", id: "北冥", name: "主账号", enabled: null, available: null }]);
  assert.deepEqual(upstream.seen.reads, ["/v1/magpie/quotas?kept=1"]);
});

test("reference data loads only explicitly, preserves snapshots and keeps the previous cache after failed refresh", async t => {
  assert.equal(typeof banks.FingerprintBank, "function", "Fingerprint reference cache is missing");
  const dir = await temporary(t), fixture = referenceFixture();
  const upstream = await fingerprintGateway(t, { bank: fixture });
  const bank = new banks.FingerprintBank({ dir: join(dir, "bank"), source: upstream.url + "/data/" });
  await bank.init(); assert.equal(bank.status().state, "missing"); assert.equal(upstream.seen.downloads.length, 0);
  const loaded = await bank.load(); assert.equal(loaded.meta.builtAt, "test-snapshot"); assert.match(loaded.meta.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(upstream.seen.downloads.map(item => item.path), ["/data/bundle.json", "/data/chunks/fixture.zst"]);
  assert.ok(upstream.seen.downloads.every(item => !item.headers.authorization));
  assert.deepEqual(await readFile(join(dir, "bank", loaded.meta.sha256 + ".bin")), fixture.cache);
  await bank.load(); assert.equal(upstream.seen.downloads.length, 2, "Loading the ready snapshot must not refresh in background");
  fixture.bundle = Buffer.from("broken"); await assert.rejects(() => bank.refresh(), /参考|JSON/);
  assert.equal(bank.status().state, "ready"); assert.equal((await bank.load()).meta.sha256, loaded.meta.sha256);
  const restored = new banks.FingerprintBank({ dir: join(dir, "bank"), source: upstream.url + "/data/" });
  await restored.init(); assert.equal((await restored.load()).meta.sha256, loaded.meta.sha256); assert.equal(upstream.seen.downloads.length, 3);
});

test("upstream update checks compare metadata without downloading chunks or replacing the current snapshot", async t => {
  const dir = await temporary(t), original = referenceFixture("current", true), upstream = await fingerprintGateway(t, { bank: original });
  const bank = new banks.FingerprintBank({ dir: join(dir, "bank"), source: upstream.url + "/data/" });
  await bank.load();
  upstream.server.removeAllListeners("request");
  const changed = referenceFixture("updated", true); let published = changed.bundle;
  const seen = [];
  upstream.server.on("request", (req, res) => {
    seen.push(req.url);
    if (req.url === "/data/bundle.json") res.end(published);
    else { res.writeHead(500); res.end(); }
  });
  const checked = await bank.checkForUpdate({ force: true });
  assert.equal(checked.updateAvailable, true, "A changed detector must show an update even when its model count is unchanged");
  assert.deepEqual(seen, ["/data/bundle.json"], "A badge check downloads metadata only");
  assert.equal(bank.status().meta.builtAt, "current", "Checking for an update must not replace the active bank");
  const renamed = JSON.parse(changed.bundle); renamed.models[0].display_name = "Reference Alpha"; published = Buffer.from(JSON.stringify(renamed));
  assert.equal((await bank.checkForUpdate({ force: true })).updateAvailable, true, "Model metadata changes remain visible even with the same detector and model count");
  const stampOnly = JSON.parse(original.bundle); stampOnly.built_at = "stamp-only update"; published = Buffer.from(JSON.stringify(stampOnly));
  assert.equal((await bank.checkForUpdate({ force: true })).updateAvailable, false, "A build-date-only change does not claim a useful update");
  published = Buffer.from("unavailable");
  const failedCheck = await bank.checkForUpdate({ force: true });
  assert.equal(failedCheck.updateAvailable, false, "A transient check failure leaves the last known update state alone");
  assert.ok(failedCheck.lastCheckedAt > 0, "A completed check records when it ran");
  assert.match(failedCheck.checkError, /参考库|JSON|unavailable/);
  assert.equal(seen.filter(path => path === "/data/chunks/fixture.zst").length, 0, "Update checks never download detector chunks");
  await bank.close();
});

test("refresh skips a stale first mirror and installs the exact snapshot advertised by the update check", async t => {
  const dir = await temporary(t), old = referenceFixture("2026-11-25T00:00:00Z", true), current = referenceFixture("2026-11-26T00:00:00Z", true), latest = referenceFixture("2026-11-27T00:00:00Z", true);
  const requests = [], server = createServer((req, res) => {
    requests.push(req.url);
    const fixture = req.url.startsWith("/old/") ? old : latest;
    if (req.url.endsWith("bundle.json")) res.end(fixture.bundle);
    else if (req.url.endsWith("fixture.zst")) res.end(fixture.compressed);
    else { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`, bank = new banks.FingerprintBank({ dir: join(dir, "bank"), source: [`${base}/old/`, `${base}/new/`] });
  t.after(async () => { await bank.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await bank.init(); bank.current = await bank.install(current.cache, false);
  const checked = await bank.checkForUpdate({ force: true });
  assert.equal(checked.updateAvailable, true); assert.equal(checked.meta.builtAt, "2026-11-26T00:00:00Z");
  const refreshed = await bank.refresh();
  assert.equal(refreshed.meta.builtAt, "2026-11-27T00:00:00Z");
  assert.deepEqual(await bank.snapshotBytes(refreshed.meta.sha256), latest.cache);
  assert.equal(bank.status().updateAvailable, false);
  assert.deepEqual(requests.filter(path => path.endsWith("bundle.json")), ["/old/bundle.json", "/new/bundle.json", "/old/bundle.json", "/new/bundle.json"]);
});

test("a changed advertised manifest or only older mirrors cannot overwrite the current reference", async t => {
  const dir = await temporary(t), originalFetch = globalThis.fetch;
  const current = referenceFixture("2026-11-26T00:00:00Z", true), latest = referenceFixture("2026-11-27T00:00:00Z", true), alternate = referenceFixture("2026-11-28T00:00:00Z", true);
  let published = latest;
  globalThis.fetch = async input => new Response(String(input).endsWith("bundle.json") ? published.bundle : published.compressed);
  t.after(() => { globalThis.fetch = originalFetch; });
  const bank = new banks.FingerprintBank({ dir, source: "http://fixture.invalid/" }); t.after(() => bank.close());
  await bank.init(); bank.current = await bank.install(current.cache); const pointer = await readFile(join(dir, "current.json"));
  assert.equal((await bank.checkForUpdate({ force: true })).updateAvailable, true);
  published = alternate;
  await assert.rejects(bank.refresh(), /清单|检查|变化/);
  assert.deepEqual(await readFile(join(dir, "current.json")), pointer); assert.equal(bank.status().updateAvailable, true);
  published = referenceFixture("2026-11-25T00:00:00Z", true);
  await assert.rejects(bank.refresh(), /旧|版本|检查|清单/);
  assert.deepEqual(await readFile(join(dir, "current.json")), pointer);
});

test("failed reference checks retry after five minutes while successful checks keep the twelve hour interval", async t => {
  const dir = await temporary(t), originalFetch = globalThis.fetch, originalNow = Date.now, fixture = referenceFixture("2026-11-26T00:00:00Z", true);
  let clock = originalNow(), unavailable = true, calls = 0;
  Date.now = () => clock;
  globalThis.fetch = async () => { calls++; return unavailable ? new Response("offline", { status: 503 }) : new Response(fixture.bundle); };
  t.after(() => { globalThis.fetch = originalFetch; Date.now = originalNow; });
  const bank = new banks.FingerprintBank({ dir, source: "http://fixture.invalid/" }); t.after(() => bank.close());
  await bank.init(); bank.current = await bank.install(fixture.cache);
  await bank.checkForUpdate(); assert.equal(calls, 1); assert.equal(bank.status().lastSuccessfulCheckAt, 0); assert.ok(bank.status().checkError);
  clock += 4 * 60 * 1000; await bank.checkForUpdate(); assert.equal(calls, 1);
  clock += 60 * 1000; unavailable = false; await bank.checkForUpdate(); assert.equal(calls, 2);
  assert.equal(bank.status().lastSuccessfulCheckAt, clock); assert.equal(bank.status().checkError, "");
  clock += 6 * 60 * 60 * 1000; await bank.checkForUpdate(); assert.equal(calls, 2);
  clock += 6 * 60 * 60 * 1000; await bank.checkForUpdate(); assert.equal(calls, 3);
});

test("a mirror with unchanged metadata cannot hide a useful update with the same build date", async t => {
  const dir = await temporary(t), originalFetch = globalThis.fetch, current = referenceFixture("2026-11-26T00:00:00Z", true);
  const changed = JSON.parse(current.bundle); changed.models[0].display_name = "New reference name";
  globalThis.fetch = async input => new Response(String(input).includes("/changed/") ? JSON.stringify(changed) : current.bundle);
  t.after(() => { globalThis.fetch = originalFetch; });
  const bank = new banks.FingerprintBank({ dir, source: ["http://fixture.invalid/current/", "http://fixture.invalid/changed/"] }); t.after(() => bank.close());
  await bank.init(); bank.current = await bank.install(current.cache);
  assert.equal((await bank.checkForUpdate({ force: true })).updateAvailable, true);
});

test("a failed refresh rechecks changed metadata after five minutes without losing the last success time", async t => {
  const dir = await temporary(t), originalFetch = globalThis.fetch, originalNow = Date.now, current = referenceFixture("2026-11-26T00:00:00Z", true);
  let clock = originalNow(), published = referenceFixture("2026-11-27T00:00:00Z", true), requests = 0;
  Date.now = () => clock;
  globalThis.fetch = async input => { requests++; return new Response(String(input).endsWith("bundle.json") ? published.bundle : published.compressed); };
  t.after(() => { globalThis.fetch = originalFetch; Date.now = originalNow; });
  const bank = new banks.FingerprintBank({ dir, source: "http://fixture.invalid/" }); t.after(() => bank.close());
  await bank.init(); bank.current = await bank.install(current.cache); await bank.checkForUpdate(); const success = bank.status().lastSuccessfulCheckAt;
  published = referenceFixture("2026-11-28T00:00:00Z", true); await assert.rejects(bank.refresh(), /清单/);
  assert.equal(bank.status().lastSuccessfulCheckAt, success);
  const before = requests; clock += 5 * 60 * 1000; await bank.checkForUpdate(); assert.equal(requests, before + 1);
  assert.equal((await bank.refresh()).meta.builtAt, "2026-11-28T00:00:00Z");
});

test("reference refresh rejects digest mismatches and chunk paths outside its configured source", async t => {
  assert.equal(typeof banks.FingerprintBank, "function");
  const dir = await temporary(t), fixture = referenceFixture(); const upstream = await fingerprintGateway(t, { bank: fixture });
  const bank = new banks.FingerprintBank({ dir, source: upstream.url + "/data/" }); await bank.init();
  const bundle = JSON.parse(fixture.bundle); bundle.files["shared_detector.bin"].sha256 = "0".repeat(64); fixture.bundle = Buffer.from(JSON.stringify(bundle));
  await assert.rejects(() => bank.load(), /校验|哈希/); assert.equal(bank.status().state, "missing");
  bundle.files["shared_detector.bin"].parts = ["../../outside"]; fixture.bundle = Buffer.from(JSON.stringify(bundle));
  const before = upstream.seen.downloads.length; await assert.rejects(() => bank.refresh(), /分块|路径/);
  assert.equal(upstream.seen.downloads.length, before + 1, "An invalid part must never be requested");
  assert.deepEqual((await readdir(dir)).filter(name => name.endsWith(".bin")), []);
});

async function runnerFixture(t, options = {}) {
  const dir = await temporary(t), fixture = referenceFixture("ranked-snapshot", true);
  const upstream = await fingerprintGateway(t, { bank: fixture, ...options });
  const store = new RunStore(join(dir, "runs")); await store.init();
  const bank = new banks.FingerprintBank({ dir: join(dir, "bank"), source: upstream.url + "/data/" }); await bank.init();
  const runner = new Runner({ store, bank, gateway: new Gateway({ url: upstream.url }), timeoutMs: options.timeoutMs || 600000 });
  t.after(async () => { await runner.close(); await bank.close(); });
  return { dir, runner, store, bank, upstream };
}
const fingerprintRequest = (ids = ["chat"], options = {}) => ({ kind: "fingerprint", models: ids.map(id => ({ id: "fixture/" + id, effort: "low" })), maxTokens: 32000, concurrency: 2, ...options });

test('fingerprint account evidence aggregates all samples and never labels partial evidence as verified', async t => {
  for (const expected of ['verified', 'unavailable', 'mismatch']) {
    let routeReads = 0;
    const { runner, store } = await runnerFixture(t, { route: () => ({ route: { model: 'fixture/chat', provider: 'fixture', ...(expected === 'unavailable' && ++routeReads === 2 ? {} : { accountId: expected === 'mismatch' ? 'other-account' : '北冥' }) } }) });
    const [created] = await runner.submit({ kind: 'fingerprint', targets: [{ modelId: 'fixture/chat', account: { mode: 'pinned', id: '北冥' } }], maxTokens: 32000, concurrency: 1 });
    await waitFor(() => !runner.busy(created.id) && !['queued', 'running'].includes(runner.get(created.id).status));
    const run = await store.get(created.id); assert.equal(run.routing.verification, expected);
    assert.equal(run.routing.requestedAccountId, '北冥');
    if (expected === 'mismatch') { assert.equal(run.status, 'error'); assert.equal(run.analysis, null); }
  }
});

test("zero fingerprint concurrency starts all samples across models and still supports cancellation", async t => {
  const { runner, upstream } = await runnerFixture(t, { handler: ({ res }) => {
    res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders();
  } });
  const created = await runner.submit(fingerprintRequest(["chat", "responses"], { concurrency: 0 }));
  await waitFor(() => upstream.seen.requests.length === 6);
  assert.equal(runner.active.size, 6);
  await runner.cancelBatch(created[0].batchId);
  assert.ok(created.every(run => runner.get(run.id).status === "cancelled"));
  assert.equal(runner.active.size, 0);
});

test("omitting concurrency starts three fingerprint samples but only two animation requests", async t => {
  const { runner, upstream } = await runnerFixture(t, { handler: ({ res }) => {
    res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders();
  } });
  try {
    const sampled = await runner.submit(fingerprintRequest(["chat", "responses"], { concurrency: undefined }));
    assert.equal(sampled[0].concurrency, 3);
    await waitFor(() => upstream.seen.requests.length === 3);
    await runner.cancelBatch(sampled[0].batchId); assert.equal(upstream.seen.requests.length, 3);
    const animated = await runner.submit({ prompt: "test", models: ["chat", "responses", "messages"].map(id => ({ id: "fixture/" + id })) });
    assert.equal(animated[0].concurrency, 2); await waitFor(() => upstream.seen.requests.length === 5);
    await runner.cancelBatch(animated[0].batchId); assert.equal(upstream.seen.requests.length, 5);
  } finally { await runner.close(); }
});

test("one fingerprint batch shares three challenges across protocols and persists the SDK ranking with compact summaries", async t => {
  const { runner, store, upstream, bank } = await runnerFixture(t);
  const created = await runner.submit(fingerprintRequest(["responses", "chat", "messages"]));
  await waitFor(() => created.every(item => !["queued", "running"].includes(runner.get(item.id).status)));
  assert.equal(upstream.seen.requests.length, 9); assert.ok(upstream.seen.peak <= 2, "Concurrency counts requests, not models times three");
  const prompts = new Map();
  for (const { payload } of upstream.seen.requests) {
    const prompt = (payload.input || payload.messages)[0].content;
    const prior = prompts.get(payload.model) || new Set(); prior.add(prompt); prompts.set(payload.model, prior);
  }
  assert.deepEqual([...prompts.values()].map(value => [...value].sort()), Array(3).fill([...prompts.values()][0]).map(value => [...value].sort()));
  const loaded = await bank.load();
  for (const item of created) {
    const detail = await store.get(item.id);
    assert.equal(detail.kind, "fingerprint"); assert.equal(detail.status, "completed"); assert.equal(detail.samples.length, 3);
    assert.equal(detail.analysis.prediction, "reference/a"); assert.ok(Math.abs(detail.analysis.probability - .8807970779778823) < 1e-10);
    assert.deepEqual(detail.analysis, loaded.detector.analyze(detail.samples.map(sample => ({ text: sample.text, expected_count: sample.expected_count })), { strict: false }));
    assert.equal(await readFile(detail.files.samples, "utf8"), JSON.stringify(detail.samples, null, 2));
    assert.equal(runner.list().find(run => run.id === item.id).samples, undefined, "Raw replies must not travel on every SSE summary");
    assert.equal(runner.list().find(run => run.id === item.id).challenges, undefined); assert.equal(runner.list().find(run => run.id === item.id).fingerprint.prediction, "Reference A");
  }
  assert.equal(runner.payloads.size, 0, "Completed batches release their detector references");
});

test("fingerprint batch cancellation aborts all active samples before the queue can start another", async t => {
  const { runner, upstream, store } = await runnerFixture(t, { handler: ({ res, chunk }) => {
    res.writeHead(200, { "content-type": "text/event-stream" }); chunk({ choices: [{ delta: { content: "17, 320, " } }] });
  } });
  const created = await runner.submit(fingerprintRequest(["chat", "responses", "messages"]));
  await waitFor(() => upstream.seen.requests.length === 2);
  assert.equal(typeof runner.cancelBatch, "function", "Atomic batch cancellation is missing");
  await runner.cancelBatch(created[0].batchId); await waitFor(() => upstream.seen.aborted === 2);
  assert.equal(upstream.seen.requests.length, 2); assert.equal(runner.queue.length, 0);
  assert.ok(created.every(item => runner.get(item.id).status === "cancelled" && !runner.get(item.id).analysis));
  assert.ok((await store.get(created[0].id)).samples.some(sample => sample.raw_text.includes("17")));
});

test("partial fingerprint scoring omits probability while strict and route-mismatched results remain unscored", async t => {
  let calls = 0;
  const partial = await runnerFixture(t, { handler: ({ res, complete }) => {
    if (++calls === 2) { res.writeHead(429, { 'retry-after': '1' }); res.end('{"error":{"message":"quota"}}'); } else complete();
  } });
  const [created] = await partial.runner.submit(fingerprintRequest());
  await waitFor(() => partial.runner.queuePolicy.status().cooldowns.length);
  await waitFor(() => !["queued", "running"].includes(partial.runner.get(created.id).status));
  assert.equal(partial.runner.get(created.id).analysis.decision, "partial"); assert.equal(partial.runner.get(created.id).analysis.probability, null);
  calls = 0;
  const [strict] = await partial.runner.submit(fingerprintRequest(["chat"], { strict: true }));
  await waitFor(() => partial.runner.queuePolicy.status().cooldowns.length);
  await waitFor(() => !["queued", "running"].includes(partial.runner.get(strict.id).status));
  assert.equal(partial.runner.get(strict.id).analysis, null);
  const mismatch = await runnerFixture(t, { route: () => ({ route: { model: "fixture/other", provider: "fixture" } }) });
  const [routed] = await mismatch.runner.submit(fingerprintRequest()); await waitFor(() => !["queued", "running"].includes(mismatch.runner.get(routed.id).status));
  assert.equal(mismatch.runner.get(routed.id).analysis, null); assert.match(mismatch.runner.get(routed.id).error, /路由/);
});

test("fingerprint validation does not download data and a large batch has no twenty-four-model or three-request ceiling", async t => {
  const ids = Array.from({ length: 25 }, (_, index) => "model-" + index);
  const { runner, upstream } = await runnerFixture(t, { models: ids, handler: ({ res }) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders(); } });
  for (const options of [{ concurrency: -1 }, { maxTokens: -1 }, { api: "unknown" }, { strict: "yes" }, { models: [{ id: "missing" }] }]) await assert.rejects(() => runner.submit(fingerprintRequest(ids, options)));
  assert.equal(upstream.seen.downloads.length, 0); assert.equal(upstream.seen.requests.length, 0);
  const created = await runner.submit(fingerprintRequest(ids, { concurrency: 8, maxTokens: 131072 }));
  await waitFor(() => upstream.seen.requests.length === 8); assert.equal(created.length, 25); assert.equal(upstream.seen.peak, 8);
  await runner.cancelBatch(created[0].batchId); assert.equal(upstream.seen.requests.length, 8);
});

test("fingerprint recovery keeps three raw samples and batch cleanup leaves the reference snapshot available", async t => {
  const { dir, runner, store, bank } = await runnerFixture(t);
  const [created] = await runner.submit(fingerprintRequest()); await waitFor(() => runner.get(created.id).status === "completed");
  const snapshot = (await bank.load()).meta.sha256;
  await runner.close(); const restored = new RunStore(store.dir); await restored.init();
  assert.equal((await restored.get(created.id)).samples.length, 3); assert.equal(restored.list()[0].fingerprint.prediction, "Reference A");
  const clean = new Runner({ store: restored, gateway: {} }); t.after(() => clean.close());
  const outcome = await clean.cleanup({ mode: "batch", batchId: created.batchId }); assert.deepEqual(outcome.removed, [created.id]);
  assert.ok(await readFile(join(dir, "bank", snapshot + ".bin"))); assert.deepEqual(await readdir(store.dir), []);
});

test("a fingerprint timeout retains partial samples and reaches an unscored terminal result", async t => {
  const { runner, upstream } = await runnerFixture(t, { timeoutMs: 80, handler: ({ res, chunk }) => {
    res.writeHead(200, { "content-type": "text/event-stream" }); chunk({ choices: [{ delta: { content: "17, 300, " } }] });
  } });
  const [created] = await runner.submit(fingerprintRequest()); await waitFor(() => runner.get(created.id).status === "error");
  assert.ok(runner.get(created.id).samples.every(sample => sample.error.includes("超时"))); assert.equal(runner.get(created.id).analysis, null);
  assert.ok(runner.get(created.id).samples.every(sample => sample.raw_text === "17, 300, ")); await waitFor(() => upstream.seen.aborted === 3);
});

test("strict JSON rejects incomplete finish reasons and responses over the sample byte boundary", async t => {
  const upstream = await fingerprintGateway(t, { handler: ({ complete }) => complete(numberReply(300), "length", true) });
  const sample = await sampling.sampleFingerprint(new Gateway({ url: upstream.url }), { model: "fixture/chat", api: "chat_completions", maxTokens: 32000, strict: true }, challenge, { signal: new AbortController().signal });
  assert.equal(sample.state, "failed"); assert.equal(sample.raw_text, numberReply(300));
  const huge = await fingerprintGateway(t, { handler: ({ complete }) => complete("x".repeat(4 * 1024 * 1024 + 1), "stop", true) });
  const limited = await sampling.sampleFingerprint(new Gateway({ url: huge.url }), { model: "fixture/chat", api: "chat_completions", maxTokens: 32000, strict: true }, challenge, { signal: new AbortController().signal });
  assert.equal(limited.state, "failed"); assert.equal(limited.raw_text, "");
});

test("an explicit SSE or JSON length finish cannot be scored just because numbers are present", async t => {
  for (const json of [false, true]) {
    const upstream = await fingerprintGateway(t, { handler: ({ complete }) => complete(numberReply(json ? 320 : 200), "length", json) });
    const sample = await sampling.sampleFingerprint(new Gateway({ url: upstream.url }), { model: "fixture/chat", api: "chat_completions", maxTokens: 32000, strict: false }, challenge, { signal: new AbortController().signal });
    assert.equal(sample.state, "failed", `A ${json ? "JSON" : "SSE"} length termination must not count as a valid sample`);
    assert.ok(sample.raw_text.length > 0);
  }
});

test("first fingerprint byte measures body arrival rather than only HTTP headers", async t => {
  const upstream = await fingerprintGateway(t, { handler: ({ res, complete }) => {
    res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders(); setTimeout(() => complete(), 90);
  } });
  const sample = await sampling.sampleFingerprint(new Gateway({ url: upstream.url }), { model: "fixture/chat", api: "chat_completions", maxTokens: 32000, strict: false }, challenge, { signal: new AbortController().signal });
  assert.ok(sample.first_byte_ms >= 70, `Got ${sample.first_byte_ms} ms before the body was sent`);
});

test("fingerprint errors redact an arbitrary gateway key echoed by the upstream", async t => {
  const key = "random-gateway-credential-7925";
  const upstream = await fingerprintGateway(t, { handler: ({ res }) => { res.writeHead(401); res.end(JSON.stringify({ error: { message: `Denied ${key}` } })); } });
  const sample = await sampling.sampleFingerprint(new Gateway({ url: upstream.url, key }), { model: "fixture/chat", api: "chat_completions", maxTokens: 32000, strict: false }, challenge, { signal: new AbortController().signal });
  assert.equal(sample.state, "failed"); assert.equal(sample.error.includes(key), false);
});

test("a stale local cache has no background refresh and offline data source keeps the exact snapshot", async t => {
  const dir = await temporary(t), fixture = referenceFixture(); const source = join(dir, "source"); await mkdir(source);
  await writeFile(join(source, "unified_bank.json"), fixture.bundle); await writeFile(join(source, "shared_detector.bin"), fixture.detector);
  const bank = new banks.FingerprintBank({ dir: join(dir, "cache"), source }); await bank.init();
  const loaded = await bank.load(); assert.equal(bank.status().local, true); assert.equal(loaded.meta.builtAt, "test-snapshot");
  const snapshot = join(dir, "cache", loaded.meta.sha256 + ".bin"); await utimes(snapshot, new Date(0), new Date(0));
  const unavailable = await fingerprintGateway(t);
  const restored = new banks.FingerprintBank({ dir: join(dir, "cache"), source: unavailable.url + "/data/" });
  await restored.init(); await restored.load(); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(unavailable.seen.downloads.length, 0);
});

test("reference cache refuses a junction root and does not read the external pointer", async t => {
  const dir = await temporary(t), external = await temporary(t);
  await writeFile(join(external, "keep.txt"), "keep"); const linked = join(dir, "bank");
  await symlink(external, linked, process.platform === "win32" ? "junction" : "dir");
  const bank = new banks.FingerprintBank({ dir: linked }); await assert.rejects(() => bank.init(), /普通目录/);
  assert.equal(await readFile(join(external, "keep.txt"), "utf8"), "keep"); assert.deepEqual(await readdir(external), ["keep.txt"]);
});

test("published reference bytes describes the compressed download while its digest describes the decoded detector", async t => {
  const dir = await temporary(t), fixture = referenceFixture();
  const bundle = JSON.parse(fixture.bundle); bundle.files["shared_detector.bin"].bytes = fixture.compressed.length; fixture.bundle = Buffer.from(JSON.stringify(bundle));
  const upstream = await fingerprintGateway(t, { bank: fixture });
  const bank = new banks.FingerprintBank({ dir, source: upstream.url + "/data/" }); await bank.init();
  const loaded = await bank.load(); assert.equal(loaded.meta.builtAt, "test-snapshot");
  assert.equal(loaded.meta.detectorSha256, bundle.files["shared_detector.bin"].sha256);
});
