import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { enhancementSetup } from './enhancement-helpers.mjs';
import { waitFor } from './helpers.mjs';
import { DEFAULT_QUEUE } from '../lib/queue-policy.mjs';

for (const kind of ['pelican', 'candy', 'fingerprint']) for (const scope of ['run', 'batch', 'shutdown']) {
  test(`${kind} ${scope} cancellation settles a request whose policy change is still being saved for readmission`, async t => {
    const bank = { load: async () => ({ meta: { sha256: 'a'.repeat(64), builtAt: 'test', sdkVersion: '0.2.0' }, detector: { analyze() { throw new Error('A cancelled sample must never be scored'); } } }), close: async () => {} };
    const { runner, settings, store, seen, dir } = await enhancementSetup(t, { runnerOptions: { bank } });
    let changed = false, entered = false, release;
    const gate = new Promise(resolve => { release = resolve; }), start = runner.usage.start.bind(runner.usage), save = store.save.bind(store);
    // Change the real admission policy after reservation, before the physical fetch.
    t.mock.method(runner.usage, 'start', async (...args) => {
      const result = await start(...args);
      if (!changed) {
        changed = true;
        await settings.save({ expectedRevision: settings.snapshot().revision, patch: { queue: { ...structuredClone(DEFAULT_QUEUE), providerConcurrency: 2 } } });
      }
      return result;
    });
    t.mock.method(store, 'save', async run => {
      if (!entered && run.physicalRequests?.some(request => request.state === 'released')) { entered = true; await gate; }
      return save(run);
    });
    const [run] = await runner.submit({ kind, prompt: 'test cancellation', concurrency: 1, targets: [{ modelId: 'fixture/one' }] });
    let cancelling;
    try {
      await waitFor(() => entered);
      cancelling = scope === 'shutdown' ? runner.close() : scope === 'batch' ? runner.cancelBatch(run.batchId) : runner.cancel(run.id);
    } finally { release(); }
    const result = await cancelling;
    const expectedStatus = scope === 'shutdown' ? 'interrupted' : 'cancelled';
    assert.equal((scope === 'shutdown' ? runner.get(run.id) : scope === 'batch' ? result[0] : result).status, expectedStatus, 'Cancellation cannot return while readmission has left the run queued or running');
    await waitFor(() => !runner.pumping && !runner.busy(run.id));
    assert.equal(runner.get(run.id).status, expectedStatus);
    assert.equal(runner.queue.some(key => runner.queuedId(key) === run.id), false);
    assert.equal(runner.payloads.has(run.id), false);
    const disk = JSON.parse(await readFile(join(dir, run.id, 'run.json'), 'utf8'));
    assert.equal(disk.status, expectedStatus); assert.equal(disk.progress.phase, 'ended');
    if (kind === 'fingerprint') assert.ok(disk.samples.every(sample => sample.state === 'cancelled' && sample.progress.phase === 'ended'));
    assert.equal(seen.length, 0, 'A cancelled readmission must never become another physical request');
    assert.equal(runner.usage.summary().knownRequests, 0);
  });
}
