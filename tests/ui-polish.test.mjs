import test from 'node:test';
import assert from 'node:assert/strict';
import { uiHarness, confirmClick } from './ui-harness.mjs';
import { waitFor } from './helpers.mjs';
import { parameterDefaults } from '../lib/test-parameters.mjs';
import { suiteCatalog, taskFor } from '../lib/suites.mjs';
import { CANDY_PROMPT } from '../lib/candy.mjs';
import { legacyReasoningTask } from './legacy-task-fixtures.mjs';

const initial = () => ({ revision: 0, manual: Object.fromEntries(['pelican', 'candy', 'fingerprint'].map(kind => [kind, parameterDefaults(kind, 'animate')])), retention: { days: 30 }, progressNotice: { enabled: true }, presets: [] });
const boot = state => ({ version: '1.0.6', models: [], runs: [], defaultPrompt: 'animate', candyAvailable: true, experimentsAvailable: true, suites: suiteCatalog(), settings: state, settingsCapabilities: { memory: true, retention: true, presets: true } });

test('candy preview retains the original prompt with no alternate question selection', async t => {
  const state = initial(), ui = await uiHarness({ bootstrap: { ...boot(state), candyPrompt: CANDY_PROMPT }, settings: async () => ({ settings: state }), search: '?view=candy' });
  t.after(() => ui.closeStream()); await waitFor(() => !ui.elements.get('candy-panel').hidden);
  assert.equal(ui.elements.get('candy-prompt').textContent, CANDY_PROMPT);
  assert.equal(ui.elements.has('suite-select'), false);
  ui.elements.get('repeat-count').value = '3'; await ui.elements.get('repeat-count').fire('input');
  assert.equal(ui.elements.get('candy-prompt').textContent, CANDY_PROMPT);
  assert.equal(ui.elements.get('candy-source').hidden, false);
});

test('retention can be previewed and saved directly from history without opening unrelated local settings', async t => {
  const state = initial(), calls = [];
  const ui = await uiHarness({ bootstrap: boot(state), search: '?view=history', retention: async () => ({ candidateCount: 2, previewToken: 'retention-proof' }), settings: async (_path, options) => {
    if (!options.body) return { settings: state };
    const body = JSON.parse(options.body); calls.push(body); state.retention = body.patch.retention; return { revision: ++state.revision, changed: { retention: state.retention } };
  } });
  t.after(() => ui.closeStream()); await waitFor(() => !ui.elements.get('history-panel').hidden);
  const opener = ui.elements.get('history-retention'); assert.ok(opener, 'History must expose its own retention entry'); await opener.fire('click');
  const controls = () => ui.descendants(ui.elements.get('drawer-content'));
  const select = controls().find(control => control.getAttribute('aria-label') === '保留策略'); select.value = '7'; await select.fire('change');
  assert.equal(controls().some(control => control.getAttribute('aria-label') === '供应商并行上限'), false);
  await controls().find(control => control.textContent === '预览影响').fire('click');
  const { completion } = await confirmClick(ui, controls().find(control => control.textContent === '保存保留策略')); await completion;
  assert.equal(calls[0].previewToken, 'retention-proof'); assert.equal(calls[0].patch.retention.days, 7);
});

test('an empty common-parameter catalog disables operations that need a saved scheme while allowing creation', async t => {
  const state = initial(), ui = await uiHarness({ bootstrap: boot(state), settings: async () => ({ settings: state }) });
  t.after(() => ui.closeStream()); await waitFor(() => !ui.elements.get('manage-presets').hidden); await ui.elements.get('manage-presets').fire('click');
  const buttons = ui.descendants(ui.elements.get('drawer-content'), 'button');
  const load = buttons.find(control => control.textContent === '应用到测试'); assert.ok(load); assert.equal(load.disabled, true);
  assert.equal(buttons.find(control => control.textContent === '新建方案').disabled, false);
  assert.equal(buttons.find(control => control.textContent === '删除方案').disabled, true);
  const create = ui.descendants(ui.elements.get('drawer-footer'), 'button').find(control => control.textContent === '保存为新方案');
  assert.ok(create); assert.equal(create.disabled, false);
});

test('common parameters use their own defaults despite an invalid main field and selecting a scheme fills the editor', async t => {
  const state = initial(); state.presets = [{ id: 'saved', kind: 'pelican', name: '长时间推理', parameters: { ...state.manual.pelican, timeoutMs: 1800000 } }];
  const ui = await uiHarness({ bootstrap: boot(state), settings: async () => ({ settings: state }) });
  t.after(() => ui.closeStream()); await waitFor(() => !ui.elements.get('manage-presets').hidden);
  ui.elements.get('generation-timeout').value = ''; await ui.elements.get('generation-timeout').fire('input'); await ui.elements.get('manage-presets').fire('click');
  const controls = () => ui.descendants(ui.elements.get('drawer-content'));
  assert.ok(controls().some(control => control.textContent === '应用到测试'));
  assert.equal(controls().find(control => control.getAttribute('aria-label') === '方案生成超时').value, '600');
  const select = controls().find(control => control.getAttribute('aria-label') === '选择方案'); select.value = 'saved'; await select.fire('change');
  assert.equal(ui.elements.get('generation-timeout').value, '');
  assert.equal(controls().find(control => control.getAttribute('aria-label') === '方案生成超时').value, '1800');
  await controls().find(control => control.textContent === '应用到测试').fire('click');
  assert.equal(ui.elements.get('generation-timeout').value, '1800');
  assert.equal(controls().find(control => control.getAttribute('aria-label') === '方案生成超时').value, '1800');
});

test('closing common parameters while delete confirmation is pending prevents a detached write', async t => {
  const state = initial(); state.presets = [{ id: 'saved', kind: 'pelican', name: '已保存方案', parameters: state.manual.pelican }]; let writes = 0;
  const ui = await uiHarness({ bootstrap: boot(state), settings: async (_path, options) => { if (options.body) writes++; return { settings: state }; } });
  t.after(() => ui.closeStream()); await waitFor(() => !ui.elements.get('manage-presets').hidden); await ui.elements.get('manage-presets').fire('click');
  const controls = () => ui.descendants(ui.elements.get('drawer-content'));
  const select = controls().find(control => control.getAttribute('aria-label') === '选择方案'); select.value = 'saved'; await select.fire('change');
  const pending = controls().find(control => control.textContent === '删除方案').fire('click'); await waitFor(() => ui.elements.get('confirm-dialog').open);
  await ui.elements.get('drawer-close').fire('click'); await ui.elements.get('confirm-accept').fire('click'); await pending;
  assert.equal(writes, 0);
});

test('a repeated question result identifies its own question and round without changing its graded answer', async t => {
  const state = initial(), task = legacyReasoningTask();
  const record = { id: 'question-record', batchId: 'question-batch', model: 'fixture/one', kind: 'candy', status: 'completed', createdAt: '2026-11-22T00:00:00Z', task, grade: { expected: 42, answer: 42, verdict: 'match' }, repetitionIndex: 1, experiment: { repeatCount: 3 } };
  const ui = await uiHarness({ bootstrap: { ...boot(state), runs: [record] }, settings: async () => ({ settings: state }), search: '?view=candy' });
  t.after(() => ui.closeStream());
  const answer = await waitFor(() => ui.descendants(ui.elements.get('candy-results')).find(control => control.className === 'candy-answer'));
  assert.equal(answer.textContent, '42');
  const context = ui.descendants(ui.elements.get('candy-results')).find(control => control.className === 'help phase-run-context');
  assert.ok(context, 'Multi-question and repeat results need an identifying caption');
  assert.match(context.textContent, /括号与乘法/); assert.match(context.textContent, /第 2\/3 轮/);
});
