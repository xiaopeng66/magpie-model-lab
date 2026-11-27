import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { enhancementSetup } from './enhancement-helpers.mjs';
import { occurrence } from '../lib/scheduler.mjs';
import { DEFAULT_QUEUE, accountScope } from '../lib/queue-policy.mjs';
import { randomUUID } from 'node:crypto';
import { waitFor } from './helpers.mjs';
import { setTimeout as delay } from 'node:timers/promises';
const transfer = await import('../lib/config-transfer.mjs').catch(() => ({}));
async function setup(t) { const environment = await enhancementSetup(t);assert.equal(typeof transfer.ConfigTransfer,'function','Missing safe configuration transfer');const config=new transfer.ConfigTransfer({...environment});return {...environment,config}; }

for (const [name, reject] of [
  ['plan validation', ({ favorites, favorite }) => favorites.savePlan({ favoriteIds: [favorite.id], kinds: ['fingerprint'] })],
  ['settings conflict', ({ settings }) => settings.save({ expectedRevision: settings.snapshot().revision + 1, patch: { progressNotice: { enabled: false } } })],
  ['note validation', ({ annotations }) => annotations.save({ runId: randomUUID(), expectedRunRevision: 0, note: '字'.repeat(2001) })],
  ['empty submission', ({ runner }) => runner.submit({ kind: 'candy', targets: [] })],
]) test(`configuration import recovers after a handled ${name} rejection`, async t => {
  const env = await setup(t), favorite = await env.favorites.save({ modelId: 'fixture/one' });
  await assert.rejects(reject({ ...env, favorite }), error => [400, 409].includes(error.status));
  const preview = await env.config.preview({ document: env.config.export() });
  assert.ok(preview.token);
  assert.equal((await env.config.apply({ token: preview.token, confirm: true })).applied, true);
  assert.equal(env.seen.length, 0);
});

for (const name of ['favorites', 'annotations']) test(`unhealthy ${name} blocks all configuration transfer operations without a rejected queue tail`, async t => {
  const env = await setup(t), document = env.config.export(), preview = await env.config.preview({ document });
  env[name].file.pause('unreadable private state');
  assert.throws(() => env.config.export(), error => error.status === 503);
  await assert.rejects(env.config.preview({ document }), error => error.status === 503);
  await assert.rejects(env.config.apply({ token: preview.token, confirm: true }), error => error.status === 503);
  assert.equal(env.seen.length, 0);
});

test('configuration preview returns a validation error for a target without an account', async t => {
  const { favorites, config } = await setup(t); await favorites.save({ modelId: 'fixture/one' });
  const document = config.export(); delete document.payload.favorites[0].account; document.digest = transfer.configDigest(document.payload);
  await assert.rejects(config.preview({ document }), error => error.status === 400);
});

test('configuration export is a whitelist and share sourceRefs preserve distinct accounts and plan links', async t => {
  const { favorites,config }=await setup(t);
  const a=await favorites.save({modelId:'fixture/one',account:{mode:'pinned',id:'a'}}),b=await favorites.save({modelId:'fixture/one',account:{mode:'pinned',id:'b'}});
  for(const f of [a,b])await favorites.savePlan({favoriteIds:[f.id],kinds:['candy'],enabled:true});
  const backup=config.export({shareMode:true}),text=JSON.stringify(backup);
  assert.equal(backup.schema,'model-lab-config-v1');
  assert.ok(!text.includes('"claims"')&&!text.includes('"targetKey"')&&!text.includes('"resumeAfter"'));
  assert.ok(!text.includes(a.id)&&!text.includes('"id":"a"')&&!text.includes('"id":"b"'));
  assert.equal(new Set(backup.payload.favorites.map(f=>f.sourceRef)).size,2);
  assert.equal(new Set(backup.payload.plans.map(p=>p.favoriteRef)).size,2);
  const preview=await config.preview({document:backup});assert.equal(preview.token,null);assert.equal(preview.unresolved.length,2);
});

test('import keeps untouched local plans, pauses affected/new plans, keeps claims and binds token choices', async t => {
  const {favorites,settings,config}=await setup(t);
  const a=await favorites.save({modelId:'fixture/one'}),b=await favorites.save({modelId:'fixture/two'});
  const pa=await favorites.savePlan({favoriteIds:[a.id],kinds:['candy'],enabled:true}),pb=await favorites.savePlan({favoriteIds:[b.id],kinds:['candy'],enabled:true});
  await favorites.transact(state=>{state.claims.push({key:'local-claim',at:new Date().toISOString(),state:'started'});});
  const doc=config.export();doc.payload.favorites[0].parameters.maxTokens=1234;doc.digest=transfer.configDigest(doc.payload);
  const choices={targets:{'target-1':'overwrite'}};
  const preview=await config.preview({document:doc,choices});assert.ok(preview.token);assert.deepEqual(preview.pausedPlanIds,[pa.id]);
  await assert.rejects(config.apply({token:preview.token,choices:{targets:{'target-1':'keep'}}}),/选择|字段|预览/);
  await config.apply({token:preview.token,confirm:true});
  assert.equal(favorites.state.favorites.find(f=>f.id===a.id).maxTokens,1234);
  assert.equal(favorites.state.plans.find(p=>p.id===pa.id).enabled,false);
  assert.equal(favorites.state.plans.find(p=>p.id===pb.id).enabled,true);
  assert.equal(favorites.state.claims[0].key,'local-claim');
  assert.ok(favorites.state.plans.find(p=>p.id===pa.id).resumeAfter);
  const resumed=await favorites.savePlan({...favorites.state.plans.find(p=>p.id===pa.id),enabled:true});
  assert.equal(occurrence({...resumed,mode:'times',times:[new Intl.DateTimeFormat('en-GB',{timeZone:resumed.timeZone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date())],days:[0,1,2,3,4,5,6]},new Date()),null);
  await assert.rejects(config.apply({token:preview.token,confirm:true}),/预览|token/);
});

test('stale local revisions and queued requests make configuration apply return conflict', async t => {
  const {runner,config,settings}=await setup(t),doc=config.export();
  const preview=await config.preview({document:doc});
  await settings.save({expectedRevision:settings.snapshot().revision,patch:{progressNotice:{enabled:false}}});
  await assert.rejects(config.apply({token:preview.token,confirm:true}),error=>error.status===409);
  const next=await config.preview({document:config.export()});runner.schedulingPaused++;
  await runner.submit({kind:'candy',targets:[{modelId:'fixture/one'}]});
  await assert.rejects(config.apply({token:next.token,confirm:true}),error=>error.status===409);
  runner.schedulingPaused--;await runner.cancel(runner.list()[0].id);
});

test('import refuses a disk edit made after preview and preserves both original files', async t => {
  const { config, dir } = await setup(t), preview = await config.preview({ document: config.export() });
  const settingsPath = join(dir, '.settings/state.json'), favoritesPath = join(dir, '.favorites/state.json');
  const original = await readFile(favoritesPath), external = JSON.parse(await readFile(settingsPath)); external.revision++;
  const bytes = JSON.stringify(external); await writeFile(settingsPath, bytes);
  await assert.rejects(config.apply({ token: preview.token, confirm: true }), error => error.status === 409);
  assert.equal(await readFile(settingsPath, 'utf8'), bytes); assert.deepEqual(await readFile(favoritesPath), original);
});

test('paused configuration storage blocks export, preview and previously approved candidates', async t => {
  const { settings, config } = await setup(t), document = config.export(), preview = await config.preview({ document });
  settings.file.pause('test recovery');
  assert.throws(() => config.export(), error => error.status === 503);
  await assert.rejects(config.preview({ document }), error => error.status === 503);
  await assert.rejects(config.apply({ token: preview.token, confirm: true }), error => error.status === 503);
});

test('configuration maintenance drains an already accepted favorite dispatch before the idle check', async t => {
  const { runner, favorites, settings, config, dir, seen } = await setup(t), favorite = await favorites.save({ modelId: 'fixture/one' });
  const preview = await config.preview({ document: config.export() }), old = await readFile(join(dir, '.settings/state.json'), 'utf8');
  let release; const gate = new Promise(resolve => { release = resolve; });
  runner.schedulingPaused++;
  const heldMutation = runner.mutate(() => gate), dispatched = favorites.run({ ids: [favorite.id], kinds: ['candy'] });
  await waitFor(() => runner.submissions !== heldMutation);
  let finished = false; const applied = config.apply({ token: preview.token, confirm: true }).then(() => { finished = true; return null; }, error => { finished = true; return error; });
  await waitFor(() => config.maintaining); assert.equal(finished, false);
  release(); const result = await dispatched, error = await applied;
  assert.equal(result.runs.length, 1); assert.equal(error?.status, 409);
  assert.equal(await readFile(join(dir, '.settings/state.json'), 'utf8'), old); assert.equal(settings.snapshot().revision, preview.settingsRevision);
  assert.equal(config.maintaining, false); assert.equal(runner.maintenance, false); assert.equal(seen.length, 0);
  await runner.cancel(result.runs[0].id); runner.schedulingPaused--;
});

test('closing drains an accepted import that is waiting for an earlier favorite write', async t => {
  const { favorites, settings, config } = await setup(t), document = config.export();
  document.payload.settings.progressNotice.enabled = false; document.digest = transfer.configDigest(document.payload);
  const preview = await config.preview({ document, choices: { settings: { progressNotice: 'overwrite' } } });
  let release; const gate = new Promise(resolve => { release = resolve; });
  favorites.dispatches = gate;
  const applying = config.apply({ token: preview.token, confirm: true }).then(value => ({ value }), error => ({ error }));
  await waitFor(() => config.maintaining);
  let closed = false; const closing = config.close().then(() => { closed = true; });
  try {
    await delay(20);
    assert.equal(closed, false, 'Close waits while the accepted import is draining earlier writes');
  } finally { release(); }
  const result = await applying; await closing;
  assert.equal(result.error, undefined, 'Closing must not revoke an import that already acquired the maintenance lock');
  assert.equal(result.value.applied, true);
  assert.equal(settings.snapshot().progressNotice.enabled, false);
});

for (const { name, preparation, save } of [
  { name: 'favorite save', preparation: 'models', save: ({ favorites }) => favorites.save({ modelId: 'fixture/two', maxTokens: 2400 }) },
  { name: 'pinned account validation', preparation: 'assertAccount', save: ({ favorites }) => favorites.save({ modelId: 'fixture/two', account: { mode: 'pinned', id: 'a' }, maxTokens: 2400 }) },
  { name: 'favorite management', preparation: 'models', save: ({ favorites, favorite }) => favorites.manage({ edits: [{ id: favorite.id, modelId: favorite.modelId, maxTokens: 2400 }] }) },
  { name: 'plan parameter save', preparation: 'models', save: ({ favorites, plan }) => favorites.savePlan({ ...plan, times: ['10:00'], parameters: { maxTokens: 2400 } }) },
]) test(`configuration maintenance waits for accepted ${name} before rejecting a stale preview`, async t => {
  const env = await setup(t), { favorites, runner, gateway, config, dir, seen } = env;
  const favorite = await favorites.save({ modelId: 'fixture/one' });
  const plan = await favorites.savePlan({ favoriteIds: [favorite.id], kinds: ['candy'], enabled: false });
  const preview = await config.preview({ document: config.export() });
  const settingsBefore = await readFile(join(dir, '.settings/state.json'));
  let release, entered = false; const gate = new Promise(resolve => { release = resolve; });
  const original = gateway[preparation]; runner.catalogAt = 0;
  t.mock.method(gateway, preparation, async function (...args) { entered = true; await gate; return original.apply(this, args); });
  const saving = save({ ...env, favorite, plan }).then(value => ({ value }), error => ({ error }));
  try {
    await waitFor(() => entered);
    let completed = false;
    const applying = config.apply({ token: preview.token, confirm: true }).then(value => { completed = true; return { value }; }, error => { completed = true; return { error }; });
    await Promise.race([applying, delay(100)]); const completedWhileSaving = completed;
    release(); const saved = await saving, applied = await applying;
    assert.equal(completedWhileSaving, false, 'Import completed while an accepted configuration save was still preparing');
    assert.equal(saved.error, undefined); assert.equal(applied.error?.status, 409);
    assert.deepEqual(await readFile(join(dir, '.settings/state.json')), settingsBefore);
    assert.deepEqual(JSON.parse(await readFile(favorites.path, 'utf8')), favorites.state);
    assert.ok(favorites.state.favorites.some(item => item.maxTokens === 2400));
    assert.equal(config.maintaining, false); assert.equal(runner.maintenance, false); assert.equal(seen.length, 0);
  } finally { release(); await saving; }
});

test('shorter imported retention requires the same fixed impact confirmation', async t => {
  const {config}=await setup(t),doc=config.export();doc.payload.settings.retention={days:1};doc.digest=transfer.configDigest(doc.payload);
  const preview=await config.preview({document:doc,choices:{settings:{retention:'overwrite'}}});assert.ok(preview.retentionImpact);
  await assert.rejects(config.apply({token:preview.token,confirm:true}),/保留|影响/);
  await config.apply({token:preview.token,confirm:true,confirmRetention:true});
});

test('all prepared/replace/committed interruption points recover a complete old or new configuration', async t => {
  for(const point of ['prepared','replaced:settings','replaced:favorites','committed']) {
    const env=await setup(t),doc=env.config.export();doc.payload.settings.progressNotice.enabled=false;doc.digest=transfer.configDigest(doc.payload);
    const preview=await env.config.preview({document:doc,choices:{settings:{progressNotice:'overwrite'}}});
    env.config.io.step=async(stage,action)=>{await action();if(stage===point)throw Object.assign(Error('simulated process death'),{crash:true});};
    await assert.rejects(env.config.apply({token:preview.token,confirm:true}),/simulated/);
    const recovery=await transfer.recoverConfigJournal(env.dir);assert.equal(recovery.recoveryError,'');
    const disk=JSON.parse(await readFile(join(env.dir,'.settings','state.json'),'utf8'));
    assert.equal(disk.progressNotice.enabled,point==='committed'?false:true);
    const state=JSON.parse(await readFile(join(env.dir,'.favorites','state.json'),'utf8'));assert.equal(state.schema,3);
  }
});

test('unknown external digest blocks journal recovery instead of overwriting a third configuration', async t => {
  const env=await setup(t),preview=await env.config.preview({document:env.config.export()});
  env.config.io.step=async(stage,action)=>{await action();if(stage==='prepared')throw Object.assign(Error('crash'),{crash:true});};
  await assert.rejects(env.config.apply({token:preview.token,confirm:true}));
  const path=join(env.dir,'.settings','state.json'),outside='{"external":true}';await writeFile(path,outside);
  const result=await transfer.recoverConfigJournal(env.dir);assert.ok(result.recoveryError);assert.equal(await readFile(path,'utf8'),outside);
});

test('share export removes account-specific admission rules, names and stable keys', async t => {
  const {settings,config}=await setup(t),id='private-account-6941',scope=accountScope('fixture',id);
  await settings.save({expectedRevision:0,patch:{queue:{...DEFAULT_QUEUE,accounts:{[scope]:{concurrency:1,intervalMs:5000}}}}});
  const ordinary=config.export(),shared=config.export({shareMode:true});
  assert.ok(JSON.stringify(ordinary).includes(id));
  assert.ok(!JSON.stringify(shared).includes(id));
  assert.deepEqual(shared.payload.settings.queue.accounts,{});
});

test('invalid nested settings and fingerprint parameters are rejected even when keeping local values', async t => {
  const {favorites,config}=await setup(t);await favorites.save({modelId:'fixture/one'});
  for(const mutate of [doc=>doc.payload.settings.manual.candy.timeoutMs=-1,doc=>doc.payload.settings.retention.days=0,doc=>doc.payload.favorites[0].fingerprint.strict='yes',doc=>doc.payload.favorites[0].parameters.maxTokens=-1]){
    const document=config.export();mutate(document);document.digest=transfer.configDigest(document.payload);
    await assert.rejects(config.preview({document}),error=>error.status===400);
  }
});

test('ordinary IO failure after committed adopts the complete new state and permits later CAS writes', async t => {
  const {settings,config}=await setup(t),document=config.export();document.payload.settings.progressNotice.enabled=false;document.digest=transfer.configDigest(document.payload);
  const preview=await config.preview({document,choices:{settings:{progressNotice:'overwrite'}}});
  config.io.step=async(stage,action)=>{await action();if(stage==='committed')throw Error('late IO failure');};
  const result=await config.apply({token:preview.token,confirm:true});
  assert.equal(result.applied,true);assert.equal(settings.snapshot().progressNotice.enabled,false);
  await settings.save({expectedRevision:settings.snapshot().revision,patch:{progressNotice:{enabled:true}}});
});

test('successful configuration imports do not accumulate completed recovery snapshots', async t => {
  const { config, dir } = await setup(t);
  for (let index = 0; index < 3; index++) {
    const preview = await config.preview({ document: config.export() });
    await config.apply({ token: preview.token, confirm: true });
  }
  assert.deepEqual(await readdir(join(dir, '.imports')), [], 'Completed snapshots and archived journals have no later recovery use');
});

test('runner rejects new mutations while committing configuration maintenance', async t => {
  const {runner,seen}=await setup(t);runner.maintenance=true;
  await assert.rejects(runner.submit({kind:'candy',models:[{id:'fixture/one'}]}),error=>error.status===409);
  assert.equal(seen.length,0);runner.maintenance=false;
});

test('configuration preview refuses a complete candidate larger than the destination settings limit', async t => {
  const { settings, config, dir } = await setup(t), document = config.export(); const before = await readFile(join(dir, '.settings/state.json'));
  document.payload.settings.presets = Array.from({ length: 35 }, (_, i) => ({ id: randomUUID(), kind: 'pelican', name: '导入预设 ' + i, parameters: { ...document.payload.settings.manual.pelican, prompt: '备'.repeat(12000) }, createdAt: '2026-11-22T00:00:00Z', updatedAt: '2026-11-22T00:00:00Z' }));
  document.digest = transfer.configDigest(document.payload);
  assert.ok(Buffer.byteLength(JSON.stringify(document, null, 2)) < 2 * 1024 * 1024);
  await assert.rejects(config.preview({ document, choices: { settings: { presets: 'overwrite' } } }), error => error.status === 413);
  assert.deepEqual(await readFile(join(dir, '.settings/state.json')), before); assert.equal(settings.recoveryError, '');
});

test('ordinary pre-commit and replacement IO failures restore both files and allow a later save', async t => {
  for (const point of ['prepared', 'replaced:settings', 'replaced:favorites']) {
    const { config, settings, favorites, dir } = await setup(t), document = config.export(); document.payload.settings.progressNotice.enabled = false; document.digest = transfer.configDigest(document.payload);
    const oldSettings = await readFile(join(dir, '.settings/state.json')), oldFavorites = await readFile(join(dir, '.favorites/state.json'));
    const preview = await config.preview({ document, choices: { settings: { progressNotice: 'overwrite' } } });
    config.io.step = async (stage, action) => { await action(); if (stage === point) throw Error('ordinary replacement failure'); };
    await assert.rejects(config.apply({ token: preview.token, confirm: true }), /ordinary/);
    assert.deepEqual(await readFile(join(dir, '.settings/state.json')), oldSettings); assert.deepEqual(await readFile(join(dir, '.favorites/state.json')), oldFavorites);
    assert.equal(config.recoveryError, ''); assert.equal(favorites.recoveryError, '');
    await settings.save({ expectedRevision: settings.snapshot().revision, patch: { progressNotice: { enabled: false } } });
  }
});
