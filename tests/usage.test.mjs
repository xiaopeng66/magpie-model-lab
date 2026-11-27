import test from "node:test";
import assert from "node:assert/strict";
import { Gateway } from "../lib/gateway.mjs";
import { Runner } from "../lib/runner.mjs";
import { RunStore } from "../lib/store.mjs";
import { summary } from "../lib/result.mjs";
import { sumUsage } from "../lib/usage.mjs";
import { sampleFingerprint } from "../lib/fingerprint-sample.mjs";
import { startTestServer as startServer, fakeGateway, temporary, waitFor, FIXTURE_HTML } from "./helpers.mjs";
import { fingerprintGateway, numberReply, referenceFixture } from "./fingerprint-helpers.mjs";

test("fingerprint usage totals stay unknown after a top-level count overflows", () => {
  assert.deepEqual(sumUsage([
    { usage: { total_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 0 } },
    { usage: { total_tokens: 2, completion_tokens: 4 } },
    { usage: { total_tokens: 3, completion_tokens: 5 } },
  ]), { total_tokens: null, completion_tokens: 9 });
  assert.deepEqual(sumUsage([
    { usage: { total_tokens: Number.MAX_SAFE_INTEGER - 2 } },
    { usage: { total_tokens: 2 } },
  ]), { total_tokens: Number.MAX_SAFE_INTEGER });
});

test("fingerprint usage details stay unknown after a nested count overflows", () => {
  assert.deepEqual(sumUsage([
    { usage: { completion_tokens_details: { reasoning_tokens: Number.MAX_SAFE_INTEGER, accepted_prediction_tokens: 0 } } },
    { usage: { completion_tokens_details: { reasoning_tokens: 2, accepted_prediction_tokens: 1 } } },
    { usage: { completion_tokens_details: { reasoning_tokens: 3, accepted_prediction_tokens: 2 } } },
  ]), { completion_tokens_details: { reasoning_tokens: null, accepted_prediction_tokens: 3 } });
});

test("all three tests project reported tokens, retaining zero and distinguishing missing samples", () => {
  for (const kind of ["pelican", "candy"]) {
    const run = summary({ kind, usage: { prompt_tokens: 10, completion_tokens: 50, completion_tokens_details: { reasoning_tokens: 0 } } });
    assert.deepEqual(run.tokens, { reasoning: 0, output: 50, total: 60, partial: [] });
  }
  const run = summary({ kind: "fingerprint", samples: [
    { state: "complete", raw_text: "1, 2", reasoningChars: 6, usage: { completion_tokens: 50, prompt_tokens: 10, completion_tokens_details: { reasoning_tokens: 20 } } },
    { state: "streaming", raw_text: "3, 4", reasoningChars: 4, usage: { input_tokens: 10, output_tokens: 40, output_tokens_details: { reasoning_tokens: 0 } } },
    { state: "queued", usage: null },
  ] });
  assert.equal(run.reasoningChars, 10); assert.equal(run.contentChars, 8);
  assert.deepEqual(run.tokens, { reasoning: 20, output: 90, total: 110, partial: ["reasoning", "output", "total"] });
  assert.deepEqual(summary({ kind: "candy", usage: { completion_tokens: -1, reasoning_tokens: "12" } }).tokens,
    { reasoning: null, output: null, total: null, partial: [] });
});

for (const kind of ["pelican", "candy"]) test(`${kind} publishes usage-only chunks, merges details and saves usage on cancellation`, async t => {
  let push;
  const upstream = await fakeGateway(t, ({ res, chunk }) => {
    res.writeHead(200, { "content-type": "text/event-stream" }); push = chunk;
    chunk({ choices: [{ delta: { reasoning: "正在分析" } }] });
    chunk({ choices: [{ delta: { content: "正在回答" } }] });
    chunk({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 50, completion_tokens_details: { reasoning_tokens: 20 } } });
  });
  const dir = await temporary(t), store = new RunStore(dir); await store.init();
  const runner = new Runner({ store, gateway: new Gateway({ url: upstream.url }) }); t.after(() => runner.close());
  const events = []; runner.subscribe(event => events.push(event));
  const [created] = await runner.submit({ kind, prompt: "test", models: [{ id: "fixture/one" }] });
  await waitFor(() => runner.get(created.id)?.content === "正在回答");
  assert.equal(runner.get(created.id).reasoning, "正在分析");
  assert.equal(runner.get(created.id).usage?.completion_tokens, 50, "Usage must be published before completion");
  const first = events.find(event => event.type === "delta" && event.tokens?.reasoning === 20);
  assert.ok(first); assert.equal(first.tokens.output, 50);
  push({ choices: [], usage: { completion_tokens: 80, completion_tokens_details: { accepted_prediction_tokens: 5 } } });
  await waitFor(() => runner.get(created.id)?.usage?.completion_tokens === 80);
  await runner.cancel(created.id);
  const restored = new RunStore(dir); await restored.init(); const saved = await restored.get(created.id);
  assert.equal(saved.status, "cancelled"); assert.equal(saved.usage.completion_tokens_details.reasoning_tokens, 20);
  assert.equal(saved.usage.completion_tokens_details.accepted_prediction_tokens, 5);
  assert.deepEqual(restored.list()[0].tokens, { reasoning: 20, output: 80, total: 90, partial: [] });
});

for (const api of ["chat_completions", "messages", "responses"]) test(`${api} fingerprint streams thought counts and usage without exposing thought text`, async t => {
  let finish;
  const upstream = await fingerprintGateway(t, { handler: ({ res, chunk }) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (api === "chat_completions") {
      chunk({ choices: [{ delta: { reasoning_content: "逐步分析" } }] });
      chunk({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 40, completion_tokens_details: { reasoning_tokens: 20 } } });
      finish = () => { chunk({ choices: [{ delta: { content: numberReply(300) }, finish_reason: "stop" }] }); res.end("data: [DONE]\n\n"); };
    } else if (api === "messages") {
      chunk({ type: "message_start", message: { usage: { input_tokens: 10 } } });
      chunk({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "逐步分析" } });
      chunk({ type: "message_delta", usage: { output_tokens: 40 } });
      finish = () => { chunk({ type: "content_block_delta", delta: { type: "text_delta", text: numberReply(300) } }); chunk({ type: "message_delta", delta: { stop_reason: "end_turn" } }); chunk({ type: "message_stop" }); res.end(); };
    } else {
      chunk({ type: "response.reasoning_summary_text.delta", delta: "逐步分析" });
      chunk({ type: "response.in_progress", response: { usage: { input_tokens: 10, output_tokens: 40, output_tokens_details: { reasoning_tokens: 20 } } } });
      finish = () => { chunk({ type: "response.output_text.delta", delta: numberReply(300) }); chunk({ type: "response.completed", response: { status: "completed" } }); res.end(); };
    }
  } });
  const updates = [], abort = new AbortController(); t.after(() => abort.abort());
  const pending = sampleFingerprint(new Gateway({ url: upstream.url }), { model: "fixture/chat", api, maxTokens: 32000, strict: true },
    { expected_count: 300, prompt: "numbers" }, { signal: abort.signal, onUpdate: value => updates.push(value) });
  await waitFor(() => typeof finish === "function");
  await new Promise(resolve => setTimeout(resolve, 30));
  const live = updates.at(-1); finish(); const result = await pending;
  assert.equal(live.reasoningChars, 4); assert.equal(live.usage?.output_tokens ?? live.usage?.completion_tokens, 40);
  assert.equal(result.state, "complete"); assert.equal(result.reasoningChars, 4);
  assert.equal(summary({ kind: "fingerprint", samples: [result] }).reasoningChars, 4);
  assert.equal(result.reasoning, undefined, "Only counts, not additional thought text, are saved for fingerprint samples");
});

test("fingerprint finish retains nested token usage and recovers it from old sample records", async t => {
  const store = new RunStore(await temporary(t)); await store.init();
  const runner = new Runner({ store, gateway: {} }); t.after(() => runner.close());
  const run = { id: "5a4a1ce4-5ffd-4ea9-a754-2a23be1e769b", model: "fixture/one", kind: "fingerprint", status: "running", createdAt: new Date().toISOString(),
    samples: [0, 1, 2].map(() => ({ state: "failed", usage: { completion_tokens: 50, completion_tokens_details: { reasoning_tokens: 20 } } })) };
  runner.runs.set(run.id, run); await runner.finishFingerprint(run, {});
  assert.equal(run.usage.completion_tokens_details?.reasoning_tokens, 60);
  const old = { ...run, usage: { completion_tokens: 150 } };
  assert.equal(summary(old).tokens.reasoning, 60, "Historic sample usage can recover details lost by the old aggregate");
  assert.equal(summary(old).tokens.output, 150);
});

test("fingerprint publishes the last sample counts in a short burst even while upstream goes silent", async t => {
  let runner; t.after(() => runner?.close());
  const upstream = await fakeGateway(t, ({ res, chunk }) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    chunk({ choices: [{ delta: { reasoning_content: "逐步分析", content: "17, 24, " } }] });
    chunk({ choices: [], usage: { completion_tokens: 40, completion_tokens_details: { reasoning_tokens: 20 } } });
  });
  const store = new RunStore(await temporary(t)); await store.init();
  runner = new Runner({ store, gateway: new Gateway({ url: upstream.url }), bank: { load: async () => ({ meta: {}, detector: {} }), close: async () => {} } });
  const events = []; runner.subscribe(event => events.push(event));
  const [run] = await runner.submit({ kind: "fingerprint", concurrency: 1, models: [{ id: "fixture/one" }] });
  await waitFor(() => runner.get(run.id)?.samples[0].raw_text === "17, 24, ");
  await new Promise(resolve => setTimeout(resolve, 160));
  const latest = events.filter(event => event.type === "run").at(-1).run;
  assert.equal(latest.fingerprint.samples[0].count, 2, "The final burst must not wait for another network chunk to render");
  assert.equal(latest.reasoningChars, 4); assert.equal(latest.tokens.reasoning, 20); assert.equal(latest.tokens.output, 40);
  assert.deepEqual(latest.tokens.partial, ["reasoning", "output"]);
});

test("completed, truncated and failed candy runs all retain the same reported token metadata", async t => {
  const upstream = await fakeGateway(t, ({ res, chunk, payload }) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    chunk({ choices: [{ delta: { reasoning_content: "思考" } }] });
    chunk({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 40, completion_tokens_details: { reasoning_tokens: 20 } } });
    if (payload.model.endsWith("three")) chunk({ error: { message: "fixture disconnected" } });
    else chunk({ choices: [{ delta: { content: "最终答案：21" }, finish_reason: payload.model.endsWith("two") ? "length" : "stop" }] });
    res.end("data: [DONE]\n\n");
  });
  const store = new RunStore(await temporary(t)); await store.init();
  const runner = new Runner({ store, gateway: new Gateway({ url: upstream.url }) }); t.after(() => runner.close());
  const created = await runner.submit({ kind: "candy", models: ["one", "two", "three"].map(name => ({ id: "fixture/" + name })) });
  await waitFor(() => created.every(run => !["queued", "running"].includes(runner.get(run.id).status)));
  assert.deepEqual(created.map(run => runner.get(run.id).status), ["completed", "truncated", "error"]);
  for (const run of store.list()) assert.deepEqual(run.tokens, { reasoning: 20, output: 40, total: 50, partial: [] });
});

test("list, detail and batch export agree on real token usage across all three HTTP test paths", async t => {
  let service; t.after(() => service?.close());
  const upstream = await fingerprintGateway(t, { models: ["chat"], bank: referenceFixture("usage-test", true), handler: ({ res, chunk, complete, payload }) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    chunk({ choices: [{ delta: { reasoning_content: "分析题目" } }], usage: { completion_tokens_details: { reasoning_tokens: 25 } } });
    const prompt = payload.messages[0].content;
    complete(prompt.includes("糖果") ? "最终答案：21" : prompt === "鹈鹕" ? FIXTURE_HTML : numberReply());
  } });
  service = await startServer({ port: 0, dataDir: await temporary(t), gatewayUrl: upstream.url, bankSource: upstream.url + "/data/" });
  const token = (await (await fetch(service.url)).text()).match(/name="pelican-token" content="([a-f0-9]+)"/)[1];
  const request = async (path, body) => {
    const response = await fetch(service.url + path, { method: body ? "POST" : "GET", headers: { "x-pelican-token": token, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.ok(response.ok); return response.json();
  };
  for (const kind of ["pelican", "fingerprint", "candy"]) await request("api/runs", { kind, models: [{ id: "fixture/chat" }], prompt: "鹈鹕" });
  const records = await waitFor(async () => { const { runs } = await request("api/runs"); return runs.length === 3 && runs.every(run => run.status === "completed") && runs; });
  for (const record of records) {
    const detail = await request("api/runs/" + record.id), batch = await request(`api/batches/${record.batchId}/export`);
    const count = record.kind === "fingerprint" ? 3 : 1;
    assert.equal(record.tokens.reasoning, 25 * count); assert.equal(record.tokens.output, 400 * count);
    assert.deepEqual(detail.tokens, record.tokens); assert.equal(detail.reasoningChars, 4 * count);
    assert.equal(batch.runs[0].usage.completion_tokens_details.reasoning_tokens, 25 * count);
  }
});
