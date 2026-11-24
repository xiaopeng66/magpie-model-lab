import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RunStore } from '../lib/store.mjs';
import { enhancementSetup } from './enhancement-helpers.mjs';
import { temporary, fakeGateway, startTestServer, waitFor } from './helpers.mjs';
import { numberReply } from './fingerprint-helpers.mjs';

test('retired random question ordering is rejected before saving or generating any run', async t => {
  const { runner, store, seen } = await enhancementSetup(t);
  await assert.rejects(runner.submit({ kind: 'candy', suite: { id: 'shape-choice', version: '1', seed: 7 }, targets: [{ modelId: 'fixture/one' }] }), error => error.status === 400);
  assert.equal(store.records.size, 0);
  assert.equal(runner.list().length, 0);
  assert.equal(seen.length, 0);
});

test('malformed physical request metadata is rejected before any new run files are written', async t => {
  const store = new RunStore(await temporary(t)); await store.init();
  for (const physicalRequests of [{}, [null], [3], [{}], [{ state: 'started', admissionPolicyHash: {} }]]) {
    const run = { id: randomUUID(), kind: 'candy', model: 'fixture/one', status: 'completed', createdAt: new Date().toISOString(), content: '最终答案：21', physicalRequests };
    await assert.rejects(store.save(run), error => error.status === 400);
    await assert.rejects(access(store.path(run.id)), error => error.code === 'ENOENT');
  }
  assert.equal(store.records.size, 0);
});

test('a later damaged physical request list gives a readable detail error and retains the healthy history index', async t => {
  const dir = await temporary(t), store = new RunStore(dir); await store.init();
  const run = await store.save({ id: randomUUID(), kind: 'candy', model: 'fixture/one', status: 'completed', createdAt: new Date().toISOString(), content: '最终答案：21', physicalRequests: [{ state: 'started' }] });
  const upstream = await fakeGateway(t), service = await startTestServer({ port: 0, dataDir: dir, gatewayUrl: upstream.url }); t.after(() => service.close());
  const token = (await (await fetch(service.url)).text()).match(/name="pelican-token" content="([a-f0-9]+)"/)[1];
  const headers = { 'x-pelican-token': token }, path = join(dir, run.id, 'run.json');
  for (const physicalRequests of [{}, [null], [{ state: 'broken' }], [{ state: 'started', startedAt: 'not-a-time' }]]) {
    const damaged = JSON.stringify({ ...run, physicalRequests }); await writeFile(path, damaged);
    const response = await fetch(service.url + 'api/runs/' + run.id, { headers });
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /记录无效/);
    assert.deepEqual((await (await fetch(service.url + 'api/runs', { headers })).json()).runs.map(item => item.id), [run.id]);
    assert.equal(await readFile(path, 'utf8'), damaged);
  }
  assert.equal(upstream.seen.requests.length, 0);
});

test('fingerprint admission storage failure ends only that sample and drains sibling samples normally', async t => {
  const bank = { async load() { return { meta: { sha256: 'a'.repeat(64), sdkVersion: '0.2.0' }, detector: { analyze() { return {}; } } }; }, async close() {} };
  const { runner, seen } = await enhancementSetup(t, { runnerOptions: { bank }, handler: async ({ complete }) => { await new Promise(resolve => setTimeout(resolve, 80)); complete(numberReply()); } });
  const reserve = runner.usage.reserve.bind(runner.usage); let admissions = 0;
  runner.usage.reserve = async input => {
    if (++admissions === 2) { await waitFor(() => seen.length === 1); throw Error('fixture usage ledger write failed'); }
    return reserve(input);
  };
  const [created] = await runner.submit({ kind: 'fingerprint', strict: true, concurrency: 3, targets: [{ modelId: 'fixture/one' }] });
  await waitFor(() => !runner.busy(created.id) && !runner.queue.length && !['queued', 'running'].includes(runner.get(created.id).status)).catch(error => {
    const current = runner.get(created.id);
    error.message += '\n' + JSON.stringify({ requests: seen.length, admissions, queued: runner.queue, active: [...runner.active.keys()], status: current.status, error: current.error, samples: current.samples.map(sample => ({ state: sample.state, phase: sample.progress.phase, error: sample.error })) });
    throw error;
  });
  const run = await runner.read(created.id);
  assert.equal(run.status, 'error');
  assert.ok(run.samples.every(sample => sample.progress.phase === 'ended'));
  assert.equal(run.samples[1].state, 'failed');
  assert.equal(run.samples[1].failureKind, 'usage_storage');
  assert.match(run.samples[1].error, /usage ledger write failed/);
  assert.equal(run.samples.filter(sample => ['complete', 'truncated'].includes(sample.state)).length, 2);
  assert.equal(seen.length, 2);
  assert.equal(runner.usage.summary().knownRequests, 2);
});
