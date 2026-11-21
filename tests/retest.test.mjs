import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Gateway } from "../lib/gateway.mjs";
import { Runner } from "../lib/runner.mjs";
import { RunStore } from "../lib/store.mjs";
import { FingerprintBank } from "../lib/fingerprint-bank.mjs";
import { fakeGateway, temporary, waitFor } from "./helpers.mjs";
import { fingerprintGateway, referenceFixture } from "./fingerprint-helpers.mjs";

async function setup(t, handler) {
  const dir = await temporary(t), upstream = await fakeGateway(t, handler);
  const store = new RunStore(dir); await store.init();
  const runner = new Runner({ store, gateway: new Gateway({ url: upstream.url }) });
  t.after(() => runner.close());
  return { runner, store, upstream, dir };
}

async function seed(runner, fields = {}) {
  const record = await runner.store.save({ id: randomUUID(), batchId: randomUUID(), kind: "pelican", model: "fixture/one", modelName: "one", provider: "fixture",
    effort: "high", prompt: "原来的测试提示词", maxTokens: 1234, concurrency: 1, status: "completed", createdAt: new Date().toISOString(),
    content: "原来的结果", reasoning: "原来的思考", html: "", error: "", ...fields });
  runner.runs.set(record.id, record); return record;
}

test("preview shows original conditions without generating or changing the source", async t => {
  const { runner, upstream } = await setup(t);
  const source = await seed(runner), before = await readFile(source.files.metadata, "utf8");
  assert.equal(typeof runner.previewRetest, "function", "Original-condition preview is missing");
  const preview = await runner.previewRetest({ runIds: [source.id] });
  assert.equal(preview.items[0].available, true);
  assert.equal(preview.items[0].conditions.prompt, "原来的测试提示词");
  assert.equal(preview.items[0].conditions.maxTokens, 1234);
  assert.equal(preview.items[0].conditions.effort, "high");
  assert.equal(upstream.seen.requests.length, 0);
  assert.equal(await readFile(source.files.metadata, "utf8"), before);
});

test("retest creates new manual results with each source's own prompt and output cap", async t => {
  const { runner, upstream } = await setup(t);
  const roundId = randomUUID();
  const first = await seed(runner, { roundId, maxTokens: 0, concurrency: 2 });
  const second = await seed(runner, { roundId, model: "fixture/two", effort: "low", maxTokens: 900, prompt: "第二条原题", concurrency: 1 });
  assert.equal(typeof runner.retest, "function", "Original-condition retest is missing");
  const result = await runner.retest({ runIds: [first.id, second.id], operationId: randomUUID() });
  await waitFor(() => result.runs.every(run => runner.get(run.id).status === "completed"));
  assert.equal(result.runs.length, 2);
  assert.ok(result.runs.every(run => run.source === "manual" && run.roundId === result.batchId));
  assert.equal(new Set(result.runs.map(run => run.batchId)).size, 2, "Different source request batches retain independent concurrency");
  const firstPayload = upstream.seen.requests.find(payload => payload.model === "fixture/one"), secondPayload = upstream.seen.requests.find(payload => payload.model === "fixture/two");
  assert.equal(firstPayload.messages[0].content, "原来的测试提示词");
  assert.equal(Object.hasOwn(firstPayload, "max_tokens"), false);
  assert.equal(firstPayload.reasoning_effort, "high");
  assert.equal(secondPayload.messages[0].content, "第二条原题");
  assert.equal(secondPayload.max_tokens, 900);
  assert.equal(runner.get(first.id).content, "原来的结果");
  assert.equal(result.runs[0].retest.sourceRunId, first.id);
});

test("automatic single retest does not inherit scheduling or favorite deduplication", async t => {
  const { runner } = await setup(t, ({ complete }) => complete("最终答案：21"));
  const source = await seed(runner, { kind: "candy", source: "automatic", favoriteId: randomUUID(), compareKey: "original", scheduledAt: new Date().toISOString(),
    plans: [], candy: { version: "shape-choice-v1", expected: 21, verdict: "match", answer: 21 }, prompt: "历史糖果原题" });
  assert.equal(typeof runner.retest, "function", "Automatic single-record retest is missing");
  const result = await runner.retest({ runIds: [source.id], operationId: randomUUID() });
  await waitFor(() => runner.get(result.runs[0].id).status === "completed");
  const run = runner.get(result.runs[0].id);
  assert.equal(run.prompt, "历史糖果原题");
  assert.equal(run.candy.verdict, "match");
  assert.equal(run.source, "manual");
  for (const key of ["favoriteId", "compareKey", "plans", "scheduledAt", "expiresAt"]) assert.equal(Object.hasOwn(run, key), false, key);
  assert.equal(run.retest.sourceMode, "automatic");
  assert.equal(run.retest.sourceTime, source.scheduledAt);
});

test("duplicate operations and restart retries reuse the created batch without new requests", async t => {
  const { runner, upstream, store, dir } = await setup(t);
  const source = await seed(runner), request = { runIds: [source.id], operationId: randomUUID() };
  assert.equal(typeof runner.retest, "function", "Idempotent retest is missing");
  const [first, duplicate] = await Promise.all([runner.retest(request), runner.retest(request)]);
  assert.equal(first.batchId, duplicate.batchId);
  assert.equal(first.runs[0].id, duplicate.runs[0].id);
  await waitFor(() => runner.get(first.runs[0].id).status === "completed" && !runner.busy(first.runs[0].id));
  await runner.close();
  const restoredStore = new RunStore(dir); await restoredStore.init();
  const restored = new Runner({ store: restoredStore, gateway: runner.gateway }); t.after(() => restored.close());
  const retry = await restored.retest(request);
  assert.equal(retry.batchId, first.batchId);
  assert.equal(upstream.seen.requests.length, 1);
  assert.ok((await store.get(first.runs[0].id)).retest);
  const other = await seed(restored);
  await assert.rejects(() => restored.retest({ runIds: [other.id], operationId: request.operationId }), /操作|重复/);
});

test("malformed operation IDs cannot create untraceable or non-idempotent retests", async t => {
  const { runner, upstream } = await setup(t), source = await seed(runner);
  await assert.rejects(() => runner.retest({ runIds: [source.id], operationId: [randomUUID()] }), /操作标识/);
  assert.equal(runner.list().length, 1);
  assert.equal(upstream.seen.requests.length, 0);
});

test("unavailable and active sources are explained and an invalid selection starts nothing", async t => {
  const { runner, upstream } = await setup(t);
  const batchId = randomUUID();
  const sources = await Promise.all([
    seed(runner, { batchId, status: "running" }), seed(runner, { batchId, model: "fixture/missing" }),
    seed(runner, { batchId, effort: "impossible" }), seed(runner, { batchId, prompt: undefined }), seed(runner, { batchId, status: "cancelled" }),
  ]);
  assert.equal(typeof runner.previewRetest, "function", "Retest eligibility checks are missing");
  const preview = await runner.previewRetest({ runIds: sources.map(run => run.id) });
  assert.deepEqual(preview.items.map(item => item.available), [false, false, false, false, true]);
  assert.ok(preview.items.slice(0, 4).every(item => item.reason));
  await assert.rejects(() => runner.retest({ runIds: sources.slice(0, 2).map(run => run.id), operationId: randomUUID() }));
  assert.equal(upstream.seen.requests.length, 0);
});

test("a malformed original automatic timestamp blocks retest before creating an untraceable result", async t => {
  const { runner, upstream } = await setup(t);
  const source = await seed(runner, { source: "automatic", scheduledAt: "not-a-time" });
  const preview = await runner.previewRetest({ runIds: [source.id] });
  assert.equal(preview.items[0].available, false); assert.match(preview.items[0].reason, /时间/);
  await assert.rejects(() => runner.retest({ runIds: [source.id], operationId: randomUUID() }), /时间/);
  assert.equal(upstream.seen.requests.length, 0); assert.equal(runner.list().length, 1);
});

test("retest rejects multiple automatic times, unrelated manual batches and mixed kinds", async t => {
  const { runner, upstream } = await setup(t), roundId = randomUUID();
  const auto = await seed(runner, { source: "automatic" }), otherAuto = await seed(runner, { source: "automatic" });
  const one = await seed(runner, { roundId }), two = await seed(runner);
  const candy = await seed(runner, { roundId, kind: "candy", candy: { version: "shape-choice-v1", expected: 21 } });
  assert.equal(typeof runner.retest, "function", "Retest source scope validation is missing");
  for (const records of [[auto, otherAuto], [one, two], [one, candy], [one, one]]) {
    await assert.rejects(() => runner.retest({ runIds: records.map(run => run.id), operationId: randomUUID() }));
  }
  assert.equal(upstream.seen.requests.length, 0);
});

test("retest rolls back every child batch before any request starts when saving fails", async t => {
  const { runner, upstream, store, dir } = await setup(t), roundId = randomUUID();
  const first = await seed(runner, { roundId }), second = await seed(runner, { roundId, model: "fixture/two" });
  const save = store.save.bind(store); let writes = 0;
  store.save = async record => { const saved = await save(record); if (++writes === 2) throw new Error("Retest disk failure"); return saved; };
  assert.equal(typeof runner.retest, "function", "Atomic retest creation is missing");
  await assert.rejects(() => runner.retest({ runIds: [first.id, second.id], operationId: randomUUID() }), /Retest disk failure/);
  assert.equal(runner.list().length, 2); assert.equal(store.list().length, 2);
  assert.equal(runner.queue.length, 0); assert.equal(upstream.seen.requests.length, 0);
  assert.equal((await readdir(dir)).length, 2);
});

test("fingerprint retest reuses all original challenges, interface, account and old bank without changing the current pointer", async t => {
  const dir = await temporary(t), upstream = await fingerprintGateway(t, { bank: referenceFixture("download") });
  const store = new RunStore(dir); await store.init();
  const bank = new FingerprintBank({ dir: join(dir, ".fingerprint-bank"), source: upstream.url + "/data/" });
  const originalBank = await bank.install(referenceFixture("original", true).cache);
  bank.current = await bank.install(referenceFixture("current", true).cache);
  const runner = new Runner({ store, bank, gateway: new Gateway({ url: upstream.url }) });
  t.after(async () => { await runner.close(); await bank.close(); });
  const challenges = ["原题一", "Original probe two", "Ancienne question trois"].map((prompt, index) => ({ id: `original-${index}`, prompt, expected_count: 280 }));
  const source = await seed(runner, { kind: "fingerprint", model: "fixture/chat", prompt: undefined, bank: originalBank.meta,
    api: "chat_completions", requestedApi: "auto", strict: true, serviceTier: "fast", account: "北冥", challenges,
    samples: challenges.map(challenge => ({ state: "complete", raw_text: "原回答", text: "原回答", count: 280, expected_count: challenge.expected_count })) });
  const pointer = await readFile(join(bank.dir, "current.json"), "utf8");
  assert.equal(typeof runner.retest, "function", "Fingerprint original-condition retest is missing");
  const result = await runner.retest({ runIds: [source.id], operationId: randomUUID() });
  await waitFor(() => upstream.seen.requests.length === 3);
  await waitFor(() => !runner.busy(result.runs[0].id) && !["queued", "running"].includes(runner.get(result.runs[0].id).status));
  const run = runner.get(result.runs[0].id);
  assert.deepEqual(run.challenges, challenges); assert.equal(run.bank.sha256, originalBank.meta.sha256);
  assert.equal(run.strict, true); assert.equal(run.api, "chat_completions"); assert.equal(run.serviceTier, "fast");
  assert.equal(run.account, "北冥");
  assert.deepEqual(upstream.seen.requests.map(item => item.payload.messages.at(-1).content), challenges.map(challenge => challenge.prompt));
  assert.ok(upstream.seen.requests.every(item => item.headers["x-magpie-account"] === encodeURIComponent("北冥")));
  assert.equal(await readFile(join(bank.dir, "current.json"), "utf8"), pointer);
  assert.equal(bank.current.meta.builtAt, "current");
});

test("missing or corrupted historical fingerprint bank blocks retest without downloading a replacement", async t => {
  const dir = await temporary(t), upstream = await fingerprintGateway(t, { bank: referenceFixture("download") });
  const store = new RunStore(dir); await store.init();
  const bank = new FingerprintBank({ dir: join(dir, ".fingerprint-bank"), source: upstream.url + "/data/" });
  const originalBank = await bank.install(referenceFixture("original", true).cache);
  const runner = new Runner({ store, bank, gateway: new Gateway({ url: upstream.url }) });
  t.after(async () => { await runner.close(); await bank.close(); });
  const challenges = [0, 1, 2].map(index => ({ id: `original-${index}`, prompt: `原题 ${index}`, expected_count: 280 }));
  const source = await seed(runner, { kind: "fingerprint", model: "fixture/chat", bank: originalBank.meta, api: "chat_completions", requestedApi: "auto", strict: false,
    serviceTier: "default", account: "", challenges, samples: challenges.map(() => ({ state: "complete", raw_text: "old", text: "old" })) });
  assert.equal(typeof runner.previewRetest, "function", "Historical bank validation is missing");
  const path = join(bank.dir, `${originalBank.meta.sha256}.bin`);
  for (const corruption of [false, true]) {
    if (corruption) await writeFile(path, "damaged"); else await rm(path);
    const preview = await runner.previewRetest({ runIds: [source.id] });
    assert.equal(preview.items[0].available, false); assert.match(preview.items[0].reason, /参考库/);
    await assert.rejects(() => runner.retest({ runIds: [source.id], operationId: randomUUID() }), /参考库/);
  }
  assert.equal(upstream.seen.downloads.length, 0); assert.equal(upstream.seen.requests.length, 0);
});

test("a catalog refresh during fingerprint preparation keeps the validated models for the whole retest", async t => {
  const dir = await temporary(t), upstream = await fingerprintGateway(t);
  const store = new RunStore(dir); await store.init();
  const bank = new FingerprintBank({ dir: join(dir, ".fingerprint-bank") });
  const snapshot = await bank.install(referenceFixture("original", true).cache);
  const runner = new Runner({ store, bank, gateway: new Gateway({ url: upstream.url }) });
  t.after(async () => { await runner.close(); await bank.close(); });
  const batchId = randomUUID(), challenges = [0, 1, 2].map(index => ({ id: `original-${index}`, prompt: `Original probe ${index}`, expected_count: 280 }));
  const fields = { batchId, kind: "fingerprint", bank: snapshot.meta, api: "chat_completions", requestedApi: "auto", strict: false,
    serviceTier: "default", account: "", challenges, samples: challenges.map(() => ({ state: "complete", raw_text: "old", text: "old" })) };
  const first = await seed(runner, { ...fields, model: "fixture/chat" }), second = await seed(runner, { ...fields, model: "fixture/messages" });
  const loadSnapshot = bank.loadSnapshot.bind(bank); let release, preparing = false;
  bank.loadSnapshot = async sha => { preparing = true; await new Promise(resolve => { release = resolve; }); return loadSnapshot(sha); };
  const completion = runner.retest({ runIds: [first.id, second.id], operationId: randomUUID() });
  await waitFor(() => preparing);
  runner.gateway.models = async () => [];
  await runner.models(true);
  release();
  const result = await completion;
  assert.deepEqual(result.runs.map(run => run.model), [first.model, second.model]);
  await waitFor(() => result.runs.every(run => !runner.busy(run.id) && !["queued", "running"].includes(runner.get(run.id).status)));
  assert.equal(upstream.seen.requests.length, 6);
  assert.ok(upstream.seen.requests.every(request => [first.model, second.model].includes(request.payload.model)));
});

test("restart rejects malformed retest links while retaining ordinary old history", async t => {
  const { runner, dir } = await setup(t);
  const old = await seed(runner), bad = await seed(runner, { retest: { sourceRunId: "../bad", sourceTime: "not-a-date" } });
  const restored = new RunStore(dir); await restored.init();
  assert.ok(restored.records.has(old.id));
  assert.equal(restored.records.has(bad.id), false, "Malformed source links must not reach the UI after restart");
});

test("restart rejects arrays in retest identifiers while keeping valid source links", async t => {
  const { runner, dir } = await setup(t);
  const link = { sourceRunId: randomUUID(), sourceBatchId: randomUUID(), operationId: randomUUID(), sourceMode: "manual",
    sourceTime: "2026-11-20T01:00:00Z", selectionHash: "a".repeat(64) };
  const valid = await seed(runner, { retest: link });
  const malformed = [];
  for (const key of ["sourceRunId", "sourceBatchId", "operationId"]) malformed.push(await seed(runner, { retest: { ...link, [key]: [link[key]] } }));
  const restored = new RunStore(dir); await restored.init();
  assert.ok(restored.records.has(valid.id));
  assert.deepEqual(malformed.map(run => restored.records.has(run.id)), [false, false, false]);
  assert.equal(restored.unreadable, 3);
});
