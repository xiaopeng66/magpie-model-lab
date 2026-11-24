import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Annotations } from '../lib/annotations.mjs';
import { historyMatches } from '../lib/history-index.mjs';
import { temporary, waitFor } from './helpers.mjs';
import { uiHarness } from './ui-harness.mjs';

const record = (kind, fields = {}) => ({
  id: randomUUID(), batchId: randomUUID(), model: 'fixture/one', modelName: '合成模型',
  kind, status: 'completed', createdAt: '2026-11-24T00:00:00Z',
  content: kind === 'candy' ? '最终答案：21' : '<!doctype html><html><body>test</body></html>',
  ...(kind === 'candy' ? { candy: { expected: 21, answer: 21, verdict: 'match' } } : {}),
  ...fields,
});
const button = (ui, root, label) => ui.descendants(ui.elements.get(root), 'button').find(control => control.textContent === label);
const noteField = ui => ui.descendants(ui.elements.get('drawer-content'), 'textarea').find(control => control.getAttribute('aria-label') === '记录备注');

test('old tags remain readable on disk while details and projections expose only notes and protection', async t => {
  const dir = await temporary(t), noted = randomUUID(), tagsOnly = randomUUID();
  await mkdir(join(dir, '.annotations'));
  const path = join(dir, '.annotations/state.json');
  const old = JSON.stringify({ schema: 2, revision: 7, byRunId: {
    [noted]: { protected: false, restoreProtection: true, note: '已有备注', tags: ['旧标签'], revision: 3, updatedAt: '2026-11-23T00:00:00Z' },
    [tagsOnly]: { protected: false, note: '', tags: ['仅有标签'], revision: 2, updatedAt: '2026-11-23T00:00:00Z' },
  } });
  await writeFile(path, old);
  const annotations = new Annotations(dir); await annotations.init(); t.after(() => annotations.close());
  assert.equal(annotations.recoveryError, '');
  assert.equal(await readFile(path, 'utf8'), old, 'Startup must not rewrite a legacy file before the disk comparison');
  const detail = annotations.detail(noted);
  assert.equal(detail.annotation.note, '已有备注'); assert.equal(detail.annotation.protected, true);
  assert.equal(Object.hasOwn(detail.annotation, 'tags'), false);
  const projection = annotations.projection([noted, tagsOnly]);
  assert.equal(Object.hasOwn(projection.byRunId[noted], 'tags'), false);
  assert.equal(Object.hasOwn(projection.byRunId, tagsOnly), false);
  assert.equal(annotations.detail(tagsOnly).runRevision, 2);
  await annotations.save({ runId: noted, expectedRunRevision: 3, note: '修改后的备注' });
  assert.equal(annotations.isProtected(noted), true);
  const saved = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(Object.hasOwn(saved.byRunId[noted], 'tags'), false, 'New writes must retire the edited record’s legacy tags');
  assert.equal(saved.byRunId[noted].note, '修改后的备注');
  assert.equal(await readFile(join(dir, '.annotations/state.previous.json'), 'utf8'), JSON.stringify(JSON.parse(old), null, 2));
  await annotations.close();
  const reopened = new Annotations(dir); await reopened.init(); t.after(() => reopened.close());
  assert.equal(reopened.recoveryError, ''); assert.equal(reopened.detail(noted).annotation.note, '修改后的备注');
  assert.equal(reopened.isProtected(noted), true);
});

test('removed tag write requests are rejected without changing a note or its revision', async t => {
  const annotations = new Annotations(await temporary(t)); await annotations.init(); t.after(() => annotations.close());
  const id = randomUUID(); await annotations.save({ runId: id, expectedRunRevision: 0, note: '保留备注' });
  for (const patch of [{ tags: ['标签'] }, { tags: [] }, { note: '不应保存', tags: ['标签'] }]) {
    await assert.rejects(annotations.save({ runId: id, expectedRunRevision: 1, ...patch }), error => error.status === 400);
    assert.equal(annotations.detail(id).annotation.note, '保留备注'); assert.equal(annotations.detail(id).runRevision, 1);
  }
});

test('legacy tags cannot match text searches or hide results through a retired tag filter', () => {
  const run = record('candy'), annotation = { note: '核对延迟', protected: false, tags: ['仅标签匹配'] };
  assert.equal(historyMatches(run, annotation, { text: '仅标签匹配' }), false);
  assert.equal(historyMatches(run, annotation, { text: '核对延迟' }), true);
  assert.equal(historyMatches(run, annotation, { tags: ['不存在的标签'] }), true);
});

for (const [kind, view, root] of [['pelican', 'current', 'results'], ['fingerprint', 'fingerprint', 'fingerprint-results'], ['candy', 'candy', 'candy-results']]) {
  test(`${kind} details make notes editable immediately without a disclosure or tag field`, async t => {
    const run = record(kind), annotation = { protected: false, note: '原备注', revision: 1 }; let submitted;
    const ui = await uiHarness({ bootstrap: { version: '1.0.6', models: [], runs: [run], defaultPrompt: 'test', notesAvailable: true, annotationsAvailable: true, fingerprintAvailable: true,
      annotations: { revision: 1, scopeRunIds: [run.id], byRunId: { [run.id]: annotation } } },
      detail: () => ({ ...run, annotation: { runId: run.id, revision: 1, runRevision: 1, annotation } }),
      annotations: input => { submitted = input; return { runId: run.id, revision: 2, runRevision: 2, annotation: { ...annotation, note: input.note, revision: 2 } }; },
      bank: () => ({ state: 'missing' }), search: `?view=${view}` });
    t.after(() => ui.closeStream());
    await (await waitFor(() => button(ui, root, '查看详情'))).fire('click');
    const note = await waitFor(() => noteField(ui));
    assert.equal(note.getClientRects().length, 1, 'The note field must be visible immediately after opening details');
    assert.equal(note.value, '原备注');
    assert.equal(ui.descendants(ui.elements.get('drawer-content'), 'input').some(control => control.getAttribute('aria-label') === '记录标签'), false);
    note.value = '直接填写的备注'; await note.fire('input'); assert.equal(submitted, undefined);
    await button(ui, 'drawer-content', '保存备注').fire('click');
    assert.deepEqual(submitted, { runId: run.id, expectedRunRevision: 1, note: '直接填写的备注' });
    assert.equal(note.value, '直接填写的备注');
  });
}

test('clearing a note reconciles a lost reply even when the committed annotation is now null', async t => {
  const run = record('candy'); let revision = 1, annotation = { protected: false, note: '将清空的备注', revision: 1 }, writes = 0;
  const ui = await uiHarness({ bootstrap: { models: [], runs: [run], defaultPrompt: 'test', notesAvailable: true, annotationsAvailable: true,
    annotations: { revision: 1, scopeRunIds: [run.id], byRunId: { [run.id]: annotation } } },
    detail: () => ({ ...run, annotation: { runId: run.id, revision, runRevision: revision, annotation } }),
    annotations: () => { writes++; revision++; annotation = null; throw Error('reply lost'); }, search: '?view=candy' });
  t.after(() => ui.closeStream()); await (await waitFor(() => button(ui, 'candy-results', '查看详情'))).fire('click');
  const note = noteField(ui); note.value = ''; await note.fire('input');
  const save = ui.descendants(ui.elements.get('drawer-content'), 'button').find(control => /^保存备注/.test(control.textContent));
  await save.fire('click');
  assert.equal(writes, 1);
  assert.ok(ui.descendants(ui.elements.get('drawer-content')).some(control => control.getAttribute('role') === 'status' && /确认.*保存成功/.test(control.textContent)));
  await ui.elements.get('drawer-close').fire('click'); await button(ui, 'candy-results', '查看详情').fire('click');
  assert.equal(noteField(ui).value, '');
});

test('a failed note write cannot be acknowledged from an unchanged matching remote note', async t => {
  const run = record('candy'), annotation = { protected: false, note: '相同备注', revision: 1 };
  const ui = await uiHarness({ bootstrap: { models: [], runs: [run], defaultPrompt: 'test', notesAvailable: true, annotationsAvailable: true,
    annotations: { revision: 1, scopeRunIds: [run.id], byRunId: { [run.id]: annotation } } },
    detail: () => ({ ...run, annotation: { runId: run.id, revision: 1, runRevision: 1, annotation } }),
    annotations: () => { throw Error('write unavailable'); }, search: '?view=candy' });
  t.after(() => ui.closeStream()); await (await waitFor(() => button(ui, 'candy-results', '查看详情'))).fire('click');
  const note = noteField(ui); note.value = '相同备注'; await note.fire('input');
  const save = ui.descendants(ui.elements.get('drawer-content'), 'button').find(control => /^保存备注/.test(control.textContent));
  await save.fire('click');
  const status = ui.descendants(ui.elements.get('drawer-content')).find(control => control.getAttribute('role') === 'status' && /草稿保留/.test(control.textContent));
  assert.ok(status, 'An unchanged remote revision cannot prove that this write committed');
  assert.doesNotMatch(status.textContent, /保存成功/);
});

test('history filters provide note search with no tag field or submitted tag condition', async t => {
  const noted = record('candy'), other = record('candy');
  const ui = await uiHarness({ bootstrap: { models: [], runs: [noted, other], defaultPrompt: 'test', notesAvailable: true,
    annotations: { revision: 1, scopeRunIds: [noted.id, other.id], byRunId: { [noted.id]: { note: '待复核备注', protected: false, revision: 1 } } } }, search: '?view=history' });
  t.after(() => ui.closeStream()); await waitFor(() => !ui.elements.get('history-panel').hidden);
  await ui.elements.get('history-tools').fire('click');
  const inputs = ui.descendants(ui.elements.get('drawer-content'), 'input');
  assert.equal(inputs.some(control => /标签/.test(control.getAttribute('aria-label') || '')), false);
  const note = inputs.find(control => control.getAttribute('aria-label') === '备注包含文字');
  note.value = '待复核'; await button(ui, 'drawer-content', '应用筛选').fire('click');
  assert.equal(ui.descendants(ui.elements.get('history-list')).filter(control => control.className === 'history-item').length, 1);
  assert.doesNotMatch(ui.elements.get('history-tools').title, /标签/);
  await button(ui, 'drawer-content', '清除筛选').fire('click');
  assert.equal(ui.descendants(ui.elements.get('history-list')).filter(control => control.className === 'history-item').length, 2);
});
