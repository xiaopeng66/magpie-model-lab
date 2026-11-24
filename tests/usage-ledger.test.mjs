import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporary, fakeGateway, startTestServer } from './helpers.mjs';
import { Settings } from '../lib/settings.mjs';
import { ConfigTransfer, configDigest } from '../lib/config-transfer.mjs';
import { enhancementSetup } from './enhancement-helpers.mjs';

import { UsageLedger } from '../lib/usage-ledger.mjs';
const oldLimits = { enabled: true, timeZone: 'UTC', activation: 'now', requests: 1, tokens: 1,
  providers: { fixture: { requests: 1, tokens: 1 } }, accounts: { '["fixture","a"]': { requests: 1, tokens: 1 } } };
const request = (provider = 'fixture', accountId = 'a') => ({ physicalRequestId: randomUUID(), runId: randomUUID(), provider, accountId });
async function ledger(t, clock = () => Date.parse('2026-11-23T10:00:00Z')) {
  const dir = await temporary(t), usage = new UsageLedger(dir, { now: clock, timeZone: 'UTC', policy: () => oldLimits });
  await usage.init(); t.after(() => usage.close()); return { dir, usage };
}
async function issue(usage, input = request(), tokens = 30) {
  const { reservation } = await usage.reserve(input);
  assert.ok(reservation, 'Every request must be recordable without a daily quota');
  await usage.start(input.physicalRequestId); await usage.markStarted(input.physicalRequestId);
  if (tokens !== null) await usage.observe(input.physicalRequestId, { total_tokens: tokens }, 1);
  await usage.complete(input.physicalRequestId); return input;
}

test('usage records every request even when legacy global, supplier and account quotas were exhausted', async t => {
  const { usage } = await ledger(t);
  await issue(usage); await issue(usage); await issue(usage);
  assert.equal(usage.summary().knownRequests, 3); assert.equal(usage.summary().tokens, 90);
});

test('restart settles interrupted entries once and leaves completed timestamps untouched', async t => {
  let at = Date.parse('2026-11-24T10:00:00Z'); const { dir, usage } = await ledger(t, () => at);
  const done = await issue(usage), pending = request(); await usage.reserve(pending); await usage.start(pending.physicalRequestId); await usage.close();
  const path = join(dir, '.budgets/state.json'), before = JSON.parse(await readFile(path));
  const reopen = async () => { at += 60000; const reopened = new UsageLedger(dir, { now: () => at, timeZone: 'UTC' }); await reopened.init(); await reopened.close(); return JSON.parse(await readFile(path)); };
  const once = await reopen(); assert.equal(once.entries[done.physicalRequestId].settledAt, before.entries[done.physicalRequestId].settledAt);
  assert.equal(once.entries[pending.physicalRequestId].possibleUnsent, true); assert.deepEqual(await reopen(), once);
});

test('an unstarted request may cross midnight and is counted on the actual fetch date', async t => {
  let at = Date.parse('2026-11-23T23:59:59Z'); const { usage } = await ledger(t, () => at), input = request();
  await usage.reserve(input); at += 2000; await usage.start(input.physicalRequestId); await usage.markStarted(input.physicalRequestId);
  await usage.observe(input.physicalRequestId, { total_tokens: 30 }, 1);
  assert.equal(usage.summary().day, '2026-11-24'); assert.equal(usage.summary().knownRequests, 1);
});

test('releasing an unsent request leaves a certain zero while unknown issued tokens stay unknown', async t => {
  const { usage } = await ledger(t), pending = request(); await usage.reserve(pending); await usage.release(pending.physicalRequestId);
  assert.equal(usage.summary().knownRequests, 0); assert.equal(usage.summary().tokens, 0);
  await issue(usage, request(), null);
  assert.equal(usage.summary().knownRequests, 1); assert.equal(usage.summary().tokens, null); assert.equal(usage.summary().unknownUsage, 1);
});

test('stored quota configuration is migrated away without changing manual parameters or queue rules', async t => {
  const dir = await temporary(t), settings = new Settings(dir); await settings.init();
  const before = settings.snapshot(); await settings.close();
  const queue = { providerConcurrency: 2, accountConcurrency: 0, minIntervalMs: 1001, providers: {}, accounts: {} };
  await writeFile(join(dir, '.settings', 'state.json'), JSON.stringify({ ...before, schema: 2, revision: 9, queue, budget: oldLimits }));
  const restored = new Settings(dir, { capabilities: { usage: true, queue: true } }); await restored.init(); t.after(() => restored.close());
  assert.equal(Object.hasOwn(restored.snapshot(), 'budget'), false);
  assert.deepEqual(restored.snapshot().manual, before.manual); assert.deepEqual(restored.snapshot().queue, queue);
  assert.equal(restored.snapshot().revision, 10);
  const saved = JSON.parse(await readFile(join(dir, '.settings', 'state.json'), 'utf8'));
  assert.equal(Object.hasOwn(saved, 'budget'), false);
  await assert.rejects(restored.save({ expectedRevision: 10, patch: { budget: oldLimits } }), /未知|无效/);
});

test('old configuration imports ignore deleted quota settings and new exports contain no quota group', async t => {
  const env = await enhancementSetup(t), transfer = new ConfigTransfer({ ...env, dir: env.dir });
  const document = transfer.export(); document.payload.settings.budget = oldLimits; document.digest = configDigest(document.payload);
  const preview = await transfer.preview({ document, choices: { settings: { budget: 'overwrite' } } });
  await transfer.apply({ token: preview.token, confirm: true });
  assert.equal(Object.hasOwn(env.settings.snapshot(), 'budget'), false);
  assert.equal(Object.hasOwn(transfer.export().payload.settings, 'budget'), false);
});

test('the read-only daily usage endpoint reports issued requests without starting a model request', async t => {
  const dir = await temporary(t), upstream = await fakeGateway(t), service = await startTestServer({ port: 0, dataDir: dir, gatewayUrl: upstream.url }); t.after(() => service.close());
  const page = await (await fetch(service.url)).text(), token = page.match(/name="pelican-token" content="([^"]+)"/)[1];
  const response = await fetch(service.url + 'api/usage', { headers: { 'x-pelican-token': token } });
  assert.equal(response.status, 200); const value = await response.json();
  assert.equal(value.knownRequests, 0); assert.equal(value.tokens, 0); assert.equal(upstream.seen.requests.length, 0);
});
