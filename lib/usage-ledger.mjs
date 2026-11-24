import { StateFile } from './state-file.mjs';
import { invalid } from './gateway.mjs';
import { UUID } from './store.mjs';
import { usageBreakdown } from './usage.mjs';
import { accountScope } from './queue-policy.mjs';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const tokenFields = { input: 'inputTokens', output: 'outputTokens', cacheRead: 'cacheReadTokens', cacheWrite: 'cacheWriteTokens' };
const sum = values => { const total = values.reduce((n, value) => n + value, 0); return integer(total) ? total : null; };
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const clocks = new Map();
const archiveDefaults = () => ({ requests: 0, tokens: 0, knownUsage: 0, unknownUsage: 0, usageNeedsReview: 0, possibleUnsent: 0 });
const detailedWindowMs = 72 * 3600000;
export function usageDay(at, zone) {
  if (!clocks.has(zone)) clocks.set(zone, new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }));
  return clocks.get(zone).format(new Date(at));
}
export function dayWindow(at, zone) {
  const day = usageDay(at, zone);
  let lo = at - 48 * 3600000, hi = at;
  while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (usageDay(mid, zone) < day) lo = mid; else hi = mid; }
  const start = hi; lo = at; hi = at + 48 * 3600000;
  while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (usageDay(mid, zone) > day) hi = mid; else lo = mid; }
  return { day, start, end: hi };
}

export class UsageLedger {
  constructor(dir, { now = Date.now, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone } = {}) {
    this.now = now; this.timeZone = timeZone;
    new Intl.DateTimeFormat('en', { timeZone });
    // RYP: keep the existing ledger location so removing quotas preserves observed usage.
    this.file = new StateFile(dir, '.budgets', { schema: 1, revision: 0, coverageStartAt: new Date(now()).toISOString(), entries: {}, archive: archiveDefaults() }, value => {
      if (value?.schema !== 1 || !integer(value.revision) || !time(value.coverageStartAt) || !object(value.entries)) throw invalid('用量账本格式无效');
      if (value.archive && (!object(value.archive) || Object.keys(value.archive).some(key => !Object.hasOwn(archiveDefaults(), key)) || Object.values(value.archive).some(n => !integer(n)))) throw invalid('用量归档格式无效');
      if (value.retainedFromAt != null && !time(value.retainedFromAt)) throw invalid('用量统计覆盖时间无效');
      for (const [id, e] of Object.entries(value.entries)) {
        if (!UUID.test(id) || !object(e) || e.physicalRequestId !== id || !UUID.test(e.runId || '') || typeof e.provider !== 'string' || typeof e.accountId !== 'string' || !['reserved', 'starting', 'started', 'released'].includes(e.state) || !time(e.reservedAt) || !/^\d{4}-\d{2}-\d{2}$/.test(e.day) || !integer(e.usageRevision) || e.tokens != null && !integer(e.tokens) || Object.values(tokenFields).some(key => e[key] != null && !integer(e[key])) || e.startedAt != null && !time(e.startedAt) || e.settledAt != null && !time(e.settledAt)) throw invalid('请求用量条目无效');
      }
    }, { maxBytes: 16 * 1024 * 1024, label: '用量账本' });
  }
  get recoveryError() { return this.file.recoveryError; }
  async init() {
    await this.file.init(); if (this.recoveryError) return;
    if (!Object.values(this.file.data.entries).some(e => e.state === 'reserved' || e.state === 'starting' || e.state === 'started' && !e.settledAt)) return;
    await this.file.enqueue(async () => {
      const next = this.file.snapshot();
      for (const e of Object.values(next.entries)) {
        if (e.state === 'reserved') e.state = 'released';
        else if (e.state === 'starting') e.possibleUnsent = true;
        if (['starting', 'started'].includes(e.state)) e.settledAt = new Date(this.now()).toISOString();
      }
      this.compactState(next); next.revision++; await this.file.commit(next);
    });
  }
  reserve(input) {
    return this.file.enqueue(async () => {
      if (!UUID.test(input.physicalRequestId || '') || !UUID.test(input.runId || '') || typeof input.provider !== 'string' || !input.provider || typeof input.accountId !== 'string') throw invalid('请求用量身份无效');
      const next = this.file.snapshot(); if (next.entries[input.physicalRequestId]) throw invalid('请求用量身份重复');
      const at = this.now(), reservation = { ...input, state: 'reserved', reservedAt: new Date(at).toISOString(), startedAt: null,
        day: usageDay(at, this.timeZone), timeZone: this.timeZone, tokens: null, usageRevision: 0 };
      this.compactState(next); next.entries[input.physicalRequestId] = reservation; next.revision++; await this.file.commit(next);
      return { reservation: structuredClone(reservation) };
    });
  }
  start(id) {
    return this.file.enqueue(async () => {
      const next = this.file.snapshot(), entry = next.entries[id];
      if (!entry || entry.state !== 'reserved') throw invalid('请求用量记录已失效', 409);
      entry.state = 'starting'; entry.startedAt = new Date(this.now()).toISOString(); next.revision++; await this.file.commit(next);
      return structuredClone(entry);
    });
  }
  markStarted(id, at = this.now()) {
    return this.file.enqueue(async () => {
      const next = this.file.snapshot(), entry = next.entries[id]; if (!entry || entry.state === 'released') return;
      if (entry.state !== 'starting') throw invalid('请求开始状态无效');
      entry.state = 'started'; entry.startedAt = new Date(at).toISOString(); entry.timeZone = this.timeZone;
      entry.day = usageDay(at, this.timeZone); entry.possibleUnsent = false; next.revision++; await this.file.commit(next);
    });
  }
  release(id) {
    return this.file.enqueue(async () => {
      const next = this.file.snapshot(), entry = next.entries[id]; if (!entry || entry.state === 'released') return;
      if (entry.state === 'started') throw invalid('已发出的请求不能移除用量记录', 409);
      entry.state = 'released'; next.revision++; await this.file.commit(next);
    });
  }
  observe(id, usage, revision) {
    return this.file.enqueue(async () => {
      const next = this.file.snapshot(), entry = next.entries[id];
      if (!entry || !['started', 'starting'].includes(entry.state) || !integer(revision) || revision <= entry.usageRevision) return;
      const counts = usageBreakdown(usage);
      for (const [name, key] of Object.entries({ total: 'tokens', ...tokenFields })) {
        const count = counts[name]; if (count == null) continue;
        if (entry[key] != null && count < entry[key]) entry.usageNeedsReview = true;
        entry[key] = Math.max(entry[key] || 0, count);
      }
      if (entry.inputTokens != null && [entry.cacheReadTokens, entry.cacheWriteTokens].some(count => count != null && count > entry.inputTokens)) entry.usageNeedsReview = true;
      entry.usageRevision = revision; next.revision++; await this.file.commit(next);
    });
  }
  complete(id) {
    return this.file.enqueue(async () => {
      const next = this.file.snapshot(), entry = next.entries[id]; if (!entry || entry.settledAt) return;
      entry.settledAt = new Date(this.now()).toISOString(); next.revision++; await this.file.commit(next);
    });
  }
  compactState(next) {
    const cutoff = this.now() - detailedWindowMs; let removed = false;
    const archive = { ...archiveDefaults(), ...next.archive };
    for (const [id, entry] of Object.entries(next.entries)) {
      if (entry.state === 'released') { if (Date.parse(entry.reservedAt) < cutoff) { delete next.entries[id]; removed = true; } continue; }
      if (!entry.settledAt || Date.parse(entry.startedAt || entry.reservedAt) >= cutoff) continue;
      archive.requests++; archive.tokens += entry.tokens || 0; archive[entry.tokens == null ? 'unknownUsage' : 'knownUsage']++;
      if (entry.usageNeedsReview) archive.usageNeedsReview++; if (entry.possibleUnsent) archive.possibleUnsent++;
      delete next.entries[id]; removed = true;
    }
    if (removed) { next.archive = archive; next.retainedFromAt = new Date(Math.max(cutoff, Date.parse(next.coverageStartAt))).toISOString(); }
    return removed;
  }
  summary() {
    const window = dayWindow(this.now(), this.timeZone), entries = Object.values(this.file.data.entries).filter(entry => {
      const at = Date.parse(entry.startedAt || entry.reservedAt);
      return ['starting', 'started'].includes(entry.state) && at >= window.start && at < window.end;
    });
    const usage = selected => {
      const tokenDetails = {};
      for (const [name, key] of Object.entries(tokenFields)) {
        const known = selected.filter(entry => entry[key] != null);
        tokenDetails[name] = known.length ? sum(known.map(entry => entry[key])) : null;
        tokenDetails[name + 'Requests'] = known.length;
      }
      const covered = selected.filter(entry => !entry.usageNeedsReview && entry.inputTokens != null && entry.cacheReadTokens != null && entry.cacheReadTokens <= entry.inputTokens);
      const input = sum(covered.map(entry => entry.inputTokens)), cache = sum(covered.map(entry => entry.cacheReadTokens));
      tokenDetails.cacheCoverageRequests = covered.length;
      tokenDetails.cacheHitRate = input > 0 && cache != null ? cache / input : null;
      const known = selected.filter(entry => entry.tokens != null);
      return { knownRequests: selected.length, tokens: !selected.length ? 0 : known.length ? sum(known.map(entry => entry.tokens)) : null,
        knownUsage: known.length, unknownUsage: selected.length - known.length, tokenDetails };
    };
    const providers = new Map(), accounts = new Map();
    for (const entry of entries) {
      if (!providers.has(entry.provider)) providers.set(entry.provider, []); providers.get(entry.provider).push(entry);
      if (entry.accountId) { const key = accountScope(entry.provider, entry.accountId); if (!accounts.has(key)) accounts.set(key, []); accounts.get(key).push(entry); }
    }
    const byRequests = ([a, first], [b, second]) => second.length - first.length || a.localeCompare(b);
    return { timeZone: this.timeZone, day: window.day,
      partial: Math.max(Date.parse(this.file.data.coverageStartAt), Date.parse(this.file.data.retainedFromAt || this.file.data.coverageStartAt)) > window.start,
      coverageStartAt: this.file.data.coverageStartAt, ...usage(entries),
      usageNeedsReview: entries.filter(e => e.usageNeedsReview).length, possibleUnsent: entries.filter(e => e.possibleUnsent).length,
      providers: [...providers].sort(byRequests).map(([provider, selected]) => ({ provider, ...usage(selected) })),
      accounts: [...accounts].sort(byRequests).map(([key, selected]) => { const [provider, accountId] = JSON.parse(key); return { provider, accountId, ...usage(selected) }; }),
      recoveryError: this.recoveryError };
  }
  close() { return this.file.close(); }
}
