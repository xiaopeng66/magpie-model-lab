import { buildPayload, invalid } from "./gateway.mjs";
import { UUID } from "./store.mjs";
import { batchKey } from "./history-groups.mjs";
import { CANDY_VERSION } from "./candy.mjs";
import { FINGERPRINT_SDK } from "./fingerprint-bank.mjs";
import { failureInfo } from "./diagnostics.mjs";

export function retestSources(runs, runIds) {
  if (!Array.isArray(runIds) || !runIds.length || runIds.some(id => typeof id !== "string" || !UUID.test(id))) throw invalid("请选择有效的源记录");
  if (new Set(runIds).size !== runIds.length) throw invalid("复测选择有重复的记录");
  const sources = runIds.map(id => {
    const run = runs.get(id); if (!run) throw invalid("原记录已删除，请重新选择", 404); return run;
  });
  if (sources.some(run => run.source === "automatic")) {
    if (sources.length !== 1) throw invalid("自动历史每次只能复测一个模型、一个时刻的一条记录");
  } else if (new Set(sources.map(batchKey)).size !== 1) throw invalid("请从同一个手动批次选择记录");
  return sources;
}

export function originalConditions(run, model) {
  if (!model) throw invalid("原模型已不在当前目录中");
  const kind = run.kind || "pelican", effort = run.effort || "";
  const sourceTime = run.source === "automatic" ? run.scheduledAt || run.createdAt : run.createdAt;
  if (typeof sourceTime !== "string" || !Number.isFinite(Date.parse(sourceTime))) throw invalid("原记录的时间标识无效，无法追溯复测来源");
  if (!Number.isSafeInteger(run.maxTokens) || run.maxTokens < 0) throw invalid("原记录缺少有效的输出上限");
  if (!Number.isSafeInteger(run.concurrency) || run.concurrency < 0) throw invalid("原记录缺少有效的并行数");
  const conditions = { kind, model: run.model, effort, maxTokens: run.maxTokens, concurrency: run.concurrency, sourceTime };
  if (kind === "fingerprint") {
    buildPayload(model, { ...conditions, prompt: "数字指纹采样" });
    if (!["responses", "chat_completions", "messages"].includes(run.api)) throw invalid("原记录缺少实际生效的指纹接口");
    if (typeof run.strict !== "boolean" || !["default", "flex", "fast", "ultrafast"].includes(run.serviceTier)) throw invalid("原记录缺少指纹采样设置");
    if (!Array.isArray(run.challenges) || run.challenges.length !== 3 || run.challenges.some(challenge => !challenge || typeof challenge.prompt !== "string" || !challenge.prompt.trim() ||
      challenge.prompt.length > 12000 || !Number.isSafeInteger(challenge.expected_count) || challenge.expected_count < 1 || challenge.expected_count > 10000)) throw invalid("原记录缺少完整的三组指纹题");
    if (!/^[a-f0-9]{64}$/.test(run.bank?.sha256 || "") || run.bank.sdkVersion !== FINGERPRINT_SDK) throw invalid("原参考库信息缺失或与当前检测器不兼容");
    const account = run.account ?? "";
    if (typeof account !== "string" || account.length > 256 || /[\x00-\x1f\x7f]/.test(account)) throw invalid("原账号标识无效");
    return { ...conditions, api: run.api, requestedApi: run.requestedApi || run.api, strict: run.strict, serviceTier: run.serviceTier, account,
      challenges: structuredClone(run.challenges), bank: { ...run.bank } };
  }
  if (!["pelican", "candy"].includes(kind)) throw invalid("原测试类型不支持复测");
  buildPayload(model, { ...conditions, prompt: run.prompt });
  if (kind === "candy" && (run.candy?.version !== CANDY_VERSION || run.candy.expected !== 21)) throw invalid("原糖果题版本缺失或不兼容");
  return { ...conditions, prompt: run.prompt, ...(kind === "candy" ? { candyVersion: run.candy.version } : {}) };
}

export function abnormalRetest(run) {
  return failureInfo(run)?.abnormal === true;
}
