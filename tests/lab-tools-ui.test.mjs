import test from 'node:test';
import assert from 'node:assert/strict';
import { createLabTools } from '../ui/lab-tools.mjs';
import { uiHarness } from './ui-harness.mjs';
import { waitFor } from './helpers.mjs';
import { createHash } from 'node:crypto';
const imported = { schema: 'model-lab-config-v1', payload: { settings: { retention: { days: 7 } }, favorites: [{ sourceRef: 'target-1', modelId: 'fixture/one', account: { mode: 'rebind' } }], plans: [] } };
async function setup(t, { api = async () => ({}), confirmAction = async () => true, settingsUI = {}, records = () => [] } = {}) {
  const ui = await uiHarness({ bootstrap: { models: [], runs: [], defaultPrompt: 'test' } }); await waitFor(() => !ui.elements.get('generate').disabled); t.after(() => ui.closeStream());
  let onClose; const body = ui.elements.get('drawer-content'), footer = ui.elements.get('drawer-footer');
  ui.elements.get('favorite-drawer').hidden = false;
  const close = () => { onClose?.(); onClose = null; body.replaceChildren(); footer.replaceChildren(); ui.elements.get('favorite-drawer').hidden = true; };
  const tools = createLabTools({ document: ui.document, $: id => ui.elements.get(id), api, settingsUI: { snapshot: () => ({ capabilities: {}, queue: null }), flush: async () => ({ state: 'saved' }), refresh: async () => {}, savePatch: async () => ({ state: 'saved' }), ...settingsUI }, openDrawer: (_title, _origin, _mode, callback) => { close(); onClose = callback; ui.elements.get('favorite-drawer').hidden = false; return body; }, closeDrawer: close, confirmAction,
    models: () => [{ provider: 'fixture', id: 'fixture/one' }], records, filteredIds: () => ['record'], readFilters: () => ui.filters || {}, setFilters: value => { ui.filters = value; }, onUpdated: async () => {} });
  tools.load({ configAvailable: true, notesAvailable: true });
  const find = label => [...ui.descendants(body, 'button'), ...ui.descendants(footer, 'button')].find(button => button.textContent === label);
  return { ui, tools, body, find, close };
}
async function openImport(env) {
  env.tools.appendLocal(env.body); await env.find('从本地 JSON 导入').fire('click');
  const file = env.ui.descendants(env.body, 'input').find(input => input.type === 'file');
  file.files = [{ size: 500, text: async () => JSON.stringify(imported) }]; await file.fire('change');
  const binding = env.ui.descendants(env.body, 'select').find(input => input.getAttribute('aria-label') === '导入目标账号绑定'); binding.value = 'account-a'; await binding.fire('change');
}
test('config File API import binds accounts and invalidates an in-flight preview after any choice change', async t => {
  let resolvePreview, sent; const env = await setup(t, { api: async (path, options) => {
    if (path.startsWith('api/accounts')) return { accounts: [{ provider: 'fixture', id: 'account-a', enabled: true }] };
    if (path === 'api/config/import/preview') { sent = JSON.parse(options.body); return new Promise(resolve => { resolvePreview = resolve; }); }
    throw Error(path);
  } }); await openImport(env);
  const pending = env.find('预览配置差异').fire('click'); await waitFor(() => resolvePreview); assert.equal(sent.bindings['target-1'].account.id, 'account-a');
  const choice = env.ui.descendants(env.body, 'select').find(input => input.getAttribute('aria-label') === '目标冲突选择'); choice.value = 'skip'; await choice.fire('change');
  resolvePreview({ token: 'old-token', differences: [], pausedPlanIds: [], unresolved: [] }); await pending;
  assert.equal(env.find('确认应用导入').disabled, true, 'A preview for an obsolete choice cannot become applicable');
});
test('a resolved preview applies the token and confirmation after showing affected plans', async t => {
  let applied; const env = await setup(t, { api: async (path, options) => {
    if (path.startsWith('api/accounts')) return { accounts: [{ provider: 'fixture', id: 'account-a' }] };
    if (path.endsWith('/preview')) return { token: 'current-token', differences: [{ sourceRef: 'target-1', action: 'add' }], pausedPlanIds: ['plan'], unresolved: [], retentionImpact: { days: 1, candidateCount: 2 } };
    if (path.endsWith('/apply')) { applied = JSON.parse(options.body); return { applied: true }; }
    throw Error(path);
  } }); await openImport(env); await env.find('预览配置差异').fire('click');
  assert.ok(env.ui.descendants(env.body).some(node => node.textContent === '目标 1 · fixture/one：新增'));
  await env.find('确认应用导入').fire('click');
  assert.deepEqual(applied, { token: 'current-token', confirm: true, confirmRetention: true });
  assert.ok(env.ui.descendants(env.body).some(node => node.textContent.includes('保持暂停')));
});

test('config import validates local draft references and counts before building any account controls', async t => {
  const requests = [], env = await setup(t, { api: async path => { requests.push(path); return { accounts: [] }; } });
  env.tools.appendLocal(env.body); await env.find('从本地 JSON 导入').fire('click');
  const file = env.ui.descendants(env.body, 'input').find(input => input.type === 'file');
  const favorite = imported.payload.favorites[0];
  for (const favorites of [[{ ...favorite, sourceRef: '旧编号' }], [favorite, favorite],
    Array.from({ length: 501 }, (_, i) => ({ ...favorite, sourceRef: 'target-' + (i + 1) }))]) {
    const payload = { ...imported.payload, favorites };
    file.files = [{ size: 60000, text: async () => JSON.stringify({ ...imported, payload }) }];
    await file.fire('change');
    assert.equal(env.find('预览配置差异').disabled, true);
    assert.equal(env.find('确认应用导入').disabled, true);
    assert.equal(env.ui.descendants(env.body, 'select').length, 0);
  }
  assert.deepEqual(requests, []);
});

test('configuration rebinding uses the target model and readable Key labels while skipping unavailable Keys', async t => {
  const id = 'key:' + createHash('sha256').update('synthetic-config-binding-key').digest('hex'); let requested;
  const env = await setup(t, { api: async path => {
    requested = new URL(path, 'http://fixture.local/');
    return { capabilities: { pinned: true }, warning: '部分账号缓存不可读', accounts: [
      { provider: 'fixture', id, name: '分组', kind: 'key', enabled: true, available: null },
      { provider: 'fixture', id: 'unsupported', available: false },
    ] };
  } });
  env.tools.appendLocal(env.body); await env.find('从本地 JSON 导入').fire('click');
  const file = env.ui.descendants(env.body, 'input').find(input => input.type === 'file');
  file.files = [{ size: 500, text: async () => JSON.stringify(imported) }]; await file.fire('change');
  assert.equal(requested.searchParams.get('model'), 'fixture/one'); assert.equal(requested.searchParams.get('provider'), 'fixture');
  const input = env.ui.descendants(env.body, 'select').find(input => input.getAttribute('aria-label') === '导入目标账号绑定');
  assert.equal(input.children.some(option => option.value === 'unsupported'), false);
  assert.equal(input.children.find(option => option.value === id).textContent, '分组 · ' + id.slice(4, 14));
  assert.ok(env.ui.descendants(env.body).some(node => node.textContent.includes('部分账号缓存不可读')));
});
test('invalid dates are shown beside the filter and do not apply conditions', async t => {
  const env = await setup(t); env.tools.openHistoryFilters();
  const from = env.ui.descendants(env.body, 'input').find(input => input.getAttribute('aria-label') === '开始日期 · 含当天'); from.value = 'invalid-date';
  await env.find('应用筛选').fire('click'); assert.equal(env.ui.filters, undefined); assert.ok(env.ui.descendants(env.body).some(node => /日期.*无效/.test(node.textContent)));
});

test('history date filters retain the selected local dates and UTC boundaries when reopened and applied again', async t => {
  const env = await setup(t); env.tools.openHistoryFilters();
  const dateInput = label => env.ui.descendants(env.body, 'input').find(input => input.getAttribute('aria-label') === label);
  dateInput('开始日期 · 含当天').value = '2026-11-22'; dateInput('结束日期 · 不含当天').value = '2026-11-25';
  await env.find('应用筛选').fire('click');
  assert.equal(env.ui.filters.from, new Date(2026, 10, 22).toISOString());
  assert.equal(env.ui.filters.to, new Date(2026, 10, 25).toISOString());
  assert.ok(env.ui.descendants(env.body).some(control => control.getAttribute('role') === 'status' && /1 条记录符合筛选/.test(control.textContent)));
  const first = structuredClone(env.ui.filters);
  env.tools.openHistoryFilters();
  assert.equal(dateInput('开始日期 · 含当天').value, '2026-11-22');
  assert.equal(dateInput('结束日期 · 不含当天').value, '2026-11-25');
  await env.find('应用筛选').fire('click'); assert.deepEqual(env.ui.filters, first);
});

test('the app applies valid history filters and reports the actual filtered record count', async t => {
  const ui = await uiHarness({ bootstrap: { notesAvailable: true, models: [], runs: [{ id: 'record', batchId: 'batch', kind: 'candy', model: 'fixture/one', modelName: 'One', createdAt: new Date(2026, 10, 22, 12).toISOString(), status: 'completed', candy: { verdict: 'match', answer: 21, expected: 21 } }], defaultPrompt: 'test' } });
  t.after(() => ui.closeStream()); await waitFor(() => !ui.elements.get('generate').disabled);
  await ui.elements.get('history-tab').fire('click'); await ui.elements.get('history-tools').fire('click');
  const body = ui.elements.get('drawer-content'), field = label => ui.descendants(body, 'input').find(input => input.getAttribute('aria-label') === label);
  field('开始日期 · 含当天').value = '2026-11-22'; field('结束日期 · 不含当天').value = '2026-11-23';
  const apply = ui.descendants(body, 'button').find(control => control.textContent === '应用筛选'); await apply.fire('click');
  assert.ok(ui.descendants(body).some(control => control.getAttribute('role') === 'status' && /1 条记录符合筛选/.test(control.textContent)));
  field('模型名称或标识').value = 'missing-model'; await apply.fire('click');
  assert.ok(ui.descendants(body).some(control => control.getAttribute('role') === 'status' && /0 条记录符合筛选/.test(control.textContent)));
});

test('waiting status identifies queued models and pinned accounts without failing on an unknown record', async t => {
  const env = await setup(t, {
    records: () => [{ id: 'queued-run', model: 'fixture/one', modelName: '合成模型', accountTarget: { mode: 'pinned', id: 'account-a', name: '合成账号' } }],
    api: async path => {
      assert.equal(path, 'api/queue/status');
      return { queued: [{ runId: 'queued-run', reason: 'provider_limit' }, { runId: 'not-loaded-yet', reason: 'concurrency' }], cooldowns: [], recoveryError: '' };
    },
  });
  env.tools.load({ queueAvailable: true }); env.tools.appendLocal(env.body);
  await waitFor(() => !env.find('刷新等待状态').disabled);
  const messages = env.ui.descendants(env.body, 'p').map(value => value.textContent);
  assert.ok(messages.includes('合成模型 · 合成账号 · 等待供应商并行空位'), 'A queued request needs its model, account and waiting reason');
  assert.ok(messages.includes('not-loaded-yet · 等待本批并行空位'), 'A record arriving after queue status remains readable by its id');
});

test('local category navigation retains unsaved input while hiding inactive forms and supports arrow keys', async t => {
  const env = await setup(t, { settingsUI: { snapshot: () => ({ capabilities: { usage: true } }) } });
  env.tools.load({ queueAvailable: true, configAvailable: true }); env.tools.appendLocal(env.body);
  const tabs = env.ui.descendants(env.body, 'button').filter(control => control.getAttribute('role') === 'tab');
  const queue = tabs.find(tab => tab.textContent === '请求控制'), usage = tabs.find(tab => tab.textContent === '每日用量');
  assert.ok(queue && usage, 'Local settings must have separate accessible category controls');
  const formScroll = env.ui.descendants(env.body).find(control => control.getAttribute('aria-label') === '设置内容');
  assert.ok(formScroll, 'Long settings forms need their own scroll area below the category controls');
  assert.equal(formScroll.contains(queue), false, 'Category controls must stay outside the scrolling forms');
  const input = env.ui.descendants(env.body, 'input').find(control => control.getAttribute('aria-label') === '供应商并行上限');
  input.value = '42'; await input.fire('input');
  env.body.scrollTop = 150; formScroll.scrollTop = 250; await usage.fire('click'); assert.equal(env.body.scrollTop, 0); assert.equal(formScroll.scrollTop, 0); assert.equal(input.getClientRects().length, 0); assert.equal(usage.getAttribute('aria-selected'), 'true');
  await usage.fire('keydown', { key: 'ArrowLeft' });
  assert.equal(input.getClientRects().length, 1); assert.equal(input.value, '42'); assert.equal(queue.getAttribute('aria-selected'), 'true');
  await queue.fire('keydown', { key: 'End' }); assert.equal(tabs.at(-1).getAttribute('aria-selected'), 'true');
});

test('a late read error from the previous config file does not replace the current file feedback', async t => {
  const env = await setup(t); env.tools.appendLocal(env.body); await env.find('从本地 JSON 导入').fire('click');
  const file = env.ui.descendants(env.body, 'input').find(input => input.type === 'file'); let rejectOldRead;
  file.files = [{ size: 500, text: () => new Promise((_resolve, reject) => { rejectOldRead = reject; }) }]; const pending = file.fire('change');
  file.files = [{ size: 500, text: async () => JSON.stringify({ ...imported, payload: { settings: {}, favorites: [], plans: [] } }) }]; await file.fire('change');
  rejectOldRead(Error('旧文件读取失败')); await pending;
  assert.equal(env.find('预览配置差异').disabled, false);
  assert.equal(env.ui.descendants(env.body).some(control => control.getAttribute('role') === 'status' && control.textContent.includes('旧文件读取失败')), false);
});

test('a stale config preview failure cannot disable a newer file preview or replace its apply token', async t => {
  let rejectOldPreview, previews = 0, applied;
  const env = await setup(t, { api: async (path, options) => {
    if (path.startsWith('api/accounts')) return { accounts: [{ provider: 'fixture', id: 'account-a', enabled: true }] };
    if (path === 'api/config/import/preview') {
      if (++previews === 1) return new Promise((_resolve, reject) => { rejectOldPreview = reject; });
      return { token: 'new-file-preview', differences: [], pausedPlanIds: [], unresolved: [] };
    }
    if (path === 'api/config/import/apply') { applied = JSON.parse(options.body); return { applied: true }; }
    throw Error(path);
  } });
  await openImport(env); const pending = env.find('预览配置差异').fire('click'); await waitFor(() => rejectOldPreview);
  const file = env.ui.descendants(env.body, 'input').find(input => input.type === 'file');
  file.files = [{ size: 500, text: async () => JSON.stringify({ ...imported, payload: { settings: {}, favorites: [], plans: [] } }) }]; await file.fire('change');
  await env.find('预览配置差异').fire('click'); rejectOldPreview(Error('旧文件预览失败')); await pending;
  assert.equal(env.find('确认应用导入').disabled, false, 'The current preview must stay applicable after an obsolete request fails');
  await env.find('确认应用导入').fire('click'); assert.equal(applied.token, 'new-file-preview');
});
