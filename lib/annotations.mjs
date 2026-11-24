import { StateFile } from './state-file.mjs';
import { invalid } from './gateway.mjs';
import { UUID } from './store.mjs';
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const revision = value => Number.isSafeInteger(value) && value >= 0;
const meaningful = value => value && (value.protected || value.restoreProtection || value.note);
// Read old protection safely; explicit protection changes use the ordinary switch.
const visibleAnnotation = annotation => { const { restoreProtection, tags, ...value } = structuredClone(annotation); value.protected ||= restoreProtection === true; return value; };
function validateText(value) {
  if (value.note != null && (typeof value.note !== 'string' || [...value.note].length > 2000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value.note))) throw invalid('备注最多 2000 字，需为普通文本');
}
export function validateAnnotations(value) {
  if (!object(value) || ![1, 2].includes(value.schema) || !revision(value.revision) || Object.keys(value).some(key => !['schema', 'revision', 'byRunId'].includes(key)) || !object(value.byRunId)) throw invalid('不支持的记录注释格式');
  for (const [id, annotation] of Object.entries(value.byRunId)) {
    if (!UUID.test(id) || !object(annotation) || typeof annotation.updatedAt !== 'string' || !Number.isFinite(Date.parse(annotation.updatedAt))) throw invalid('记录注释索引无效');
    if (value.schema === 1) { if (annotation.protected !== true || Object.keys(annotation).some(key => !['protected', 'updatedAt'].includes(key))) throw invalid('记录保护索引无效'); }
    else {
      if (typeof annotation.protected !== 'boolean' || !revision(annotation.revision) || Object.hasOwn(annotation, 'restoreProtection') && typeof annotation.restoreProtection !== 'boolean' || Object.keys(annotation).some(key => !['protected', 'note', 'tags', 'restoreProtection', 'revision', 'updatedAt'].includes(key))) throw invalid('记录注释字段无效');
      validateText(annotation);
      // RYP: legacy tags are read-only compatibility; views and new writes omit them.
      if (annotation.tags != null && (!Array.isArray(annotation.tags) || annotation.tags.length > 10 || new Set(annotation.tags).size !== annotation.tags.length || annotation.tags.some(tag => typeof tag !== 'string' || !tag.trim() || [...tag].length > 20 || /[\x00-\x1f\x7f]/.test(tag)))) throw invalid('旧版记录注释格式无效');
    }
  }
  return value;
}
const recordDefaults = () => ({ protected: false, note: '', revision: 0 });
function upgrade(state) {
  if (state.schema === 2) return;
  state.schema = 2;
  for (const [id, value] of Object.entries(state.byRunId)) state.byRunId[id] = { ...recordDefaults(), ...value };
}
export class Annotations {
  constructor(dataDir) { this.file = new StateFile(dataDir, '.annotations', { schema: 1, revision: 0, byRunId: {} }, validateAnnotations, { maxBytes: 64 * 1024 * 1024, label: '记录注释' }); }
  get revision() { return this.file.data.revision; }
  get recoveryError() { return this.file.recoveryError; }
  init() { return this.file.init(); }
  snapshot() { return this.file.snapshot(); }
  isProtected(id) { const value = this.file.data.byRunId[id]; return value?.protected === true || value?.restoreProtection === true; }
  detail(runId) { const value = this.file.data.byRunId[runId]; return { revision: this.revision, runId, runRevision: value?.revision || 0, annotation: meaningful(value) ? visibleAnnotation(value) : null }; }
  projection(scopeRunIds) { return { revision: this.revision, scopeRunIds: [...scopeRunIds], runRevisions: Object.fromEntries(scopeRunIds.filter(id => this.file.data.byRunId[id]?.revision > 0).map(id => [id, this.file.data.byRunId[id].revision])), byRunId: Object.fromEntries(scopeRunIds.filter(id => meaningful(this.file.data.byRunId[id])).map(id => [id, visibleAnnotation(this.file.data.byRunId[id])])) }; }
  save(request) {
    const input = structuredClone(request);
    return this.file.enqueue(async () => {
      if (!object(input) || Object.keys(input).some(key => !['runId', 'expectedRevision', 'expectedRunRevision', 'protected', 'note'].includes(key)) || !UUID.test(input.runId || '') ||
        Object.hasOwn(input, 'protected') && typeof input.protected !== 'boolean' || Object.hasOwn(input, 'note') && typeof input.note !== 'string' || !['protected', 'note'].some(key => Object.hasOwn(input, key))) throw invalid('记录注释参数无效');
      validateText(input);
      if (input.expectedRunRevision != null) {
        if (!revision(input.expectedRunRevision)) throw invalid('记录注释 revision 无效');
        if (input.expectedRunRevision !== (this.file.data.byRunId[input.runId]?.revision || 0)) throw invalid('此记录注释已更新，草稿保留，请核对后再保存', 409);
      } else if (!revision(input.expectedRevision)) throw invalid('记录注释 revision 无效');
      else if (input.expectedRevision !== this.revision) throw invalid('记录保护已更新，请读取当前状态后再保存', 409);
      const next = this.snapshot(); next.revision++;
      const enhanced = next.schema === 2 || input.note != null || input.expectedRunRevision != null;
      if (enhanced) {
        upgrade(next); const value = { ...recordDefaults(), ...next.byRunId[input.runId] };
        delete value.tags;
        for (const key of ['protected', 'note']) if (Object.hasOwn(input, key)) value[key] = structuredClone(input[key]);
        if (Object.hasOwn(input, 'protected')) delete value.restoreProtection;
        value.updatedAt = new Date().toISOString(); value.revision++; next.byRunId[input.runId] = value;
      } else if (input.protected) next.byRunId[input.runId] = { protected: true, updatedAt: new Date().toISOString() };
      else delete next.byRunId[input.runId];
      await this.file.commit(next); return this.detail(input.runId);
    });
  }
  removeOrphans(ids) {
    return this.file.enqueue(async () => { const next = this.snapshot(); let changed = false; for (const id of ids) if (Object.hasOwn(next.byRunId, id)) { delete next.byRunId[id]; changed = true; } if (changed) { next.revision++; await this.file.commit(next); } });
  }
  close() { return this.file.close(); }
}
