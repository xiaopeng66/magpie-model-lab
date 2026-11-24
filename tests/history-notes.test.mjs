import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Annotations } from '../lib/annotations.mjs';
import { temporary } from './helpers.mjs';
const search=await import('../lib/history-index.mjs').catch(()=>({}));

test('notes migrate annotations to schema 2 and local record CAS merges unrelated edits',async t=>{
  const dir=await temporary(t),annotations=new Annotations(dir);await annotations.init();t.after(()=>annotations.close());const a=randomUUID(),b=randomUUID();
  await annotations.save({runId:a,expectedRevision:0,protected:true});
  const first=await annotations.save({runId:a,expectedRunRevision:0,note:'需要再核对'});
  const other=await annotations.save({runId:b,expectedRunRevision:0,note:'另一条'});
  assert.equal(first.annotation.note,'需要再核对');assert.equal(first.annotation.protected,true);assert.equal(other.annotation.note,'另一条');assert.equal(annotations.snapshot().schema,2);
  await assert.rejects(annotations.save({runId:a,expectedRunRevision:0,note:'过期草稿'}),error=>error.status===409);
  await annotations.save({runId:a,expectedRunRevision:first.runRevision,protected:false});assert.equal(annotations.detail(a).annotation.note,'需要再核对');assert.equal(Object.hasOwn(annotations.detail(a).annotation,'tags'),false);
  assert.ok(annotations.projection([a,b]).byRunId[a]);
  const recovered=new Annotations(dir);await recovered.init();t.after(()=>recovered.close());assert.equal(recovered.detail(a).annotation.note,'需要再核对');
  const disk=JSON.parse(await readFile(join(dir,'.annotations','state.json'),'utf8'));assert.equal(disk.schema,2);
});

test('note limits are enforced without changing unrelated annotations or output',async t=>{
  const annotations=new Annotations(await temporary(t));await annotations.init();t.after(()=>annotations.close());const id=randomUUID();
  for(const patch of [{note:'字'.repeat(2001)},{note:'含有\u0000控制字符'},{restoreProtection:false}])await assert.rejects(annotations.save({runId:id,expectedRunRevision:0,...patch}),error=>error.status===400);
  assert.equal(annotations.revision,0);
  await annotations.save({runId:id,expectedRunRevision:0,note:'<script>plain text</script>'});assert.equal(annotations.detail(id).annotation.note,'<script>plain text</script>');
  await annotations.save({runId:id,expectedRunRevision:1,note:'🙂'.repeat(2000)});assert.equal([...annotations.detail(id).annotation.note].length,2000);
});

test('light history search filters metadata and annotations without touching output bodies',()=>{
  assert.equal(typeof search.historyMatches,'function');
  const id=randomUUID(),other=randomUUID(),a={id,model:'fixture/one',modelName:'Model One',kind:'candy',status:'completed',createdAt:'2026-11-22T08:00:00Z',accountTarget:{mode:'pinned',id:'a',name:'主账号'},grade:{verdict:'mismatch',answer:7,expected:42}};
  Object.defineProperties(a,{content:{get(){throw Error('must not load body');}},reasoning:{get(){throw Error('must not load reasoning');}}});
  const annotation={protected:true,note:'还要核对时间'},otherRecord={id:other,model:'fixture/two',kind:'pelican',status:'error',createdAt:'2026-11-21T00:00:00Z'};
  const filters={model:'one',account:'主账号',kind:'candy',result:'mismatch',protected:true,note:'时间',from:'2026-11-22T00:00:00Z',to:'2026-11-23T00:00:00Z'};
  assert.equal(search.historyMatches(a,annotation,filters),true);assert.equal(search.historyMatches(otherRecord,{},filters),false);
  assert.equal(search.historyMatches(a,annotation,{text:'must not load body'}),false);assert.equal(search.historyMatches(a,annotation,{text:'核对'}),true);
});
