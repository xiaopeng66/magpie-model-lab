import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Favorites, comparisonKey } from '../lib/favorites.mjs';
import { recentTrend } from '../lib/comparison.mjs';
import { enhancementSetup } from './enhancement-helpers.mjs';
import { waitFor } from './helpers.mjs';
const targets = await import('../lib/targets.mjs').catch(() => ({}));

test('target identity separates accounts and ignores display aliases; old overrides stay scoped to fingerprint', () => {
  assert.equal(typeof targets.normalizeTarget, 'function', 'Missing target normalization');
  const a = targets.normalizeTarget({ modelId: 'fixture/one', account: { mode: 'pinned', id: 'a', name: 'A' } });
  const renamed = targets.normalizeTarget({ modelId: 'fixture/one', account: { mode: 'pinned', id: 'a', name: 'Changed' } });
  assert.equal(a.targetKey, createHash('sha256').update(JSON.stringify(['fixture', 'fixture/one', 'pinned', 'a'])).digest('hex'));
  assert.equal(a.targetKey, renamed.targetKey);
  assert.notEqual(a.targetKey, targets.normalizeTarget({ modelId: 'fixture/one', account: { mode: 'pinned', id: 'b' } }).targetKey);
  assert.equal(targets.readFavoriteTarget({ modelId: 'fixture/one', fingerprint: { account: 'a' } }, 'candy').account.mode, 'auto');
  assert.equal(targets.readFavoriteTarget({ modelId: 'fixture/one', fingerprint: { account: 'a' } }, 'fingerprint').account.id, 'a');
  assert.equal(targets.readRunTarget({ model: 'fixture/one', kind: 'candy', account: 'a' }).account.mode, 'auto');
  assert.equal(targets.readRunTarget({ model: 'fixture/one', kind: 'fingerprint', account: 'a' }).account.id, 'a');
  for (const id of ['', 'a\n', 'x'.repeat(257)]) assert.throws(() => targets.normalizeTarget({ modelId: 'fixture/one', account: { mode: 'pinned', id } }), /账号/);
  assert.equal(targets.accountHeader('北冥'), '%E5%8C%97%E5%86%A5');
});

test('parallel requests for two accounts preserve headers, sessions and exact retest identities', async t => {
  const { runner, seen, gateway, store } = await enhancementSetup(t);
  const runs = await runner.submit({ kind: 'candy', targets: ['a', 'b'].map(id => ({ modelId: 'fixture/one', account: { mode: 'pinned', id } })), concurrency: 2 });
  await waitFor(() => runs.every(run => !runner.busy(run.id) && runner.get(run.id)?.status === 'completed'));
  assert.deepEqual(seen.map(item => item.account).sort(), ['a', 'b']);
  assert.equal(new Set(seen.map(item => item.session)).size, 2);
  assert.equal(gateway.headers['x-magpie-account'], undefined);
  for (const run of runs) {
    const detail = await store.get(run.id);
    assert.equal(detail.routing.verification, 'verified');
    assert.equal(detail.routing.reportedAccountId, detail.accountTarget.id);
    assert.equal(detail.account, undefined);
  }
  const preview = await runner.previewRetest({ runIds: runs.map(run => run.id) });
  assert.ok(preview.items.every(item => item.available));
  assert.deepEqual(preview.items.map(item => item.conditions.accountTarget.id).sort(), ['a', 'b']);
  const completed = runner.list();
  const trend = recentTrend(completed.find(run => run.id === runs[0].id), completed);
  assert.equal(trend.attempts, 1, 'Two account results cannot count as same conditions');
});

test('fixed account checks reject missing/disabled/provider mismatches with no auto request', async t => {
  const { runner, seen, candidates } = await enhancementSetup(t);
  candidates[0].enabled = false;
  for (const id of ['a', 'absent']) await assert.rejects(runner.submit({ kind: 'candy', targets: [{ modelId: 'fixture/one', account: { mode: 'pinned', id } }] }), /账号/);
  assert.equal(seen.length, 0);
  await assert.rejects(runner.submit({ kind: 'candy', models: [{ id: 'fixture/one', account: 'b' }] }), /targets|迁移/);
});

test('provider/model evidence alone remains unavailable and account mismatch is retained', async t => {
  const { runner } = await enhancementSetup(t, { handler({ complete, account }) { complete('最终答案：21', { provider: 'fixture', model: 'fixture/one', ...(account === 'b' ? { accountId: 'elsewhere' } : {}) }); } });
  const runs = await runner.submit({ kind: 'candy', targets: ['a', 'b'].map(id => ({ modelId: 'fixture/one', account: { mode: 'pinned', id } })) });
  await waitFor(() => runs.every(run => !runner.busy(run.id) && runner.get(run.id)?.status === 'completed'));
  assert.equal(runner.get(runs[0].id).routing.verification, 'unavailable');
  assert.equal(runner.get(runs[1].id).routing.verification, 'mismatch');
  assert.equal(recentTrend(runs[1], runs).valid, 0);
});

test('schema 2 migration keeps UUID, revisions and claims; pinned favorites add distinct identities', async t => {
  const { dir, runner, favorites } = await enhancementSetup(t);
  const auto = await favorites.save({ modelId: 'fixture/one', fingerprint: { account: 'a' } });
  const plan = await favorites.savePlan({ favoriteIds: [auto.id], kinds: ['candy'], enabled: true });
  const state = structuredClone(favorites.state); state.schema = 2; delete state.revision;
  for (const f of state.favorites) { delete f.account; delete f.targetKey; }
  state.claims = [{ key: 'already-claimed', at: new Date().toISOString(), state: 'started' }];
  await writeFile(join(dir, '.favorites', 'state.json'), JSON.stringify(state));
  const reloaded = new Favorites({ dir, runner }); await reloaded.init();
  assert.equal(reloaded.state.schema, 3);
  assert.equal(reloaded.state.favorites[0].id, auto.id);
  assert.equal(reloaded.state.plans[0].id, plan.id);
  assert.equal(reloaded.state.plans[0].revision, plan.revision);
  assert.equal(reloaded.state.plans[0].enabled, true);
  assert.deepEqual(reloaded.state.claims, state.claims);
  const files = await readdir(join(dir, '.favorites'));
  const backup = files.find(name => name.startsWith('state-v2-backup'));
  assert.ok(backup); assert.deepEqual(JSON.parse(await readFile(join(dir, '.favorites', backup))), state);
  const beforeKey = comparisonKey(state.favorites[0], 'candy');
  assert.equal(comparisonKey(reloaded.state.favorites[0], 'candy'), beforeKey);
  const pinned = await reloaded.save({ modelId: 'fixture/one', account: { mode: 'pinned', id: 'b' } });
  assert.notEqual(pinned.id, auto.id);
  await assert.rejects(reloaded.save({ id: auto.id, modelId: 'fixture/one', account: { mode: 'pinned', id: 'b' } }), /新增|新账号|更改/);
  const result = await reloaded.run({ ids: [auto.id, pinned.id], kinds: ['candy'] });
  assert.equal(result.runs.length, 2); assert.equal(new Set(result.runs.map(run => run.favoriteId)).size, 2);
});

test('upstream status and Retry-After survive gateway errors for admission cooling', async t => {
  const { gateway } = await enhancementSetup(t, { handler({ res }) { res.writeHead(429, { 'retry-after': '120', 'x-request-id': 'rate-one' }); res.end('{"error":{"message":"rate"}}'); } });
  await assert.rejects(gateway.generate({ model: 'fixture/one' }), error => error.upstreamStatus === 429 && error.retryAfterMs === 120000 && error.requestId === 'rate-one');
});
