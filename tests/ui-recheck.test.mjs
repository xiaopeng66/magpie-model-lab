import test from 'node:test';
import assert from 'node:assert/strict';
import { uiHarness } from './ui-harness.mjs';
import { waitFor } from './helpers.mjs';
import { createAccountTargets } from '../ui/account-targets.mjs';

const record = (id, model = 'fixture/model-a') => ({ id, batchId: id, model, kind: 'candy', status: 'completed', createdAt: '2026-11-23T00:00:00Z', content: '最终答案：21' });
const find = (ui, root, label) => ui.descendants(ui.elements.get(root), 'button').find(control => control.textContent === label);

test('active history conditions remain visible after closing the filter panel and clear with the filter', async t => {
  const runs = [record('a'), record('b', 'fixture/model-b')];
  const ui = await uiHarness({ bootstrap: { models: [], runs, defaultPrompt: 'test', notesAvailable: true }, search: '?view=history' });
  t.after(() => ui.closeStream()); await waitFor(() => !ui.elements.get('history-panel').hidden);
  await ui.elements.get('history-tools').fire('click');
  const controls = ui.descendants(ui.elements.get('drawer-content'));
  controls.find(control => control.getAttribute('aria-label') === '模型名称或标识').value = 'model-a';
  controls.find(control => control.getAttribute('aria-label') === '保护状态').value = 'no';
  await find(ui, 'drawer-content', '应用筛选').fire('click'); await ui.elements.get('drawer-close').fire('click');
  assert.equal(ui.descendants(ui.elements.get('history-list')).filter(control => control.className === 'history-item').length, 1);
  assert.match(ui.elements.get('history-tools').getAttribute('aria-label') || '', /2.*条件/, 'Unprotected is an active condition even though its value is false');
  await ui.elements.get('history-tools').fire('click'); await find(ui, 'drawer-content', '清除筛选').fire('click'); await ui.elements.get('drawer-close').fire('click');
  assert.equal(ui.descendants(ui.elements.get('history-list')).filter(control => control.className === 'history-item').length, 2);
  assert.doesNotMatch(ui.elements.get('history-tools').getAttribute('aria-label') || '', /已应用/);
});

test('a conflicting annotation disables saving until the current annotation is read while preserving the draft', async t => {
  const run = record('note'); let annotation = null, revision = 0, submitted;
  const ui = await uiHarness({ bootstrap: { models: [], runs: [run], defaultPrompt: 'test', notesAvailable: true, annotationsAvailable: true }, search: '?view=candy',
    detail: () => ({ ...run, annotation: { runId: run.id, revision, runRevision: revision, annotation } }),
    annotations: input => { submitted = input; annotation = { note: input.note, tags: input.tags, revision: ++revision }; return { runId: run.id, revision, runRevision: revision, annotation }; } });
  t.after(() => ui.closeStream()); await (await waitFor(() => find(ui, 'candy-results', '查看详情'))).fire('click');
  const note = ui.descendants(ui.elements.get('drawer-content'), 'textarea').find(control => control.getAttribute('aria-label') === '记录备注');
  note.value = '保留的本地草稿'; await note.fire('input'); annotation = { note: '其他页面的备注', tags: [], revision: 1 }; revision = 1;
  ui.event('annotation', { runId: run.id, revision, runRevision: revision, annotation });
  await waitFor(() => ui.descendants(ui.elements.get('drawer-content')).some(control => /注释已更新/.test(control.textContent)));
  const save = find(ui, 'drawer-content', '保存备注与标签'); assert.equal(save.disabled, true, 'A visible save button must not look available when its click is ignored');
  await find(ui, 'drawer-content', '读取当前注释并保留草稿').fire('click');
  assert.equal(note.value, '保留的本地草稿'); assert.equal(save.disabled, false); await save.fire('click');
  assert.equal(submitted.expectedRunRevision, 1); assert.equal(submitted.note, '保留的本地草稿');
});

test('account confirmation waits for the cache response before accepting an unavailable previous account', async t => {
  const ui = await uiHarness({ bootstrap: { models: [], runs: [], defaultPrompt: 'test' } }); t.after(() => ui.closeStream());
  await waitFor(() => !ui.elements.get('generate').disabled);
  let resolveRead, applied; const body = ui.elements.get('drawer-content'), footer = ui.elements.get('drawer-footer');
  const targets = createAccountTargets({ document: ui.document, api: () => new Promise(resolve => { resolveRead = resolve; }),
    openDrawer: () => { ui.elements.get('favorite-drawer').hidden = false; return body; }, closeDrawer: () => { ui.elements.get('favorite-drawer').hidden = true; }, footer: () => footer });
  const pending = targets.open({ id: 'fixture/model-a', provider: 'fixture' }, null, { initial: [{ mode: 'pinned', id: 'previous-account' }], onApply: accounts => { applied = accounts; } });
  await waitFor(() => resolveRead);
  const apply = find(ui, 'drawer-footer', '确认账号选择'); assert.equal(apply.disabled, true, 'The previous cached account must not be confirmed before refreshing its availability');
  assert.equal(find(ui, 'drawer-content', '刷新缓存账号').disabled, true);
  resolveRead({ capabilities: { pinned: true }, accounts: [{ id: 'previous-account', enabled: false }] }); await pending;
  await apply.fire('click'); assert.equal(applied, undefined);
  const automatic = ui.descendants(body, 'input').find(control => control.getAttribute('aria-label') === '自动分配'); automatic.checked = true; await automatic.fire('change');
  await apply.fire('click'); assert.deepEqual(applied, [{ mode: 'auto' }]);
});
