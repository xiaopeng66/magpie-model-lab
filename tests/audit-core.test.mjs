import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Gateway, parseSSE, safeError } from "../lib/gateway.mjs";
import { sampleFingerprint } from "../lib/fingerprint-sample.mjs";
import { historyBatches, scheduledTime } from "../lib/history-groups.mjs";
import { parseNumbers } from "../vendor/lmfpd-sdk/index.js";
import { RunStore } from "../lib/store.mjs";
import { Runner } from "../lib/runner.mjs";
import { temporary, waitFor } from "./helpers.mjs";
import { numberReply } from "./fingerprint-helpers.mjs";

const sse = text => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n` +
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
const gatewayFixture = () => Object.assign(new Gateway({ url: "http://127.0.0.1:54321", key: "fixture" }), {
  route: async () => ({ model: "fixture/one", provider: "fixture" }), redact: safeError,
  models: async () => [{ id: "fixture/one", name: "One", provider: "fixture", efforts: [] }] });
const sampleOptions = { model: "fixture/one", api: "chat_completions", maxTokens: 1000, strict: false };
const challenge = { prompt: "Choose 280 integers from 1 to 355.", expected_count: 280 };

test("001: CR, LF and split CRLF produce the same SSE events and release the reader", async () => {
  for (const newline of ["\r", "\n", "\r\n"]) {
    const wire = new TextEncoder().encode([": heartbeat", "event: chunk", 'data: {"text":"鹈鹕"}', "", "data: [DONE]", ""].join(newline));
    const stream = new ReadableStream({ start(controller) {
      for (const byte of wire) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    } });
    const events = [];
    for await (const event of parseSSE(stream)) events.push(event);
    assert.deepEqual(events, [{ event: "chunk", data: '{"text":"鹈鹕"}' }, { event: "message", data: "[DONE]" }], JSON.stringify(newline));
    assert.equal(stream.locked, false);
  }
});

test("002: a normal terminal newline does not turn an exact fingerprint sample into a truncation", async t => {
  for (const suffix of ["", "\n"]) {
    t.mock.method(globalThis, "fetch", async () => new Response(sse(numberReply(280) + suffix), { headers: { "content-type": "text/event-stream" } }));
    const sample = await sampleFingerprint(gatewayFixture(), sampleOptions, challenge);
    assert.equal(sample.state, "complete", JSON.stringify(suffix));
    assert.equal(sample.count, 280); assert.equal(sample.finishReason, "stop"); assert.equal(sample.error, null);
    assert.equal(sample.raw_text, numberReply(280) + suffix);
    t.mock.restoreAll();
  }
});

test("002: an actually oversized sample retains its complete prefix and truncated state", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response(sse(numberReply(281)), { headers: { "content-type": "text/event-stream" } }));
  const sample = await sampleFingerprint(gatewayFixture(), sampleOptions, challenge);
  assert.equal(sample.state, "truncated"); assert.equal(sample.count, 280);
  assert.equal(sample.raw_text, numberReply(281));
});

test("003: reliable planned times group by minute while creation-time fallbacks keep their precision", () => {
  const make = (id, model, scheduledAt) => ({ id, model, kind: "candy", source: "automatic", status: "completed",
    createdAt: id === "one" ? "2026-11-20T09:00:04Z" : "2026-11-20T09:00:00Z", scheduledAt });
  const planned = [make("one", "fixture/one", "2026-11-20T17:00:04+08:00"), make("two", "fixture/two", "2026-11-20T09:00:00Z")];
  const groups = historyBatches(planned, "UTC");
  assert.equal(groups.length, 1); assert.deepEqual(groups[0].times, ["2026-11-20T09:00:00.000Z"]);
  assert.equal(scheduledTime(planned[0]), "2026-11-20T09:00:00.000Z");
  assert.equal(historyBatches(planned.map(run => ({ ...run, scheduledAt: undefined })), "UTC").length, 2);
});

test("004: damaged optional timestamps are unreadable and their original files remain recoverable", async t => {
  const dir = await temporary(t), store = new RunStore(dir); await store.init();
  const healthy = await store.save({ id: randomUUID(), createdAt: "2026-11-20T09:00:00Z", status: "completed" });
  const damaged = [];
  for (const key of ["scheduledAt", "startedAt", "finishedAt", "expiresAt"]) {
    damaged.push(await store.save({ id: randomUUID(), createdAt: healthy.createdAt, status: "completed", [key]: "bad-date" }));
  }
  damaged.push(await store.save({ id: randomUUID(), createdAt: healthy.createdAt, status: "completed",
    plans: [{ id: randomUUID(), expiresAt: "bad-date" }] }));
  const restored = new RunStore(dir), recovery = await restored.init();
  assert.equal(recovery.unreadable, 5); assert.deepEqual([...restored.records.keys()], [healthy.id]);
  for (const run of damaged) assert.equal(JSON.parse(await readFile(join(dir, run.id, "run.json"), "utf8")).id, run.id);
});

test("004: cutoff cleanup falls back to creation time if an in-memory finished time is invalid", async t => {
  const store = new RunStore(await temporary(t)); await store.init();
  const run = await store.save({ id: randomUUID(), createdAt: "2026-11-10T09:00:00Z", finishedAt: "bad-date", status: "completed" });
  const runner = new Runner({ store, gateway: {} }); t.after(() => runner.close());
  const result = await runner.cleanup({ mode: "before", before: "2026-11-11T00:00:00Z" });
  assert.deepEqual(result.removed, [run.id]);
});

test("005: gateway query and fragment components are rejected before any request, including empty delimiters", () => {
  for (const suffix of ["?mode=local", "/#local", "?", "#"]) {
    assert.throws(() => new Gateway({ url: "http://127.0.0.1:54321" + suffix }), error => error.status === 400 && /查询|片段/.test(error.message));
  }
  assert.equal(new Gateway({ url: "http://127.0.0.1:54321/base/v1///" }).url, "http://127.0.0.1:54321/base");
});

test("010: task first response includes the wait for preceding fingerprint samples that failed before bytes", async t => {
  const store = new RunStore(await temporary(t)); await store.init();
  const gateway = gatewayFixture(), bank = { load: async () => ({ meta: { sha256: "a".repeat(64), builtAt: "fixture", sdkVersion: "0.2.0" },
    detector: { analyze: () => ({ decision: "partial", results: [], probability: null }) } }), close: async () => {} };
  let calls = 0, firstByteAt = null;
  t.mock.method(globalThis, "fetch", async () => {
    if (calls++ === 0) { await new Promise(resolve => setTimeout(resolve, 140)); throw new Error("fixture failed before bytes"); }
    await new Promise(resolve => setTimeout(resolve, 25)); firstByteAt ??= Date.now();
    return new Response(sse(numberReply(340)), { headers: { "content-type": "text/event-stream" } });
  });
  const runner = new Runner({ store, gateway, bank }); t.after(() => runner.close());
  const [created] = await runner.submit({ kind: "fingerprint", models: [{ id: "fixture/one" }], concurrency: 1, api: "chat_completions", maxTokens: 1000 });
  const run = await waitFor(() => runner.get(created.id).status === "completed" && runner.get(created.id));
  const actual = firstByteAt - Date.parse(run.startedAt);
  assert.equal(calls, 3); assert.equal(run.samples[0].first_byte_ms, null);
  assert.ok(run.firstContentMs >= actual - 1 && run.firstContentMs <= actual + 80, `${run.firstContentMs}ms reported, ${actual}ms observed`);
  assert.ok(run.firstContentMs - run.samples[1].first_byte_ms >= 130);
});

test("011: numeric parsing keeps complete signs and decimal values rather than turning them into integers", () => {
  assert.deepEqual(parseNumbers("[-12, -340, 1.5, 2.7]"), []);
  assert.deepEqual(parseNumbers("[1, 355, -2, 1.5, 2.7, +3]"), [1, 355, 3]);
  assert.deepEqual(parseNumbers("[10, 20] explanation 30"), [10, 20], "Keep the existing longest numeric-sequence policy");
});

test("011: strict negative samples fail with zero accepted integers and preserve raw evidence", async t => {
  const text = Array.from({ length: 300 }, (_, index) => index % 2 ? "-340" : "-12").join(", ");
  t.mock.method(globalThis, "fetch", async () => new Response(sse(text), { headers: { "content-type": "text/event-stream" } }));
  const sample = await sampleFingerprint(gatewayFixture(), { ...sampleOptions, strict: true }, { ...challenge, expected_count: 300 });
  assert.equal(sample.state, "failed"); assert.equal(sample.count, 0); assert.equal(sample.raw_text, text);
  assert.match(sample.error, /有效数字不足/);
});
