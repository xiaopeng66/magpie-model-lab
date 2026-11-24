import test from 'node:test';
import assert from 'node:assert/strict';
import { uiHarness } from './ui-harness.mjs';
import { waitFor } from './helpers.mjs';
import { createAccountTargets } from '../ui/account-targets.mjs';
import { createLabTools } from '../ui/lab-tools.mjs';
import { enhancementSetup } from './enhancement-helpers.mjs';
import { originalConditions } from '../lib/retest.mjs';
import { legacyReasoningTask } from './legacy-task-fixtures.mjs';

async function accountPicker(t, result, initial = [{ mode: 'auto' }], options = {}) {
  const ui = await uiHarness({ bootstrap: { models: [], runs: [], defaultPrompt: 'test' } });
  t.after(() => ui.closeStream()); await waitFor(() => !ui.elements.get('generate').disabled);
  const body = ui.elements.get('drawer-content'), footer = ui.elements.get('drawer-footer'); let applied;
  const targets = createAccountTargets({ document: ui.document, api: async () => typeof result === 'function' ? result() : result,
    openDrawer: () => body, closeDrawer: () => {}, footer: () => footer });
  const opened = targets.open({ id: 'fixture/one', provider: 'fixture' }, null, { initial, onApply: async accounts => { applied = accounts; await options.onApply?.(accounts); } });
  const inputs = () => ui.descendants(body, 'input');
  const all = () => inputs().find(input => input.getAttribute('aria-label') === '全选可用账号');
  const apply = ui.descendants(footer, 'button').find(button => button.textContent === '确认账号选择');
  const env = { ui, body, inputs, all, apply, applied: () => applied };
  await options.onLoading?.(env); await opened; return env;
}

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

async function rulePanel(t, { kind = 'queue', accountApi = async () => ({ accounts: [] }), savePatch = async () => ({ state: 'saved' }), records = () => [] } = {}) {
  const ui = await uiHarness({ bootstrap: { models: [], runs: [], defaultPrompt: 'test' } });
  t.after(() => ui.closeStream()); await waitFor(() => !ui.elements.get('generate').disabled);
  const body = ui.elements.get('drawer-content');
  const state = { capabilities: { usage: true }, queue: { providerConcurrency: 0, accountConcurrency: 0, minIntervalMs: 0, providers: {}, accounts: {} } };
  const tools = createLabTools({ document: ui.document, $: id => ui.elements.get(id), api: accountApi,
    settingsUI: { snapshot: () => state, refresh: async () => state, savePatch: async patch => { const result = await savePatch(patch); if (result.state === 'saved') Object.assign(state, structuredClone(patch)); return result; } }, confirmAction: async () => true,
    models: () => [{ id: 'fixture/one', provider: 'fixture', providerName: '供应商 A' }, { id: 'other/one', provider: 'other', providerName: '供应商 B' }], records });
  tools.load({ queueAvailable: true }); tools.appendLocal(body);
  const section = ui.descendants(body).find(node => node.id === 'phase-local-panel-' + kind);
  const find = label => ui.descendants(section, 'button').find(button => button.textContent === label);
  const input = label => ui.descendants(section).find(node => node.getAttribute('aria-label') === label);
  const messages = () => ui.descendants(section).filter(node => node.getAttribute('role') === 'status').map(node => node.textContent);
  return { ui, section, find, input, messages };
}

test('select all includes only available fixed accounts and replaces automatic routing', async t => {
  const env = await accountPicker(t, { capabilities: { pinned: true }, accounts: [
    { id: 'a', name: '账号 A', enabled: true }, { id: 'b', name: '账号 B', enabled: null },
    { id: 'off', enabled: false }, { id: 'unavailable', available: false },
  ] });
  assert.ok(env.all(), 'The account picker needs an available-account select-all control');
  assert.equal(env.all().disabled, false); env.all().checked = true; await env.all().fire('change');
  assert.equal(env.inputs().find(input => input.getAttribute('aria-label') === '自动分配').checked, false);
  assert.deepEqual(env.inputs().filter(input => input.dataset.accountId && input.checked).map(input => input.dataset.accountId), ['a', 'b']);
  await env.apply.fire('click'); assert.deepEqual(env.applied().map(account => account.id), ['a', 'b']);
});

test('select all reflects partial selection and clearing never silently selects automatic routing', async t => {
  const env = await accountPicker(t, { capabilities: { pinned: true }, accounts: [{ id: 'a' }, { id: 'b' }] }, [{ mode: 'pinned', id: 'a' }]);
  assert.ok(env.all()); assert.equal(env.all().checked, false); assert.equal(env.all().indeterminate, true);
  env.all().checked = true; await env.all().fire('change'); assert.equal(env.all().indeterminate, false);
  env.all().checked = false; await env.all().fire('change');
  assert.equal(env.inputs().filter(input => input.checked).length, 0); assert.equal(env.apply.disabled, true);
  const auto = env.inputs().find(input => input.getAttribute('aria-label') === '自动分配'); auto.checked = true; await auto.fire('change');
  assert.equal(env.apply.disabled, false); await env.apply.fire('click'); assert.deepEqual(env.applied(), [{ mode: 'auto' }]);
});

test('select all is disabled when the host cannot route any fixed account', async t => {
  const env = await accountPicker(t, { capabilities: { pinned: false }, accounts: [{ id: 'a', enabled: true }] });
  assert.ok(env.all()); assert.equal(env.all().disabled, true);
  env.all().checked = true; await env.all().fire('change'); await env.apply.fire('click');
  assert.deepEqual(env.applied(), [{ mode: 'auto' }]);
});

test('account loading and submission lock all selection controls', async t => {
  const response = deferred(), save = deferred();
  const env = await accountPicker(t, () => response.promise, [{ mode: 'auto' }], {
    onLoading: env => {
      assert.equal(env.all().disabled, true); assert.equal(env.apply.disabled, true);
      assert.equal(env.ui.descendants(env.body, 'button').find(button => button.textContent === '刷新缓存账号').disabled, true);
      response.resolve({ capabilities: { pinned: true }, accounts: [{ id: 'a' }] });
    }, onApply: () => save.promise,
  });
  env.all().checked = true; await env.all().fire('change'); const applying = env.apply.fire('click');
  assert.equal(env.all().disabled, true); assert.equal(env.apply.disabled, true);
  assert.equal(env.inputs().every(input => input.disabled), true);
  save.resolve(); await applying;
});

test('account refresh removes an unavailable selection and safely recovers after cache failure', async t => {
  let reads = 0;
  const env = await accountPicker(t, () => {
    reads++;
    if (reads === 3) throw Error('缓存暂不可读');
    return { capabilities: { pinned: true }, accounts: [{ id: 'a', enabled: reads === 1 }, { id: 'b', enabled: true }] };
  }, [{ mode: 'pinned', id: 'a' }]);
  const refresh = env.ui.descendants(env.body, 'button').find(button => button.textContent === '刷新缓存账号');
  await refresh.fire('click'); assert.equal(env.apply.disabled, true); assert.equal(refresh.disabled, false);
  assert.equal(env.inputs().find(input => input.dataset.accountId === 'a').checked, false);
  await refresh.fire('click'); assert.equal(env.all().disabled, true); assert.equal(env.apply.disabled, false);
  assert.equal(env.inputs().find(input => input.getAttribute('aria-label') === '自动分配').checked, true);
  await env.apply.fire('click'); assert.deepEqual(env.applied(), [{ mode: 'auto' }]);
});

test('unsaved rule input and guidance survive changing the account provider and loading its cache', async t => {
  for (const kind of ['queue']) {
    const env = await rulePanel(t, { kind, accountApi: async () => ({ accounts: [{ id: 'a' }] }) });
    await env.find('新增账号规则').fire('click');
    const first = env.input('单独并行数'); first.value = '4'; await first.fire('input');
    const provider = env.input('规则供应商'); provider.value = 'other'; await provider.fire('change');
    assert.equal(first.value, '4');
    assert.ok(env.messages().some(message => /未保存/.test(message)), `${kind}: account loading must preserve the unsaved-rule guidance`);
  }
});

test('failed account loads cannot reuse an account belonging to the previous rule provider', async t => {
  const env = await rulePanel(t, { accountApi: async path => { if (path.includes('other')) throw Error('供应商 B 缓存暂不可读'); return { accounts: [{ id: 'a' }] }; } });
  await env.find('新增账号规则').fire('click');
  const account = env.input('规则账号'); account.value = 'a'; await account.fire('change');
  const provider = env.input('规则供应商'); provider.value = 'other'; await provider.fire('change');
  assert.equal(account.value, '', 'A failed provider change must not retain the previous provider account');
  await env.find('保存规则').fire('click');
  assert.equal(env.ui.descendants(env.section, 'button').some(button => button.textContent === '删除规则'), false);
});

test('saving a submitted rule disables destructive actions until its snapshot is acknowledged', async t => {
  const saved = deferred(); let submitted;
  const env = await rulePanel(t, { savePatch: patch => { submitted = patch; return saved.promise; } });
  await env.find('新增供应商规则').fire('click'); const saving = env.find('保存规则').fire('click'); await waitFor(() => submitted);
  assert.deepEqual(submitted.queue.providers, { fixture: { concurrency: 0, intervalMs: 0 } });
  assert.equal(env.input('单独并行数').disabled, true); assert.equal(env.find('取消编辑').disabled, true);
  await env.find('取消编辑').fire('click'); saved.resolve({ state: 'saved' }); await saving;
  assert.ok(env.messages().some(message => /规则已保存/.test(message)));
  assert.deepEqual(submitted.queue.providers, { fixture: { concurrency: 0, intervalMs: 0 } });
});

test('a late rule-account cache response cannot replace the newly selected provider options', async t => {
  const first = deferred();
  const env = await rulePanel(t, { accountApi: path => path.includes('other') ? { accounts: [{ id: 'b' }] } : first.promise });
  const oldLoad = env.find('新增账号规则').fire('click');
  assert.equal(env.find('保存规则').disabled, true);
  const provider = env.input('规则供应商'); provider.value = 'other'; await provider.fire('change');
  first.resolve({ accounts: [{ id: 'a' }] }); await oldLoad;
  assert.deepEqual(env.input('规则账号').children.map(option => option.value), ['', 'b']);
});

test('waiting status automatically identifies provider and fixed-account limits without a manual bypass', async t => {
  const cooldowns = [{ scope: 'provider:fixture', until: Date.now() + 60000 }, { scope: 'account:["fixture","a"]', until: Date.now() + 60000 }];
  const env = await rulePanel(t, { records: () => [{ id: 'waiting-a', modelName: '合成模型', accountTarget: { mode: 'pinned', id: 'a', name: '固定账号 A' } }], accountApi: async path => {
    assert.equal(path, 'api/queue/status');
    return { queued: cooldowns.length ? [{ runId: 'waiting-a', reason: 'account_limit' }] : [], cooldowns };
  } });
  await waitFor(() => !env.find('刷新等待状态').disabled);
  const visible = env.ui.descendants(env.section).map(node => node.textContent).join('\n');
  assert.match(visible, /供应商 · 供应商 A · 等待至/);
  assert.match(visible, /固定账号 · 供应商 A · a · 等待至/);
  assert.match(visible, /合成模型 · 固定账号 A · 等待账号并行空位/);
  assert.equal(env.find('解除此本地等待'), undefined);
});

test('waiting status blocks duplicate refreshes until its automatic read completes', async t => {
  const response = deferred(); let reads = 0;
  const env = await rulePanel(t, { accountApi: path => {
    assert.equal(path, 'api/queue/status'); reads++; return response.promise;
  } });
  const refresh = env.find('刷新等待状态'); assert.equal(refresh.disabled, true); await refresh.fire('click'); assert.equal(reads, 1);
  response.resolve({ queued: [], cooldowns: [] }); await waitFor(() => !refresh.disabled);
});

test('retired reasoning requests are rejected before saving or calling the model while original repetitions still run', async t => {
  const { runner, seen } = await enhancementSetup(t, { handler: ({ complete }) => complete('最终答案：21') });
  await assert.rejects(runner.submit({ kind: 'candy', suite: { id: 'reasoning-basics', version: '1' }, targets: [{ modelId: 'fixture/one' }] }), error => error.status === 400 && /移除|不可用/.test(error.message));
  assert.equal(runner.list().length, 0); assert.equal(seen.length, 0);
  const runs = await runner.submit({ kind: 'candy', repeat: { count: 2 }, targets: [{ modelId: 'fixture/one' }] });
  await waitFor(() => runner.list().every(run => run.status === 'completed'));
  assert.equal(runs.length, 2); assert.equal(seen.length, 2);
  for (const run of runs) { const saved = await runner.read(run.id); assert.equal(saved.task.suiteId, 'shape-choice'); assert.equal(saved.grade.expected, 21); assert.equal(saved.grade.verdict, 'match'); }
});

test('retired historical tasks cannot be replayed as a newly created reasoning test', () => {
  const task = legacyReasoningTask();
  const record = { id: 'legacy', model: 'fixture/one', kind: 'candy', status: 'completed', source: 'manual', createdAt: '2026-11-22T00:00:00Z', prompt: task.prompt, task, maxTokens: 0, concurrency: 1, timeoutMs: 600000 };
  assert.throws(() => originalConditions(record, { id: record.model, provider: 'fixture', efforts: [] }), /移除|不可用/);
});

test('direct rule actions save independently of the separate default controls', async t => {
  const ui = await uiHarness({ bootstrap: { models: [], runs: [], defaultPrompt: 'test' } });
  t.after(() => ui.closeStream()); await waitFor(() => !ui.elements.get('generate').disabled);
  const body = ui.elements.get('drawer-content'), state = { capabilities: {}, queue: { providerConcurrency: 0, accountConcurrency: 0, minIntervalMs: 0, providers: {}, accounts: {} } }; let writes = 0, saved;
  const tools = createLabTools({ document: ui.document, $: id => ui.elements.get(id), api: async () => ({ queued: [], cooldowns: [] }),
    settingsUI: { snapshot: () => state, refresh: async () => state, savePatch: async patch => { writes++; saved = patch; Object.assign(state, structuredClone(patch)); return { state: 'saved' }; } }, confirmAction: async () => true,
    models: () => [{ id: 'fixture/one', provider: 'fixture', providerName: '供应商 A' }], records: () => [] });
  tools.load({ queueAvailable: true }); tools.appendLocal(body);
  const find = name => ui.descendants(body, 'button').find(button => button.textContent === name);
  const add = find('新增供应商规则'); assert.ok(add, 'Adding a rule needs a visible action');
  await add.fire('click'); assert.equal(writes, 0);
  await find('保存规则').fire('click'); assert.equal(writes, 1); assert.deepEqual(saved.queue.providers, { fixture: { concurrency: 0, intervalMs: 0 } });
  assert.ok(ui.descendants(body).some(node => /规则.*已保存/.test(node.textContent)));
  assert.equal(ui.descendants(body).some(node => /规则已加入草稿/.test(node.textContent)), false);
  await find('删除规则').fire('click'); assert.equal(writes, 2); assert.deepEqual(saved.queue.providers, {});
});
