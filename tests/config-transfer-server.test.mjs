import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { startTestServer, fakeGateway, temporary, waitFor } from './helpers.mjs';
import { configDigest } from '../lib/config-transfer.mjs';
const auth=async service=>{'use strict';const html=await(await fetch(service.url)).text();return {'x-pelican-token':html.match(/name="pelican-token" content="([^"]+)"/)[1],'content-type':'application/json'};};

test('bootstrap disables configuration migration when protection storage needs recovery', async t => {
  const dir = await temporary(t), upstream = await fakeGateway(t), path = join(dir, '.annotations', 'state.json');
  await mkdir(join(dir, '.annotations')); await writeFile(path, 'unreadable protection index');
  const service = await startTestServer({ port: 0, dataDir: dir, gatewayUrl: upstream.url }); t.after(() => service.close());
  const headers = await auth(service), boot = await (await fetch(service.url + 'api/bootstrap', { headers })).json();
  assert.equal(boot.configAvailable, false); assert.equal(boot.cleanupPaused, true); assert.ok(boot.annotationsError);
  assert.equal((await fetch(service.url + 'api/config/export', { method: 'POST', headers, body: '{}' })).status, 503);
  assert.equal(await readFile(path, 'utf8'), 'unreadable protection index'); assert.equal(upstream.seen.requests.length, 0);
});

test('authenticated configuration routes accept 2 MiB previews while ordinary APIs remain 64 KiB',async t=>{
  const dir=await temporary(t),upstream=await fakeGateway(t),service=await startTestServer({port:0,dataDir:dir,gatewayUrl:upstream.url});t.after(()=>service.close());const headers=await auth(service);
  const post=(path,body,authHeaders=headers)=>fetch(service.url+'api/'+path,{method:'POST',headers:authHeaders,body:JSON.stringify(body)});
  assert.equal((await post('config/export',{},{})).status,403);
  const response=await post('config/export',{shareMode:true});assert.equal(response.status,200);const document=await response.json();
  assert.equal(document.schema,'model-lab-config-v1');
  for(let i=0;i<12;i++)document.payload.settings.presets.push({id:`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`,kind:'pelican',name:'preset '+i,parameters:{...document.payload.settings.manual.pelican,prompt:'x'.repeat(8000)},createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
  document.digest=configDigest(document.payload);
  const preview=await post('config/import/preview',{document});assert.equal(preview.status,200);const result=await preview.json();assert.ok(result.token);
  assert.equal((await post('config/import/apply',{token:result.token,confirm:true})).status,200);
  assert.equal((await post('settings/save',{extra:'x'.repeat(65536)})).status,413);
  assert.equal((await post('config/import/preview',{document,extra:'x'.repeat(3*1024*1024)})).status,413);
  assert.equal(upstream.seen.requests.length,0);
});

test('near-limit config files retain bounded space for account rebinding and conflict choices', async t => {
  const dir = await temporary(t), upstream = await fakeGateway(t), service = await startTestServer({ port: 0, dataDir: dir, gatewayUrl: upstream.url }); t.after(() => service.close()); const headers = await auth(service);
  const post = (path, body) => fetch(service.url + 'api/' + path, { method: 'POST', headers, body: JSON.stringify(body) });
  await post('favorites/save', { modelId: 'fixture/one' }); const document = await (await post('config/export', {})).json(), base = document.payload.favorites[0];
  document.payload.favorites = Array.from({ length: 500 }, (_, i) => ({ ...structuredClone(base), sourceRef: 'target-' + (i + 1), account: { mode: 'rebind' }, fingerprintAccount: { mode: 'rebind' } }));
  for (const favorite of document.payload.favorites) favorite.parameters.prompt = '';
  const room = Math.floor((2 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(document, null, 2)) - 2048) / 500);
  for (const favorite of document.payload.favorites) favorite.parameters.prompt = 'x'.repeat(room);
  document.digest = configDigest(document.payload);
  const choices = { targets: Object.fromEntries(document.payload.favorites.map(f => [f.sourceRef, 'skip'])) }, bindings = Object.fromEntries(document.payload.favorites.map(f => [f.sourceRef, { account: { mode: 'pinned', id: 'a'.repeat(256) }, fingerprintAccount: { mode: 'pinned', id: 'b'.repeat(256) } }]));
  const input = { document, choices, bindings }; assert.ok(Buffer.byteLength(JSON.stringify(document, null, 2)) < 2 * 1024 * 1024); assert.ok(Buffer.byteLength(JSON.stringify(input)) > 2 * 1024 * 1024);
  const response = await post('config/import/preview', input); assert.equal(response.status, 200); assert.ok((await response.json()).token); assert.equal(upstream.seen.requests.length, 0);
});

test('an open save operation excludes config apply and other saves until it is cancelled', async t => {
  let finishSave;
  const dir = await temporary(t), upstream = await fakeGateway(t), service = await startTestServer({ port: 0, dataDir: dir, gatewayUrl: upstream.url, saveExport: () => new Promise(resolve => { finishSave = resolve; }) }); t.after(() => service.close());
  const headers = await auth(service), post = (path, body) => fetch(service.url + 'api/' + path, { method: 'POST', headers, body: JSON.stringify(body) });
  const document = await (await post('config/export', {})).json(), preview = await (await post('config/import/preview', { document })).json();
  const saving = post('config/save', {}); await waitFor(() => finishSave);
  for (const [path, value] of [['config/import/apply', { token: preview.token, confirm: true }], ['config/save', {}]]) assert.equal((await post(path, value)).status, 409);
  finishSave({ cancelled: true }); assert.equal((await (await saving).json()).cancelled, true);
  assert.equal((await post('config/import/apply', { token: preview.token, confirm: true })).status, 200); assert.equal(upstream.seen.requests.length, 0);
});

test('invalid startup journal preserves history and blocks configuration, cleanup and generation',async t=>{
  const dir=await temporary(t),upstream=await fakeGateway(t);
  await mkdir(join(dir,'.imports'));const path=join(dir,'.imports','journal.json');await writeFile(path,'{"schema":"unknown"}');
  const service=await startTestServer({port:0,dataDir:dir,gatewayUrl:upstream.url});t.after(()=>service.close());const headers=await auth(service);
  const boot=await(await fetch(service.url+'api/bootstrap',{headers})).json();assert.ok(boot.recovery.configError);assert.equal(boot.cleanupPaused,true);
  for(const [route,body]of [['runs',{kind:'candy',models:[{id:'fixture/one'}]}],['runs/cleanup',{mode:'all'}],['settings/save',{expectedRevision:0,patch:{progressNotice:{enabled:false}}}],['favorites/save',{modelId:'fixture/one'}]])assert.equal((await fetch(service.url+'api/'+route,{method:'POST',headers,body:JSON.stringify(body)})).status,503);
  assert.equal(await readFile(path,'utf8'),'{"schema":"unknown"}');assert.equal(upstream.seen.requests.length,0);
});
