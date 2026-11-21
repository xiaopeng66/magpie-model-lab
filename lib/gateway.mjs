import { mergeUsage } from "./usage.mjs";
import metadata from "../package.json" with { type: "json" };

export const DEFAULT_PROMPT = '请生成一个“鹈鹕骑自行车”的循环动画。输出一个完整的、保存为 .html 后可离线打开的单文件 HTML。使用内联 CSS、JavaScript，以及 SVG 或 Canvas；不要依赖外部图片、字体、CDN、库或网络。画面应让人清楚看出鹈鹕正在骑自行车，并有连续的骑行动作。只返回 HTML，不要 Markdown 代码围栏或解释。';
export const DEFAULT_MAX_TOKENS = 64000;
export const DEFAULT_TIMEOUT_MS = 600000;

export function generationTimeout(value = DEFAULT_TIMEOUT_MS) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2147483647) throw invalid("生成超时需为 0–2147483647 毫秒的整数，0 表示不设超时");
  return value;
}

export function invalid(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

export function safeError(error) {
  return String(error?.message || error || "请求失败")
    .replace(/\b(?:Bearer\s+|sk-)[A-Za-z0-9._-]+/gi, "[已隐藏凭据]")
    .replace(/((?:api[_-]?key|authorization|access[_-]?token)\s*[=:]\s*["']?)[^\s"',}]+/gi, "$1[已隐藏凭据]")
    .slice(0, 600);
}

export async function boundedBytes(response, limit = 4 * 1024 * 1024) {
  const reader = response.body?.getReader();
  if (!reader) throw invalid("响应没有正文", 502);
  let size = 0; const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) throw invalid("响应超过允许的字节大小", 502);
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function normalizeModels(body) {
  if (!Array.isArray(body?.data)) throw invalid("Magpie 返回的模型目录格式不正确", 502);
  const seen = new Set();
  return body.data.flatMap((m) => {
    const id = typeof m?.id === "string" ? m.id : "";
    const output = m?.modalities?.output;
    if (!id || id.startsWith("group/") || seen.has(id) || m.disabled || m.decides ||
        ["decision", "embedding", "rerank", "image", "audio", "video"].includes(m.type) ||
        (Array.isArray(output) && !output.includes("text"))) return [];
    seen.add(id);
    const efforts = Array.isArray(m.reasoning_levels) ? m.reasoning_levels : Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels.map(x => x?.effort) : [];
    const provider = id.split("/")[0];
    const providerLabel = typeof m.magpie_label === "string" ? m.magpie_label.split(" · ").slice(1).join(" · ").trim() : "";
    return [{
      id, name: [m.magpie_label, m.display_name, m.name].find(value => typeof value === "string" && value.trim()) || id,
      provider, providerName: providerLabel || provider, efforts: [...new Set(efforts.filter(x => typeof x === "string" && x))],
      maxOutputTokens: Number.isInteger(m.max_output_tokens) && m.max_output_tokens > 0 ? m.max_output_tokens : null,
      nativeEndpoints: Array.isArray(m.native_endpoints) ? m.native_endpoints : [],
    }];
  });
}

export function buildPayload(model, { prompt, maxTokens = DEFAULT_MAX_TOKENS, effort = "" }) {
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 12000) throw invalid("提示词需为 1–12000 个字符");
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 0) throw invalid("输出上限需为非负整数，0 表示不设上限");
  if (typeof effort !== "string" || (effort && !model.efforts.includes(effort))) throw invalid(`${model.name || model.id} 不支持这个思考档位`);
  return {
    model: model.id, messages: [{ role: "user", content: prompt }], stream: true,
    stream_options: { include_usage: true }, ...(maxTokens ? { max_tokens: maxTokens } : {}),
    ...(effort ? { reasoning_effort: effort } : {}),
  };
}

export async function* parseSSE(stream, onBytes = () => {}) {
  if (!stream) throw invalid("响应没有流式正文", 502);
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "", event = "message", data = [], eventBytes = 0, skipLF = false;
  const line = (text) => {
    if (!text) {
      const out = data.length ? { event, data: data.join("\n") } : null;
      data = []; event = "message"; eventBytes = 0;
      return out;
    }
    eventBytes += Buffer.byteLength(text) + 1;
    if (eventBytes > 4 * 1024 * 1024) throw invalid("单个流式事件过大", 502);
    if (text.startsWith(":")) return null;
    const colon = text.indexOf(":");
    const field = colon < 0 ? text : text.slice(0, colon);
    const value = colon < 0 ? "" : text.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value || "message";
    if (field === "data") data.push(value);
    return null;
  };
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.value?.byteLength) onBytes(chunk.value.byteLength);
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      if (skipLF && buffer) { if (buffer.startsWith("\n")) buffer = buffer.slice(1); skipLF = false; }
      let end;
      while ((end = buffer.search(/[\r\n]/)) >= 0) {
        const cr = buffer[end] === "\r", out = line(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (cr) {
          if (buffer.startsWith("\n")) buffer = buffer.slice(1);
          else if (!buffer) skipLF = true;
        }
        if (out) yield out;
      }
      if (eventBytes + Buffer.byteLength(buffer) > 4 * 1024 * 1024) throw invalid("单个流式事件过大", 502);
      if (chunk.done) break;
    }
    if (buffer) line(buffer);
    const last = line("");
    if (last) yield last;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export class Gateway {
  constructor({ url = "http://127.0.0.1:3425", key = "magpie" } = {}) {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw invalid("网关地址需为 HTTP(S)，不能包含用户名或密码");
    if (parsed.href.includes("?") || parsed.href.includes("#")) throw invalid("网关地址不能包含查询参数或片段");
    this.url = parsed.href.replace(/\/+$/, "").replace(/\/v1$/, "");
    this.headers = { "content-type": "application/json", authorization: `Bearer ${key}`, "user-agent": `${metadata.name}/${metadata.version}` };
  }

  redact(error) {
    const key = this.headers.authorization.replace(/^Bearer\s+/i, "");
    return safeError(String(error?.message || error || "请求失败").replaceAll(key || "\0", "[已隐藏凭据]"));
  }

  async models() {
    const response = await fetch(`${this.url}/v1/models`, { headers: this.headers, signal: AbortSignal.timeout(10000), redirect: "error" });
    if (!response.ok) throw invalid(`模型目录请求失败（HTTP ${response.status}）`, 502);
    const reader = response.body?.getReader();
    if (!reader) throw invalid("模型目录没有正文", 502);
    let size = 0; const chunks = [];
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > 4 * 1024 * 1024) throw invalid("模型目录过大", 502);
        chunks.push(value);
      }
      return normalizeModels(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size))));
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }

  async accounts() {
    const response = await fetch(`${this.url}/v1/magpie/quotas?kept=1`, { headers: this.headers, signal: AbortSignal.timeout(2500), redirect: "error" });
    if (!response.ok) { await response.body?.cancel(); throw invalid("当前网关未提供缓存账号", 502); }
    const body = JSON.parse((await boundedBytes(response, 1024 * 1024)).toString("utf8"));
    const seen = new Set();
    return (Array.isArray(body.data) ? body.data : []).flatMap(item => {
      if (typeof item?.provider !== "string" || typeof item?.user !== "string" || !item.user || (item.kind && item.kind !== "subscription")) return [];
      const key = `${item.provider}\0${item.user}`; if (seen.has(key)) return [];
      seen.add(key); return [{ provider: item.provider, id: item.user, name: typeof item.alias === "string" && item.alias ? item.alias : item.user }];
    });
  }

  async route(session, signal) {
    const response = await fetch(`${this.url}/v1/magpie/route?session=${encodeURIComponent(session)}`, {
      headers: this.headers, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(2500)]) : AbortSignal.timeout(2500), redirect: "error",
    });
    if (!response.ok) { await response.body?.cancel(); throw invalid(`路由信息不可用（HTTP ${response.status}）`, 502); }
    const body = JSON.parse((await boundedBytes(response, 256 * 1024)).toString("utf8"));
    const value = body?.route || body;
    return { ...(typeof value?.model === "string" ? { model: value.model } : {}), ...(typeof value?.provider === "string" ? { provider: value.provider } : {}) };
  }

  async generate(payload, { signal, onChunk }) {
    const response = await fetch(`${this.url}/v1/chat/completions`, {
      method: "POST", headers: this.headers, body: JSON.stringify(payload), signal, redirect: "error",
    });
    if (!response.ok) {
      const reader = response.body?.getReader();
      const first = reader ? await reader.read() : { value: null };
      await reader?.cancel().catch(() => {});
      const text = first.value ? new TextDecoder().decode(first.value).slice(0, 1500) : "";
      let detail = text;
      try { const body = JSON.parse(text); detail = body.error?.message || body.message || text; } catch { /* plain upstream error */ }
      throw invalid(this.redact(`生成失败（HTTP ${response.status}）：${detail}`), 502);
    }
    let finishReason = "", usage = null, ended = false;
    const requestId = response.headers.get("x-request-id") || response.headers.get("x-magpie-request-id") || "";
    for await (const item of parseSSE(response.body)) {
      if (item.data === "[DONE]") { ended = true; break; }
      let chunk;
      try { chunk = JSON.parse(item.data); } catch { throw invalid("网关返回了无效的流式 JSON", 502); }
      if (chunk.error || item.event === "error") throw invalid(this.redact(chunk.error?.message || chunk.message || "网关流式请求失败"), 502);
      const choice = chunk.choices?.[0];
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (chunk.usage) usage = mergeUsage(usage, chunk.usage);
      const delta = choice?.delta || {};
      const content = typeof delta.content === "string" ? delta.content : "";
      const reasoning = typeof delta.reasoning_content === "string" ? delta.reasoning_content : typeof delta.reasoning === "string" ? delta.reasoning : "";
      if (content || reasoning || chunk.usage) onChunk({ content, reasoning, ...(chunk.usage ? { usage } : {}) });
    }
    if (!ended && !finishReason) throw invalid("响应在结束标志之前断开，保留了已收到的输出", 502);
    return { finishReason: finishReason || "stop", usage, requestId };
  }
}
