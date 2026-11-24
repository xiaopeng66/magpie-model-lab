import { identityHash, readRunTarget, validAccountId } from './targets.mjs';
import { invalid } from './gateway.mjs';
import { StateFile } from './state-file.mjs';
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
export const DEFAULT_QUEUE = { providerConcurrency: 0, accountConcurrency: 0, minIntervalMs: 0, providers: {}, accounts: {} };
// RYP: retain the old disabled marker only in digests so historical comparisons remain compatible.
export const queuePolicyHash = queue => identityHash(JSON.stringify({ queue, budget: { enabled: false } }));
export const accountScope = (provider, id) => JSON.stringify([provider, id]);
export function validateQueue(value) {
  if (!object(value) || Object.keys(value).some(key => !Object.hasOwn(DEFAULT_QUEUE,key)) || !['providerConcurrency','accountConcurrency','minIntervalMs'].every(key => integer(value[key])) || value.minIntervalMs > 2147483647) throw invalid('队列规则需为非负整数，0 取消对应限制');
  for (const group of ['providers','accounts']) {
    if (!object(value[group]) || Object.keys(value[group]).length > 500) throw invalid('队列目标规则无效或超过 500 项');
    for (const [key, rule] of Object.entries(value[group])) {
      if (!key || key.length > 600 || /[\x00-\x1f\x7f]/.test(key) || !object(rule) || Object.keys(rule).some(k => !['concurrency','intervalMs'].includes(k)) || !integer(rule.concurrency) || !integer(rule.intervalMs) || rule.intervalMs > 2147483647) throw invalid('供应商或账号队列规则无效');
      if (group === 'accounts') { let pair; try { pair = JSON.parse(key); } catch { throw invalid('账号队列标识无效'); } if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || !validAccountId(pair[1])) throw invalid('账号队列标识无效'); }
    }
  }
  return structuredClone(value);
}
export class QueuePolicy {
  constructor(policy = () => DEFAULT_QUEUE, { now = Date.now, dir } = {}) {
    this.policy = policy; this.now = now; this.cooldowns = new Map(); this.lastStarted = new Map();
    if (dir) this.file = new StateFile(dir, '.queue', { schema: 1, revision: 0, cooldowns: {} }, value => {
      if (value?.schema !== 1 || !integer(value.revision) || !object(value.cooldowns) || Object.entries(value.cooldowns).some(([key, until]) => !key || !Number.isSafeInteger(until) || until < 0)) throw invalid('本地冷却状态无效');
    });
  }
  async init() { if (this.file) { await this.file.init(); this.cooldowns = new Map(Object.entries(this.file.data.cooldowns)); } }
  hash() { return queuePolicyHash(this.policy() || DEFAULT_QUEUE); }
  scopes(run) { const account = readRunTarget(run).account; return { provider: `provider:${run.provider}`, account: account.mode === 'pinned' ? `account:${accountScope(run.provider,account.id)}` : null, accountId: account.id || '' }; }
  check(run, active) {
    if (this.file?.recoveryError) throw invalid('本地冷却状态不可写，新的请求已暂停：' + this.file.recoveryError, 503);
    const value = this.policy() || DEFAULT_QUEUE, scope = this.scopes(run), accountKey = accountScope(run.provider, scope.accountId);
    const provider = Object.hasOwn(value.providers || {}, run.provider) ? value.providers[run.provider] : { concurrency: value.providerConcurrency || 0, intervalMs: value.minIntervalMs || 0 };
    const account = Object.hasOwn(value.accounts || {}, accountKey) ? value.accounts[accountKey] : { concurrency: value.accountConcurrency || 0, intervalMs: value.minIntervalMs || 0 };
    const providerCount = active.filter(item => item.run.provider === run.provider).length, accountCount = scope.account ? active.filter(item => this.scopes(item.run).account === scope.account).length : 0;
    if (provider.concurrency > 0 && providerCount >= provider.concurrency) return { allowed: false, reason: 'provider_limit' };
    if (scope.account && account.concurrency > 0 && accountCount >= account.concurrency) return { allowed: false, reason: 'account_limit' };
    const until = Math.max(this.cooldowns.get(scope.provider) || 0, scope.account ? this.cooldowns.get(scope.account) || 0 : 0,
      (this.lastStarted.get(scope.provider) ?? -Infinity) + provider.intervalMs, scope.account ? (this.lastStarted.get(scope.account) ?? -Infinity) + account.intervalMs : 0);
    return until > this.now() ? { allowed: false, reason: 'cooldown', until } : { allowed: true };
  }
  started(run) { const scopes = this.scopes(run); this.lastStarted.set(scopes.provider,this.now()); if (scopes.account) this.lastStarted.set(scopes.account,this.now()); }
  noteFailure(run, error) {
    if (error?.upstreamStatus !== 429) return null;
    const scopes = this.scopes(run), scope = scopes.account || scopes.provider, delay = Number.isFinite(error.retryAfterMs) ? Math.max(1000, error.retryAfterMs) : 30000;
    const until = Math.min(Number.MAX_SAFE_INTEGER, this.now() + delay); this.cooldowns.set(scope, Math.max(this.cooldowns.get(scope) || 0, until));
    if (this.file) this.persist().catch(() => {});
    return { cooldownUntil: until, cooldownScope: scope };
  }
  persist() { return this.file.enqueue(async () => { const next = this.file.snapshot(); next.revision++; next.cooldowns = Object.fromEntries(this.cooldowns); await this.file.commit(next); }); }
  nextDelay(until) { return Math.max(1, Math.min(3600000, until - this.now())); }
  status() { return { cooldowns: [...this.cooldowns].filter(([,until]) => until > this.now()).map(([scope,until]) => ({ scope, until })), recoveryError: this.file?.recoveryError || '' }; }
  close() { return this.file?.close(); }
}
