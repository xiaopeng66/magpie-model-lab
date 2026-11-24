import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { mkdir, lstat, readFile, open, rename, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { invalid, safeError } from './gateway.mjs';
import { normalizeTarget, normalizeAccount, identityHash } from './targets.mjs';
import { restoreFavoritesState, validateSchedule } from './favorites.mjs';
import { normalizeParameters } from './test-parameters.mjs';
import { dailyTimes } from './scheduler.mjs';
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const white=(value,keys)=>Object.fromEntries(keys.filter(k=>Object.hasOwn(value,k)).map(k=>[k,structuredClone(value[k])]));
const rejectKeys=(value,keys)=>{if(!object(value)||Object.keys(value).some(k=>!keys.includes(k)))throw invalid('配置含未知字段或无效对象');};
export const configDigest=value=>identityHash(JSON.stringify(value));
const byteHash=bytes=>createHash('sha256').update(bytes).digest('hex');
const kinds=['candy','pelican'];
const parameterFields=['effort','maxTokens','timeoutMs','prompt','concurrency'];
const scheduleFields=['name','mode','times','intervalMinutes','start','end','allDay','days','timeZone'];
const settingFields=['manual','presets','retention','progressNotice','queue'];
const pathsFor=root=>({settings:join(root,'.settings','state.json'),favorites:join(root,'.favorites','state.json')});
async function ordinary(path,limit=2*1024*1024){const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>limit)throw invalid('配置事务文件不是允许大小内的普通文件',503);return readFile(path);}
async function directory(path){for(let at=path;;at=dirname(at)){const stat=await lstat(at);if(!stat.isDirectory()||stat.isSymbolicLink())throw invalid('配置事务路径不是普通目录',503);if(dirname(at)===at)break;}}
async function durableWrite(path,bytes){await directory(dirname(path));try{await ordinary(path);}catch(error){if(error.code!=='ENOENT')throw error;}const temp=path+'.'+randomUUID()+'.tmp',file=await open(temp,'wx',0o600);try{try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}await rename(temp,path);}finally{await unlink(temp).catch(()=>{});}}
const journalPath=root=>join(root,'.imports','journal.json');
export async function recoverConfigJournal(root){
  const path=journalPath(root);let bytes;try{bytes=await ordinary(path);}catch(error){if(error.code==='ENOENT')return{recoveryError:''};return{recoveryError:safeError(error)};}
  try{
    await directory(root);await directory(dirname(path));const journal=JSON.parse(bytes),fixed=pathsFor(root);
    if(journal.schema!=='model-lab-config-journal-v1'||!['prepared','committed'].includes(journal.phase)||!/^[a-f0-9-]{36}$/.test(journal.id||'')||!Array.isArray(journal.files)||journal.files.length!==2||new Set(journal.files.map(f=>f.kind)).size!==2)throw invalid('配置恢复 journal 无效');
    const backups=[];
    for(const f of journal.files){if(!Object.hasOwn(fixed,f.kind)||!['oldHash','newHash'].every(k=>/^[a-f0-9]{64}$/.test(f[k]||''))||f.backup!==`${journal.id}-${f.kind}-old.json`||f.staged!==`${journal.id}-${f.kind}-new.json`)throw invalid('配置恢复引用无效');await directory(dirname(fixed[f.kind]));const hash=byteHash(await ordinary(fixed[f.kind]));if(![f.oldHash,f.newHash].includes(hash)||journal.phase==='committed'&&hash!==f.newHash)throw invalid('配置文件出现未知摘要，未覆盖外部修改');const backup=await ordinary(join(dirname(path),f.backup));if(byteHash(backup)!==f.oldHash)throw invalid('配置恢复备份摘要不符');backups.push({path:fixed[f.kind],bytes:backup});}
    if(journal.phase==='prepared')for(const backup of backups)await durableWrite(backup.path,backup.bytes);
    await rename(path,join(dirname(path),`journal-${journal.id}-${journal.phase}.json`));return{recoveryError:'',recovered:journal.phase==='committed'?'new':'old'};
  }catch(error){return{recoveryError:'配置事务恢复失败，写入与调度已暂停：'+safeError(error)};}
}
export class ConfigTransfer {
  constructor({settings,favorites,runner,scheduler,dir=runner.store.dir,isExternalBusy=()=>false,now=Date.now,io={}}){this.settings=settings;this.favorites=favorites;this.runner=runner;this.scheduler=scheduler;this.dir=dir;this.isExternalBusy=isExternalBusy;this.now=now;this.tokens=new Map();this.maintaining=false;this.recoveryError='';this.io={step:async(_stage,action)=>action(),...io};}
  export({shareMode=false}={}){
    if(typeof shareMode!=='boolean')throw invalid('分享模式无效');const state=this.favorites.state,refs=new Map(state.favorites.map((f,i)=>[f.id,`target-${i+1}`]));
    const payload={settings:white(this.settings.snapshot(),settingFields),favorites:state.favorites.map(f=>({sourceRef:refs.get(f.id),modelId:f.modelId,account:shareMode&&f.account.mode==='pinned'?{mode:'rebind'}:structuredClone(f.account),parameters:white(f,parameterFields),fingerprint:white(f.fingerprint,['api','strict','serviceTier']),...(f.fingerprint.account?{fingerprintAccount:shareMode?{mode:'rebind'}:{mode:'pinned',id:f.fingerprint.account}}:{})})),plans:state.plans.map((p,i)=>({sourceRef:`plan-${i+1}`,favoriteRef:refs.get(p.favoriteIds[0]),kind:p.kinds[0],...white(p,scheduleFields)}))};
    if (shareMode && payload.settings.queue) payload.settings.queue.accounts = {};
    const document = {schema:'model-lab-config-v1',pluginVersion:'1.0.6',exportedAt:new Date(this.now()).toISOString(),payload,digest:configDigest(payload)};
    if (Buffer.byteLength(JSON.stringify(document, null, 2)) > 2 * 1024 * 1024) throw invalid('配置导出超过 2 MiB，请减少预设或收藏规模', 413);
    return document;
  }
  validate(document) {
    if (Buffer.byteLength(JSON.stringify(document, null, 2)) > 2 * 1024 * 1024) throw invalid('配置文件超过 2 MiB', 413);
    rejectKeys(document, ['schema', 'pluginVersion', 'exportedAt', 'payload', 'digest']);
    if (document.schema !== 'model-lab-config-v1' || document.digest !== configDigest(document.payload)) throw invalid('配置版本未知或内容摘要不符');
    rejectKeys(document.payload, ['settings', 'favorites', 'plans']);
    const payload = structuredClone(document.payload);
    rejectKeys(payload.settings, [...settingFields, 'budget']);
    // RYP: old signed config files remain importable, but cannot restore removed quotas.
    delete payload.settings.budget;
    const settings = { ...this.settings.snapshot(), ...structuredClone(payload.settings) };
    if (settings.queue) settings.schema = 2;
    this.settings.validate(settings);
    if (!Array.isArray(payload.favorites) || payload.favorites.length > 500 || !Array.isArray(payload.plans) || payload.plans.length > 1000) throw invalid('配置目标或计划格式无效或超出数量限制');
    const refs = new Set();
    for (const f of payload.favorites) {
      rejectKeys(f, ['sourceRef', 'modelId', 'account', 'parameters', 'fingerprint', 'fingerprintAccount']);
      if (typeof f.sourceRef !== 'string' || !/^target-\d+$/.test(f.sourceRef) || refs.has(f.sourceRef)) throw invalid('配置目标关联重复或无效');
      refs.add(f.sourceRef); rejectKeys(f.parameters, parameterFields); rejectKeys(f.fingerprint, ['api', 'strict', 'serviceTier']);
      if (f.account?.mode === 'rebind') rejectKeys(f.account, ['mode']);
      else normalizeTarget(f);
      if (f.fingerprintAccount?.mode === 'rebind') rejectKeys(f.fingerprintAccount, ['mode']);
      else if (f.fingerprintAccount) normalizeAccount(f.fingerprintAccount);
      if (f.parameters.concurrency) rejectKeys(f.parameters.concurrency, ['pelican', 'candy', 'fingerprint']);
      restoreFavoritesState({ schema: 3, revision: 0, enabled: true, concurrency: 3, plans: [], claims: [], favorites: [{
        ...f.parameters, ...normalizeTarget({ modelId: f.modelId, account: f.account.mode === 'rebind' ? { mode: 'auto' } : f.account }), id: randomUUID(),
        fingerprint: { ...f.fingerprint, account: f.fingerprintAccount?.mode === 'pinned' ? f.fingerprintAccount.id : '' },
      }] });
    }
    const plans = new Set(), pairs = new Set();
    for (const p of payload.plans) {
      rejectKeys(p, ['sourceRef', 'favoriteRef', 'kind', ...scheduleFields]);
      const pair = `${p.favoriteRef}:${p.kind}`;
      if (!/^plan-\d+$/.test(p.sourceRef || '') || plans.has(p.sourceRef) || pairs.has(pair) || !refs.has(p.favoriteRef) || !kinds.includes(p.kind)) throw invalid('配置计划关联重复或无效');
      plans.add(p.sourceRef); pairs.add(pair); validateSchedule({ ...p, enabled: false }); dailyTimes(p);
    }
    return payload;
  }
  async preview(input){
    rejectKeys(input,['document','choices','bindings']);const payload=this.validate(input.document),choices=input.choices||{},bindings=input.bindings||{};rejectKeys(choices,['targets','plans','settings']);for(const group of ['targets','plans','settings'])if(choices[group]!=null&&!object(choices[group]))throw invalid('冲突选择无效');if(!object(bindings))throw invalid('账号绑定选择无效');
    const beforeSettings=this.settings.snapshot(),beforeFavorites=structuredClone(this.favorites.state),nextSettings=structuredClone(beforeSettings),nextFavorites=structuredClone(beforeFavorites),catalog=new Map((await this.runner.models()).map(m=>[m.id,m])),unresolved=[],differences=[],mapping=new Map(),affected=new Set(),at=new Date(this.now()).toISOString();
    for(const [key,value]of Object.entries(payload.settings)){
      const choice=choices.settings?.[key]||'keep';if(!['keep','overwrite','merge'].includes(choice))throw invalid('设置冲突选择无效');if(choice==='keep')continue;
      if(key==='presets') {if(!Array.isArray(value))throw invalid('预设格式无效');for(const p of value){rejectKeys(p,['id','name','kind','parameters','createdAt','updatedAt']);const old=nextSettings.presets.find(x=>x.kind===p.kind&&x.name===p.name);if(old&&choice==='merge')continue;const next={id:old?.id||randomUUID(),name:p.name,kind:p.kind,parameters:normalizeParameters(p.kind,p.parameters,{defaultPrompt:this.settings.defaultPrompt}),createdAt:old?.createdAt||at,updatedAt:at};if(old)nextSettings.presets[nextSettings.presets.indexOf(old)]=next;else nextSettings.presets.push(next);}}
      else nextSettings[key]=structuredClone(value);
    }
    if(nextSettings.queue)nextSettings.schema=2;
    for(const item of payload.favorites){
      const action=choices.targets?.[item.sourceRef]||'keep';if(!['keep','overwrite','skip'].includes(action))throw invalid('目标冲突选择无效');if(action==='skip'){differences.push({sourceRef:item.sourceRef,action:'skip'});continue;}
      const binding=bindings[item.sourceRef]||{},account=item.account.mode==='rebind'?binding.account:item.account;
      if(!account){unresolved.push({sourceRef:item.sourceRef,code:'binding',modelId:item.modelId});continue;}
      const target=normalizeTarget({modelId:item.modelId,account}),old=nextFavorites.favorites.find(f=>f.targetKey===target.targetKey),model=catalog.get(item.modelId);
      if(!model){unresolved.push({sourceRef:item.sourceRef,code:'model_unavailable',modelId:item.modelId});continue;}
      try{if(target.account.mode==='pinned')target.account=await this.runner.gateway.assertAccount(model.provider,target.account);}catch(error){unresolved.push({sourceRef:item.sourceRef,code:'account_unavailable',modelId:item.modelId,reason:safeError(error)});continue;}
      if([...mapping.values()].includes(old?.id||target.targetKey)){unresolved.push({sourceRef:item.sourceRef,code:'duplicate_target',modelId:item.modelId});continue;}
      let fpAccount=item.fingerprintAccount?.mode==='rebind'?binding.fingerprintAccount:item.fingerprintAccount;
      if(item.fingerprintAccount&&!fpAccount){unresolved.push({sourceRef:item.sourceRef,code:'fingerprint_binding',modelId:item.modelId});continue;}
      if(fpAccount){fpAccount=normalizeAccount(fpAccount);if(fpAccount.mode==='pinned')try{await this.runner.gateway.assertAccount(model.provider,fpAccount);}catch(error){unresolved.push({sourceRef:item.sourceRef,code:'fingerprint_account_unavailable',reason:safeError(error)});continue;}}
      if(old&&action==='keep'){mapping.set(item.sourceRef,old.id);differences.push({sourceRef:item.sourceRef,action:'keep',favoriteId:old.id});continue;}
      const incoming={...item.parameters,modelId:item.modelId,account:target.account,fingerprint:{...item.fingerprint,account:fpAccount?.id||''},...(old?{id:old.id}:{})};
      const favorite=this.favorites.applyFavorite(nextFavorites,incoming,model);mapping.set(item.sourceRef,favorite.id);differences.push({sourceRef:item.sourceRef,action:old?'overwrite':'add',favoriteId:favorite.id});
      if(old&&configDigest(white(old,[...parameterFields,'fingerprint']))!==configDigest(white(favorite,[...parameterFields,'fingerprint'])))for(const p of nextFavorites.plans)if(p.favoriteIds.includes(old.id))affected.add(p.id);
    }
    for(const item of payload.plans){const id=mapping.get(item.favoriteRef);if(!id)continue;const old=nextFavorites.plans.find(p=>p.favoriteIds[0]===id&&p.kinds[0]===item.kind),action=choices.plans?.[item.sourceRef]||'keep';if(!['keep','overwrite','skip'].includes(action))throw invalid('计划冲突选择无效');if(action==='skip'||old&&action==='keep')continue;const p={...white(item,scheduleFields),id:old?.id||randomUUID(),revision:(old?.revision||0)+1,favoriteIds:[id],kinds:[item.kind],enabled:false,resumeAfter:at};if(old)nextFavorites.plans[nextFavorites.plans.indexOf(old)]=p;else nextFavorites.plans.push(p);affected.add(p.id);}
    for(const p of nextFavorites.plans)if(affected.has(p.id)){p.enabled=false;p.resumeAfter=at;if(beforeFavorites.plans.some(old=>old.id===p.id&&old.revision===p.revision))p.revision++;}
    if(configDigest(nextSettings)!==configDigest(beforeSettings))nextSettings.revision++;
    if(configDigest(nextFavorites)!==configDigest(beforeFavorites))nextFavorites.revision++;
    this.settings.validate(nextSettings);restoreFavoritesState(nextFavorites);
    for (const [file, state] of [[this.settings.file, nextSettings], [this.favorites.file, nextFavorites]]) if (Buffer.byteLength(JSON.stringify(state, null, 2)) > file.maxBytes) throw invalid('导入后的完整配置超过本地状态大小限制，请减少预设或收藏规模', 413);
    let retentionImpact=null;
    if(nextSettings.retention.days!==null&&(beforeSettings.retention.days===null||nextSettings.retention.days<beforeSettings.retention.days))retentionImpact=await this.runner.previewRetention({days:nextSettings.retention.days});
    if(this.settings.snapshot().revision!==beforeSettings.revision||this.favorites.state.revision!==beforeFavorites.revision)throw invalid('预览期间配置已变化，请重新预览',409);
    const base={settingsRevision:beforeSettings.revision,favoritesRevision:beforeFavorites.revision,settingsHash:configDigest(beforeSettings),favoritesHash:configDigest(beforeFavorites)},candidateDigest=configDigest({settings:nextSettings,favorites:nextFavorites});
    const token=unresolved.length?null:randomBytes(32).toString('hex');if(token){for(const [key,value]of this.tokens)if(value.expires<this.now())this.tokens.delete(key);if(this.tokens.size>=20)this.tokens.delete(this.tokens.keys().next().value);this.tokens.set(token,{base,settings:nextSettings,favorites:nextFavorites,candidateDigest,choicesDigest:configDigest({choices,bindings}),retentionImpact,expires:this.now()+300000});}
    return{token,unresolved,differences,pausedPlanIds:[...affected],retentionImpact,candidateDigest,...base};
  }
  async apply(input){
    rejectKeys(input,['token','confirm','confirmRetention']);const preview=this.tokens.get(input.token);if(!preview||preview.expires<this.now())throw invalid('配置预览 token 已失效，请重新预览',409);if(input.confirm!==true)throw invalid('请确认最终配置影响');if(preview.retentionImpact&&input.confirmRetention!==true)throw invalid('请明确确认保留期限缩短的长期清理影响');if(this.maintaining||this.isExternalBusy())throw invalid('已有维护或导出操作，请完成后重试',409);
    this.maintaining=true;if(this.scheduler)this.scheduler.paused=true;
    try{
      await this.scheduler?.pending;await this.favorites.dispatches;await this.favorites.pending;await this.settings.file.pending;await this.runner.annotations?.file.pending;await this.runner.submissions;
      if(this.runner.queue.length||this.runner.active.size||this.runner.pendingFinishes.size||this.isExternalBusy())throw invalid('请等待任务结束后恢复配置',409);
      const current=this.settings.snapshot();if(preview.base.settingsHash!==configDigest(current)||preview.base.favoritesHash!==configDigest(this.favorites.state))throw invalid('本地配置已变化，请重新预览',409);
      this.runner.maintenance=true;
      if(preview.retentionImpact){const old=this.runner.retentionPreviews.context(preview.retentionImpact.previewToken);this.runner.retentionPreviews.verify(preview.retentionImpact.previewToken,this.runner.retentionContext(preview.settings.retention.days,old.previewAt));}
      await this.commit(preview);
      this.settings.file.data=structuredClone(preview.settings);this.favorites.file.data=structuredClone(preview.favorites);this.favorites.state=structuredClone(preview.favorites);this.runner.automaticConcurrency=preview.favorites.concurrency;this.tokens.delete(input.token);if(preview.retentionImpact)this.runner.retentionPreviews.consume(preview.retentionImpact.previewToken);this.runner.emit('favorites',{});this.runner.emit('settings_changed',{revision:preview.settings.revision,changedGroups:settingFields});return{applied:true,candidateDigest:preview.candidateDigest,pausedPlanIds:preview.favorites.plans.filter(p=>p.resumeAfter&&p.enabled===false).map(p=>p.id)};
    }finally{this.maintaining=false;if(!this.recoveryError){this.runner.maintenance=false;if(this.scheduler){this.scheduler.lastMinute=Math.floor(this.now()/60000);this.scheduler.paused=false;}}}
  }
  async commit(preview){
    const imports=join(this.dir,'.imports');try{await mkdir(imports);}catch(error){if(error.code!=='EEXIST')throw error;}await directory(imports);const id=randomUUID(),fixed=pathsFor(this.dir),files=[];
    for(const kind of ['settings','favorites']){const old=await ordinary(fixed[kind]),next=Buffer.from(JSON.stringify(preview[kind],null,2)),backup=`${id}-${kind}-old.json`,staged=`${id}-${kind}-new.json`;await durableWrite(join(imports,backup),old);await durableWrite(join(imports,staged),next);files.push({kind,oldHash:byteHash(old),newHash:byteHash(next),backup,staged});}
    const journal={schema:'model-lab-config-journal-v1',id,phase:'prepared',files};
    try{
      await this.io.step('prepared',()=>durableWrite(journalPath(this.dir),Buffer.from(JSON.stringify(journal,null,2))));
      for(const f of files)await this.io.step(`replaced:${f.kind}`,async()=>{if(byteHash(await ordinary(fixed[f.kind]))!==f.oldHash)throw invalid('配置文件已由外部修改',409);await rename(join(imports,f.staged),fixed[f.kind]);});
      journal.phase='committed';await this.io.step('committed',()=>durableWrite(journalPath(this.dir),Buffer.from(JSON.stringify(journal,null,2))));
      const result=await recoverConfigJournal(this.dir);if(result.recoveryError)throw invalid(result.recoveryError,503);
    }catch(error){if(error.crash){this.recoveryError='配置提交中断，需启动恢复 journal';throw error;}const result=await recoverConfigJournal(this.dir);if(result.recoveryError){this.recoveryError=result.recoveryError;this.settings.file.pause(result.recoveryError);this.favorites.recoveryError=result.recoveryError;}if(!result.recoveryError&&result.recovered==='new')return;throw error;}
  }
}
