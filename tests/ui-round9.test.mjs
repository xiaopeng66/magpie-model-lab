import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createLabTools } from '../ui/lab-tools.mjs';
import { createAccountTargets } from '../ui/account-targets.mjs';
import { createSettingsUI } from '../ui/settings.mjs';
import { Settings } from '../lib/settings.mjs';
import { UsageLedger } from '../lib/usage-ledger.mjs';
import { DEFAULT_QUEUE, QueuePolicy } from '../lib/queue-policy.mjs';
import { temporary, waitFor, fakeGateway, startTestServer } from './helpers.mjs';
import { uiHarness } from './ui-harness.mjs';

const deferred = () => { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; };
async function panel(t, { queue = {}, accounts = async () => ({ accounts: [{ id: 'a' }], capabilities: { pinned: true } }), confirmAction = async () => true, beforeSave, beforeRefresh } = {}) {
  const dir = await temporary(t), settings = new Settings(dir, { capabilities: { queue: true, usage: true } });
  await settings.init(); t.after(() => settings.close());
  await settings.save({ expectedRevision: 0, patch: { queue: { ...structuredClone(DEFAULT_QUEUE), ...queue } } });
  const ui = await uiHarness({ bootstrap: { models: [], runs: [], defaultPrompt: 'test' } }); t.after(() => ui.closeStream());
  await waitFor(() => !ui.elements.get('generate').disabled);
  const body = ui.elements.get('drawer-content'); ui.elements.get('favorite-drawer').hidden = false;
  let writes = 0;
  const tools = createLabTools({ document: ui.document, $: id => ui.elements.get(id), api: async path => path.startsWith('api/accounts') ? accounts(path) : { queued: [], cooldowns: [] }, confirmAction,
    settingsUI: { snapshot: () => ({ ...settings.snapshot(), capabilities: { usage: true } }), refresh: async () => { await beforeRefresh?.(); return settings.snapshot(); }, savePatch: async patch => { writes++; await beforeSave?.(); await settings.save({ expectedRevision: settings.snapshot().revision, patch }); return { state: 'saved' }; } },
    models: () => [{ id: 'fixture/one', provider: 'fixture', providerName: '供应商 A' }, { id: 'other/one', provider: 'other', providerName: '供应商 B' }], records: () => [] });
  tools.load({ queueAvailable: true }); tools.appendLocal(body);
  const all = tag => ui.descendants(body, tag), find = label => all('button').find(control => control.textContent === label && control.getClientRects().length), input = label => all().find(control => control.getAttribute('aria-label') === label && control.getClientRects().length);
  return { ui, body, settings, all, find, input, writes: () => writes, close() { body.replaceChildren(); } };
}

test('saved supplier rules are visible without expanding and editing commits only that rule', async t => {
  const env = await panel(t, { queue: { providerConcurrency: 5, providers: { fixture: { concurrency: 2, intervalMs: 1000 }, other: { concurrency: 3, intervalMs: 0 } } } });
  const edit = env.find('编辑规则'); assert.ok(edit, 'Saved rules need a visible edit action');
  assert.equal(edit.getClientRects().length, 1);
  env.input('供应商并行上限').value = '9'; await env.input('供应商并行上限').fire('input');
  await edit.fire('click'); env.input('单独并行数').value = '1';
  await env.find('保存规则').fire('click');
  assert.deepEqual(env.settings.snapshot().queue, { providerConcurrency: 5, accountConcurrency: 0, minIntervalMs: 0, providers: { fixture: { concurrency: 1, intervalMs: 1000 }, other: { concurrency: 3, intervalMs: 0 } }, accounts: {} });
  assert.equal(env.input('供应商并行上限').value, '9', 'Saving a rule must retain the separate default draft');
});

test('new supplier rules save directly and an explicit zero rule still overrides defaults', async t => {
  const env = await panel(t, { queue: { providerConcurrency: 2, minIntervalMs: 1000 } });
  await env.find('新增供应商规则')?.fire('click'); assert.ok(env.find('保存规则'));
  await env.find('保存规则').fire('click');
  assert.deepEqual(env.settings.snapshot().queue.providers, { fixture: { concurrency: 0, intervalMs: 0 } });
  assert.equal(env.writes(), 1);
  await env.find('删除规则').fire('click'); assert.deepEqual(env.settings.snapshot().queue.providers, {});
});

test('rule saving merges unrelated remote edits but preserves a draft on a same-rule conflict', async t => {
  const env = await panel(t, { queue: { providers: { fixture: { concurrency: 1, intervalMs: 0 } } } });
  await env.find('编辑规则')?.fire('click'); assert.ok(env.find('保存规则')); env.input('单独并行数').value = '2';
  const state = env.settings.snapshot(); await env.settings.save({ expectedRevision: state.revision, patch: { queue: { ...state.queue, providers: { ...state.queue.providers, other: { concurrency: 7, intervalMs: 1000 } } } } });
  await env.find('保存规则').fire('click'); assert.equal(env.settings.snapshot().queue.providers.other.concurrency, 7);
  await env.find('编辑规则').fire('click'); env.input('单独并行数').value = '3';
  const current = env.settings.snapshot(); await env.settings.save({ expectedRevision: current.revision, patch: { queue: { ...current.queue, providers: { ...current.queue.providers, fixture: { concurrency: 4, intervalMs: 0 } } } } });
  await env.find('保存规则').fire('click'); assert.equal(env.settings.snapshot().queue.providers.fixture.concurrency, 4);
  assert.equal(env.input('单独并行数').value, '3'); assert.equal(env.writes(), 1);
});

test('direct rule submission locks controls and blocks duplicate writes until the save resolves', async t => {
  const wait = deferred(), env = await panel(t, { beforeSave: () => wait.promise });
  await env.find('新增供应商规则')?.fire('click'); assert.ok(env.find('保存规则'));
  const save = env.find('保存规则'), pending = save.fire('click'); await waitFor(() => env.writes() === 1);
  assert.equal(save.disabled, true); assert.equal(env.input('单独并行数').disabled, true);
  await save.fire('click'); assert.equal(env.writes(), 1); wait.resolve(); await pending;
});

test('changing a new account rule provider rejects late accounts and cannot save a failed cache', async t => {
  const wait = deferred(), env = await panel(t, { accounts: async path => path.includes('other') ? { accounts: [{ id: 'b' }], capabilities: { pinned: true } } : wait.promise });
  const opening = env.find('新增账号规则')?.fire('click'); assert.ok(env.input('规则供应商'));
  const provider = env.input('规则供应商'); provider.value = 'other'; await provider.fire('change');
  wait.resolve({ accounts: [{ id: 'a' }], capabilities: { pinned: true } }); await opening;
  assert.deepEqual(env.input('规则账号').children.map(option => option.value), ['', 'b']);
  env.input('规则账号').value = 'b'; await env.input('规则账号').fire('change'); await env.find('保存规则').fire('click');
  assert.deepEqual(env.settings.snapshot().queue.accounts, { '["other","b"]': { concurrency: 0, intervalMs: 0 } });
});

test('closing while confirming a rule deletion prevents changing detached settings', async t => {
  const wait = deferred(), env = await panel(t, { queue: { providers: { fixture: { concurrency: 2, intervalMs: 0 } } }, confirmAction: () => wait.promise });
  const pending = env.find('删除规则').fire('click'); await Promise.resolve(); env.close(); wait.resolve(true); await pending;
  assert.equal(env.writes(), 0); assert.equal(env.settings.snapshot().queue.providers.fixture.concurrency, 2);
});

test('selectable accounts with missing cache state do not claim unknown health or verified credentials', async t => {
  const ui = await uiHarness({ bootstrap: { models: [], runs: [], defaultPrompt: 'test' } }); t.after(() => ui.closeStream()); await waitFor(() => !ui.elements.get('generate').disabled);
  const body = ui.elements.get('drawer-content'), picker = createAccountTargets({ document: ui.document, api: async () => ({ capabilities: { pinned: true }, accounts: [{ id: 'a', enabled: null }, { id: 'off', enabled: false }] }), openDrawer: () => body, closeDrawer() {}, footer: () => ui.elements.get('drawer-footer') });
  await picker.open({ id: 'fixture/one', provider: 'fixture' });
  const rows = ui.descendants(body, 'label'), selectable = rows.find(row => ui.descendants(row, 'input').some(input => input.dataset.accountId === 'a'));
  assert.equal(ui.descendants(selectable, 'input')[0].disabled, false);
  assert.ok(ui.descendants(selectable, 'span').some(span => span.textContent === '可选择'));
  assert.equal(ui.descendants(selectable, 'span').some(span => /状态未知|缓存可用|已验证/.test(span.textContent)), false);
});

test('today usage groups only issued requests by provider and pinned account', async t => {
  const dir = await temporary(t), usage = new UsageLedger(dir, { now: () => Date.parse('2026-11-23T10:00:00Z'), timeZone: 'UTC' }); await usage.init(); t.after(() => usage.close());
  const issue = async (provider, accountId, tokens) => {
    const input = { physicalRequestId: randomUUID(), runId: randomUUID(), provider, accountId };
    await usage.reserve(input); await usage.start(input.physicalRequestId); await usage.markStarted(input.physicalRequestId);
    if (tokens !== null) await usage.observe(input.physicalRequestId, { total_tokens: tokens }, 1);
    await usage.complete(input.physicalRequestId);
  };
  await issue('fixture', 'a', 30); await issue('fixture', '', null); await issue('other', 'b', 40);
  await usage.reserve({ physicalRequestId: randomUUID(), runId: randomUUID(), provider: 'fixture', accountId: 'a' });
  const after = usage.summary(); assert.equal(after.knownRequests, 3); assert.equal(after.tokens, 70); assert.equal(after.unknownUsage, 1);
  assert.deepEqual(after.providers, [{ provider: 'fixture', knownRequests: 2, tokens: 30, knownUsage: 1, unknownUsage: 1 }, { provider: 'other', knownRequests: 1, tokens: 40, knownUsage: 1, unknownUsage: 0 }]);
  assert.deepEqual(after.accounts, [{ provider: 'fixture', accountId: 'a', knownRequests: 1, tokens: 30, knownUsage: 1, unknownUsage: 0 }, { provider: 'other', accountId: 'b', knownRequests: 1, tokens: 40, knownUsage: 1, unknownUsage: 0 }]);
});

test('the retired manual cooldown bypass returns 404 while waiting status remains read-only', async t => {
  const dir = await temporary(t), queue = new QueuePolicy(() => DEFAULT_QUEUE, { dir }); await queue.init();
  queue.noteFailure({ model: 'fixture/one', provider: 'fixture', accountTarget: { mode: 'auto' } }, { upstreamStatus: 429, retryAfterMs: 60000 }); await queue.file.pending; await queue.close();
  const gateway = await fakeGateway(t), service = await startTestServer({ port: 0, dataDir: dir, gatewayUrl: gateway.url }); t.after(() => service.close());
  const page = await (await fetch(service.url)).text(), token = page.match(/name="pelican-token" content="([^"]+)"/)[1];
  const response = await fetch(service.url + 'api/queue/cooldown/clear', { method: 'POST', headers: { 'x-pelican-token': token, 'content-type': 'application/json' }, body: '{"scope":"provider:fixture"}' });
  assert.equal(response.status, 404); assert.equal(gateway.seen.requests.length, 0);
  const status = await (await fetch(service.url + 'api/queue/status', { headers: { 'x-pelican-token': token } })).json(); assert.equal(status.cooldowns.length, 1);
});

test('a lost queue save response reconciles the committed rules without resending', async t => {
  const dir = await temporary(t), settings = new Settings(dir, { capabilities: { queue: true } }); await settings.init(); t.after(() => settings.close());
  const initial = structuredClone(DEFAULT_QUEUE);
  await settings.save({ expectedRevision: 0, patch: { queue: initial } }); let writes = 0;
  const ui = createSettingsUI({ api: async (path, options) => {
    if (path === 'api/settings') return { settings: settings.snapshot() };
    writes++; await settings.save(JSON.parse(options.body)); throw Error('response lost after commit');
  }, readFields: () => settings.snapshot().manual.pelican, writeFields() {} });
  ui.load(settings.snapshot(), { memory: true, queue: true }); t.after(() => ui.dispose());
  const result = await ui.savePatch({ queue: { ...initial, minIntervalMs: 1001 } });
  assert.equal(result.state, 'saved'); assert.equal(writes, 1);
  assert.equal(ui.snapshot().queue.minIntervalMs, 1001);
});

test('millisecond request intervals round-trip through defaults and target editing without floating-point rejection', async t => {
  const env = await panel(t); env.input('请求间隔 · 秒').value = '1.001'; await env.find('保存默认限制').fire('click');
  assert.equal(env.settings.snapshot().queue.minIntervalMs, 1001);
  await env.find('新增供应商规则').fire('click'); env.input('单独间隔 · 秒').value = '1.009'; await env.find('保存规则').fire('click');
  assert.equal(env.settings.snapshot().queue.providers.fixture.intervalMs, 1009);
});
