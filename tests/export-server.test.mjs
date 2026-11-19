import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { temporary, fakeGateway, waitFor, FIXTURE_HTML } from './helpers.mjs';
import { RunStore } from '../lib/store.mjs';
import { startServer } from '../lib/server.mjs';
import { saveJSON } from '../lib/export.mjs';

const at = new Date().toISOString();
function run(kind = 'candy', extra = {}) { const id = randomUUID(); return { id, batchId: id, kind, model: 'fixture/one', modelName: 'One', status: 'completed', createdAt: at, content: '答案 21', reasoning: '完整推理', ...(kind === 'pelican' ? { html: FIXTURE_HTML } : kind === 'fingerprint' ? { samples: Array.from({ length: 3 }, () => ({ raw_text: '1', text: '1', state: 'complete' })), challenges: [{}, {}, {}] } : { candy: { answer: 21, verdict: 'match' } }), ...extra }; }
async function setup(t, records, saver, handler) {
  const dir = await temporary(t), store = new RunStore(dir); await store.init();
  for (const record of records) await store.save(record);
  const upstream = await fakeGateway(t, handler);
  const service = await startServer({ port: 0, dataDir: dir, gatewayUrl: upstream.url, saveExport: saver }); t.after(() => service.close()); await service.ready;
  const html = await (await fetch(service.url)).text(), token = /name="pelican-token" content="([a-f0-9]+)"/.exec(html)[1];
  const headers = { 'content-type': 'application/json', 'x-pelican-token': token, origin: 'null' };
  return { dir, service, upstream, headers, save: (path, body = {}) => fetch(service.url + path, { method: 'POST', headers, body: JSON.stringify(body) }) };
}
function nativeWriter(path) { return (data, filename, options) => saveJSON(data, filename, { ...options, platform: 'win32', launch: () => { const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {}; queueMicrotask(() => { child.stdout.end(path); child.emit('close', 0); }); return child; } }); }

test('authenticated manual saves write each result type, exclude preview capabilities and ignore client paths', async t => {
  const records = ['candy', 'pelican', 'fingerprint'].map(kind => run(kind)), selected = await temporary(t), calls = [];
  const { service, headers, upstream, save } = await setup(t, records, async (data, filename, options) => { calls.push(filename); return nativeWriter(join(selected, filename))(data, filename, options); });
  for (const record of records) {
    const path = `api/batches/${record.batchId}/save`;
    assert.equal((await fetch(service.url + path, { method: 'POST', body: '{}' })).status, 403);
    assert.equal((await fetch(service.url + path, { method: 'POST', headers: { ...headers, origin: 'https://evil.example' }, body: '{}' })).status, 403);
    assert.equal(calls.length, records.indexOf(record));
    const response = await save(path, { path: 'C:/Windows/ignored.json', content: 'forged' }); assert.equal(response.status, 200);
    const result = await response.json(), data = JSON.parse(await readFile(result.path, 'utf8'));
    assert.equal(data.schema, 'pelican-batch-v1'); assert.equal(data.batchId, record.batchId); assert.equal(data.runs.length, 1); assert.equal(data.runs[0].id, record.id);
    assert.equal(data.runs[0].previewKey, undefined); assert.equal(data.runs[0].content, '答案 21');
    assert.match(calls.at(-1), new RegExp(`^magpie-model-lab-\\d{4}-\\d{2}-\\d{2}-${record.kind}-[a-f0-9]{8}\\.json$`));
  }
  assert.equal(upstream.seen.requests.length, 0);
});

test('automatic daily saves validate complete model groups and retain each model result', async t => {
  const records = [run('candy', { source: 'automatic', scheduledAt: at }), run('candy', { source: 'automatic', scheduledAt: at, model: 'fixture/two' })], calls = [];
  const { save, upstream } = await setup(t, records, async data => { calls.push(data); return { cancelled: true }; });
  const response = await save('api/batches/save', { runIds: records.map(record => record.id) }); assert.equal(response.status, 200); assert.deepEqual(await response.json(), { cancelled: true });
  assert.equal(calls[0].source, 'automatic'); assert.deepEqual(calls[0].runs.map(record => record.id).sort(), records.map(record => record.id).sort());
  assert.equal((await save('api/batches/save', { runIds: ['missing'] })).status, 400);
  assert.equal(calls.length, 1); assert.equal(upstream.seen.requests.length, 0);
});

test('one pending native save blocks duplicate windows and failed or cancelled saves can be retried', async t => {
  const record = run(); let release, count = 0;
  const pending = new Promise(resolve => { release = resolve; }); t.after(() => release({ cancelled: true }));
  const { save, service, headers } = await setup(t, [record], async () => { count++; if (count === 1) return pending; if (count === 2) throw Object.assign(new Error('无法写入 JSON'), { status: 502 }); return { cancelled: true }; });
  const path = `api/batches/${record.batchId}/save`, first = save(path);
  await waitFor(() => count === 1); const duplicate = await save(path); assert.equal(duplicate.status, 409); assert.equal(count, 1);
  release({ cancelled: true }); assert.deepEqual(await (await first).json(), { cancelled: true });
  const failure = await save(path); assert.equal(failure.status, 502); assert.match((await failure.json()).error, /写入/);
  assert.deepEqual(await (await save(path)).json(), { cancelled: true });
  assert.deepEqual((await (await fetch(service.url + 'api/runs', { headers })).json()).runs.map(record => record.id), [record.id]);
});

test('in-flight or nonexistent manual batches never open the native picker', async t => {
  let release, saves = 0; const pending = new Promise(resolve => { release = resolve; });
  const { save, service, headers, upstream } = await setup(t, [], async () => { saves++; return { cancelled: true }; }, async ({ complete }) => { await pending; complete(); });
  const { runs } = await (await save('api/runs', { prompt: 'fixture', models: [{ id: 'fixture/one' }] })).json();
  try {
    assert.equal((await save(`api/batches/${runs[0].batchId}/save`)).status, 409);
    assert.equal((await save(`api/batches/${randomUUID()}/save`)).status, 404); assert.equal(saves, 0);
  } finally {
    release();
    // The gateway can still be idle before the queued request starts; wait for its persisted result.
    await waitFor(async () => {
      const result = await (await fetch(service.url + `api/runs/${runs[0].id}`, { headers })).json();
      return result.status === 'completed' && upstream.seen.active === 0;
    });
  }
});
