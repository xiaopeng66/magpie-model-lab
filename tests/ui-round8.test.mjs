import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Annotations } from '../lib/annotations.mjs';
import { originalConditions } from '../lib/retest.mjs';
import { RunStore } from '../lib/store.mjs';
import { parameterDefaults } from '../lib/test-parameters.mjs';
import { temporary, fakeGateway, startTestServer, waitFor } from './helpers.mjs';
import { uiHarness } from './ui-harness.mjs';

test('obsolete history tools cannot read records or open a native save dialog', async t => {
  const dir = await temporary(t), upstream = await fakeGateway(t); let saves = 0;
  const save = async () => { saves++; return { cancelled: true }; };
  const service = await startTestServer({ port: 0, dataDir: dir, gatewayUrl: upstream.url, saveExport: save });
  t.after(() => service.close());
  const page = await (await fetch(service.url)).text();
  const headers = { 'x-pelican-token': page.match(/name="pelican-token" content="([^"]+)"/)[1], 'content-type': 'application/json' };
  for (const path of ['api/reports/export', 'api/reports/save', 'api/history/backup/save', 'api/history/restore-protection/preview', 'api/history/restore-protection/apply']) {
    const response = await fetch(service.url + path, { method: 'POST', headers, body: '{}' });
    assert.equal(response.status, 404, path);
  }
  const config = await fetch(service.url + 'api/config/save', { method: 'POST', headers, body: '{"shareMode":true}' });
  assert.equal(config.status, 200); assert.equal((await config.json()).cancelled, true);
  assert.equal(saves, 1, 'Only the retained configuration save may invoke the picker');
  assert.equal(upstream.seen.requests.length, 0);
});

test('legacy protection is readable without rewriting files and uses the ordinary protection switch', async t => {
  const dir = await temporary(t), id = randomUUID(); await mkdir(join(dir, '.annotations'));
  const oldState = JSON.stringify({ schema: 2, revision: 4, byRunId: { [id]: { protected: false, restoreProtection: true, revision: 2, note: '原备注', tags: ['保留'], updatedAt: '2026-11-22T00:00:00Z' } } });
  const statePath = join(dir, '.annotations/state.json'); await writeFile(statePath, oldState);
  const annotations = new Annotations(dir); await annotations.init(); t.after(() => annotations.close());
  assert.equal(annotations.isProtected(id), true);
  assert.equal(annotations.detail(id).annotation.protected, true);
  assert.equal(annotations.projection([id]).byRunId[id].protected, true);
  assert.equal(await readFile(statePath, 'utf8'), oldState);
  await annotations.save({ runId: id, expectedRunRevision: 2, note: '修改备注' });
  assert.equal(annotations.isProtected(id), true, 'Editing a note must not remove old protection');
  const cleared = await annotations.save({ runId: id, expectedRunRevision: 3, protected: false });
  assert.equal(annotations.isProtected(id), false); assert.equal(cleared.annotation.protected, false);
  assert.equal(cleared.annotation.note, '修改备注'); assert.deepEqual(cleared.annotation.tags, ['保留']);
  assert.equal(Object.hasOwn(JSON.parse(await readFile(statePath, 'utf8')).byRunId[id], 'restoreProtection'), false, 'An explicit ordinary protection change retires its old marker');
  await annotations.close(); const reopened = new Annotations(dir); await reopened.init(); t.after(() => reopened.close());
  assert.equal(reopened.isProtected(id), false);
});

test('ordinary annotation records reopen and save without the retired protection marker', async t => {
  const dir = await temporary(t), id = randomUUID(); await mkdir(join(dir, '.annotations'));
  const path = join(dir, '.annotations/state.json');
  await writeFile(path, JSON.stringify({ schema: 2, revision: 1, byRunId: { [id]: { protected: true, revision: 1, note: '普通注释', tags: [], updatedAt: '2026-11-23T00:00:00Z' } } }));
  const annotations = new Annotations(dir); await annotations.init(); t.after(() => annotations.close());
  assert.equal(annotations.recoveryError, ''); assert.equal(annotations.isProtected(id), true);
  await annotations.save({ runId: id, expectedRunRevision: 1, note: '修改普通注释' });
  const saved = JSON.parse(await readFile(path, 'utf8')); assert.equal(Object.hasOwn(saved.byRunId[id], 'restoreProtection'), false);
  await annotations.close(); const reopened = new Annotations(dir); await reopened.init(); t.after(() => reopened.close());
  assert.equal(reopened.recoveryError, ''); assert.equal(reopened.detail(id).annotation.note, '修改普通注释'); assert.equal(reopened.isProtected(id), true);
});

test('retest validates current original conditions instead of a retired restore-time availability flag', () => {
  const run = { kind: 'pelican', model: 'fixture/one', createdAt: '2026-11-22T00:00:00Z', prompt: 'Animate a pelican', maxTokens: 1000, concurrency: 1, timeoutMs: 600000,
    restoreDependencies: { retestAvailable: false, reason: '旧迁移时的资源检查' } };
  const model = { id: 'fixture/one', provider: 'fixture', efforts: [] };
  const conditions = originalConditions(run, model);
  assert.equal(conditions.model, 'fixture/one'); assert.equal(conditions.prompt, 'Animate a pelican'); assert.equal(conditions.timeoutMs, 600000);
  assert.throws(() => originalConditions({ ...run, maxTokens: undefined }, model), /输出上限/);
  assert.throws(() => originalConditions(run, undefined), /原模型/);
});

test('startup and batch cleanup retain old protected history until an explicit ordinary unprotect', async t => {
  const dir = await temporary(t), id = randomUUID(), store = new RunStore(dir); await store.init();
  await store.save({ id, kind: 'candy', model: 'fixture/one', status: 'completed', createdAt: '2020-01-01T00:00:00Z', finishedAt: '2020-01-01T00:01:00Z', content: '最终答案：21', prompt: '原糖果题', effort: '', maxTokens: 0, timeoutMs: 0, concurrency: 1 });
  await mkdir(join(dir, '.annotations')); await writeFile(join(dir, '.annotations/state.json'), JSON.stringify({ schema: 2, revision: 1, byRunId: { [id]: { protected: false, restoreProtection: true, revision: 1, note: '', tags: [], updatedAt: '2020-01-01T00:00:00Z' } } }));
  const upstream = await fakeGateway(t), service = await startTestServer({ port: 0, dataDir: dir, gatewayUrl: upstream.url }); t.after(() => service.close());
  const page = await (await fetch(service.url)).text(), headers = { 'x-pelican-token': page.match(/name="pelican-token" content="([^"]+)"/)[1], 'content-type': 'application/json' };
  const call = async (path, input) => { const response = await fetch(service.url + path, { method: input ? 'POST' : 'GET', headers, ...(input ? { body: JSON.stringify(input) } : {}) }); assert.equal(response.status, 200, path); return response.json(); };
  const boot = await call('api/bootstrap'); assert.equal(boot.runs.length, 1); assert.equal(boot.annotations.byRunId[id].protected, true);
  const skipped = await call('api/runs/cleanup', { mode: 'all' }); assert.equal(skipped.removed.length, 0); assert.equal(skipped.skippedProtected, 1);
  await call('api/runs/annotations', { runId: id, expectedRunRevision: 1, protected: false });
  const removed = await call('api/runs/cleanup', { mode: 'all' }); assert.deepEqual(removed.removed, [id]);
});

test('normal local settings show only adjustable runtime controls while saved parameters still restore by mode', async t => {
  const state = { revision: 0, manual: Object.fromEntries(['pelican', 'candy', 'fingerprint'].map(kind => [kind, parameterDefaults(kind, 'animate')])), retention: { days: 7 }, progressNotice: { enabled: true }, presets: [] };
  state.manual.candy.timeoutMs = 123000;
  const ui = await uiHarness({ bootstrap: { models: [], runs: [], defaultPrompt: 'animate', settings: state, settingsCapabilities: { memory: true, progressNotice: true } } });
  t.after(() => ui.closeStream()); await waitFor(() => !ui.elements.get('generate').disabled);
  await ui.elements.get('local-settings').fire('click');
  const visibleGroups = ui.descendants(ui.elements.get('drawer-content'), 'section').filter(element => element.getClientRects().length);
  assert.equal(visibleGroups.length, 1, 'Normal runtime settings must not display a second explanation-only card');
  const notice = ui.descendants(visibleGroups[0], 'input').find(input => input.type === 'checkbox'); assert.ok(notice);
  await ui.elements.get('drawer-close').fire('click'); await ui.elements.get('candy-tab').fire('click');
  assert.equal(ui.elements.get('generation-timeout').value, '123');
});

const settingsState = () => ({ revision: 0, manual: Object.fromEntries(['pelican', 'candy', 'fingerprint'].map(kind => [kind, parameterDefaults(kind, 'animate')])), retention: { days: 7 }, progressNotice: { enabled: true }, presets: [] });
const recoveryPanel = ui => ui.descendants(ui.elements.get('drawer-content'), 'section').find(section => section.children.some(child => child.textContent === '参数保存异常'));
const control = (ui, label) => ui.descendants(ui.elements.get('drawer-content'), 'button').find(element => element.textContent === label);
async function editTimeout(ui, value) {
  const before = new Set(ui.timers.keys()); ui.elements.get('generation-timeout').value = value; await ui.elements.get('generation-timeout').fire('input');
  const debounce = [...ui.timers.keys()].find(id => !before.has(id)); if (debounce) ui.runTimer(debounce);
}

test('parameter failure shows the actual reason and retry saves the latest draft then hides recovery actions', async t => {
  let writes = 0, last; const state = settingsState();
  const ui = await uiHarness({ bootstrap: { models: [], runs: [], defaultPrompt: 'animate', settings: state, settingsCapabilities: { memory: true, progressNotice: true } }, settings: async (path, options) => {
    if (path === 'api/settings') return { settings: state };
    last = JSON.parse(options.body); if (++writes === 1) throw Object.assign(Error('磁盘暂时无法写入'), { status: 503 });
    return { revision: 1, changed: last.patch };
  } }); t.after(() => ui.closeStream()); await waitFor(() => !ui.elements.get('generate').disabled);
  await editTimeout(ui, '123'); await waitFor(() => ui.elements.get('settings-save-status').dataset.error === 'true');
  await ui.elements.get('local-settings').fire('click'); const recovery = recoveryPanel(ui);
  assert.equal(recovery.hidden, false); assert.ok(ui.descendants(recovery).some(element => element.textContent.includes('磁盘暂时无法写入')));
  await editTimeout(ui, '124'); await control(ui, '重试保存').fire('click');
  await waitFor(() => recovery.hidden); assert.equal(last.patch.manual.pelican.timeoutMs, 124000); assert.equal(writes, 2);
  assert.equal(ui.elements.get('generation-timeout').value, '124');
});

for (const source of ['local', 'server']) test(`parameter conflict exposes actionable source selection: ${source}`, async t => {
  let writes = 0, last; const local = settingsState(), remote = settingsState(); remote.revision = 1; remote.manual.pelican.timeoutMs = 111000;
  const ui = await uiHarness({ bootstrap: { models: [], runs: [], defaultPrompt: 'animate', settings: local, settingsCapabilities: { memory: true, progressNotice: true } }, settings: async (path, options) => {
    if (path === 'api/settings') return { settings: remote };
    last = JSON.parse(options.body); if (++writes === 1) throw Object.assign(Error('设置发生冲突'), { status: 409 });
    return { revision: 2, changed: last.patch };
  } }); t.after(() => ui.closeStream()); await waitFor(() => !ui.elements.get('generate').disabled);
  await editTimeout(ui, '123'); await waitFor(() => ui.elements.get('settings-save-status').dataset.error === 'true');
  await ui.elements.get('local-settings').fire('click'); const recovery = recoveryPanel(ui);
  assert.equal(control(ui, '重试保存').hidden, true); assert.equal(control(ui, '使用本地草稿保存').hidden, false); assert.equal(control(ui, '使用服务器参数').hidden, false);
  await control(ui, source === 'local' ? '使用本地草稿保存' : '使用服务器参数').fire('click');
  await waitFor(() => recovery.hidden); assert.equal(writes, source === 'local' ? 2 : 1);
  assert.equal(ui.elements.get('generation-timeout').value, source === 'local' ? '123' : '111');
});

test('damaged settings display the repair reason and do not offer an ineffective retry', async t => {
  const ui = await uiHarness({ bootstrap: { models: [], runs: [], defaultPrompt: 'animate', settings: settingsState(), settingsError: '记录设置文件损坏；修复后重新启用插件', settingsCapabilities: { memory: true, progressNotice: true } } });
  t.after(() => ui.closeStream()); await waitFor(() => !ui.elements.get('generate').disabled);
  await ui.elements.get('local-settings').fire('click'); assert.equal(recoveryPanel(ui).hidden, false);
  assert.equal(control(ui, '重试保存').hidden, true); assert.equal(ui.elements.get('settings-retry').disabled, true);
  const notice = ui.descendants(ui.elements.get('drawer-content'), 'input').find(input => input.getAttribute('aria-label') === '长时间无响应时提醒'); assert.equal(notice.disabled, true);
});
