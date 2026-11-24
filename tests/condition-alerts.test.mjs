import test from 'node:test';
import assert from 'node:assert/strict';
const comparison=await import('../lib/comparison.mjs');
import { summary } from '../lib/result.mjs';
import { QueuePolicy, DEFAULT_QUEUE } from '../lib/queue-policy.mjs';
import { identityHash } from '../lib/targets.mjs';
const run=(id,index,fields={})=>({id,model:'fixture/one',provider:'fixture',kind:'pelican',promptHash:'a'.repeat(64),effort:'',maxTokens:1,timeoutMs:600000,concurrency:2,createdAt:new Date(Date.UTC(2026,10,22,0,index)).toISOString(),startedAt:new Date(Date.UTC(2026,10,22,0,index)).toISOString(),status:'error',failureKind:'auth',upstreamStatus:401,physicalRequests:[{state:'started',admissionPolicyHash:'rules'}],...fields});

test('same-condition consecutive alerts count only executed upstream failures and retract when evidence disappears',()=>{
  assert.equal(typeof comparison.conditionAlerts,'function');const records=[run('a',1),run('local',2,{failureKind:'storage',error:'保存失败'}),run('b',3),run('q',4,{physicalRequests:[],status:'cancelled'}),run('c',5),run('other',6,{accountTarget:{mode:'pinned',id:'different'}})];
  const result=comparison.conditionAlerts(records[0],records);assert.equal(result.consecutive.code,'authentication');assert.deepEqual(result.consecutive.runIds,['c','b','a']);assert.equal(result.consecutive.runIds.length,3);
  assert.equal(comparison.conditionAlerts(records[0],records.filter(r=>r.id!=='a')).consecutive,null);
  assert.equal(comparison.conditionAlerts(records[0],[...records,run('success',7,{status:'completed',failureKind:undefined,upstreamStatus:undefined})]).consecutive,null);
  assert.equal(comparison.conditionAlerts(records[0],records).consecutive.key,result.consecutive.key);
});

test('timeouts, rate limits and host disconnections remain distinct alert classes',()=>{
  assert.equal(typeof comparison.conditionAlerts,'function');for(const [status,kind,code]of [[429,'rate','rate-limit'],[504,'timeout','timeout']]){const records=[1,2,3].map(i=>run(String(i),i,{upstreamStatus:status,failureKind:kind}));assert.equal(comparison.conditionAlerts(records[0],records).consecutive.code,code);}
  const disconnected=[1,2,3].map(i=>run(String(i),i,{upstreamStatus:undefined,failureKind:'gateway',error:'fetch failed'}));assert.equal(comparison.conditionAlerts(disconnected[0],disconnected).consecutive,null);
});

test('slowdown needs five recent and ten prior valid durations with both threshold conditions',()=>{
  assert.equal(typeof comparison.conditionAlerts,'function');const records=Array.from({length:15},(_,i)=>run(String(i),i,{status:'completed',failureKind:undefined,upstreamStatus:undefined,elapsedMs:i<10?20000:65000}));
  const result=comparison.conditionAlerts(records[0],records);assert.equal(result.slowdown.status,'slower');assert.equal(result.slowdown.recentMedianMs,65000);assert.equal(result.slowdown.previousMedianMs,20000);assert.equal(result.slowdown.runIds.length,15);
  assert.equal(comparison.conditionAlerts(records[0],records.slice(1)).slowdown.status,'insufficient');
  assert.equal(comparison.conditionAlerts(records[0],records.map(r=>({...r,elapsedMs:r.elapsedMs===65000?40000:r.elapsedMs}))).slowdown.status,'stable');
  assert.equal(comparison.conditionAlerts(records[0],records.map(r=>({...r,elapsedMs:r.elapsedMs===65000?45000:r.elapsedMs}))).slowdown.status,'stable');
});

test('incomplete legacy conditions remain readable without an alert key failure', () => {
  const result = comparison.conditionAlerts({ id: 'old', kind: 'pelican', status: 'error', createdAt: '2026-11-22T00:00:00Z' }, []);
  assert.equal(result.available, false); assert.equal(result.consecutive, null);
});

test('fingerprint timeout classification survives compact summaries using structured sample failures', () => {
  const records = [1, 2, 3].map(i => summary(run(String(i), i, { kind: 'fingerprint', failureKind: undefined, upstreamStatus: undefined, error: '没有有效采样', api: 'responses', strict: false, serviceTier: 'default', account: '', bank: { sha256: 'b'.repeat(64), sdkVersion: '0.2.0' }, challenges: Array.from({ length: 3 }, () => ({ prompt: 'numbers', expected_count: 1 })), samples: Array.from({ length: 3 }, () => ({ state: 'failed', raw_text: '', text: '', failureKind: 'timeout', error: '请求结束' })) })));
  assert.equal(records[0].diagnostic.code, 'timeout'); assert.equal(comparison.conditionAlerts(records[0], records).consecutive.code, 'timeout');
});

test('removing daily quotas preserves comparisons with historical requests that had quotas disabled', () => {
  for (const queue of [DEFAULT_QUEUE, { ...DEFAULT_QUEUE, providerConcurrency: 2, minIntervalMs: 1000 }]) {
    const oldHash = identityHash(JSON.stringify({ queue, budget: { enabled: false } }));
    const oldRun = run('before', 1, { status: 'completed', physicalRequests: [{ state: 'started', admissionPolicyHash: oldHash }] });
    const newRun = run('after', 2, { status: 'completed', physicalRequests: [{ state: 'started', admissionPolicyHash: new QueuePolicy(() => queue).hash() }] });
    assert.equal(comparison.recentTrend(newRun, [oldRun, newRun]).attempts, 2);
    if (queue === DEFAULT_QUEUE) assert.equal(comparison.conditionProfile({ ...oldRun, physicalRequests: undefined }).admissionPolicy, comparison.conditionProfile(oldRun).admissionPolicy);
  }
});
