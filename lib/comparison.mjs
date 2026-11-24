import { failureInfo } from "./diagnostics.mjs";
import { readRunTarget } from "./targets.mjs";
import { identityHash } from './targets.mjs';
import { readGrade } from './suites.mjs';

const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const text = value => typeof value === "string" ? value : null;
const baseFields = [["kind", "测试类型"], ["question", "题面"], ["effort", "思考档位"], ["maxTokens", "输出上限"], ["timeoutMs", "生成超时"], ["concurrency", "并行数"], ['accountMode','账号模式'], ['accountId','账号目标'], ['admissionPolicy','准入规则']];
const fieldsFor = kind => [...baseFields, ...(kind === "fingerprint" ? [["api", "采样接口"], ["strict", "采样模式"], ["serviceTier", "服务档位"],
  ["account", "固定账号"], ["bank", "指纹库"], ["sdk", "检测器版本"]] : kind === "candy" ? [["testVersion", "题目版本"], ["expected", "预期答案"], ['grader','判分器版本'], ['answerHash','答案摘要']] : [])];
// RYP: keep the disabled marker in digests for historical comparisons; this module also runs in the browser.
const defaultAdmission = identityHash(JSON.stringify({ queue: { providerConcurrency: 0, accountConcurrency: 0, minIntervalMs: 0, providers: {}, accounts: {} }, budget: { enabled: false } }));

export function conditionProfile(run) {
  let target; try { target = readRunTarget(run); } catch { target = null; }
  const accountFields = { accountMode: target?.account.mode ?? null, accountId: target ? target.account.id || '' : null };
  const hashes = [...new Set((run.physicalRequests || []).filter(request => request.state === 'started').map(request => request.admissionPolicyHash).filter(Boolean))].sort();
  const admissionPolicy = hashes.length ? JSON.stringify(hashes) : JSON.stringify([defaultAdmission]);
  if ([1, 2].includes(run.conditions?.version)) return { ...run.conditions, version: 2, timeoutMs: count(run.conditions.timeoutMs ?? run.timeoutMs ?? 600000), admissionPolicy: run.conditions.admissionPolicy || admissionPolicy, ...accountFields,
    ...(run.kind === 'candy' ? { grader: run.conditions.grader || 'exact-number:1', answerHash: run.conditions.answerHash || identityHash(JSON.stringify(run.conditions.expected)) } : {}) };
  const kind = run.kind || "pelican";
  const profile = { version: 2, kind, question: text(run.questionHash) || text(run.promptHash) || (typeof run.prompt === "string" && run.prompt.trim() ? `text:${run.prompt}` : null),
    effort: text(run.effort), maxTokens: count(run.maxTokens), timeoutMs: count(run.timeoutMs ?? 600000), concurrency: count(run.concurrency), ...accountFields, admissionPolicy };
  if (kind === "fingerprint") Object.assign(profile, { api: text(run.api), strict: typeof run.strict === "boolean" ? run.strict : null,
    serviceTier: text(run.serviceTier), account: text(run.account), bank: text(run.bank?.sha256), sdk: text(run.bank?.sdkVersion) });
  if (kind === "candy") Object.assign(profile, { testVersion: run.task ? run.task.suiteId === 'shape-choice' && run.task.suiteVersion === '1' && run.task.questionId === 'shape-choice' ? 'shape-choice-v1' : `${run.task.suiteId}:${run.task.suiteVersion}:${run.task.questionId}` : text(run.candy?.version), expected: run.task ? run.task.expected : count(run.candy?.expected),
    grader: run.task ? `${run.task.graderId}:${run.task.graderVersion}` : 'exact-number:1', answerHash: identityHash(JSON.stringify(run.task?.expected ?? run.candy?.expected ?? null)) });
  return profile;
}

const finiteDuration = value => Number.isFinite(value) && value >= 0 ? value : null;
const totalTokens = run => run.tokens?.partial?.includes("total") ? null : count(run.tokens?.total ?? run.usage?.total_tokens);
const prediction = run => run.fingerprint?.prediction || run.analysis?.results?.[0]?.display_name || run.analysis?.results?.[0]?.model || "";
const median = values => {
  const sorted = values.filter(value => value !== null).sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length ? sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2 : null;
};

export function executedRun(run) {
  if (Array.isArray(run.physicalRequests)) return run.physicalRequests.some(request => request.state === 'started');
  return Boolean(run.startedAt) && !['usage_storage', 'budget_storage', 'queue_storage', 'target_unavailable', 'storage'].includes(run.failureKind);
}
function sameConditionRecords(anchor, records) {
  const profile = conditionProfile(anchor), fields = fieldsFor(profile.kind), available = typeof anchor.model === 'string' && fields.every(([key]) => profile[key] != null);
  const matching = available ? records.filter(run => {
    if (run.model !== anchor.model || ['queued', 'running', 'cancelled'].includes(run.status) || !Number.isFinite(Date.parse(run.createdAt))) return false;
    const other = conditionProfile(run); return fields.every(([key]) => other[key] != null && other[key] === profile[key]);
  }).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || (b.id || '').localeCompare(a.id || '')) : [];
  return { profile, available, matching };
}
export function conditionAlerts(anchor, records) {
  const { profile, available, matching } = sameConditionRecords(anchor, records);
  const relevant = matching.filter(run => executedRun(run) && run.status !== 'interrupted' &&
    !['usage_storage', 'budget_storage', 'queue_storage', 'target_unavailable', 'storage', 'shutdown'].includes(run.failureKind) && !['storage', 'connection', 'load'].includes(failureInfo(run)?.code));
  const recent = relevant.slice(0, 3), codes = recent.map(run => failureInfo(run)?.code), ruleKey = rule => available ? identityHash(JSON.stringify([readRunTarget(anchor).targetKey, profile, rule, relevant[0]?.id || ''])) : null;
  const consecutive = recent.length === 3 && ['authentication', 'rate-limit', 'timeout', 'mismatch'].includes(codes[0]) && codes.every(code => code === codes[0])
    ? { code: codes[0], key: ruleKey(codes[0]), runIds: recent.map(run => run.id) } : null;
  const durations = relevant.filter(run => run.status === 'completed' && run.routing?.verification !== 'mismatch' && Number.isFinite(run.elapsedMs) && run.elapsedMs >= 0 &&
    (run.kind !== 'candy' || ['match', 'mismatch'].includes(readGrade(run)?.verdict))).slice(0, 15);
  const current = durations.slice(0, 5), previous = durations.slice(5, 15), currentMedian = median(current.map(run => run.elapsedMs)), previousMedian = median(previous.map(run => run.elapsedMs));
  const status = current.length !== 5 || previous.length !== 10 ? 'insufficient' : currentMedian > previousMedian * 2 && currentMedian - previousMedian >= 30000 ? 'slower' : 'stable';
  return { available, consecutive, slowdown: { status, recentCount: current.length, previousCount: previous.length, recentMedianMs: currentMedian, previousMedianMs: previousMedian,
    key: ruleKey('duration'), runIds: durations.map(run => run.id) } };
}

export function recentTrend(anchor, records) {
  const { profile, available, matching: found } = sameConditionRecords(anchor, records), matching = found.slice(0, 20).reverse();
  const valid = matching.filter(run => run.routing?.verification !== 'mismatch' && run.status === "completed" && (profile.kind === "candy" ? ["match", "mismatch"].includes(readGrade(run)?.verdict) : profile.kind === "fingerprint" ? Boolean(prediction(run)) : true));
  const successes = profile.kind === "candy" ? valid.filter(run => readGrade(run).verdict === "match").length : valid.length;
  const denominator = profile.kind === "candy" ? valid.length : matching.length;
  const elapsed = valid.map(run => finiteDuration(run.elapsedMs)).filter(value => value !== null), tokens = valid.map(totalTokens).filter(value => value !== null);
  const candidates = new Map();
  if (profile.kind === "fingerprint") for (const run of valid) { const name = prediction(run); candidates.set(name, (candidates.get(name) || 0) + 1); }
  return { available, attempts: matching.length, valid: valid.length, successes, rate: denominator ? successes / denominator * 100 : null,
    rateLabel: profile.kind === "candy" ? "答案命中率" : profile.kind === "fingerprint" ? "可评分率" : "生成完成率", insufficient: valid.length < 3,
    exceptions: matching.filter(run => failureInfo(run)?.abnormal).length,
    elapsedMedian: median(elapsed), elapsedCount: elapsed.length, tokenMedian: median(tokens), tokenCount: tokens.length,
    candidates: [...candidates].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, 3),
    points: matching.map(run => { const diagnosis = failureInfo(run); return { id: run.id, at: run.createdAt, elapsedMs: finiteDuration(run.elapsedMs), tokens: totalTokens(run),
      label: diagnosis?.label || (profile.kind === "candy" ? "答案匹配" : profile.kind === "fingerprint" ? prediction(run) || "未匹配" : "生成完成"), tone: diagnosis?.tone || "success" }; }) };
}
