import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ConfigTransfer, configDigest } from '../lib/config-transfer.mjs';
import { StateFile } from '../lib/state-file.mjs';
import { acquireDataOwner } from '../lib/data-owner.mjs';
import { fakeGateway, startTestServer, temporary, waitFor } from './helpers.mjs';

async function setup(t) {
  const dir = await temporary(t), upstream = await fakeGateway(t);
  const service = await startTestServer({ port: 0, dataDir: dir, gatewayUrl: upstream.url });
  t.after(() => service.close());
  const html = await (await fetch(service.url)).text();
  const headers = { 'x-pelican-token': html.match(/name="pelican-token" content="([^"]+)"/)[1], 'content-type': 'application/json' };
  const post = (path, body) => fetch(service.url + 'api/' + path, { method: 'POST', headers, body: JSON.stringify(body) });
  return { dir, upstream, service, headers, post };
}

test('shutdown retains ownership until an accepted configuration import finishes its two-file transaction', async t => {
  const { dir, upstream, service, post } = await setup(t);
  const document = await (await post('config/export', {})).json();
  document.payload.settings.progressNotice.enabled = false;
  document.digest = configDigest(document.payload);
  const preview = await (await post('config/import/preview', { document, choices: { settings: { progressNotice: 'overwrite' } } })).json();
  assert.ok(preview.token);
  let release, entered = false, closed = false;
  const gate = new Promise(resolve => { release = resolve; }), commit = ConfigTransfer.prototype.commit;
  t.mock.method(ConfigTransfer.prototype, 'commit', async function (...args) {
    const step = this.io.step;
    this.io.step = async (stage, action) => {
      if (stage === 'replaced:favorites') { entered = true; await gate; }
      return step(stage, action);
    };
    return commit.apply(this, args);
  });
  const applying = post('config/import/apply', { token: preview.token, confirm: true }).then(async response => ({ status: response.status, body: await response.json() }), error => ({ error }));
  let closing;
  try {
    await waitFor(() => entered);
    assert.equal(JSON.parse(await readFile(join(dir, '.settings', 'state.json'), 'utf8')).progressNotice.enabled, false);
    assert.equal(JSON.parse(await readFile(join(dir, '.imports', 'journal.json'), 'utf8')).phase, 'prepared');
    assert.equal((await post('config/import/apply', { token: preview.token, confirm: true })).status, 409, 'A rejected duplicate must not replace the transaction being drained');
    closing = service.close().then(() => { closed = true; });
    await delay(100);
    assert.equal(closed, false, 'Shutdown cannot finish while the import still owns a partially committed journal');
    await assert.rejects(() => acquireDataOwner(dir), error => error.status === 503);
  } finally {
    release(); await closing; await applying;
  }
  const result = await applying;
  assert.deepEqual(result, { status: 200, body: { applied: true, candidateDigest: preview.candidateDigest, pausedPlanIds: [] } });
  assert.equal((await readdir(join(dir, '.imports'))).includes('journal.json'), false);
  const owner = await acquireDataOwner(dir); await owner.release();
  const restored = await startTestServer({ port: 0, dataDir: dir, gatewayUrl: upstream.url });
  try {
    await restored.ready;
    assert.equal(JSON.parse(await readFile(join(dir, '.settings', 'state.json'), 'utf8')).progressNotice.enabled, false);
  } finally { await restored.close(); }
  assert.equal(upstream.seen.requests.length, 0);
});

test('concurrent shutdown callers all wait for the accepted settings write and directory release', async t => {
  const { dir, upstream, service, post, headers } = await setup(t);
  const settings = (await (await fetch(service.url + 'api/settings', { headers })).json()).settings;
  let release, entered = false, firstClosed = false, secondClosed = false;
  const gate = new Promise(resolve => { release = resolve; }), replace = StateFile.prototype.replace;
  t.mock.method(StateFile.prototype, 'replace', async function (path, value) {
    if (path === join(dir, '.settings', 'state.json')) { entered = true; await gate; }
    return replace.call(this, path, value);
  });
  const saving = post('settings/save', { expectedRevision: settings.revision, patch: { progressNotice: { enabled: false } } }).then(async response => ({ status: response.status, body: await response.json() }), error => ({ error }));
  let first, second;
  try {
    await waitFor(() => entered);
    first = service.close().then(() => { firstClosed = true; });
    second = service.close().then(() => { secondClosed = true; });
    await delay(100);
    assert.equal(firstClosed, false);
    assert.equal(secondClosed, false, 'Every close caller must wait for the same drain operation');
    await assert.rejects(() => acquireDataOwner(dir), error => error.status === 503);
  } finally { release(); await Promise.all([first, second, saving]); }
  assert.equal(JSON.parse(await readFile(join(dir, '.settings', 'state.json'), 'utf8')).progressNotice.enabled, false);
  const owner = await acquireDataOwner(dir); await owner.release();
  assert.equal(upstream.seen.requests.length, 0);
});
