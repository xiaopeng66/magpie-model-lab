import test from 'node:test';
import assert from 'node:assert/strict';
import { uiHarness } from './ui-harness.mjs';
import { waitFor } from './helpers.mjs';
import { enhancementSetup } from './enhancement-helpers.mjs';
import { parameterDefaults } from '../lib/test-parameters.mjs';
import { newProgress, advanceProgress } from '../lib/progress.mjs';

const initial = () => ({ revision: 0, manual: Object.fromEntries(['pelican', 'candy', 'fingerprint'].map(kind => [kind, parameterDefaults(kind, 'animate')])), retention: { days: 7 }, progressNotice: { enabled: true }, presets: [] });
const find = (ui, host, label) => ui.descendants(ui.elements.get(host)).find(item => item.getAttribute('aria-label') === label || item.tagName === 'BUTTON' && item.textContent === label);
const record = (id, model, account, repetitionIndex, executionIndex) => ({ id, model, modelName: model.split('/')[1], provider: 'fixture', providerName: '合成供应商', accountTarget: { mode: 'pinned', id: account, name: account }, kind: 'candy', batchId: 'batch', experimentId: 'batch', experiment: { repeatCount: 2 }, repetitionIndex, executionIndex, createdAt: '2026-11-23T01:00:00Z', status: 'completed', content: '21' });

test('repeated cards keep each model-account target together in ascending round order in current and manual history views', async t => {
  const records = [record('a1', 'fixture/one', 'a', 0, 0), record('b1', 'fixture/two', 'b', 0, 1), record('c1', 'fixture/one', 'c', 0, 2), record('a2', 'fixture/one', 'a', 1, 3), record('b2', 'fixture/two', 'b', 1, 4), record('c2', 'fixture/one', 'c', 1, 5)];
  const ui = await uiHarness({ bootstrap: { models: [], runs: records, defaultPrompt: 'animate', candyAvailable: true }, detail: id => records.find(run => run.id === id), search: '?view=candy' });
  t.after(() => ui.closeStream());
  await waitFor(() => ui.descendants(ui.elements.get('candy-results'), 'article').length === 6);
  assert.deepEqual(ui.descendants(ui.elements.get('candy-results'), 'article').map(card => card.dataset.runId), ['a1', 'a2', 'b1', 'b2', 'c1', 'c2']);
  const groups = ui.elements.get('candy-results').children;
  assert.equal(groups.length, 3); assert.deepEqual(groups.map(group => ui.descendants(group, 'article').map(card => card.dataset.runId)), [['a1', 'a2'], ['b1', 'b2'], ['c1', 'c2']]);
  await ui.elements.get('history-tab').fire('click');
  const batch = await waitFor(() => ui.descendants(ui.elements.get('history-list'), 'button').find(button => button.getAttribute('aria-expanded') === 'false'));
  await batch.fire('click');
  assert.deepEqual(ui.descendants(ui.elements.get('history-results'), 'article').map(card => card.dataset.runId), ['a1', 'a2', 'b1', 'b2', 'c1', 'c2']);
});

test('new streamed rounds stay in their model groups and history switches cleanly between repeated and ordinary batches', async t => {
  const records = [record('a1', 'fixture/one', 'a', 0, 0), record('b1', 'fixture/two', 'b', 0, 1)];
  const ui = await uiHarness({ bootstrap: { models: [], runs: records, defaultPrompt: 'animate', candyAvailable: true }, search: '?view=candy' });
  t.after(() => ui.closeStream()); await waitFor(() => ui.descendants(ui.elements.get('candy-results'), 'article').length === 2);
  for (const run of [record('b2', 'fixture/two', 'b', 1, 3), record('a2', 'fixture/one', 'a', 1, 2)]) ui.event('run', { run });
  await waitFor(() => ui.descendants(ui.elements.get('candy-results'), 'article').length === 4);
  assert.deepEqual(ui.descendants(ui.elements.get('candy-results'), 'article').map(card => card.dataset.runId), ['a1', 'a2', 'b1', 'b2']);
  assert.equal(ui.elements.get('candy-results').children.length, 2);
  const ordinary = { ...record('single', 'fixture/one', 'a', 0, 0), batchId: 'single-batch', experiment: undefined, createdAt: '2026-11-22T00:00:00Z' };
  ui.event('run', { run: ordinary }); await ui.elements.get('history-tab').fire('click');
  const row = id => ui.descendants(ui.elements.get('history-list')).find(item => item.className === 'history-item' && item.dataset.batchId === id)?.querySelector('button');
  await waitFor(() => row('single-batch')); await row('single-batch').fire('click');
  assert.deepEqual(ui.elements.get('history-results').children.map(item => item.dataset.runId), ['single']); assert.equal(ui.elements.get('history-results').dataset.repeated, 'false');
  await row('batch').fire('click'); assert.deepEqual(ui.descendants(ui.elements.get('history-results'), 'article').map(card => card.dataset.runId), ['a1', 'a2', 'b1', 'b2']); assert.equal(ui.elements.get('history-results').children.length, 2);
});

test('a repeated target heading does not retain an obsolete account verification after streamed results arrive', async t => {
  const records = [record('a1', 'fixture/one', 'a', 0, 0), record('a2', 'fixture/one', 'a', 1, 1)].map(run => ({ ...run, status: 'queued' }));
  const ui = await uiHarness({ bootstrap: { models: [], runs: records, defaultPrompt: 'animate', candyAvailable: true }, search: '?view=candy' });
  t.after(() => ui.closeStream());
  await waitFor(() => ui.descendants(ui.elements.get('candy-results'), 'article').length === 2);
  ui.event('run', { run: { ...records[0], status: 'completed', routing: { verification: 'verified' } } });
  ui.event('run', { run: { ...records[1], status: 'completed', routing: { verification: 'mismatch' } } });
  await waitFor(() => ui.descendants(ui.elements.get('candy-results')).some(item => /账号不符/.test(item.textContent)));
  const heading = ui.descendants(ui.elements.get('candy-results'), 'h3').find(item => item.className === 'repeat-model-heading');
  assert.match(heading.textContent, /one · 合成供应商 · a/);
  assert.doesNotMatch(heading.textContent, /账号未核实|账号已核实|账号不符/, 'Routing belongs to each result, since different rounds can report different accounts');
  assert.ok(ui.descendants(ui.elements.get('candy-results')).some(item => /账号已核实/.test(item.textContent)));
});

test('31 original candy repetitions execute without the former 30-round cap', async t => {
  const { runner, seen } = await enhancementSetup(t, { handler: ({ complete }) => complete('最终答案：21') });
  const runs = await runner.submit({ kind: 'candy', repeat: { count: 31 }, concurrency: 3, targets: [{ modelId: 'fixture/one' }] });
  await waitFor(() => runner.list().every(run => run.status === 'completed'));
  assert.equal(runs.length, 31); assert.equal(seen.length, 31); assert.equal(runs.at(-1).repetitionIndex, 30);
});

test('removing repeated records removes empty target headings from the current batch', async t => {
  const records = [record('a1', 'fixture/one', 'a', 0, 0), record('b1', 'fixture/two', 'b', 0, 1), record('a2', 'fixture/one', 'a', 1, 2), record('b2', 'fixture/two', 'b', 1, 3)];
  const ui = await uiHarness({ bootstrap: { models: [], runs: records, defaultPrompt: 'animate', candyAvailable: true }, search: '?view=candy' });
  t.after(() => ui.closeStream()); await waitFor(() => ui.descendants(ui.elements.get('candy-results'), 'article').length === 4);
  ui.event('removed', { ids: ['a1', 'a2'] });
  await waitFor(() => ui.descendants(ui.elements.get('candy-results'), 'article').length === 2);
  assert.equal(ui.elements.get('candy-results').children.length, 1);
  assert.deepEqual(ui.descendants(ui.elements.get('candy-results'), 'article').map(card => card.dataset.runId), ['b1', 'b2']);
  ui.event('removed', { ids: ['b1', 'b2'] });
  await waitFor(() => ui.descendants(ui.elements.get('candy-results'), 'article').length === 0);
  assert.equal(ui.elements.get('candy-results').children.length, 0);
});

test('repeat inputs above 30 calculate the real request count and reject unsafe counts', async t => {
  let submitted;
  const ui = await uiHarness({ bootstrap: { models: [{ id: 'fixture/one', name: 'one', provider: 'fixture', efforts: [] }], runs: [], defaultPrompt: 'animate', experimentsAvailable: true, candyAvailable: true }, search: '?view=candy', create: body => { submitted = body; return { runs: [] }; } });
  t.after(() => ui.closeStream()); await waitFor(() => !ui.elements.get('generate').disabled);
  const model = ui.descendants(ui.elements.get('model-list'), 'input')[0]; model.checked = true; await model.fire('change');
  const repeat = ui.elements.get('repeat-count'); repeat.value = '100'; await repeat.fire('input');
  assert.match(ui.elements.get('experiment-estimate').textContent, /100 份结果.*100 次生成请求/);
  await ui.elements.get('generate').fire('click'); assert.equal(submitted.repeat.count, 100);
  submitted = null; repeat.value = String(Number.MAX_SAFE_INTEGER + 1); await repeat.fire('input'); await ui.elements.get('generate').fire('click');
  assert.equal(submitted, null); assert.match(ui.elements.get('form-error').textContent, /整数|范围/);
});

test('huge repetition preparation is rejected within the byte budget before creating records or sending requests', async t => {
  const { runner, seen } = await enhancementSetup(t); let saved = 0;
  const originalSave = runner.store.save.bind(runner.store); runner.store.save = run => { saved++; return originalSave(run); };
  await assert.rejects(runner.submit({ prompt: 'x'.repeat(12000), repeat: { count: Number.MAX_SAFE_INTEGER }, models: [{ id: 'fixture/one' }] }), error => error.status === 413 && /8 MiB/.test(error.message));
  assert.equal(saved, 0); assert.equal(runner.list().length, 0); assert.equal(seen.length, 0);
});

async function presetEditor(t, state = initial(), options = {}) {
  const writes = [];
  const ui = await uiHarness({ bootstrap: { models: [{ id: 'fixture/one', name: 'one', provider: 'fixture', efforts: ['low', 'high'] }], runs: [], defaultPrompt: 'animate', settings: state, settingsCapabilities: { memory: true, presets: true }, candyAvailable: true }, search: options.search || '', settings: async (path, request) => {
    await options.beforeSettings?.({ path, request, state });
    if (!request.body) return { settings: structuredClone(state) };
    const { patch } = JSON.parse(request.body); if (patch.manual) Object.assign(state.manual, patch.manual);
    if (patch.presetDelete) state.presets = state.presets.filter(preset => preset.id !== patch.presetDelete.id);
    let preset;
    if (patch.presetUpsert) { writes.push(structuredClone(patch.presetUpsert)); preset = { ...patch.presetUpsert, id: patch.presetUpsert.id || 'new-scheme' }; state.presets = [...state.presets.filter(item => item.id !== preset.id), preset]; }
    return { revision: ++state.revision, changed: { presetCatalog: state.presets.map(({ id, kind, name }) => ({ id, kind, name })) }, ...(preset ? { preset } : {}) };
  } });
  t.after(() => ui.closeStream()); await waitFor(() => !ui.elements.get('manage-presets').hidden); await ui.elements.get('manage-presets').fire('click');
  return { ui, state, writes, input: label => { const input = find(ui, 'drawer-content', label); assert.ok(input, `The editor must expose ${label}`); return input; }, action: label => find(ui, 'drawer-content', label) || find(ui, 'drawer-footer', label) };
}

test('new schemes save parameters edited in the modal while the main settings stay unchanged', async t => {
  const state = initial(); state.manual.pelican = { prompt: 'main prompt', maxTokens: 321, timeoutMs: 120000, concurrency: 7 };
  const { ui, writes, input, action } = await presetEditor(t, state);
  const name = input('方案名称'); name.value = '独立编辑'; await name.fire('input');
  const timeout = input('方案生成超时'); timeout.value = '900'; await timeout.fire('input');
  const cap = input('方案输出上限'); cap.value = '0'; await cap.fire('input');
  const concurrency = input('方案每批并行数'); concurrency.value = '5'; await concurrency.fire('input');
  const prompt = input('方案动画提示词'); prompt.value = 'modal prompt'; await prompt.fire('input');
  await action('保存为新方案').fire('click');
  assert.deepEqual(writes[0], { name: '独立编辑', kind: 'pelican', parameters: { prompt: 'modal prompt', maxTokens: 0, timeoutMs: 900000, concurrency: 5 } });
  assert.equal(ui.elements.get('generation-timeout').value, '120'); assert.equal(ui.elements.get('max-tokens').value, '321'); assert.equal(ui.elements.get('concurrency').value, '7'); assert.equal(ui.elements.get('prompt').value, 'main prompt');
});

test('editing a saved scheme updates its name and parameters together and retains its model effort settings', async t => {
  const state = initial(); state.presets.push({ id: 'saved', name: '原方案', kind: 'candy', parameters: { maxTokens: 234, timeoutMs: 750000, concurrency: 4, effortByModel: { 'fixture/one': 'high' } } });
  const { ui, writes, input, action } = await presetEditor(t, state, { search: '?view=candy' });
  const pick = input('选择方案'); pick.value = 'saved'; await pick.fire('change');
  assert.equal(input('方案生成超时').value, '750'); assert.equal(input('方案输出上限').value, '234');
  const name = input('方案名称'); name.value = '修改方案'; await name.fire('input');
  const timeout = input('方案生成超时'); timeout.value = '0'; await timeout.fire('input');
  await action('保存修改').fire('click');
  assert.deepEqual(writes[0], { id: 'saved', name: '修改方案', kind: 'candy', parameters: { maxTokens: 234, timeoutMs: 0, concurrency: 4, effortByModel: { 'fixture/one': 'high' } } });
  assert.equal(ui.elements.get('generation-timeout').value, '600');
  await action('应用到测试').fire('click'); assert.equal(ui.elements.get('generation-timeout').value, '0'); assert.equal(ui.elements.get('max-tokens').value, '234');
});

test('scheme validation rejects bad modal inputs without mutating the main settings or saved scheme', async t => {
  const { ui, writes, input, action } = await presetEditor(t);
  const name = input('方案名称'); name.value = 'bad'; await name.fire('input');
  const timeout = input('方案生成超时'); timeout.value = '-1'; await timeout.fire('input');
  await action('保存为新方案').fire('click'); assert.equal(writes.length, 0); assert.equal(timeout.value, '-1'); assert.equal(ui.elements.get('generation-timeout').value, '600');
  assert.equal(timeout.getAttribute('aria-invalid'), 'true'); assert.ok(ui.descendants(ui.elements.get('drawer-content')).some(item => /生成超时需为 0/.test(item.textContent)));
});

test('saved millisecond timeouts round-trip through modal editing, application, generation and favorites', async t => {
  const state = initial(); state.presets.push({ id: 'saved', name: '毫秒超时', kind: 'candy', parameters: { maxTokens: 0, timeoutMs: 1001, concurrency: 1 } });
  const { ui, writes, input, action } = await presetEditor(t, state, { search: '?view=candy' });
  const pick = input('选择方案'); pick.value = 'saved'; await pick.fire('change');
  assert.equal(input('方案生成超时').value, '1.001');
  await action('保存修改').fire('click'); assert.equal(writes[0]?.parameters.timeoutMs, 1001);
  await action('应用到测试').fire('click'); assert.equal(ui.elements.get('generation-timeout').value, '1.001');
  await ui.elements.get('drawer-close').fire('click');

  let submitted, favorite;
  const another = await uiHarness({ bootstrap: { models: [{ id: 'fixture/one', name: 'one', provider: 'fixture', efforts: [] }], runs: [], defaultPrompt: 'animate', candyAvailable: true, favoritesAvailable: true, favorites: { enabled: false, favorites: [], plans: [] } }, search: '?view=candy', create: body => { submitted = body; return { runs: [] }; }, favorites: (_path, value) => { if (value) favorite = value; return { favorites: [], plans: [], enabled: false }; } });
  t.after(() => another.closeStream()); await waitFor(() => !another.elements.get('generate').disabled);
  const model = another.descendants(another.elements.get('model-list'), 'input')[0]; model.checked = true; await model.fire('change');
  another.elements.get('generation-timeout').value = '1.001'; await another.elements.get('generation-timeout').fire('input');
  await another.elements.get('generate').fire('click'); assert.equal(submitted?.timeoutMs, 1001);
  await another.elements.get('favorite-selected').fire('click'); assert.equal(favorite?.timeoutMs, 1001);
});

test('fingerprint schemes directly edit all request parameters and an existing model effort', async t => {
  const state = initial(); state.presets.push({ id: 'saved', name: '指纹方案', kind: 'fingerprint', parameters: { ...state.manual.fingerprint, effortByModel: { 'fixture/one': 'high' } } });
  const { ui, writes, input, action } = await presetEditor(t, state, { search: '?view=fingerprint' });
  const pick = input('选择方案'); pick.value = 'saved'; await pick.fire('change');
  for (const [label, value] of [['方案请求接口', 'responses'], ['方案服务档位', 'fast'], ['方案模型思考档位', 'low']]) { input(label).value = value; await input(label).fire('change'); }
  input('方案严格采样').checked = true; await input('方案严格采样').fire('change');
  input('方案生成超时').value = '2147483.647'; await input('方案生成超时').fire('input');
  await action('保存修改').fire('click');
  assert.deepEqual(writes[0].parameters, { maxTokens: 64000, timeoutMs: 2147483647, concurrency: 3, api: 'responses', serviceTier: 'fast', strict: true, effortByModel: { 'fixture/one': 'low' } });
  assert.equal(ui.elements.get('fp-api').value, 'auto'); assert.equal(ui.elements.get('fp-strict').checked, false);
});

test('model effort controls add and remove saved settings without selecting a test model', async t => {
  const { ui, writes, input, action } = await presetEditor(t);
  input('方案名称').value = '档位方案'; await input('方案名称').fire('input'); await action('添加模型思考档位').fire('click');
  input('方案模型思考档位').value = 'high'; await input('方案模型思考档位').fire('change'); await action('保存为新方案').fire('click');
  assert.deepEqual(writes[0].parameters.effortByModel, { 'fixture/one': 'high' }); assert.equal(ui.descendants(ui.elements.get('model-list'), 'input').some(item => item.checked), false);
  await action('移除此档位').fire('click'); await action('保存修改').fire('click'); assert.deepEqual(writes[1].parameters.effortByModel ?? {}, {}); assert.equal(find(ui, 'drawer-content', '方案档位模型'), undefined);
});

test('saved unavailable models retain their effort settings and duplicate model entries cannot overwrite the scheme', async t => {
  const state = initial(), effortByModel = { 'fixture/one': 'high', 'retired/model': 'former-effort' }; state.presets.push({ id: 'saved', name: '旧档位', kind: 'pelican', parameters: { ...state.manual.pelican, effortByModel } });
  const { ui, writes, input, action } = await presetEditor(t, state); input('选择方案').value = 'saved'; await input('选择方案').fire('change');
  await action('保存修改').fire('click'); assert.deepEqual(writes[0].parameters.effortByModel, effortByModel);
  const model = ui.descendants(ui.elements.get('drawer-content')).find(item => item.getAttribute('aria-label') === '方案档位模型' && item.value === 'retired/model'); assert.ok(model); model.value = 'fixture/one'; await model.fire('change');
  await action('保存修改').fire('click'); assert.equal(writes.length, 1); assert.ok(ui.descendants(ui.elements.get('drawer-content')).some(item => /同一模型只能设置一次/.test(item.textContent)));
});

test('a rejected scheme save retains edited inputs and can be corrected without changing main parameters', async t => {
  let rejected = true;
  const { ui, writes, input, action } = await presetEditor(t, initial(), { beforeSettings: ({ request }) => { if (request.body && rejected) throw Object.assign(new Error('模拟保存拒绝'), { status: 400 }); } });
  input('方案名称').value = '失败后保留'; await input('方案名称').fire('input'); input('方案每批并行数').value = '9'; await input('方案每批并行数').fire('input');
  await action('保存为新方案').fire('click'); assert.equal(writes.length, 0); assert.equal(input('方案每批并行数').value, '9'); assert.match(ui.descendants(ui.elements.get('drawer-content')).find(item => item.id === 'phase-preset-status').textContent, /模拟保存拒绝.*输入已保留/);
  assert.equal(action('保存为新方案').disabled, false); rejected = false;
  await action('保存为新方案').fire('click'); assert.equal(writes.length, 1); assert.equal(writes[0].parameters.concurrency, 9); assert.equal(ui.elements.get('concurrency').value, '2');
});

test('external scheme changes are reported before overwrite and the local draft remains available', async t => {
  const state = initial(); state.presets.push({ id: 'saved', name: '原方案', kind: 'pelican', parameters: state.manual.pelican });
  const { ui, writes, input, action } = await presetEditor(t, state); input('选择方案').value = 'saved'; await input('选择方案').fire('change');
  input('方案名称').value = '本页草稿'; await input('方案名称').fire('input'); state.presets[0].name = '其他页方案'; state.revision++;
  await action('保存修改').fire('click'); assert.equal(writes.length, 0); assert.equal(input('方案名称').value, '本页草稿');
  assert.ok(ui.descendants(ui.elements.get('drawer-content')).some(item => /其他页面修改/.test(item.textContent)));
});

test('discarding a draft can be canceled and a failed scheme read restores the selection to its matching fields', async t => {
  const state = initial(); state.presets = ['one', 'two'].map((id, index) => ({ id, name: id, kind: 'pelican', parameters: { ...state.manual.pelican, timeoutMs: (index + 1) * 1000 } }));
  let failed = false;
  const { ui, input, action } = await presetEditor(t, state, { beforeSettings: ({ request }) => { if (!request.body && failed) throw new Error('模拟读取失败'); } });
  const pick = input('选择方案'); pick.value = 'one'; await pick.fire('change'); input('方案名称').value = '未保存'; await input('方案名称').fire('input');
  pick.value = 'two'; let pending = pick.fire('change'); await waitFor(() => ui.elements.get('confirm-dialog').open); await ui.elements.get('confirm-cancel').fire('click'); await pending;
  assert.equal(pick.value, 'one'); assert.equal(input('方案名称').value, '未保存'); assert.equal(action('应用到测试').disabled, true);
  failed = true; pick.value = 'two'; pending = pick.fire('change'); await waitFor(() => ui.elements.get('confirm-dialog').open); await ui.elements.get('confirm-accept').fire('click'); await pending;
  assert.equal(pick.value, 'one'); assert.equal(input('方案名称').value, '未保存'); assert.equal(input('方案生成超时').value, '1');
  failed = false; pick.value = 'two'; pending = pick.fire('change'); await waitFor(() => ui.elements.get('confirm-dialog').open); await ui.elements.get('confirm-accept').fire('click'); await pending;
  assert.equal(pick.value, 'two'); assert.equal(input('方案生成超时').value, '2'); assert.equal(action('应用到测试').disabled, false);
});

test('closing an editor while applying a scheme is awaiting its read leaves main parameters unchanged', async t => {
  const state = initial(); state.presets.push({ id: 'saved', name: '迟到读取', kind: 'pelican', parameters: { ...state.manual.pelican, timeoutMs: 1000 } });
  let delayed = false, release;
  const { ui, input, action } = await presetEditor(t, state, { beforeSettings: ({ request }) => { if (!request.body && delayed) return new Promise(resolve => { release = resolve; }); } });
  input('选择方案').value = 'saved'; await input('选择方案').fire('change'); delayed = true;
  const pending = action('应用到测试').fire('click'); await waitFor(() => release); await ui.elements.get('drawer-close').fire('click'); release(); await pending;
  assert.equal(ui.elements.get('generation-timeout').value, '600'); assert.equal(ui.elements.get('favorite-drawer').hidden, true);
});

test('scheme buttons lock while a save is in flight and repeated clicks produce one write', async t => {
  let release;
  const { writes, input, action } = await presetEditor(t, initial(), { beforeSettings: ({ request }) => { if (request.body) return new Promise(resolve => { release = resolve; }); } });
  input('方案名称').value = '一次保存'; await input('方案名称').fire('input');
  const save = action('保存为新方案'), pending = save.fire('click'); await waitFor(() => release); assert.equal(save.disabled, true); assert.equal(input('方案名称').disabled, true);
  await save.fire('click'); assert.equal(writes.length, 0); release(); await pending; assert.equal(writes.length, 1); assert.equal(save.disabled, false);
});

test('a favorite created with a millisecond timeout stays editable without changing the saved timeout', async t => {
  const favorite = { id: 'favorite', modelId: 'fixture/one', modelName: 'one', provider: 'fixture', maxTokens: 10, timeoutMs: 1001, prompt: 'animate' }, state = { enabled: false, concurrency: 3, favorites: [favorite], plans: [] }; let submitted;
  const ui = await uiHarness({ bootstrap: { models: [{ id: 'fixture/one', name: 'one', provider: 'fixture', efforts: [] }], runs: [], defaultPrompt: 'animate', favoritesAvailable: true, favorites: state }, search: '?view=favorites', favorites: (_path, value) => { if (value) submitted = value; return state; } });
  t.after(() => ui.closeStream()); await waitFor(() => ui.elements.get('favorite-count').textContent === '1'); await ui.elements.get('favorite-manage').fire('click'); await find(ui, 'drawer-content', '编辑').fire('click');
  const tokens = ui.descendants(ui.elements.get('drawer-content'), 'label').find(row => row.children.some(item => item.textContent === '输出上限 · Token')).querySelector('input');
  tokens.value = '20'; await tokens.fire('input'); const done = find(ui, 'drawer-footer', '完成编辑'); assert.equal(done.disabled, false); await done.fire('click');
  await find(ui, 'drawer-footer', '保存设置').fire('click'); assert.equal(submitted.edits[0].timeoutMs, 1001); assert.equal(submitted.edits[0].maxTokens, 20);
});

test('record protection is an independent tool beside copy and still saves and reflects its state', async t => {
  let protectedValue = false, writes = 0;
  const run = record('protect', 'fixture/one', 'a', 0, 0);
  const ui = await uiHarness({ bootstrap: { models: [], runs: [run], defaultPrompt: 'animate', candyAvailable: true, annotationsAvailable: true }, search: '?view=candy', detail: () => ({ ...run, annotation: { runId: run.id, revision: writes, annotation: protectedValue ? { protected: true } : null } }), annotations: value => { writes++; protectedValue = value.protected; return { runId: run.id, revision: writes, annotation: { protected: protectedValue } }; } });
  t.after(() => ui.closeStream()); const open = await waitFor(() => find(ui, 'candy-results', '查看详情')); await open.fire('click');
  const protect = find(ui, 'drawer-tools', '保护此记录'); assert.ok(protect, 'Protection must be beside the copy tool'); assert.ok(find(ui, 'drawer-tools', '复制回答'));
  await protect.fire('click'); assert.equal(writes, 1); assert.equal(protect.getAttribute('aria-pressed'), 'true');
  await protect.fire('click'); assert.equal(writes, 2); assert.equal(protect.getAttribute('aria-pressed'), 'false');
});

test('finished details omit the old runtime accordion', async t => {
  const run = { ...record('progress', 'fixture/one', 'a', 0, 0), progress: advanceProgress(newProgress(), 'end', { at: '2026-11-23T01:00:01Z' }), elapsedMs: 1500 };
  const ui = await uiHarness({ bootstrap: { models: [], runs: [run], defaultPrompt: 'animate', candyAvailable: true }, search: '?view=candy', detail: () => run });
  t.after(() => ui.closeStream()); await (await waitFor(() => find(ui, 'candy-results', '查看详情'))).fire('click');
  assert.equal(ui.descendants(ui.elements.get('drawer-content'), 'summary').some(item => /运行明细/.test(item.textContent)), false);
  assert.equal(ui.timers.size, 0);
});
