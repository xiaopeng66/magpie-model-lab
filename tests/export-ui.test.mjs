import test from 'node:test';
import assert from 'node:assert/strict';
import { uiHarness } from './ui-harness.mjs';
import { waitFor } from './helpers.mjs';

const run = { id: 'one', batchId: 'batch', kind: 'candy', model: 'fixture/one', modelName: 'One', status: 'completed', createdAt: '2026-11-19T09:00:00Z', candy: { answer: 21, verdict: 'match' } };
const boot = records => ({ version: '1.0.3', defaultPrompt: 'fixture prompt', dataDir: 'fixture-dir', historyTimeZone: 'UTC', runs: records, models: [{ id: run.model, name: 'One', provider: 'fixture', efforts: [] }], candyAvailable: true, batchExport: true, favoritesAvailable: true, favorites: { favorites: [], plans: [], enabled: true } });
const button = (ui, id, name) => ui.descendants(ui.elements.get(id), 'button').find(control => control.textContent === name);
async function open(ui) { await waitFor(() => ui.descendants(ui.elements.get('model-list'), 'input').length); await ui.elements.get('history-tab').fire('click'); const control = ui.descendants(ui.elements.get('history-list'), 'button').find(control => control.dataset.icon === 'export'); await control.fire('click'); return button(ui, 'drawer-footer', '下载 JSON'); }

test('JSON download waits for a confirmed save and blocks repeated clicks while the picker is open', async t => {
  let release, calls = 0, sent;
  const pending = new Promise(resolve => { release = resolve; }); t.after(() => release({ cancelled: true }));
  const ui = await uiHarness({ bootstrap: boot([run]), exportBatch: () => ({ runs: [run] }), saveBatch: async (path, body) => { calls++; sent = { path, body }; return pending; } });
  const download = await open(ui), saving = download.fire('click');
  await waitFor(() => calls === 1); assert.equal(download.disabled, true); assert.equal(download.getAttribute('aria-busy'), 'true');
  assert.match(ui.elements.get('drawer-status').textContent, /保存位置/); await download.fire('click'); assert.equal(calls, 1);
  release({ path: 'C:/selected/saved.json' }); await saving;
  assert.deepEqual(sent, { path: 'api/batches/batch/save', body: {} }); assert.equal(download.disabled, false); assert.equal(download.getAttribute('aria-busy'), null);
  assert.match(ui.elements.get('drawer-status').textContent, /已保存.*saved\.json/);
});

test('cancelled or failed JSON saves leave content available and can retry', async () => {
  let calls = 0;
  const ui = await uiHarness({ bootstrap: boot([run]), exportBatch: () => ({ runs: [run] }), saveBatch: async () => { if (++calls === 1) return { cancelled: true }; if (calls === 2) throw new Error('磁盘无法写入'); return { path: 'C:/selected/retry.json' }; } });
  const download = await open(ui), source = ui.descendants(ui.elements.get('drawer-content'), 'textarea')[0];
  const content = source.value; await download.fire('click'); assert.match(ui.elements.get('drawer-status').textContent, /取消/); assert.equal(source.value, content);
  await download.fire('click'); assert.match(ui.elements.get('drawer-status').textContent, /无法写入/); assert.equal(download.disabled, false);
  await download.fire('click'); assert.match(ui.elements.get('drawer-status').textContent, /已保存/); assert.equal(source.value, content);
});

test('daily JSON saves send the selected group IDs and late outcomes cannot update a newer drawer', async t => {
  const automatic = { ...run, source: 'automatic', scheduledAt: run.createdAt }; let release, sent;
  const pending = new Promise(resolve => { release = resolve; }); t.after(() => release({ cancelled: true }));
  const ui = await uiHarness({ bootstrap: boot([automatic]), exportBatch: () => ({ runs: [automatic] }), saveBatch: async (path, body) => { sent = { path, body }; return pending; } });
  const download = await open(ui), saving = download.fire('click'); await waitFor(() => sent);
  assert.deepEqual(sent, { path: 'api/batches/save', body: { runIds: ['one'] } });
  await ui.elements.get('drawer-close').fire('click'); await ui.elements.get('favorites-tab').fire('click'); await ui.elements.get('favorite-manage').fire('click');
  const title = ui.elements.get('drawer-title').textContent;
  release({ path: 'C:/selected/old.json' }); await saving;
  assert.equal(ui.elements.get('drawer-title').textContent, title); assert.equal(ui.elements.get('drawer-status').hidden, true);
});
