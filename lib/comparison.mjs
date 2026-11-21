import { failureInfo } from "./diagnostics.mjs";

const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const text = value => typeof value === "string" ? value : null;
const baseFields = [["kind", "测试类型"], ["question", "题面"], ["effort", "思考档位"], ["maxTokens", "输出上限"], ["concurrency", "并行数"]];
const fieldsFor = kind => [...baseFields, ...(kind === "fingerprint" ? [["api", "采样接口"], ["strict", "采样模式"], ["serviceTier", "服务档位"],
  ["account", "固定账号"], ["bank", "指纹库"], ["sdk", "检测器版本"]] : kind === "candy" ? [["testVersion", "题目版本"], ["expected", "预期答案"]] : [])];

export function conditionProfile(run) {
  if (run.conditions?.version === 1) return run.conditions;
  const kind = run.kind || "pelican";
  const profile = { version: 1, kind, question: text(run.questionHash) || text(run.promptHash) || (typeof run.prompt === "string" && run.prompt.trim() ? `text:${run.prompt}` : null),
    effort: text(run.effort), maxTokens: count(run.maxTokens), concurrency: count(run.concurrency) };
  if (kind === "fingerprint") Object.assign(profile, { api: text(run.api), strict: typeof run.strict === "boolean" ? run.strict : null,
    serviceTier: text(run.serviceTier), account: text(run.account), bank: text(run.bank?.sha256), sdk: text(run.bank?.sdkVersion) });
  if (kind === "candy") Object.assign(profile, { testVersion: text(run.candy?.version), expected: count(run.candy?.expected) });
  return profile;
}

const finiteDuration = value => Number.isFinite(value) && value >= 0 ? value : null;
const totalTokens = run => run.tokens?.partial?.includes("total") ? null : count(run.tokens?.total ?? run.usage?.total_tokens);
const prediction = run => run.fingerprint?.prediction || run.analysis?.results?.[0]?.display_name || run.analysis?.results?.[0]?.model || "";
const median = values => {
  const sorted = values.filter(value => value !== null).sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length ? sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2 : null;
};

export function recentTrend(anchor, records) {
  const profile = conditionProfile(anchor), fields = fieldsFor(profile.kind), available = typeof anchor.model === "string" && fields.every(([key]) => profile[key] != null);
  const matching = available ? records.filter(run => run.model === anchor.model && !["queued", "running", "cancelled"].includes(run.status) && Number.isFinite(Date.parse(run.createdAt)) &&
    fields.every(([key]) => conditionProfile(run)[key] != null && conditionProfile(run)[key] === profile[key]))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || (b.id || "").localeCompare(a.id || "")).slice(0, 20).reverse() : [];
  const valid = matching.filter(run => run.status === "completed" && (profile.kind === "candy" ? ["match", "mismatch"].includes(run.candy?.verdict) : profile.kind === "fingerprint" ? Boolean(prediction(run)) : true));
  const successes = profile.kind === "candy" ? valid.filter(run => run.candy.verdict === "match").length : valid.length;
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
