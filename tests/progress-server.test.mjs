import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Gateway } from "../lib/gateway.mjs";
import { Runner } from "../lib/runner.mjs";
import { RunStore } from "../lib/store.mjs";
import { sampleFingerprint } from "../lib/fingerprint-sample.mjs";
import { FingerprintBank } from "../lib/fingerprint-bank.mjs";
import { newProgress, advanceProgress } from "../lib/progress.mjs";
import { fakeGateway, temporary, waitFor } from "./helpers.mjs";
import { fingerprintGateway, referenceFixture } from "./fingerprint-helpers.mjs";
import { phaseABoot } from "./phase-a-fixtures.mjs";

test("Gateway notifies valid empty role events but ignores heartbeats and JSON ping", async t => {
  const events = [], upstream = await fakeGateway(t, ({ res, chunk }) => {
    res.writeHead(200, { "content-type": "text/event-stream" }); res.write(": heartbeat\n\n"); chunk({ type: "ping" }); chunk({ type: "unknown" });
    chunk({ choices: [{ delta: { role: "assistant" } }] }); chunk({ choices: [{ delta: { content: "21" }, finish_reason: "stop" }] }); res.end("data: [DONE]\n\n");
  });
  await new Gateway({ url: upstream.url }).generate({}, { onChunk: value => events.push(value) });
  assert.equal(events.length, 2); assert.ok(events.every(value => value.modelEvent === true)); assert.equal(events[0].content, "");
});
test("fingerprint raw first bytes remain independent from parsed model event progress", async t => {
  let chunk, res, sample, valid = []; const upstream = await fingerprintGateway(t, { handler: value => { ({ chunk, res } = value); res.writeHead(200, { "content-type": "text/event-stream" }); res.write(": heartbeat\n\n"); chunk({ type: "ping" }); } });
  const abort = new AbortController();
  const task = sampleFingerprint(new Gateway({ url: upstream.url }), { model: "fixture/chat", api: "chat_completions", maxTokens: 64000, strict: true }, { prompt: "numbers", expected_count: 300 }, { signal: abort.signal, onUpdate: value => { sample = value; }, onProgress: value => valid.push(value) });
  await waitFor(() => sample?.first_byte_ms !== null); assert.equal(valid.length, 0);
  chunk({ choices: [{ delta: { role: "assistant" } }] }); await waitFor(() => valid.length === 1); assert.equal(valid[0].modelEvent, true);
  chunk({ choices: [{ delta: { reasoning_content: "reason" } }] }); await waitFor(() => valid.length === 2); assert.equal(valid[1].reasoning, true);
  abort.abort(); await task;
});
test("terminal progress is published after durable saving, late chunks never rewrite terminal output", async t => {
  const store = new RunStore(await temporary(t)); await store.init(); const save = store.save.bind(store), events = []; let release, callback, savedTerminal = false;
  store.save = async run => { if (run.status === "completed") { await new Promise(resolve => { release = resolve; }); savedTerminal = true; } return save(run); };
  const gateway = { models: async () => [{ id: "fixture/one", efforts: [] }], generate: async (_payload, { onChunk }) => { callback = onChunk; onChunk({ modelEvent: true }); onChunk({ content: "21", modelEvent: true }); return { finishReason: "stop" }; } };
  let mono = 100; const runner = new Runner({ store, gateway, monoNow: () => mono }); t.after(() => runner.close()); runner.subscribe(event => events.push({ ...event, savedTerminal }));
  const [run] = await runner.submit({ kind: "candy", models: [{ id: "fixture/one" }], timeoutMs: 0 }); await waitFor(() => release);
  assert.equal(runner.get(run.id).status, "running"); assert.equal(runner.get(run.id).progress.phase, "saving");
  callback({ content: "late", modelEvent: true }); assert.equal(runner.get(run.id).content, "21");
  release(); await waitFor(() => !runner.busy(run.id)); const ended = runner.get(run.id); assert.equal(ended.progress.phase, "ended");
  assert.ok(events.filter(event => event.run?.status === "completed").every(event => event.savedTerminal));
  const raw = JSON.parse(await readFile(join(store.path(run.id), "run.json"), "utf8")); assert.equal(raw.progress.phase, "ended"); assert.equal(raw.runtimeTiming, undefined);
  const count = events.length; callback({ content: "later", modelEvent: true }); assert.equal(events.length, count); assert.equal(runner.get(run.id).content, "21");
});
test("saving failures produce an ended error rather than an indefinitely saving run", async t => {
  const store = new RunStore(await temporary(t)); await store.init(); const save = store.save.bind(store);
  store.save = run => run.status === "completed" ? Promise.reject(new Error("disk full")) : save(run);
  const runner = new Runner({ store, gateway: { models: async () => [{ id: "fixture/one", efforts: [] }], generate: async (_payload, { onChunk }) => { onChunk({ content: "21", modelEvent: true }); return { finishReason: "stop" }; } } }); t.after(() => runner.close());
  const [run] = await runner.submit({ kind: "candy", models: [{ id: "fixture/one" }] }); await waitFor(() => !runner.busy(run.id));
  assert.equal(runner.get(run.id).status, "error"); assert.equal(runner.get(run.id).progress.phase, "ended"); assert.match(runner.get(run.id).error, /保存失败/);
});
test("fingerprint samples start and time independently, summaries omit text and queued timers", async t => {
  const dir = await temporary(t), holds = []; const upstream = await fingerprintGateway(t, { bank: referenceFixture(), handler: value => { holds.push(value); value.res.writeHead(200, { "content-type": "text/event-stream" }); value.res.flushHeaders(); } });
  const store = new RunStore(join(dir, "runs")); await store.init(); const bank = new FingerprintBank({ dir: join(dir, "bank"), source: upstream.url + "/data/" }); await bank.init();
  let mono = 100; const runner = new Runner({ store, bank, gateway: new Gateway({ url: upstream.url }), monoNow: () => mono }); t.after(() => runner.close());
  const [created] = await runner.submit({ kind: "fingerprint", models: [{ id: "fixture/chat" }], concurrency: 1, timeoutMs: 600000 }); await waitFor(() => holds.length === 1);
  mono = 1500; let run = runner.list()[0]; assert.equal(run.runtimeTiming[0].elapsedMs, 1400); assert.equal(run.runtimeTiming[1], null); assert.equal(run.fingerprint.samples[1].startedAt, null); assert.equal(run.fingerprint.samples[0].progress.phase, "waiting_response");
  holds[0].complete(); await waitFor(() => holds.length === 2); mono = 2000; run = runner.list()[0]; assert.equal(run.runtimeTiming[0], null); assert.equal(run.runtimeTiming[1].elapsedMs, 500); assert.equal(run.fingerprint.samples[0].progress.phase, "ended"); assert.equal(run.fingerprint.samples[0].text, undefined);
  await runner.cancel(created.id); assert.ok(runner.get(created.id).samples.every(s => s.progress.phase === "ended"));
});
test("optional corrupt progress degrades history alone while new invalid progress is rejected", async t => {
  const dir = await temporary(t), store = new RunStore(dir); await store.init(); const id = randomUUID();
  const run = { id, status: "completed", kind: "candy", createdAt: "2026-11-22T00:00:00Z", content: "21", progress: advanceProgress(newProgress(), "end", { at: "2026-11-22T00:00:01Z" }) };
  await store.save(run); await assert.rejects(() => store.save({ ...run, progress: { schema: 9 } }));
  const path = join(store.path(id), "run.json"), raw = JSON.parse(await readFile(path, "utf8")); raw.progress = { schema: 9 }; await writeFile(path, JSON.stringify(raw));
  const restored = new RunStore(dir); const recovery = await restored.init(); assert.equal(recovery.unreadable, 0); const loaded = await restored.get(id); assert.equal(loaded.content, "21"); assert.equal(loaded.progress, undefined); assert.match(loaded.progressWarning, /进度/);
});
test("high-frequency model events throttle progress pushes while wall-clock jumps leave runtime timing intact", async t => {
  const store = new RunStore(await temporary(t)); await store.init();
  let mono = 100, utc = "2026-11-22T00:00:00.000Z", callback, release;
  const events = [], gateway = { models: async () => [{ id: "fixture/one", efforts: [] }], generate: async (_payload, { onChunk }) => {
    callback = onChunk; await new Promise(resolve => { release = resolve; }); return { finishReason: "stop" };
  } };
  const runner = new Runner({ store, gateway, monoNow: () => mono, progressNow: () => utc }); t.after(() => runner.close());
  runner.subscribe(event => { if (event.type === "delta" && event.progress) events.push(event); });
  const [created] = await runner.submit({ kind: "candy", models: [{ id: "fixture/one" }], timeoutMs: 600000 }); await waitFor(() => callback);
  mono = 200; utc = "2026-11-22T00:00:00.100Z"; callback({ modelEvent: true });
  assert.equal(events.length, 1, "The first model event must be immediate");
  for (let i = 1; i <= 90; i++) { mono = 200 + i * 5; utc = new Date(Date.UTC(2026, 10, 22) + 100 + i * 5).toISOString(); callback({ modelEvent: true }); }
  assert.equal(events.length, 1, "Repeated role events must not produce one SSE push per chunk");
  mono = 1200; utc = "2020-01-01T00:00:00.000Z"; callback({ modelEvent: true });
  assert.equal(events.length, 2);
  const runtime = runner.publicRun(runner.get(created.id)).runtimeTiming;
  assert.deepEqual(runtime, { progressRevision: runner.get(created.id).progress.revision, elapsedMs: 1100, silenceMs: 0, remainingMs: 598900 });
  assert.equal(runner.get(created.id).progress.firstEventAt, "2026-11-22T00:00:00.100Z");
  mono = 1300; callback({}); assert.equal(runner.publicRun(runner.get(created.id)).runtimeTiming.silenceMs, 100);
  utc = "2030-01-01T00:00:00.000Z"; callback({ content: "21", modelEvent: true });
  assert.equal(events.length, 3, "The first output phase must bypass ordinary throttling");
  release(); await waitFor(() => !runner.busy(created.id)); assert.equal(runner.get(created.id).status, "completed");
});
test("restart ends run and independent sample progress while preserving partial replies", async t => {
  const dir = await temporary(t), store = new RunStore(dir); await store.init();
  const run = phaseABoot({ count: 2 }).runs[1], at = "2026-11-22T00:00:00.000Z";
  run.status = "running"; run.finishedAt = null; run.progress = advanceProgress(newProgress(), "start", { at });
  run.samples = run.samples.map((sample, index) => ({ ...sample, state: index === 0 ? "streaming" : "queued", text: index === 0 ? "12, 340" : "", raw_text: index === 0 ? "12, 340" : "",
    startedAt: index === 0 ? at : null, finishedAt: null, progress: index === 0 ? advanceProgress(newProgress(), "output", { at }) : newProgress() }));
  await store.save(run); const reply = await readFile(join(store.path(run.id), "response.txt"), "utf8");
  const restored = new RunStore(dir), recovery = await restored.init(), loaded = await restored.get(run.id);
  assert.equal(recovery.interrupted, 1); assert.equal(loaded.status, "interrupted"); assert.equal(loaded.progress.phase, "ended");
  assert.ok(loaded.samples.every(sample => sample.progress.phase === "ended" && sample.state === "cancelled" && sample.finishedAt));
  assert.equal(await readFile(join(store.path(run.id), "response.txt"), "utf8"), reply);
});
test("concurrent sample checkpoints cannot publish or overwrite a terminal run before all samples are durable", async t => {
  const dir = await temporary(t), holds = [], upstream = await fingerprintGateway(t, { bank: referenceFixture(), handler: value => holds.push(value) });
  const store = new RunStore(join(dir, "runs")); await store.init(); const save = store.save.bind(store);
  let releaseSamples, releaseTerminal, checkpoints = 0;
  const sampleGate = new Promise(resolve => { releaseSamples = resolve; });
  const terminalGate = new Promise(resolve => { releaseTerminal = resolve; });
  store.save = async run => {
    if (run.status === "running" && run.samples.some(sample => sample.progress.phase === "ended")) { checkpoints++; await sampleGate; }
    if (!["queued", "running"].includes(run.status)) await terminalGate;
    return save(run);
  };
  const bank = new FingerprintBank({ dir: join(dir, "bank"), source: upstream.url + "/data/" }); await bank.init();
  const runner = new Runner({ store, bank, gateway: new Gateway({ url: upstream.url }) });
  t.after(async () => { releaseSamples(); releaseTerminal(); await runner.close(); });
  const events = []; runner.subscribe(event => events.push(event));
  const [created] = await runner.submit({ kind: "fingerprint", models: [{ id: "fixture/chat" }], concurrency: 3, strict: true });
  await waitFor(() => holds.length === 3); holds.forEach((value, index) => value.complete(index === 1 ? "12, 340" : undefined));
  await waitFor(() => checkpoints === 3); assert.equal(runner.get(created.id).status, "running");
  assert.ok(events.every(event => !event.run || ["queued", "running"].includes(event.run.status)));
  releaseSamples(); await waitFor(() => runner.get(created.id).samples.every(sample => sample.progress.phase === "ended"));
  assert.equal(runner.get(created.id).status, "running"); releaseTerminal(); await waitFor(() => !runner.busy(created.id));
  const stored = JSON.parse(await readFile(join(store.path(created.id), "run.json"), "utf8"));
  assert.equal(stored.progress.phase, "ended"); assert.ok(stored.samples.every(sample => sample.progress.phase === "ended"));
  assert.equal(stored.samples[1].raw_text, "12, 340"); assert.equal(store.pending.size, 0); assert.equal(upstream.seen.requests.length, 3);
});
