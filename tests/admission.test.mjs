import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enhancementSetup } from './enhancement-helpers.mjs';
import { waitFor } from './helpers.mjs';
import { sampleFingerprint } from '../lib/fingerprint-sample.mjs';
import { Gateway } from '../lib/gateway.mjs';
const ledger = await import('../lib/usage-ledger.mjs');
const policyModule = await import('../lib/queue-policy.mjs').catch(() => ({}));
async function standalone(t, now = () => Date.parse('2026-11-22T12:00:00Z')) {
  const dir = await mkdtemp(join(tmpdir(), 'usage-bd-'));
  const usage = new ledger.UsageLedger(dir, { now, timeZone: 'UTC' }); await usage.init();
  t.after(async () => { await usage.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, usage };
}
const request = () => ({ physicalRequestId: randomUUID(), runId: randomUUID(), provider: 'fixture', accountId: 'a', admissionPolicyHash: 'test' });

test('concurrent requests are independently recorded and only unsent reservations may be released', async t => {
  const { usage } = await standalone(t), choices = await Promise.all([usage.reserve(request()), usage.reserve(request())]);
  await usage.release(choices[0].reservation.physicalRequestId);
  await usage.start(choices[1].reservation.physicalRequestId); await usage.markStarted(choices[1].reservation.physicalRequestId);
  await assert.rejects(usage.release(choices[1].reservation.physicalRequestId), /已发出/);
  assert.equal(usage.summary().knownRequests, 1);
});

test('usage is cumulative per local request, ignores late revisions and never refunds a rollback', async t => {
  const { usage } = await standalone(t);
  const { reservation } = await usage.reserve(request()); await usage.start(reservation.physicalRequestId);
  await usage.observe(reservation.physicalRequestId, { total_tokens: 30 }, 1);
  await usage.observe(reservation.physicalRequestId, { total_tokens: 30 }, 2);
  await usage.observe(reservation.physicalRequestId, { total_tokens: 10 }, 1);
  assert.equal(usage.summary().tokens, 30);
  await usage.observe(reservation.physicalRequestId, { total_tokens: 20 }, 3);
  assert.equal(usage.summary().tokens, 30); assert.equal(usage.summary().usageNeedsReview, 1);
});

test('restart releases reserved entries and conservatively counts starting with unknown usage', async t => {
  const { dir, usage } = await standalone(t);
  const a = await usage.reserve(request()), b = await usage.reserve(request());
  await usage.start(b.reservation.physicalRequestId); await usage.close();
  const restored = new ledger.UsageLedger(dir, { now: () => Date.parse('2026-11-22T12:01:00Z'), timeZone: 'UTC' }); await restored.init();
  t.after(() => restored.close());
  assert.equal(restored.summary().knownRequests, 1);
  assert.equal(restored.summary().unknownUsage, 1);
  assert.equal(restored.file.data.entries[a.reservation.physicalRequestId].state, 'released');
  assert.equal(restored.file.data.entries[b.reservation.physicalRequestId].possibleUnsent, true);
});

test('a late usage response remains attached to the fetch day after midnight', async t => {
  let now = Date.parse('2026-11-22T23:59:59Z');
  const { usage } = await standalone(t, () => now), value = await usage.reserve(request()); now += 2000;
  await usage.start(value.reservation.physicalRequestId); await usage.markStarted(value.reservation.physicalRequestId);
  now += 86400000; await usage.observe(value.reservation.physicalRequestId, { total_tokens: 45 }, 1);
  assert.equal(usage.summary().knownRequests, 0); assert.equal(usage.file.data.entries[value.reservation.physicalRequestId].day, '2026-11-23');
});

test('429 cooling scans another account instead of blocking every target', async t => {
  const { runner, seen, settings } = await enhancementSetup(t, { handler({ account, complete, res }) { if (account === 'a') { res.writeHead(429, { 'retry-after': '120' }); res.end('{}'); } else complete(); } });
  await settings.save({ expectedRevision: settings.snapshot().revision, patch: { queue: { providerConcurrency: 0, accountConcurrency: 1, minIntervalMs: 0, providers: {}, accounts: {} } } });
  const runs = await runner.submit({ kind: 'candy', concurrency: 1, targets: ['a', 'a', 'b'].map((id, index) => ({ modelId: index === 1 ? 'fixture/two' : 'fixture/one', account: { mode: 'pinned', id } })) });
  await waitFor(() => runner.get(runs[2].id)?.status === 'completed');
  assert.deepEqual(seen.map(item => item.account), ['a', 'b']);
  assert.equal(runner.get(runs[1].id).status, 'queued');
  assert.equal(runner.get(runs[1].id).queueReason, 'cooldown');
  await runner.cancel(runs[1].id);
});

test('a damaged cooldown file leaves all requests queued with a storage reason and an actionable event', async t => {
  const { runner, seen } = await enhancementSetup(t); const events = [];
  runner.subscribe(value => { if (value.type === 'queue-error') events.push(value); });
  runner.queuePolicy.file.pause(Error('damaged cooldown state'));
  const runs = await runner.submit({ kind: 'candy', models: [{ id: 'fixture/one' }, { id: 'fixture/two' }] });
  await waitFor(() => !runner.pumping);
  assert.equal(seen.length, 0); assert.ok(runs.every(run => runner.get(run.id).status === 'queued'));
  assert.deepEqual(runner.queueStatus().queued.map(value => value.reason), ['queue_storage', 'queue_storage']);
  assert.ok(events.some(value => /冷却|离线恢复/.test(value.error)));
});

test('disk failure refuses generation and cancellation during admission never calls fetch', async t => {
  const { runner, seen } = await enhancementSetup(t);
  assert.ok(runner.usage, 'Runner requires the real usage ledger');
  let release; const prior = runner.usage.file.commit.bind(runner.usage.file);
  runner.usage.file.commit = async next => { await new Promise(resolve => { release = resolve; }); return prior(next); };
  const [run] = await runner.submit({ kind: 'candy', targets: [{ modelId: 'fixture/one' }] });
  await waitFor(() => release);
  runner.pump(); runner.pump();
  const cancelling = runner.cancel(run.id); release();
  runner.usage.file.commit = prior; await cancelling;
  await waitFor(() => !runner.busy(run.id));
  assert.equal(seen.length, 0); assert.equal(runner.get(run.id).status, 'cancelled');
  runner.usage.file.commit = async () => { throw Error('disk full'); };
  const [failed] = await runner.submit({ kind: 'candy', targets: [{ modelId: 'fixture/two' }] });
  await waitFor(() => runner.get(failed.id)?.status === 'error');
  assert.equal(seen.length, 0); assert.equal(runner.get(failed.id).failureKind, 'usage_storage');
});

test('queue rules enforce provider/account limits and long Retry-After without timer overflow', () => {
  assert.equal(typeof policyModule.QueuePolicy, 'function', 'Missing admission policy');
  const queue = new policyModule.QueuePolicy(() => ({ providerConcurrency: 1, accountConcurrency: 1, minIntervalMs: 0, providers: {}, accounts: {} }), { now: () => 1000 });
  const run = { provider: 'fixture', model: 'fixture/one', accountTarget: { mode: 'pinned', id: 'a' } };
  assert.equal(queue.check(run, [{ run }]).reason, 'provider_limit');
  queue.noteFailure(run, { upstreamStatus: 429, retryAfterMs: 172800000 });
  assert.equal(queue.check(run, []).until, 172801000);
  assert.equal(queue.nextDelay(172801000), 3600000);
  assert.equal(queue.check({ ...run, accountTarget: { mode: 'pinned', id: 'b' } }, []).allowed, true);
});

test('compaction retains current time-zone windows and all observed lifetime totals',async t=>{
  let at=Date.parse('2026-11-22T12:00:00Z');const {usage}=await standalone(t,()=>at);
  const first=await usage.reserve(request());await usage.start(first.reservation.physicalRequestId);await usage.markStarted(first.reservation.physicalRequestId,at);await usage.observe(first.reservation.physicalRequestId,{total_tokens:30},1);await usage.complete(first.reservation.physicalRequestId);
  at+=4*86400000;const second=await usage.reserve(request());await usage.start(second.reservation.physicalRequestId);await usage.markStarted(second.reservation.physicalRequestId,at);await usage.observe(second.reservation.physicalRequestId,{total_tokens:45},1);await usage.complete(second.reservation.physicalRequestId);
  assert.ok(!usage.file.data.entries[first.reservation.physicalRequestId]);assert.ok(usage.file.data.entries[second.reservation.physicalRequestId]);
  assert.equal(usage.summary().knownRequests,1);assert.equal(usage.summary().tokens,45);assert.equal(usage.file.snapshot().archive.requests,1);assert.equal(usage.file.snapshot().archive.tokens,30);
});

test('failed cooldown persistence preserves the active local block and corrupt restart fails closed',async t=>{
  const {dir,runner}=await enhancementSetup(t),queue=runner.queuePolicy,run={model:'fixture/one',provider:'fixture',accountTarget:{mode:'pinned',id:'a'}};
  queue.noteFailure(run,{upstreamStatus:429,retryAfterMs:120000});await queue.file.pending;
  const scope=queue.status().cooldowns[0].scope;queue.file.replace=async()=>{throw Error('disk full');};queue.noteFailure(run,{upstreamStatus:429,retryAfterMs:180000});await queue.file.pending.catch(()=>{});assert.ok(queue.status().cooldowns.some(item=>item.scope===scope));assert.throws(()=>queue.check(run,[]),/冷却|恢复|写入/);
  await queue.close();await writeFile(join(dir,'.queue','state.json'),'broken');const restored=new policyModule.QueuePolicy(()=>policyModule.DEFAULT_QUEUE,{dir});await restored.init();t.after(()=>restored.close());assert.throws(()=>restored.check(run,[]),/冷却|恢复|写入/);
});

test('fingerprint propagates a not-yet-fetched readmission decision without turning it into sample failure',async()=>{
  const gateway=Object.assign(new Gateway({url:'http://127.0.0.1:9',key:'fixture'}),{route:async()=>({})});
  await assert.rejects(sampleFingerprint(gateway,{model:'fixture/one',api:'chat_completions',effort:'',maxTokens:1},{prompt:'test',expected_count:320},{beforeFetch:()=>{throw Object.assign(Error('readmit'),{readmit:true});}}),error=>error.readmit===true);
});

test('cancelled unstarted physical metadata is persisted as released',async t=>{
  const {runner,store,seen}=await enhancementSetup(t);const generate=runner.gateway.generate.bind(runner.gateway);
  runner.gateway.generate=async(payload,options)=>{runner.cancel(runner.list()[0].id).catch(()=>{});await Promise.resolve();return generate(payload,options);};
  const [run]=await runner.submit({kind:'candy',targets:[{modelId:'fixture/one'}]});await waitFor(()=>!runner.busy(run.id)&&runner.get(run.id)?.status==='cancelled');
  const disk=JSON.parse(await readFile(join(store.dir,run.id,'run.json'),'utf8'));assert.equal(disk.physicalRequests[0].state,'released');assert.equal(seen.length,0);
});
