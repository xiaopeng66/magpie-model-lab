import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Gateway } from '../lib/gateway.mjs';
import { Runner } from '../lib/runner.mjs';
import { RunStore } from '../lib/store.mjs';
import { FingerprintBank } from '../lib/fingerprint-bank.mjs';
import { ConfigTransfer, configDigest } from '../lib/config-transfer.mjs';
import { sampleFingerprint } from '../lib/fingerprint-sample.mjs';
import { recentTrend } from '../lib/comparison.mjs';
import { enhancementSetup } from './enhancement-helpers.mjs';
import { temporary, waitFor } from './helpers.mjs';
import { fingerprintGateway, referenceFixture, numberReply } from './fingerprint-helpers.mjs';

const primaryKey = 'synthetic-primary-key', spareKey = 'synthetic-spare-key';
const target = key => ({ mode: 'pinned', id: 'key:' + createHash('sha256').update(key).digest('hex') });
const original = () => ({ id: 'fixture', key: primaryKey, keyName: '相同名称', keys: [{ key: spareKey, name: '相同名称' }], accountModels: { e8774afc67: ['one'] } });
async function saveConfig(configDir, gatewayURL, providers) {
  await writeFile(join(configDir, 'gateway.json'), JSON.stringify({ addr: new URL(gatewayURL).host, version: '0.1.4572', pid: 123 }));
  await writeFile(join(configDir, 'providers.json'), JSON.stringify({ providers }));
}
async function setup(t, options = {}) {
  const configDir = await temporary(t);
  const env = await enhancementSetup(t, { handler: ({ complete }) => complete('最终答案：21'), ...options, gatewayOptions: { configDir } });
  await saveConfig(configDir, env.gateway.url, [original()]);
  return { ...env, configDir, save: providers => saveConfig(configDir, env.gateway.url, providers) };
}

test('the account API combines registered accounts and ordinary Keys while preserving model availability', async t => {
  const { gateway } = await setup(t);
  const accounts = await gateway.accounts({ modelId: 'fixture/two' });
  assert.equal(accounts.length, 4, 'Both ordinary Keys must join the existing two registered accounts');
  const primary = accounts.find(account => account.id === target(primaryKey).id), spare = accounts.find(account => account.id === target(spareKey).id);
  assert.equal(primary.available, null); assert.equal(spare.available, false); assert.match(spare.unavailableReason, /模型/);
  assert.equal(accounts.find(account => account.id === 'a').name, 'A');
  assert.equal(JSON.stringify(accounts).includes(primaryKey), false); assert.equal(JSON.stringify(accounts).includes(spareKey), false);
});

test('two same-name Keys get independent request headers, history, retest and daily usage identities', async t => {
  const { runner, seen, gateway, store } = await setup(t);
  const runs = await runner.submit({ kind: 'candy', targets: [primaryKey, spareKey].map(key => ({ modelId: 'fixture/one', account: target(key) })), concurrency: 2 });
  await waitFor(() => runs.every(run => runner.get(run.id)?.status === 'completed' && !runner.busy(run.id)));
  assert.deepEqual(seen.map(request => request.account).sort(), ['fixture#942e114ed5', 'fixture#e8774afc67']);
  assert.equal(new Set(seen.map(request => request.session)).size, 2); assert.equal(gateway.headers['x-magpie-account'], undefined);
  for (const run of runs) {
    const saved = await store.get(run.id);
    assert.equal(saved.accountTarget.name, '相同名称');
    assert.equal(saved.routing.verification, 'verified');
    assert.equal(saved.routing.reportedAccountId, saved.accountTarget.id);
    assert.equal(JSON.stringify(saved).includes(primaryKey), false); assert.equal(JSON.stringify(saved).includes(spareKey), false);
  }
  const preview = await runner.previewRetest({ runIds: runs.map(run => run.id) });
  assert.ok(preview.items.every(item => item.available));
  assert.deepEqual(preview.items.map(item => item.conditions.accountTarget.id).sort(), [target(primaryKey).id, target(spareKey).id].sort());
  assert.equal(recentTrend(runner.get(runs[0].id), runner.list()).attempts, 1);
  const usage = runner.usage.summary();
  assert.equal(usage.knownRequests, 2);
  assert.deepEqual(usage.accounts.map(account => account.accountId).sort(), [target(primaryKey).id, target(spareKey).id].sort());
});

test('a saved Key retest resolves its new single-Key request seat after other Keys are removed', async t => {
  const { runner, seen, save } = await setup(t);
  const [run] = await runner.submit({ kind: 'candy', targets: [{ modelId: 'fixture/one', account: target(spareKey) }] });
  await waitFor(() => !runner.busy(run.id) && runner.get(run.id)?.status === 'completed');
  await save([{ id: 'fixture', key: spareKey, keyName: '已重命名', accountModels: { e8774afc67: ['one'] } }]);
  const result = await runner.retest({ runIds: [run.id], operationId: randomUUID() });
  await waitFor(() => result.runs.every(item => !runner.busy(item.id) && runner.get(item.id)?.status === 'completed'));
  assert.deepEqual(seen.map(item => item.account), ['fixture#e8774afc67', 'fixture']);
  assert.equal(result.runs[0].accountTarget.id, run.accountTarget.id);
  assert.equal(runner.usage.summary().accounts.length, 1);
});

test('server submission, favorites and configuration import reject a Key whose model is restricted', async t => {
  const env = await setup(t), { runner, favorites, seen } = env;
  await assert.rejects(runner.submit({ kind: 'candy', targets: [{ modelId: 'fixture/two', account: target(spareKey) }] }), /模型/);
  await assert.rejects(favorites.save({ modelId: 'fixture/two', account: target(spareKey) }), /模型/);
  assert.equal(seen.length, 0); assert.equal(runner.list().length, 0);
  await favorites.save({ modelId: 'fixture/one', account: target(spareKey) });
  const transfer = new ConfigTransfer(env), document = transfer.export();
  document.payload.favorites[0].modelId = 'fixture/two'; document.digest = configDigest(document.payload);
  const preview = await transfer.preview({ document });
  assert.equal(preview.token, null); assert.equal(preview.unresolved[0].code, 'account_unavailable');
  assert.equal(JSON.stringify(document).includes(primaryKey), false); assert.equal(JSON.stringify(document).includes(spareKey), false);
});

test('removing or replacing a Key makes its old target unavailable without issuing an automatic request', async t => {
  const { runner, seen, save } = await setup(t);
  runner.schedulingPaused++;
  const [run] = await runner.submit({ kind: 'candy', targets: [{ modelId: 'fixture/one', account: target(spareKey) }] });
  await save([{ id: 'fixture', key: primaryKey, keys: [{ key: 'synthetic-replacement-key', name: '相同名称' }] }]);
  runner.schedulingPaused--; runner.pump();
  await waitFor(() => !runner.busy(run.id) && runner.get(run.id)?.status === 'error');
  assert.equal(seen.length, 0);
  assert.equal(runner.usage.summary().knownRequests, 0);
  const preview = await runner.previewRetest({ runIds: [run.id] });
  assert.equal(preview.items[0].available, false);
});

test('Key availability is rechecked after a delayed request admission and before the HTTP generation', async t => {
  const { gateway, seen, save } = await setup(t);
  let admitted = false;
  await assert.rejects(gateway.generate({ model: 'fixture/one', messages: [], stream: true }, {
    account: target(spareKey), beforeFetch: () => { admitted = true; return save([{ id: 'fixture', key: primaryKey }]); },
  }), /账号|Key/);
  assert.equal(admitted, true);
  assert.equal(seen.length, 0);
});

test('malformed local configuration preserves registered accounts and refuses old fixed Keys', async t => {
  const { gateway, configDir } = await setup(t);
  await writeFile(join(configDir, 'providers.json'), 'invalid JSON ' + spareKey);
  assert.equal(typeof gateway.accountSnapshot, 'function', 'Account snapshots must retain a partial-source warning');
  const snapshot = await gateway.accountSnapshot();
  assert.deepEqual(snapshot.accounts.map(account => account.id), ['a', 'b']); assert.ok(snapshot.warning);
  assert.equal(JSON.stringify(snapshot).includes(spareKey), false);
  await assert.rejects(gateway.assertAccount('fixture', target(spareKey), 'fixture/one'), /账号|Key/);
});

test('registered accounts keep routing but hide upstream diagnostics while local credentials cannot be read', async t => {
  const { gateway, configDir } = await setup(t);
  const account = { mode: 'pinned', id: 'a' };
  await writeFile(join(configDir, 'providers.json'), '{');
  const pinned = await gateway.resolveAccount('fixture/one', account);
  const automatic = await gateway.resolveAccount('fixture/one', { mode: 'auto' });
  assert.equal(pinned.header, 'a');
  assert.equal(pinned.redact('上游诊断'), automatic.redact('上游诊断'));
  assert.match(pinned.redact('上游诊断'), /已隐藏上游详情/);
});

test('HTTP and stream errors cannot expose configured ordinary Keys, including credentials without a sk prefix', async t => {
  let streaming = false;
  const { gateway } = await setup(t, { handler: ({ res }) => {
    const message = 'Rejected credential ' + primaryKey + ' or ' + spareKey;
    if (streaming) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: ' + JSON.stringify({ error: { message } }) + '\n\n'); }
    else { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message } })); }
  } });
  for (streaming of [false, true]) {
    await assert.rejects(gateway.generate({ model: 'fixture/one', messages: [], stream: true }, { account: target(spareKey) }), error => {
      assert.equal(error.message.includes(primaryKey), false);
      assert.equal(error.message.includes(spareKey), false);
      assert.match(error.message, /已隐藏凭据/);
      return true;
    });
    const sample = await sampleFingerprint(gateway, { model: 'fixture/one', api: 'chat_completions', maxTokens: 1000, account: target(spareKey).id }, { prompt: 'numbers', expected_count: 300 });
    assert.equal(sample.state, 'failed');
    assert.equal(JSON.stringify(sample).includes(primaryKey), false);
    assert.equal(JSON.stringify(sample).includes(spareKey), false);
    assert.match(sample.error, /已隐藏凭据/);
  }
});

test('an HTTP error split across network chunks is combined before credential redaction', async t => {
  const split = Math.floor(spareKey.length / 2);
  const { gateway } = await setup(t, { handler: async ({ res }) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.write('{"error":{"message":"Credential rejected: ' + spareKey.slice(0, split));
    await new Promise(resolve => setTimeout(resolve, 40));
    res.end(spareKey.slice(split) + '"}}');
  } });
  await assert.rejects(gateway.generate({ model: 'fixture/one', messages: [], stream: true }, { account: target(spareKey) }), error => {
    assert.equal(error.message.includes(spareKey.slice(0, split)), false);
    assert.equal(error.message.includes(spareKey.slice(split)), false);
    assert.match(error.message, /已隐藏凭据/);
    assert.equal(error.upstreamStatus, 401); return true;
  });
});

test('automatic routing protects diagnostic text and request IDs without opening account settings first', async t => {
  const { gateway } = await setup(t, { handler: ({ res }) => {
    res.writeHead(401, { 'x-request-id': spareKey }); res.end(primaryKey);
  } });
  await assert.rejects(gateway.generate({ model: 'fixture/one' }), error => {
    assert.equal(error.message.includes(primaryKey), false); assert.equal(error.requestId.includes(spareKey), false); return true;
  });
});

test('fingerprint retains cooldown information when a rate-limit response exceeds the diagnostic cap', async t => {
  const { gateway } = await setup(t, { handler: ({ res }) => { res.writeHead(429, { 'retry-after': '7', 'x-request-id': 'sample-42' }); res.end('x'.repeat(65537)); } });
  const sample = await sampleFingerprint(gateway, { model: 'fixture/one', api: 'chat_completions', maxTokens: 1000 }, { prompt: 'numbers', expected_count: 300 });
  assert.equal(sample.failureKind, 'rate'); assert.equal(sample.upstreamStatus, 429); assert.equal(sample.retryAfterMs, 7000); assert.equal(sample.requestId, 'sample-42');
});

test('temporary host discovery failure is retried on the next capability check', async t => {
  const { gateway } = await setup(t);
  const fetchOriginal = globalThis.fetch; let calls = 0;
  globalThis.fetch = (...args) => ++calls === 1 ? Promise.resolve(new Response(null, { status: 503 })) : fetchOriginal(...args);
  t.after(() => { globalThis.fetch = fetchOriginal; });
  assert.equal((await gateway.accountCapabilities()).pinned, false);
  assert.equal((await gateway.accountCapabilities()).pinned, true);
});

test('unrecognized upstream finish metadata cannot persist arbitrary diagnostic text', async t => {
  const { gateway } = await setup(t, { handler: ({ res }) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'unexpected test diagnostic' }] }) + '\n\ndata: [DONE]\n\n');
  } });
  const result = await gateway.generate({ model: 'fixture/one' });
  assert.equal(result.finishReason, 'unknown');
  const sample = await sampleFingerprint(gateway, { model: 'fixture/one', api: 'chat_completions', maxTokens: 100 }, { prompt: 'numbers', expected_count: 300 });
  assert.equal(sample.finishReason, 'unknown'); assert.equal(sample.state, 'failed');
  assert.ok(!JSON.stringify(sample).includes('unexpected test diagnostic'));
});

test('an in-flight fixed Key error remains redacted if the host credential is replaced before the error arrives', async t => {
  let environment;
  environment = await setup(t, { handler: async ({ res }) => {
    await environment.save([{ id: 'fixture', key: 'synthetic-replacement-key' }]);
    await environment.gateway.accounts();
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Credential rejected: ' + spareKey } }));
  } });
  await assert.rejects(environment.gateway.generate({ model: 'fixture/one', messages: [], stream: true }, { account: target(spareKey) }), error => {
    assert.equal(error.message.includes(spareKey), false); assert.match(error.message, /已隐藏凭据/); return true;
  });
});

test('overlapping account refreshes keep error redaction attached to the snapshot used by each request', async t => {
  const environment = await setup(t, { handler: ({ res }) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Credential rejected: ' + spareKey } }));
  } });
  const originalSnapshot = environment.gateway.accountSnapshot.bind(environment.gateway);
  let release, ready;
  const held = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { ready = resolve; });
  t.mock.method(environment.gateway, 'accountSnapshot', async options => {
    const snapshot = await originalSnapshot(options); ready(); await held; return snapshot;
  });
  const request = environment.gateway.generate({ model: 'fixture/one', messages: [], stream: true }, { account: target(spareKey) });
  await started;
  await environment.save([{ id: 'fixture', key: 'synthetic-replacement-key' }]);
  await originalSnapshot();
  release();
  await assert.rejects(request, error => { assert.equal(error.message.includes(spareKey), false); assert.match(error.message, /已隐藏凭据/); return true; });
});

test('model-only evidence stays unverified and a different reported Key remains a mismatch', async t => {
  const { runner } = await setup(t, { handler: ({ complete, account }) => complete('最终答案：21', { provider: 'fixture', model: 'fixture/one', ...(account.endsWith('e8774afc67') ? { accountId: 'fixture#different-key' } : {}) }) });
  const runs = await runner.submit({ kind: 'candy', targets: [primaryKey, spareKey].map(key => ({ modelId: 'fixture/one', account: target(key) })) });
  await waitFor(() => runs.every(run => !runner.busy(run.id) && runner.get(run.id)?.status === 'completed'));
  assert.equal(runner.get(runs[0].id).routing.verification, 'unavailable');
  assert.equal(runner.get(runs[1].id).routing.verification, 'mismatch');
});

test('all three fingerprint samples for each Key use the resolved host request seat', async t => {
  const dir = await temporary(t), configDir = await temporary(t), routes = new Map();
  const upstream = await fingerprintGateway(t, { models: ['chat'], bank: referenceFixture('ordinary-key-fingerprint', true),
    route: session => ({ route: routes.get(session) || {} }),
    handler: ({ req, complete }) => { routes.set(req.headers['x-magpie-session'], { model: 'fixture/chat', accountId: req.headers['x-magpie-account'] }); complete(numberReply(400)); } });
  await saveConfig(configDir, upstream.url, [{ ...original(), accountModels: { e8774afc67: ['chat'] } }]);
  const store = new RunStore(dir); await store.init();
  const gateway = new Gateway({ url: upstream.url, configDir }), bank = new FingerprintBank({ dir: join(dir, 'bank'), source: upstream.url + '/data/' });
  const runner = new Runner({ store, gateway, bank }); t.after(async () => { await runner.close(); await bank.close(); });
  const runs = await runner.submit({ kind: 'fingerprint', api: 'chat_completions', targets: [primaryKey, spareKey].map(key => ({ modelId: 'fixture/chat', account: target(key) })), concurrency: 2 });
  await waitFor(() => runs.every(run => !runner.busy(run.id) && !['queued', 'running'].includes(runner.get(run.id)?.status)), 10000);
  const headers = upstream.seen.requests.map(request => request.headers['x-magpie-account']);
  assert.equal(headers.filter(value => value === 'fixture#942e114ed5').length, 3);
  assert.equal(headers.filter(value => value === 'fixture#e8774afc67').length, 3);
  for (const run of runs) {
    const saved = await store.get(run.id); assert.equal(saved.status, 'completed', saved.error);
    assert.ok(saved.samples.every(sample => sample.routing.verification === 'verified'));
    assert.equal(saved.account, saved.accountTarget.id);
  }
});
