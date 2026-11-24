export const DEFAULT_MAX_TOKENS = 64000;
export const DEFAULT_TIMEOUT_MS = 600000;
const invalid = message => Object.assign(new Error(message), { status: 400 });
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
export function generationTimeout(value = DEFAULT_TIMEOUT_MS) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2147483647) throw invalid("生成超时需为 0–2147483647 毫秒的整数，0 表示不设超时");
  return value;
}
export function generationTimeoutFromSeconds(input) {
  const seconds = typeof input === 'number' ? input : typeof input === 'string' && input.trim() ? Number(input) : NaN;
  const milliseconds = Math.round(seconds * 1000);
  if (!Number.isSafeInteger(milliseconds) || seconds < 0 || milliseconds > 2147483647 || seconds !== milliseconds / 1000) {
    throw invalid('生成超时需为 0–2147483.647 秒的数值，最多三位小数，0 表示不设超时');
  }
  return milliseconds;
}
export function parameterDefaults(kind, defaultPrompt = "") {
  if (!["pelican", "candy", "fingerprint"].includes(kind)) throw invalid("测试模式无效");
  return { maxTokens: DEFAULT_MAX_TOKENS, timeoutMs: DEFAULT_TIMEOUT_MS, concurrency: kind === "pelican" ? 2 : 3,
    ...(kind === "pelican" ? { prompt: defaultPrompt } : kind === "fingerprint" ? { api: "auto", strict: false, serviceTier: "default" } : {}) };
}
export function normalizeParameters(kind, input, { defaultPrompt = "" } = {}) {
  const defaults = parameterDefaults(kind, defaultPrompt);
  if (!object(input)) throw invalid("测试参数需为对象");
  const allowed = new Set([...Object.keys(defaults), "effortByModel"]);
  if (Object.keys(input).some(key => !allowed.has(key))) throw invalid("参数包含未知字段或模型、账号等目标字段");
  const out = { ...defaults, ...input };
  for (const key of ["maxTokens", "concurrency"]) if (!Number.isSafeInteger(out[key]) || out[key] < 0) throw invalid(`${key === "maxTokens" ? "输出上限" : "并行数"}需为非负整数，0 表示不设上限`);
  out.timeoutMs = generationTimeout(out.timeoutMs);
  if (kind === "pelican" && (typeof out.prompt !== "string" || !out.prompt.trim() || out.prompt.length > 12000)) throw invalid("提示词需为 1–12000 个字符");
  if (kind === "fingerprint") {
    if (!["auto", "responses", "chat_completions", "messages"].includes(out.api)) throw invalid("指纹请求接口无效");
    if (typeof out.strict !== "boolean") throw invalid("严格模式参数无效");
    if (!["default", "flex", "fast", "ultrafast"].includes(out.serviceTier)) throw invalid("服务档位无效");
  }
  if (out.effortByModel !== undefined) {
    if (!object(out.effortByModel) || Object.keys(out.effortByModel).length > 500 || Object.entries(out.effortByModel).some(([key, value]) => !key || key.length > 256 || /[\x00-\x1f\x7f]/.test(key) || typeof value !== "string" || value.length > 40 || /[\x00-\x1f\x7f]/.test(value))) throw invalid("模型思考档位映射无效");
    out.effortByModel = { ...out.effortByModel };
  }
  return out;
}
