import test from 'node:test';
import assert from 'node:assert/strict';
import { createLabTools } from '../ui/lab-tools.mjs';
import { uiHarness } from './ui-harness.mjs';
import { waitFor } from './helpers.mjs';

async function summaryPanel(t, fail = () => false) {
  const ui = await uiHarness({ bootstrap: { models: [], runs: [], defaultPrompt: 'test' } });
  await waitFor(() => !ui.elements.get('generate').disabled); t.after(() => ui.closeStream());
  const body = ui.elements.get('drawer-content'), value = { day: '2026-11-23', timeZone: 'UTC', knownRequests: 3, tokens: 1234567890,
    knownUsage: 2, unknownUsage: 1, providers: [{ provider: 'fixture', knownRequests: 3, tokens: 1234567890, unknownUsage: 1 }],
    accounts: [{ provider: 'fixture', accountId: 'a', knownRequests: 2, tokens: 1234567890, unknownUsage: 0 }] };
  let writes = 0;
  const tools = createLabTools({ document: ui.document, $: id => ui.elements.get(id), api: async path => {
    if (path === 'api/settings/save') { writes++; return {}; }
    if (fail()) throw Error('合成的读取失败');
    if (path === 'api/accounts') return { accounts: [{ provider: 'fixture', id: 'a', name: '友好账号名称' }] };
    return path === 'api/queue/status' ? { budget: value } : value;
  }, settingsUI: { snapshot: () => ({ capabilities: { usage: true, budget: true } }), savePatch: async () => { writes++; return { state: 'saved' }; }, refresh: async () => {} },
    openDrawer: () => body, closeDrawer() {}, confirmAction: async () => true,
    models: () => [{ provider: 'fixture', providerName: '供应商名称', id: 'fixture/one' }],
    records: () => [{ provider: 'fixture', accountTarget: { mode: 'pinned', id: 'a', name: '友好账号名称' } }], filteredIds: () => [], readFilters: () => ({}), setFilters() {} });
  tools.load({}); tools.appendLocal(body);
  const all = tag => ui.descendants(body, tag), find = label => all('button').find(button => button.textContent === label);
  await find('每日用量').fire('click'); await waitFor(() => !find('刷新今日用量').disabled);
  const panel = all('div').find(node => node.getAttribute('role') === 'tabpanel' && !node.hidden);
  return { ui, panel, all, find, writes: () => writes };
}

test('daily usage is a read-only view with formatted totals and readable account names', async t => {
  const env = await summaryPanel(t), visible = env.ui.descendants(env.panel);
  assert.equal(visible.some(node => ['input', 'select'].includes(node.tagName.toLowerCase())), false, 'Daily usage must not contain quota editors');
  assert.ok(visible.some(node => node.tagName.toLowerCase() === 'strong' && node.textContent === '1,234,567,890'));
  assert.ok(visible.some(node => node.textContent.includes('友好账号名称')));
  await env.find('刷新今日用量').fire('click'); assert.equal(env.writes(), 0);
});

test('a failed usage refresh keeps the last observed totals and permits retry', async t => {
  let fail = false; const env = await summaryPanel(t, () => fail); fail = true;
  await env.find('刷新今日用量').fire('click');
  const visible = env.ui.descendants(env.panel);
  assert.ok(visible.some(node => node.tagName.toLowerCase() === 'strong' && node.textContent === '1,234,567,890'));
  assert.ok(visible.some(node => node.textContent.includes('合成的读取失败')));
  assert.equal(env.find('刷新今日用量').disabled, false);
});
