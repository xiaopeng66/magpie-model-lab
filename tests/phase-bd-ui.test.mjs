import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { uiHarness } from './ui-harness.mjs';
import { waitFor } from './helpers.mjs';
import { parameterDefaults } from '../lib/test-parameters.mjs';

const model = { id: 'fixture/one', name: 'One', provider: 'fixture', efforts: [] };
const initial = () => ({ revision: 0, manual: Object.fromEntries(['pelican', 'candy', 'fingerprint'].map(kind => [kind, parameterDefaults(kind, 'animate')])), retention: { days: 7 }, progressNotice: { enabled: true }, presets: [] });
const boot = fields => ({ models: [model], runs: [], defaultPrompt: 'animate', version: '1.0.6', candyAvailable: true, accountsAvailable: true, experimentsAvailable: true, notesAvailable: true, settings: initial(), settingsCapabilities: { memory: true, queue: true, usage: true }, ...fields });
const run = fields => ({ id: randomUUID(), batchId: randomUUID(), model: model.id, kind: 'candy', status: 'completed', createdAt: '2026-11-22T00:00:00Z', content: '最终答案：21', candy: { expected: 21, answer: 21, verdict: 'match' }, ...fields });
const button = (ui, root, label) => ui.descendants(ui.elements.get(root), 'button').find(control => control.textContent === label);

test('manual multi-account selection produces distinct fixed targets and removes stale binding with the model', async () => {
  let submitted; const ui = await uiHarness({ bootstrap: boot(), accounts: async () => [{ provider: 'fixture', id: 'account-a', name: 'A', enabled: true }, { provider: 'fixture', id: 'account-b', name: 'B', enabled: null }], create: async body => { submitted = body; return { runs: [run({ kind: 'pelican', status: 'queued' })] }; }, settings: async () => ({ settings: initial() }), detail: () => ({}) });
  await waitFor(() => !ui.elements.get('generate').disabled); const pick = ui.descendants(ui.elements.get('model-list'), 'input')[0]; pick.checked = true; await pick.fire('change');
  const accounts = ui.descendants(ui.elements.get('selected-models'), 'button').find(control => control.className === 'account-target-button'); assert.ok(accounts);
  assert.equal(ui.descendants(accounts).find(control => control.className === 'account-target-value').textContent, '自动分配'); await accounts.fire('click');
  const candidates = await waitFor(() => ui.descendants(ui.elements.get('drawer-content'), 'input').filter(input => input.type === 'checkbox' && input.dataset.accountId).length === 2 && ui.descendants(ui.elements.get('drawer-content'), 'input').filter(input => input.type === 'checkbox' && input.dataset.accountId));
  for (const candidate of candidates) { candidate.checked = true; await candidate.fire('change'); }
  await button(ui, 'drawer-footer', '确认账号选择').fire('click');
  assert.equal(ui.document.activeElement.className, 'account-target-button', 'Closing the account picker returns focus to the updated account control');
  await ui.elements.get('generate').fire('click');
  assert.deepEqual(submitted.targets.map(target => target.account.id), ['account-a', 'account-b']); assert.equal(submitted.models, undefined);
  pick.checked = false; await pick.fire('change'); pick.checked = true; await pick.fire('change');
  assert.equal(ui.descendants(ui.elements.get('selected-models')).find(control => control.className === 'account-target-value').textContent, '自动分配');
  await ui.elements.get('clear-selection').fire('click'); pick.checked = true; await pick.fire('change');
  assert.equal(ui.descendants(ui.elements.get('selected-models')).find(control => control.className === 'account-target-value').textContent, '自动分配');
});

test('repeat controls show the original candy request count and never submit an alternate suite', async () => {
  let submitted; const ui = await uiHarness({ bootstrap: boot(), create: async body => { submitted = body; return { runs: [run({ status: 'queued' })] }; }, detail: () => ({}), search: '?view=candy' });
  await waitFor(() => !ui.elements.get('generate').disabled); const pick = ui.descendants(ui.elements.get('model-list'), 'input')[0]; pick.checked = true; await pick.fire('change');
  assert.ok(ui.elements.get('repeat-count')); ui.elements.get('repeat-count').value = '2'; await ui.elements.get('repeat-count').fire('input');
  assert.match(ui.elements.get('experiment-estimate').textContent, /2 份结果.*2 次生成请求/);
  await ui.elements.get('generate').fire('click'); assert.equal(submitted.repeat.count, 2); assert.equal(submitted.suite, undefined);
});

test('notes save explicitly with a local revision and a conflict preserves the draft', async () => {
  const record = run(); let writes = 0, saved;
  const ui = await uiHarness({ bootstrap: boot({ runs: [record], annotationsAvailable: true, annotations: { revision: 3, scopeRunIds: [record.id], byRunId: { [record.id]: { protected: true, note: '原备注', revision: 2 } } } }), detail: () => ({ ...record, annotation: { revision: 3, runId: record.id, runRevision: 2, annotation: { protected: true, note: '原备注', revision: 2 } } }), annotations: input => { writes++; saved = input; throw Object.assign(new Error('此记录注释已更新'), { status: 409 }); }, search: '?view=candy' });
  const open = await waitFor(() => button(ui, 'candy-results', '查看详情')); await open.fire('click');
  const note = ui.descendants(ui.elements.get('drawer-content'), 'textarea').find(input => input.getAttribute('aria-label') === '记录备注'); assert.ok(note);
  note.value = '本地未保存草稿'; await note.fire('input'); assert.equal(writes, 0);
  await button(ui, 'drawer-content', '保存备注').fire('click'); assert.equal(writes, 1); assert.equal(saved.expectedRunRevision, 2); assert.equal(saved.note, '本地未保存草稿'); assert.equal(note.value, '本地未保存草稿');
  assert.ok(ui.descendants(ui.elements.get('drawer-content')).some(element => element.textContent.includes('草稿保留')));
});

test('notes edited during an in-flight save survive acknowledgement and reopening', async () => {
  const record = run(); let resolveWrite, annotation = null;
  const ui = await uiHarness({ bootstrap: boot({ runs: [record], annotationsAvailable: true }), detail: () => ({ ...record, annotation: { runId: record.id, revision: annotation ? 1 : 0, runRevision: annotation ? 1 : 0, annotation } }), annotations: () => new Promise(resolve => { resolveWrite = resolve; }), search: '?view=candy' });
  await (await waitFor(() => button(ui, 'candy-results', '查看详情'))).fire('click');
  const note = ui.descendants(ui.elements.get('drawer-content'), 'textarea').find(input => input.getAttribute('aria-label') === '记录备注');
  note.value = '第一版'; await note.fire('input'); const pending = button(ui, 'drawer-content', '保存备注').fire('click'); await waitFor(() => resolveWrite);
  note.value = '继续编辑的新草稿'; await note.fire('input'); annotation = { protected: false, note: '第一版', revision: 1 };
  resolveWrite({ runId: record.id, revision: 1, runRevision: 1, annotation }); await pending; assert.equal(note.value, '继续编辑的新草稿');
  await ui.elements.get('drawer-close').fire('click'); await button(ui, 'candy-results', '查看详情').fire('click');
  const reopened = ui.descendants(ui.elements.get('drawer-content'), 'textarea').find(input => input.getAttribute('aria-label') === '记录备注'); assert.equal(reopened.value, '继续编辑的新草稿'); ui.closeStream();
});

test('history search matches notes from the lightweight annotation index without reading output', async () => {
  const first = run(), second = run(); const ui = await uiHarness({ bootstrap: boot({ runs: [first, second], annotations: { revision: 1, scopeRunIds: [first.id, second.id], byRunId: { [first.id]: { protected: false, note: '检查时区', revision: 1 } } } }), detail: () => { throw new Error('search must not read output'); }, search: '?view=history' });
  await waitFor(() => ui.elements.get('history-panel').hidden === false); assert.ok(ui.elements.get('history-search'));
  ui.elements.get('history-search').value = '时区'; await ui.elements.get('history-search').fire('input');
  assert.equal(ui.descendants(ui.elements.get('history-list')).filter(element => element.className === 'history-item').length, 1);
});

test('new numeric and enum question cards display their own graded answer', async () => {
  for (const answer of [42, 'B']) {
    const record = run({ candy: undefined, grade: { expected: answer, answer, verdict: 'match' } });
    const ui = await uiHarness({ bootstrap: boot({ runs: [record] }), detail: () => record, search: '?view=candy' });
    const displayed = await waitFor(() => ui.descendants(ui.elements.get('candy-results')).find(element => element.className === 'candy-answer'));
    assert.equal(displayed.textContent, String(answer)); assert.equal(displayed.title, String(answer)); ui.closeStream();
  }
});

test('annotation updates immediately re-evaluate the visible history note filter', async () => {
  const record = run(); const ui = await uiHarness({ bootstrap: boot({ runs: [record] }), detail: () => { throw Error('note filtering must not read output'); }, search: '?view=history' });
  await waitFor(() => !ui.elements.get('history-panel').hidden);
  ui.elements.get('history-search').value = '更新备注'; await ui.elements.get('history-search').fire('input');
  const count = () => ui.descendants(ui.elements.get('history-list')).filter(element => element.className === 'history-item').length;
  assert.equal(count(), 0);
  ui.event('annotation', { runId: record.id, revision: 1, runRevision: 1, annotation: { protected: false, note: '更新备注', revision: 1 } });
  await waitFor(() => count() === 1);
  ui.event('annotation', { runId: record.id, revision: 2, runRevision: 2, annotation: null });
  await waitFor(() => count() === 0); ui.closeStream();
});

test('opening manual history clears text and advanced filters that would hide the requested records', async () => {
  const record = run(); const ui = await uiHarness({ bootstrap: boot({ runs: [record] }), detail: () => record, search: '?view=history' });
  await waitFor(() => !ui.elements.get('history-panel').hidden); await ui.elements.get('history-tools').fire('click');
  const modelFilter = ui.descendants(ui.elements.get('drawer-content'), 'input').find(input => input.getAttribute('aria-label') === '模型名称或标识');
  modelFilter.value = 'absent/model'; await button(ui, 'drawer-content', '应用筛选').fire('click');
  await ui.elements.get('drawer-close').fire('click'); ui.elements.get('history-search').value = 'absent'; await ui.elements.get('history-search').fire('input');
  await ui.elements.get('candy-history-link').fire('click');
  assert.equal(ui.elements.get('history-search').value, '');
  assert.equal(ui.descendants(ui.elements.get('history-list')).filter(element => element.className === 'history-item').length, 1); ui.closeStream();
});

test('local queue controls save zero limits and retain the server acknowledged policy', async () => {
  const state = initial(); let saved;
  const ui = await uiHarness({ bootstrap: boot({ queueAvailable: true }), settings: async (path, options) => { if (path === 'api/settings') return { settings: state }; saved = JSON.parse(options.body).patch.queue; state.queue = saved; state.revision++; return { revision: state.revision, changed: { queue: saved } }; } });
  await waitFor(() => !ui.elements.get('local-settings').hidden); await ui.elements.get('local-settings').fire('click');
  const control = ui.descendants(ui.elements.get('drawer-content'), 'input').find(input => input.getAttribute('aria-label') === '供应商并行上限'); assert.ok(control); control.value = '0';
  await button(ui, 'drawer-content', '保存默认限制').fire('click'); assert.equal(saved.providerConcurrency, 0); assert.equal(saved.minIntervalMs, 0); assert.deepEqual(saved.providers, {});
  await ui.elements.get('drawer-close').fire('click'); await ui.elements.get('local-settings').fire('click'); assert.equal(ui.descendants(ui.elements.get('drawer-content'), 'input').find(input => input.getAttribute('aria-label') === '供应商并行上限').value, '0');
});

test('daily history keeps the same model under different fixed accounts in distinct lanes', async () => {
  const items = ['a', 'b'].flatMap(account => [9, 12].map(hour => run({ kind: 'pelican', source: 'automatic', scheduledAt: `2026-11-22T${hour === 9 ? '09' : '12'}:00:00Z`, accountTarget: { mode: 'pinned', id: account, name: 'Account ' + account } })));
  const ui = await uiHarness({ bootstrap: boot({ runs: items, historyTimeZone: 'UTC' }), detail: id => items.find(run => run.id === id), search: '?view=history' });
  const row = await waitFor(() => ui.descendants(ui.elements.get('history-list'), 'button').find(button => button.className === 'history-row')); await row.fire('click');
  const lanes = ui.descendants(ui.elements.get('history-results')).filter(element => element.className.includes('history-animation-lane')); assert.equal(lanes.length, 2); assert.ok(lanes.every(lane => lane.children.length === 2));
});
