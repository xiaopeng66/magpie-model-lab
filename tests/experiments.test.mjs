import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { enhancementSetup } from './enhancement-helpers.mjs';
import { temporary, fakeGateway, waitFor } from './helpers.mjs';
import { RunStore } from '../lib/store.mjs';
import { Runner } from '../lib/runner.mjs';
import { Gateway } from '../lib/gateway.mjs';
import { FingerprintBank } from '../lib/fingerprint-bank.mjs';
import { fingerprintGateway, referenceFixture } from './fingerprint-helpers.mjs';
import { conditionProfile, recentTrend } from '../lib/comparison.mjs';
import { originalConditions } from '../lib/retest.mjs';
import { legacyReasoningTask } from './legacy-task-fixtures.mjs';
const suites=await import('../lib/suites.mjs').catch(()=>({}));
const experiments=await import('../lib/experiments.mjs').catch(()=>({}));

test('two account targets repeat in round-first order with independent runs and one experiment batch',async t=>{
  const {runner,seen}=await enhancementSetup(t,{handler:({complete})=>complete('最终答案：21')});
  const runs=await runner.submit({kind:'candy',concurrency:1,repeat:{count:3},targets:['a','b'].map(id=>({modelId:'fixture/one',account:{mode:'pinned',id}}))});
  assert.equal(runs.length,6);assert.equal(new Set(runs.map(r=>r.id)).size,6);assert.equal(new Set(runs.map(r=>r.batchId)).size,1);
  assert.deepEqual(runs.map(r=>[r.repetitionIndex,r.executionIndex,r.accountTarget.id]),[[0,0,'a'],[0,1,'b'],[1,2,'a'],[1,3,'b'],[2,4,'a'],[2,5,'b']]);
  assert.ok(runs.every(r=>r.experimentId===r.batchId&&!r.roundId&&r.experiment.plannedRequests===6));
  await waitFor(()=>runner.list().every(r=>r.status==='completed'));assert.deepEqual(seen.map(s=>s.account),['a','b','a','b','a','b']);
  const disk=JSON.parse(await readFile(join(runner.store.dir,runs[5].id,'run.json'),'utf8'));assert.equal(disk.executionIndex,5);assert.equal(disk.experiment.plannedRunCount,6);
});

test('repeat validation and expanded preparation byte limit reject the entire batch before any write',async t=>{
  const dir=await temporary(t),upstream=await fakeGateway(t,undefined,{modelIds:Array.from({length:16},(_,i)=>'m'+i)}),store=new RunStore(dir);await store.init();const runner=new Runner({store,gateway:new Gateway({url:upstream.url})});t.after(()=>runner.close());
  const models=Array.from({length:16},(_,i)=>({id:'fixture/m'+i}));
  for(const repeat of [{count:0},{count:-1},{count:Number.MAX_SAFE_INTEGER+1},{count:1.5},{count:2,extra:true}])await assert.rejects(runner.submit({kind:'candy',models,repeat}),error=>error.status===400);
  await assert.rejects(runner.submit({prompt:'x'.repeat(12000),models,repeat:{count:30}}),error=>error.status===413&&/8 MiB/.test(error.message));
  assert.equal(runner.list().length,0);assert.equal(store.records.size,0);assert.equal(upstream.seen.requests.length,0);
});

test('fingerprint experiment preparation includes the actual output cap in every physical request body', async t => {
  const dir = await temporary(t), upstream = await fingerprintGateway(t, { bank: referenceFixture('preparation', true) }), store = new RunStore(join(dir, 'runs')); await store.init();
  const bank = new FingerprintBank({ dir: join(dir, 'bank'), source: upstream.url + '/data/' }); await bank.init();
  const runner = new Runner({ store, bank, gateway: new Gateway({ url: upstream.url }) }); t.after(async () => { await runner.close(); await bank.close(); });
  const snapshots = [], save = store.save.bind(store); store.save = run => { if (run.status === 'queued' && !snapshots.some(value => value.id === run.id)) snapshots.push(structuredClone(run)); return save(run); };
  const runs = await runner.submit({ kind: 'fingerprint', models: [{ id: 'fixture/chat' }], repeat: { count: 2 }, maxTokens: 131072, concurrency: 1 });
  await waitFor(() => runs.every(run => !runner.busy(run.id) && !['queued', 'running'].includes(runner.get(run.id).status)));
  assert.equal(upstream.seen.requests.length, 6); assert.ok(upstream.seen.requests.every(request => request.payload.max_tokens === 131072));
  const actual = snapshots.reduce((sum, run) => sum + Buffer.byteLength(JSON.stringify(run)), 0) + upstream.seen.requests.reduce((sum, request) => sum + Buffer.byteLength(JSON.stringify(request.payload)), 0);
  assert.ok(runs[0].experiment.preparedBytes >= actual, `Preparation ${runs[0].experiment.preparedBytes} must cover actual metadata and payload ${actual}`);
});

test('original candy repetitions freeze one question and keep its answer out of model request metadata',async t=>{
  assert.equal(typeof suites.suiteCatalog,'function','Versioned suites must be available');
  const {runner,seen}=await enhancementSetup(t,{handler:({complete})=>complete('最终答案：21')});
  const runs=await runner.submit({kind:'candy',concurrency:1,repeat:{count:2},targets:[{modelId:'fixture/one'},{modelId:'fixture/two'}]});
  assert.equal(runs.length,4);assert.deepEqual(runs.map(r=>r.task.questionId),['shape-choice','shape-choice','shape-choice','shape-choice']);
  await waitFor(()=>runner.list().every(r=>r.status==='completed'));
  for(let i=0;i<runs.length;i++){const run=await runner.read(runs[i].id);assert.equal(seen[i].payload.messages[0].content,run.prompt);assert.ok(!Object.hasOwn(seen[i].payload,'task')&&!Object.hasOwn(seen[i].payload,'expected'));assert.equal(run.task.suiteVersion,'1');assert.equal(run.candy.version,'shape-choice-v1');assert.equal(run.grade.verdict,'match');}
  await assert.rejects(runner.submit({kind:'candy',suite:{id:'shape-choice',version:'1',questionIds:['inventory']},targets:[{modelId:'fixture/one'}]}),error=>error.status===400);
});

test('only the original candy grader can execute while historical numeric and enum grades remain readable',()=>{
  assert.equal(typeof suites.gradeTask,'function');
  const arithmetic=legacyReasoningTask(),deduction=legacyReasoningTask('deduction'),original=suites.taskFor('shape-choice','1','shape-choice');
  assert.throws(()=>suites.gradeTask(arithmetic,'最终答案：42','stop'),/移除/);
  assert.throws(()=>suites.gradeTask(deduction,'最终答案：B','stop'),/移除/);
  assert.equal(suites.readGrade({kind:'candy',grade:{verdict:'match',expected:'B',answer:'B'}}).answer,'B');
  assert.equal(suites.gradeTask(original,'最终答案：21','stop').candy.version,'shape-choice-v1');
  assert.equal(suites.readGrade({kind:'candy',candy:{verdict:'match',expected:21,answer:21}}).verdict,'match');
});

test('retesting repeated experiment sources creates exactly one new request per selected source',async t=>{
  const {runner,seen}=await enhancementSetup(t,{handler:({complete})=>complete('最终答案：21')});const sources=await runner.submit({kind:'candy',repeat:{count:3},targets:[{modelId:'fixture/one'}]});
  assert.equal(sources.length,3);await waitFor(()=>runner.list().every(r=>r.status==='completed'));
  const created=await runner.retest({operationId:randomUUID(),runIds:sources.map(r=>r.id)});assert.equal(created.runs.length,3);await waitFor(()=>runner.list().every(r=>r.status==='completed'));assert.equal(seen.length,6);assert.ok(created.runs.every(r=>r.task.expected===21));
  const unsupported={...await runner.read(sources[0].id),task:{...sources[0].task,suiteVersion:'missing'}};assert.throws(()=>originalConditions(unsupported,runner.catalog[0]),/版本|题集|依赖/);
});

test('experiment statistics keep account and question denominators separate and show no score for zero samples',()=>{
  assert.equal(typeof experiments.experimentStats,'function');const task=legacyReasoningTask(),base={id:'r',experimentId:'experiment',batchId:'experiment',model:'fixture/one',provider:'fixture',kind:'candy',task,prompt:task.prompt,effort:'',maxTokens:0,timeoutMs:0,concurrency:1,accountTarget:{mode:'pinned',id:'a'},physicalRequests:[{state:'started'}],elapsedMs:5000,status:'completed',grade:{verdict:'match',expected:42,answer:42}};
  const records=[base,{...base,id:'m',grade:{verdict:'mismatch',expected:42,answer:7}},{...base,id:'c',status:'cancelled',grade:{verdict:'incomplete',answer:null,expected:42}},{...base,id:'q',status:'cancelled',physicalRequests:[]},{...base,id:'b',accountTarget:{mode:'pinned',id:'b'}},{...base,id:'other',task:legacyReasoningTask('inventory')}];
  const result=experiments.experimentStats(base,records);assert.equal(result.submitted,4);assert.equal(result.executed,3);assert.equal(result.completed,2);assert.equal(result.gradable,2);assert.equal(result.matches,1);assert.equal(result.matchRate,50);assert.ok(Math.abs(result.executedMatchRate-33.3333333333333)<0.0001);assert.equal(result.cancelled,2);assert.equal(result.p90Ms,null);
  const empty=experiments.experimentStats({...base,experimentId:'none'},[]);assert.equal(empty.matchRate,null);assert.equal(empty.executedMatchRate,null);assert.equal(empty.elapsedMedian,null);
});

test('comparison groups include grader answer and admission rules and read unified grades',()=>{
  assert.equal(typeof suites.taskFor,'function');const task=legacyReasoningTask(),base={id:'a',kind:'candy',model:'fixture/one',prompt:task.prompt,promptHash:task.questionHash,task,status:'completed',createdAt:'2026-11-22T01:00:00Z',effort:'',maxTokens:1,timeoutMs:0,concurrency:1,grade:{verdict:'match',expected:42,answer:42},physicalRequests:[{state:'started',admissionPolicyHash:'policy-a'}]};
  assert.notDeepEqual(conditionProfile(base),conditionProfile({...base,task:{...task,expected:21}}));assert.notDeepEqual(conditionProfile(base),conditionProfile({...base,physicalRequests:[{state:'started',admissionPolicyHash:'policy-b'}]}));
  const trend=recentTrend(base,[base,{...base,id:'b',task:{...task,expected:21}}]);assert.equal(trend.valid,1);assert.equal(trend.successes,1);assert.equal(trend.attempts,1);
});

test('an account routing mismatch cannot contribute a correct answer or valid experiment score', () => {
  const task = legacyReasoningTask(), run = { id: 'route', experimentId: 'experiment', model: 'fixture/one', kind: 'candy', task, prompt: task.prompt, effort: '', maxTokens: 0, timeoutMs: 0, concurrency: 1, status: 'completed', physicalRequests: [{ state: 'started' }], grade: { expected: 42, answer: 42, verdict: 'match' }, routing: { verification: 'mismatch' } };
  const result = experiments.experimentStats(run, [run]); assert.equal(result.executed, 1); assert.equal(result.gradable, 0); assert.equal(result.matches, 0); assert.equal(result.matchRate, null);
});
