import { readGrade } from './suites.mjs';
import { failureInfo } from './diagnostics.mjs';
const contains = (value, query) => String(value || '').toLocaleLowerCase().includes(String(query || '').toLocaleLowerCase());
export function historyMatches(run, annotation = {}, filters = {}) {
  const model = `${run.model || ''} ${run.modelName || ''} ${run.providerName || ''}`, account = run.accountTarget?.mode === 'pinned' ? `${run.accountTarget.id} ${run.accountTarget.name || ''}` : run.kind === 'fingerprint' && run.account ? run.account : '自动路由';
  if (!contains(model, filters.model) || !contains(account, filters.account) || filters.kind && run.kind !== filters.kind) return false;
  if (filters.result && run.status !== filters.result && readGrade(run)?.verdict !== filters.result && failureInfo(run)?.code !== filters.result) return false;
  const at = Date.parse(run.createdAt); if (filters.from && at < Date.parse(filters.from) || filters.to && at >= Date.parse(filters.to)) return false;
  if (typeof filters.protected === 'boolean' && Boolean(annotation.protected) !== filters.protected) return false;
  if (filters.tags?.length && !filters.tags.every(tag => annotation.tags?.includes(tag))) return false;
  if (!contains(annotation.note, filters.note)) return false;
  return !filters.text || contains(`${model} ${account} ${annotation.note || ''} ${(annotation.tags || []).join(' ')}`, filters.text);
}
