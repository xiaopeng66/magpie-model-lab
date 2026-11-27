import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { RunStore } from '../lib/store.mjs';
import { StateFile } from '../lib/state-file.mjs';
import { temporary } from './helpers.mjs';

test('malformed private state does not echo file contents in recovery feedback', async t => {
  const root = await temporary(t), file = new StateFile(root, '.settings', {}, () => {});
  await file.init(); await fs.writeFile(file.path, 'private-note-fragment'); await file.init();
  assert.match(file.recoveryError, /UTF-8 JSON/); assert.ok(!file.recoveryError.includes('private-note'));
  assert.equal(await fs.readFile(file.path, 'utf8'), 'private-note-fragment'); await file.close();
});

// RYP: inject only the OS rename failure; retain the real writes, reads and cleanup.
function rejectReplacement(t, path, failures, code) {
  const original = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to === path && failures-- > 0) throw Object.assign(new Error('replacement rejected'), { code });
    return original(from, to);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}

test('Windows transient rename rejection still commits complete metadata and removes its temporary file', { skip: process.platform !== 'win32' }, async t => {
  const dir = await temporary(t), path = join(dir, 'run.json'), store = new RunStore(dir);
  await fs.writeFile(path, 'old metadata');
  rejectReplacement(t, path, 2, 'EPERM');
  await store.atomic(path, 'complete new metadata');
  assert.equal(await fs.readFile(path, 'utf8'), 'complete new metadata');
  assert.deepEqual(await fs.readdir(dir), ['run.json']);
});

test('Windows persistent rename rejection preserves old metadata and cleans up within a bounded wait', { skip: process.platform !== 'win32', timeout: 2000 }, async t => {
  const dir = await temporary(t), path = join(dir, 'run.json'), store = new RunStore(dir);
  await fs.writeFile(path, 'old metadata');
  rejectReplacement(t, path, Infinity, 'EPERM');
  await assert.rejects(store.atomic(path, 'uncommitted metadata'), { code: 'EPERM' });
  assert.equal(await fs.readFile(path, 'utf8'), 'old metadata');
  assert.deepEqual(await fs.readdir(dir), ['run.json']);
});

test('nontransient rename errors preserve old metadata without retrying a failed write', async t => {
  const dir = await temporary(t), path = join(dir, 'run.json'), store = new RunStore(dir);
  await fs.writeFile(path, 'old metadata');
  rejectReplacement(t, path, 1, 'ENOSPC');
  await assert.rejects(store.atomic(path, 'uncommitted metadata'), { code: 'ENOSPC' });
  assert.equal(await fs.readFile(path, 'utf8'), 'old metadata');
  assert.deepEqual(await fs.readdir(dir), ['run.json']);
});

async function privateState(t) {
  const dir = await temporary(t), initial = { schema: 1, revision: 0, value: 'old settings' };
  const state = new StateFile(dir, '.settings', initial, value => assert.equal(value.schema, 1));
  await state.init(); t.after(() => state.close());
  const backup = join(state.dir, 'state.previous.json'); await state.replace(backup, initial);
  return { state, initial, backup };
}

for (const stage of [1, 2]) test(`private-state replacement preserves an external edit during ${stage === 1 ? 'backup' : 'primary'} file sync`, async t => {
  const { state, initial, backup } = await privateState(t), external = { schema: 1, revision: 2, value: 'external protection must survive' };
  const bytes = JSON.stringify(external), probe = await fs.open(state.path, 'r');
  const handlePrototype = Object.getPrototypeOf(probe), originalSync = handlePrototype.sync;
  await probe.close(); let syncedFiles = 0, injected = false;
  // RYP: Bun does not rebind named fs imports; intercept the real shared handle sync instead.
  t.mock.method(handlePrototype, 'sync', async function (...args) {
    await originalSync.apply(this, args);
    if (++syncedFiles === stage) { await fs.writeFile(state.path, bytes); injected = true; }
  });
  t.after(() => t.mock.restoreAll());
  await assert.rejects(state.enqueue(() => state.commit({ schema: 1, revision: 1, value: 'stale local update' })), error => error.status === 409);
  assert.equal(injected, true); assert.equal(await fs.readFile(state.path, 'utf8'), bytes);
  assert.deepEqual(state.snapshot(), initial); assert.ok(state.recoveryError);
  assert.deepEqual(JSON.parse(await fs.readFile(backup, 'utf8')), initial);
  assert.deepEqual((await fs.readdir(state.dir)).sort(), ['state.json', 'state.previous.json']);
});

test('Windows private-state retry rechecks external changes after a sharing failure', { skip: process.platform !== 'win32' }, async t => {
  const { state, initial } = await privateState(t), bytes = JSON.stringify({ schema: 1, revision: 2, value: 'changed during retry' });
  const originalRename = fs.rename; let primaryAttempts = 0;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to === state.path && ++primaryAttempts === 1) {
      await fs.writeFile(state.path, bytes); throw Object.assign(new Error('sharing violation'), { code: 'EPERM' });
    }
    return originalRename(from, to);
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(state.enqueue(() => state.commit({ schema: 1, revision: 1, value: 'stale local update' })), error => error.status === 409);
  assert.equal(primaryAttempts, 1); assert.equal(await fs.readFile(state.path, 'utf8'), bytes);
  assert.deepEqual(state.snapshot(), initial); assert.ok(state.recoveryError);
});

test('Windows transient private-state backup rejection still commits the acknowledged settings', { skip: process.platform !== 'win32' }, async t => {
  const { state, initial, backup } = await privateState(t);
  rejectReplacement(t, backup, 2, 'EPERM'); const next = { schema: 1, revision: 1, value: 'new settings' };
  await state.enqueue(() => state.commit(next));
  assert.deepEqual(JSON.parse(await fs.readFile(state.path, 'utf8')), next);
  assert.deepEqual(JSON.parse(await fs.readFile(backup, 'utf8')), initial);
  assert.deepEqual(state.snapshot(), next); assert.equal(state.recoveryError, '');
  assert.deepEqual((await fs.readdir(state.dir)).sort(), ['state.json', 'state.previous.json']);
});

test('Windows persistent private-state rejection preserves both versions and pauses later writes', { skip: process.platform !== 'win32', timeout: 2000 }, async t => {
  const { state, initial, backup } = await privateState(t);
  rejectReplacement(t, backup, Infinity, 'EPERM');
  await assert.rejects(state.enqueue(() => state.commit({ schema: 1, revision: 1, value: 'not saved' })), error => error.status === 503);
  assert.deepEqual(JSON.parse(await fs.readFile(state.path, 'utf8')), initial);
  assert.deepEqual(JSON.parse(await fs.readFile(backup, 'utf8')), initial);
  await assert.rejects(state.enqueue(() => state.commit(initial)), error => error.status === 503);
  assert.deepEqual((await fs.readdir(state.dir)).sort(), ['state.json', 'state.previous.json']);
});

test('a nontransient private-state replacement error cannot retry past a failed write', async t => {
  const { state, initial, backup } = await privateState(t);
  rejectReplacement(t, backup, 1, 'ENOSPC');
  await assert.rejects(state.enqueue(() => state.commit({ schema: 1, revision: 1, value: 'not saved' })), error => error.status === 503);
  assert.deepEqual(JSON.parse(await fs.readFile(state.path, 'utf8')), initial);
  assert.deepEqual(state.snapshot(), initial);
  assert.deepEqual((await fs.readdir(state.dir)).sort(), ['state.json', 'state.previous.json']);
});
