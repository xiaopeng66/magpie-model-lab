import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mergeUsage, tokenUsage } from '../lib/usage.mjs';
import { UsageLedger } from '../lib/usage-ledger.mjs';
import { Gateway } from '../lib/gateway.mjs';
import { sampleFingerprint } from '../lib/fingerprint-sample.mjs';
import { temporary, fakeGateway, startTestServer, waitFor } from './helpers.mjs';
import { fingerprintGateway, numberReply } from './fingerprint-helpers.mjs';

const clock = () => Date.parse('2026-11-24T07:00:00Z');
async function ledger(t) {
  const dir = await temporary(t), usage = new UsageLedger(dir, { now: clock, timeZone: 'UTC' });
  await usage.init(); t.after(() => usage.close()); return { dir, usage };
}
async function issue(usage, reported, provider = 'fixture', accountId = 'a') {
  const input = { physicalRequestId: randomUUID(), runId: randomUUID(), provider, accountId };
  await usage.reserve(input); await usage.start(input.physicalRequestId); await usage.markStarted(input.physicalRequestId);
  if (reported) await usage.observe(input.physicalRequestId, reported, 1);
  return input.physicalRequestId;
}

for (const [label, usage, total] of [
  ['Chat Completions cache is a subset of prompt tokens', { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100, prompt_tokens_details: { cached_tokens: 800, cache_write_tokens: 100 } }, 1100],
  ['Responses cache is a subset of input tokens', { input_tokens: 1000, output_tokens: 100, input_tokens_details: { cached_tokens: 800 } }, 1100],
  ['native Messages cache reads and writes complete the input total', { input_tokens: 200, output_tokens: 100, cache_read_input_tokens: 600, cache_creation_input_tokens: 200 }, 1100],
  ['an explicit total remains authoritative with cache details', { input_tokens: 200, output_tokens: 100, cache_read_input_tokens: 600, cache_creation_input_tokens: 200, total_tokens: 1100 }, 1100],
  ['DeepSeek cache hits are included in prompt tokens', { prompt_tokens: 1000, completion_tokens: 100, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200 }, 1100],
  ['invalid cache counts never become inferred input', { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: -1, cache_creation_input_tokens: '300' }, null],
]) {
  test(label, () => assert.equal(tokenUsage({ usage }).total, total));
}

test('sanitizing a malformed native cache count does not turn unknown total usage into a smaller total', () => {
  const usage = mergeUsage(null, { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: -1 });
  assert.equal(tokenUsage({ usage }).total, null);
});

test('native cache input from a start frame survives later output-only frames without being added twice', async t => {
  const { usage } = await ledger(t);
  let reported = mergeUsage(null, { input_tokens: 200, output_tokens: 0, cache_read_input_tokens: 600, cache_creation_input_tokens: 200 });
  const id = await issue(usage, reported);
  reported = mergeUsage(reported, { output_tokens: 100 }); await usage.observe(id, reported, 2);
  reported = mergeUsage(reported, { output_tokens: 150 }); await usage.observe(id, reported, 3);
  assert.equal(usage.summary().tokens, 1150); assert.equal(usage.summary().tokenDetails.cacheRead, 600);
  assert.equal(usage.summary().tokenDetails.input, 1000); assert.equal(usage.summary().tokenDetails.cacheHitRate, .6);
});

test('daily cache details use cumulative snapshots and weighted coverage, including reported zero', async t => {
  const { usage } = await ledger(t);
  const first = await issue(usage, { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 800 } });
  await usage.observe(first, { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 800 } }, 1);
  await usage.observe(first, { prompt_tokens: 2000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 1600 } }, 2);
  await usage.complete(first);
  await usage.complete(await issue(usage, { input_tokens: 200, output_tokens: 100, cache_read_input_tokens: 600, cache_creation_input_tokens: 200 }));
  await usage.complete(await issue(usage, { total_tokens: 10 }));
  await usage.complete(await issue(usage, { prompt_tokens: 1000, completion_tokens: 100, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1000 }));
  const value = usage.summary();
  assert.equal(value.knownRequests, 4); assert.equal(value.tokens, 4410);
  assert.equal(value.tokenDetails?.input, 4000); assert.equal(value.tokenDetails.output, 400);
  assert.equal(value.tokenDetails.cacheRead, 2200); assert.equal(value.tokenDetails.cacheWrite, 200);
  assert.equal(value.tokenDetails.inputRequests, 3); assert.equal(value.tokenDetails.cacheReadRequests, 3);
  assert.equal(value.tokenDetails.cacheCoverageRequests, 3); assert.equal(value.tokenDetails.cacheHitRate, .55);
  assert.deepEqual(value.providers[0].tokenDetails, value.tokenDetails);
  assert.deepEqual(value.accounts[0].tokenDetails, value.tokenDetails);
});

test('cache detail snapshots remain available after restarting the ledger', async t => {
  const { dir, usage } = await ledger(t), id = await issue(usage, { input_tokens: 1000, output_tokens: 200, input_tokens_details: { cached_tokens: 700 } });
  await usage.complete(id); const before = usage.summary(); await usage.close();
  const restored = new UsageLedger(dir, { now: clock, timeZone: 'UTC' }); await restored.init(); t.after(() => restored.close());
  assert.equal(restored.recoveryError, ''); assert.equal(restored.summary().tokenDetails?.cacheRead, 700);
  assert.deepEqual(restored.summary(), before);
});

test('legacy totals stay readable without inventing cache details or rewriting settled entries', async t => {
  const { dir, usage } = await ledger(t), id = await issue(usage, { total_tokens: 30 }); await usage.complete(id); await usage.close();
  const path = join(dir, '.budgets/state.json'), stored = JSON.parse(await readFile(path, 'utf8'));
  for (const name of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) delete stored.entries[id][name];
  await writeFile(path, JSON.stringify(stored)); const before = await readFile(path);
  const restored = new UsageLedger(dir, { now: clock, timeZone: 'UTC' }); await restored.init(); t.after(() => restored.close());
  assert.equal(restored.recoveryError, ''); assert.equal(restored.summary().tokens, 30);
  assert.equal(restored.summary().tokenDetails?.cacheRead, null); assert.equal(restored.summary().tokenDetails.cacheHitRate, null);
  assert.equal(restored.summary().tokenDetails.cacheCoverageRequests, 0); assert.deepEqual(await readFile(path), before);
});

test('a decreasing cache snapshot preserves the observed count and flags it for review', async t => {
  const { usage } = await ledger(t), id = await issue(usage, { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 800 } });
  await usage.observe(id, { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 600 } }, 2);
  assert.equal(usage.summary().tokenDetails?.cacheRead, 800); assert.equal(usage.summary().usageNeedsReview, 1);
});

test('cache counts greater than input are excluded from the hit rate rather than clamped', async t => {
  const { usage } = await ledger(t); await issue(usage, { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 20 } });
  assert.equal(usage.summary().tokens, 12); assert.equal(usage.summary().tokenDetails?.cacheRead, 20);
  assert.equal(usage.summary().tokenDetails.cacheHitRate, null); assert.equal(usage.summary().usageNeedsReview, 1);
});

test('negative stored Token details pause writes without replacing the original ledger', async t => {
  const { dir, usage } = await ledger(t), id = await issue(usage, { total_tokens: 30 }); await usage.complete(id); await usage.close();
  const path = join(dir, '.budgets/state.json'), stored = JSON.parse(await readFile(path, 'utf8')); stored.entries[id].cacheReadTokens = -1;
  await writeFile(path, JSON.stringify(stored)); const before = await readFile(path);
  const restored = new UsageLedger(dir, { now: clock, timeZone: 'UTC' }); await restored.init(); t.after(() => restored.close());
  assert.match(restored.recoveryError, /用量/); assert.deepEqual(await readFile(path), before);
});

test('native Messages fingerprint sampling retains the cache-inclusive derived total', async t => {
  const upstream = await fingerprintGateway(t, { models: ['one'], handler: ({ res }) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ content: [{ type: 'text', text: numberReply(300) }], stop_reason: 'end_turn',
      usage: { input_tokens: 200, output_tokens: 100, cache_read_input_tokens: 600, cache_creation_input_tokens: 200 } }));
  } });
  const value = await sampleFingerprint(new Gateway({ url: upstream.url }), { model: 'fixture/one', api: 'messages', maxTokens: 2000, strict: true }, { prompt: 'numbers', expected_count: 300 });
  assert.equal(value.state, 'complete'); assert.equal(value.usage.total_tokens, 1100);
});

test('the daily usage API delivers cached Token details for an actual isolated generation', async t => {
  const dir = await temporary(t), upstream = await fakeGateway(t, ({ res, chunk }) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    chunk({ choices: [{ delta: { content: '最终答案：21' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100, prompt_tokens_details: { cached_tokens: 800 } } });
    res.end('data: [DONE]\n\n');
  });
  const service = await startTestServer({ port: 0, dataDir: dir, gatewayUrl: upstream.url }); t.after(() => service.close());
  await service.ready;
  const page = await (await fetch(service.url)).text(), headers = { 'content-type': 'application/json', 'x-pelican-token': page.match(/name="pelican-token" content="([^"]+)"/)[1] };
  const create = await fetch(service.url + 'api/runs', { method: 'POST', headers, body: JSON.stringify({ kind: 'candy', models: [{ id: 'fixture/one' }], concurrency: 1 }) });
  assert.equal(create.status, 201); const id = (await create.json()).runs[0].id;
  await waitFor(async () => (await (await fetch(service.url + 'api/runs/' + id, { headers })).json()).status === 'completed');
  await waitFor(async () => (await (await fetch(service.url + 'api/usage', { headers })).json()).tokens === 1100);
  const value = await (await fetch(service.url + 'api/usage', { headers })).json();
  assert.equal(value.tokenDetails?.cacheRead, 800);
  assert.equal(value.tokens, 1100); assert.equal(value.tokenDetails.input, 1000); assert.equal(value.tokenDetails.output, 100);
  assert.equal(value.tokenDetails.cacheHitRate, .8); assert.equal(value.tokenDetails.cacheCoverageRequests, 1);
});
