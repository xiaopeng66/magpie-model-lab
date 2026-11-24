import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Annotations } from '../lib/annotations.mjs';
import { temporary, waitFor } from './helpers.mjs';
import { uiHarness } from './ui-harness.mjs';

const button = (ui, root, label) => ui.descendants(ui.elements.get(root), 'button').find(control => control.textContent === label);
const noteField = ui => ui.descendants(ui.elements.get('drawer-content'), 'textarea').find(control => control.getAttribute('aria-label') === '记录备注');

test('reconnection after clearing a note keeps the same record revision and an editable draft', async t => {
  const annotations = new Annotations(await temporary(t)); await annotations.init(); t.after(() => annotations.close());
  const run = { id: randomUUID(), batchId: randomUUID(), model: 'fixture/one', modelName: '合成模型', kind: 'candy', status: 'completed', createdAt: '2026-11-24T00:00:00Z', content: '最终答案：21' };
  await annotations.save({ runId: run.id, expectedRunRevision: 0, note: '原备注' });
  await annotations.save({ runId: run.id, expectedRunRevision: 1, note: '' });
  let reads = 0;
  const ui = await uiHarness({ bootstrap: { models: [], runs: [run], defaultPrompt: 'test', notesAvailable: true, annotationsAvailable: true, annotations: annotations.projection([run.id]) },
    detail: () => { reads++; return { ...run, annotation: annotations.detail(run.id) }; }, annotations: input => annotations.save(input), search: '?view=candy' });
  t.after(() => ui.closeStream());
  await (await waitFor(() => button(ui, 'candy-results', '查看详情'))).fire('click');
  await waitFor(() => reads > 0 && noteField(ui));
  const note = noteField(ui); assert.equal(note.value, '');
  note.value = '重连后继续填写的备注'; await note.fire('input');
  ui.event('hello', { runs: [run], annotations: annotations.projection([run.id]) });
  await new Promise(resolve => setTimeout(resolve, 10));
  const save = button(ui, 'drawer-content', '保存备注');
  assert.equal(save.disabled, false, 'A reconnect snapshot must not turn an unchanged empty note into a revision conflict');
  assert.equal(note.value, '重连后继续填写的备注');
  await save.fire('click');
  assert.equal(annotations.detail(run.id).annotation.note, '重连后继续填写的备注');
  assert.equal(annotations.detail(run.id).runRevision, 3);
});

for (const [field, setup] of [['protected', { expectedRevision: 0, protected: true }], ['note', { expectedRunRevision: 0, note: '保留备注' }]]) {
  test(`an explicit null ${field} write is rejected without clearing existing data`, async t => {
    const annotations = new Annotations(await temporary(t)); await annotations.init(); t.after(() => annotations.close());
    const id = randomUUID(); await annotations.save({ runId: id, ...setup });
    const before = annotations.snapshot();
    await assert.rejects(annotations.save({ runId: id, expectedRevision: 1, [field]: null }), error => error.status === 400);
    assert.deepEqual(annotations.snapshot(), before);
  });
}
