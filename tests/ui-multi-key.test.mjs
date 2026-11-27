import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAccountTargets } from '../ui/account-targets.mjs';
import { createLabTools } from '../ui/lab-tools.mjs';
import { uiHarness } from './ui-harness.mjs';
import { startTestServer, temporary, waitFor } from './helpers.mjs';
import { fingerprintGateway } from './fingerprint-helpers.mjs';

const primaryKey = 'synthetic-primary-key', spareKey = 'synthetic-spare-key';
const keyID = key => 'key:' + createHash('sha256').update(key).digest('hex');
const accounts = () => [
  { provider: 'fixture', id: keyID(primaryKey), name: '分组 A', kind: 'key', primary: true, keyPrefix: 'syntheti…', enabled: true, available: null },
  { provider: 'fixture', id: keyID(spareKey), name: '分组 B', kind: 'key', primary: false, keyPrefix: 'syntheti…', enabled: true, available: false, unavailableReason: '此 Key 未允许使用当前模型，请在 Magpie 调整模型范围' },
];

async function picker(t, response, initial = [{ mode: 'auto' }]) {
  const ui = await uiHarness({ bootstrap: { models: [], runs: [], defaultPrompt: 'test' } });
  t.after(() => ui.closeStream()); await waitFor(() => !ui.elements.get('generate').disabled);
  const body = ui.elements.get('drawer-content'), footer = ui.elements.get('drawer-footer'), requests = []; let applied;
  const targets = createAccountTargets({ document: ui.document, api: async path => { requests.push(path); return typeof response === 'function' ? response() : response; },
    openDrawer: () => body, closeDrawer: () => {}, footer: () => footer });
  await targets.open({ id: 'fixture/two', provider: 'fixture', name: '当前模型' }, null, { initial, onApply: value => { applied = value; } });
  const find = label => ui.descendants(body, 'button').find(button => button.textContent === label);
  const input = id => ui.descendants(body, 'input').find(input => input.dataset.accountId === id);
  return { ui, body, requests, find, input, applied: () => applied,
    apply: ui.descendants(footer, 'button').find(button => button.textContent === '确认账号选择'),
    all: ui.descendants(body, 'input').find(input => input.getAttribute('aria-label') === '全选可用账号') };
}

test('the account picker requests the current full model ID and shows ordinary Key metadata and disabled reasons', async t => {
  const env = await picker(t, { capabilities: { pinned: true }, accounts: accounts() });
  const query = new URL(env.requests[0], 'http://fixture.local/').searchParams;
  assert.equal(query.get('provider'), 'fixture'); assert.equal(query.get('model'), 'fixture/two');
  const rows = env.ui.descendants(env.body, 'label');
  const primary = rows.find(row => row.contains(env.input(keyID(primaryKey)))), spare = rows.find(row => row.contains(env.input(keyID(spareKey))));
  assert.ok(env.ui.descendants(primary).some(node => node.textContent === 'API Key · 主 Key · syntheti…'));
  assert.ok(env.ui.descendants(spare).some(node => node.textContent === 'API Key · 附加 Key · syntheti…'));
  assert.ok(env.ui.descendants(spare).some(node => node.textContent === accounts()[1].unavailableReason));
  assert.equal(env.ui.descendants(env.body).some(node => node.textContent.includes(keyID(primaryKey))), false, 'The full persistent digest must not crowd the Key row');
  assert.equal(env.input(keyID(spareKey)).disabled, true);
  env.all.checked = true; await env.all.fire('change'); await env.apply.fire('click');
  assert.deepEqual(env.applied(), [{ mode: 'pinned', id: keyID(primaryKey), name: '分组 A' }]);
});

test('the account refresh remains above the scrollable account list', async t => {
  const env = await picker(t, { capabilities: { pinned: true }, accounts: accounts() });
  const list = env.ui.descendants(env.body).find(element => element.className === 'phase-account-list');
  const refresh = env.find('刷新账号');
  const index = env.body.children.indexOf(refresh.parentElement);
  assert.ok(index >= 0 && index < env.body.children.indexOf(list));
  assert.equal(refresh.parentElement.contains(env.all), true);
});

test('refresh removes deleted or unsupported Keys, updates renamed selections and preserves a partial-source warning', async t => {
  let reads = 0;
  const env = await picker(t, () => ({ capabilities: { pinned: true }, warning: '已注册账号缓存暂不可读，当前只显示本机 API Key。', accounts: reads++ ? [{ ...accounts()[0], name: '改名后的分组' }] : accounts().map(account => ({ ...account, available: null })) }),
    [{ mode: 'pinned', id: keyID(primaryKey), name: '旧名称' }, { mode: 'pinned', id: keyID(spareKey), name: '旧备用名称' }]);
  const refresh = env.find('刷新账号'); assert.ok(refresh);
  await refresh.fire('click'); await env.apply.fire('click');
  assert.deepEqual(env.applied(), [{ mode: 'pinned', id: keyID(primaryKey), name: '改名后的分组' }]);
  assert.ok(env.ui.descendants(env.body).some(node => node.textContent.includes('当前只显示本机 API Key')));
});

test('failed refresh keeps the fixed selection pending until a successful retry', async t => {
  let reads = 0;
  const selection = [{ mode: 'pinned', id: keyID(primaryKey), name: '分组 A' }];
  const env = await picker(t, () => { if (++reads === 2) throw Error('暂时离线'); return { accounts: accounts() }; }, selection);
  await env.find('刷新账号').fire('click'); assert.equal(env.apply.disabled, true);
  await env.find('刷新账号').fire('click'); await env.apply.fire('click');
  assert.deepEqual(env.applied(), selection);
});

test('same-name Keys remain distinguishable to assistive technology and long names keep a full text tooltip', async t => {
  const name = '不同上游的账号'.repeat(30);
  const env = await picker(t, { capabilities: { pinned: true }, accounts: accounts().map(account => ({ ...account, name, primary: false, available: null })) });
  const first = env.input(keyID(primaryKey)), second = env.input(keyID(spareKey));
  assert.notEqual(first.getAttribute('aria-label'), second.getAttribute('aria-label'));
  assert.match(first.getAttribute('aria-label'), /syntheti…/); assert.match(second.getAttribute('aria-label'), /syntheti…/);
  const titles = env.ui.descendants(env.body).filter(node => node.className === 'phase-account-name');
  assert.ok(titles.some(node => node.textContent === name && node.title === name));
});

test('request control and daily usage distinguish same-name Keys and shorten missing-history identities', async t => {
  const ui = await uiHarness({ bootstrap: { models: [], runs: [], defaultPrompt: 'test' } });
  t.after(() => ui.closeStream()); await waitFor(() => !ui.elements.get('generate').disabled);
  const body = ui.elements.get('drawer-content'), fixed = accounts().map(account => ({ ...account, name: '同名分组', available: null }));
  const state = { capabilities: { usage: true }, queue: { providerConcurrency: 0, accountConcurrency: 0, minIntervalMs: 0, providers: {}, accounts: {} } };
  const tools = createLabTools({ document: ui.document, $: id => ui.elements.get(id), api: async path => path.startsWith('api/accounts') ? { accounts: fixed } : path === 'api/usage' ? {
    day: '2026-11-24', timeZone: 'UTC', knownRequests: 2, tokens: 10, providers: [{ provider: 'fixture', knownRequests: 2, tokens: 10 }],
    accounts: fixed.map(account => ({ provider: 'fixture', accountId: account.id, knownRequests: 1, tokens: 5 })),
  } : { queued: [], cooldowns: [] }, settingsUI: { snapshot: () => state }, models: () => [{ id: 'fixture/two', provider: 'fixture' }],
    records: () => [{ provider: 'fixture', accountTarget: { mode: 'pinned', id: fixed[0].id, name: '同名分组' } }] });
  tools.load({ queueAvailable: true }); tools.appendLocal(body);
  const find = label => ui.descendants(body, 'button').find(button => button.textContent === label);
  await find('新增账号规则').fire('click');
  const input = ui.descendants(body, 'select').find(node => node.getAttribute('aria-label') === '规则账号');
  for (const account of fixed) {
    const option = input.children.find(node => node.value === account.id);
    assert.ok(option); assert.equal(option.textContent, '同名分组 · ' + account.id.slice(4, 14));
    assert.equal(option.title.includes(account.id), false);
  }
  await find('每日用量').fire('click'); await waitFor(() => !find('刷新今日用量').disabled);
  const labels = ui.descendants(body).filter(node => node.className === 'phase-usage-name').map(node => node.textContent);
  assert.ok(labels.includes('固定账号 · 同名分组 · ' + fixed[0].id.slice(4, 14)));
  assert.ok(labels.includes('固定账号 · API Key · ' + fixed[1].id.slice(4, 14)));
  assert.equal(labels.some(label => fixed.some(account => label.includes(account.id))), false);
});

test('the account endpoint projects model-specific safe Key metadata and retains registered accounts', async t => {
  const dataDir = await temporary(t), gatewayConfigDir = await temporary(t), upstream = await fingerprintGateway(t);
  await writeFile(join(gatewayConfigDir, 'gateway.json'), JSON.stringify({ addr: new URL(upstream.url).host }));
  await writeFile(join(gatewayConfigDir, 'providers.json'), JSON.stringify({ providers: [{ id: 'fixture', key: primaryKey, keys: [{ key: spareKey, name: '分组 B' }], accountModels: { e8774afc67: ['chat'] } }] }));
  const service = await startTestServer({ port: 0, dataDir, gatewayUrl: upstream.url, gatewayConfigDir }); t.after(() => service.close());
  const page = await (await fetch(service.url)).text(), token = page.match(/name="pelican-token" content="([a-f0-9]+)"/)[1];
  const api = path => fetch(service.url + 'api/' + path, { headers: { 'x-pelican-token': token } });
  assert.equal((await fetch(service.url + 'api/accounts?provider=fixture')).status, 403);
  assert.equal((await api('accounts?provider=other&model=fixture%2Fmessages')).status, 400);
  assert.equal((await api('accounts?model=invalid')).status, 400);
  const response = await api('accounts?provider=fixture&model=fixture%2Fmessages'); assert.equal(response.status, 200);
  const result = await response.json(); assert.equal(result.accounts.length, 3);
  assert.ok(result.accounts.some(account => account.id === '北冥'));
  const keys = result.accounts.filter(account => account.kind === 'key'); assert.equal(keys.length, 2);
  assert.ok(keys.every(account => account.keyPrefix === 'syntheti…'));
  assert.equal(keys.find(account => account.id === keyID(spareKey)).available, false);
  assert.equal(JSON.stringify(result).includes('routingId'), false);
  assert.equal(JSON.stringify(result).includes(primaryKey), false); assert.equal(JSON.stringify(result).includes(spareKey), false);
  const unfiltered = await (await api('accounts?provider=fixture')).json();
  assert.ok(unfiltered.accounts.every(account => !Object.hasOwn(account, 'keyPrefix')));
  assert.equal(unfiltered.accounts.find(account => account.id === keyID(spareKey)).available, null);
  await writeFile(join(gatewayConfigDir, 'providers.json'), 'invalid JSON ' + spareKey);
  const partial = await (await api('accounts?provider=fixture')).json();
  assert.deepEqual(partial.accounts.map(account => account.id), ['北冥']); assert.ok(partial.warning);
  assert.equal(JSON.stringify(partial).includes(spareKey), false);
});
