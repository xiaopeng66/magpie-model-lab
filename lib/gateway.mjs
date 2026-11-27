import { mergeUsage } from "./usage.mjs";
import metadata from "../package.json" with { type: "json" };
import { DEFAULT_MAX_TOKENS } from "./test-parameters.mjs";
import { chatChoice, isModelEvent } from "./progress.mjs";
import { randomUUID } from "node:crypto";
import { accountHeader, normalizeAccount, routingEvidence, validAccountId } from "./targets.mjs";
import { readKeyAccounts } from './key-accounts.mjs';
export { DEFAULT_MAX_TOKENS, DEFAULT_TIMEOUT_MS, generationTimeout } from "./test-parameters.mjs";

export const DEFAULT_PROMPT = '请生成一个“鹈鹕骑自行车”的循环动画。输出一个完整的、保存为 .html 后可离线打开的单文件 HTML。使用内联 CSS、JavaScript，以及 SVG 或 Canvas；不要依赖外部图片、字体、CDN、库或网络。画面应让人清楚看出鹈鹕正在骑自行车，并有连续的骑行动作。只返回 HTML，不要 Markdown 代码围栏或解释。';
export function invalid(message, status = 400) {
  return Object.assign(new Error(message), { status });
}
export function requestIdOf(response, redact) {
  const value = response.headers.get('x-request-id') || response.headers.get('x-magpie-request-id') || '';
  return value && redact(value) === value ? value : '';
}

export function finishCode(value) {
  if (value == null || value === '') return '';
  return ['stop', 'end_turn', 'completed', 'length', 'max_tokens', 'refusal', 'content_filter', 'tool_calls', 'function_call', 'tool_use', 'stop_sequence', 'pause_turn', 'incomplete', 'failed', 'error', 'cancelled'].includes(value) ? value : 'unknown';
}

export async function upstreamFailure(label, response, redact) {
  let detail;
  try {
    detail = (await boundedBytes(response, 65536)).toString('utf8');
    try { const body = JSON.parse(detail); detail = body?.error?.message || body?.message || detail; } catch {}
  } catch (error) { detail = error.message; }
  return upstreamError(redact(`${label}（HTTP ${response.status}）：${detail}`), response, redact);
}

export function upstreamError(message, response, redact = safeError) {
  const raw = response.headers.get('retry-after'), seconds = raw && /^\d+(?:\.\d+)?$/.test(raw.trim()) ? Number(raw) * 1000 : raw ? Date.parse(raw) - Date.now() : null;
  return Object.assign(invalid(message, 502), { upstreamStatus: response.status, requestId: requestIdOf(response, redact),
    retryAfterMs: seconds !== null && Number.isFinite(seconds) ? Math.max(1000, seconds) : null });
}

export function safeError(error) {
  return String(error?.message || error || "请求失败")
    .replace(/\b(?:Bearer\s+|sk-)[A-Za-z0-9._-]+/gi, "[已隐藏凭据]")
    .replace(/((?:api[_-]?key|authorization|access[_-]?token)\s*[=:]\s*["']?)[^\s"',}]+/gi, "$1[已隐藏凭据]")
    .slice(0, 600);
}

const hideUnreadableDiagnostics = () => '本机凭据配置暂不可读，已隐藏上游详情';

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
  #keyRedactor = value => value;
  constructor({ url = "http://127.0.0.1:3425", key = "magpie", configDir } = {}) {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw invalid("网关地址需为 HTTP(S)，不能包含用户名或密码");
    if (parsed.href.includes("?") || parsed.href.includes("#")) throw invalid("网关地址不能包含查询参数或片段");
    this.url = parsed.href.replace(/\/+$/, "").replace(/\/v1$/, "");
    this.configDir = configDir;
    this.headers = { "content-type": "application/json", authorization: `Bearer ${key}`, "user-agent": `${metadata.name}/${metadata.version}` };
  }

  redact(error, hideKeys = this.#keyRedactor) {
    const key = this.headers.authorization.replace(/^Bearer\s+/i, "");
    return safeError(hideKeys(String(error?.message || error || "请求失败")).replaceAll(key || "\0", "[已隐藏凭据]"));
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
      let catalog;
      try { catalog = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size))); }
      catch { throw invalid('模型目录不是有效的 UTF-8 JSON', 502); }
      return normalizeModels(catalog);
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }

  async cachedAccounts() {
    const response = await fetch(`${this.url}/v1/magpie/quotas?kept=1`, { headers: this.headers, signal: AbortSignal.timeout(2500), redirect: "error" });
    if (!response.ok) { await response.body?.cancel(); throw upstreamError("当前网关未提供缓存账号", response); }
    let body;
    try { body = JSON.parse((await boundedBytes(response, 1024 * 1024)).toString("utf8")); } catch { throw invalid('缓存账号响应无效', 502); }
    if (!Array.isArray(body?.data)) throw invalid('缓存账号响应格式不正确', 502);
    const seen = new Set();
    return (Array.isArray(body.data) ? body.data : []).flatMap(item => {
      if (typeof item?.provider !== "string" || !validAccountId(item?.user) || (item.kind && item.kind !== "subscription")) return [];
      const key = `${item.provider}\0${item.user}`; if (seen.has(key)) return [];
      seen.add(key); return [{ provider: item.provider, id: item.user, name: typeof item.alias === "string" && item.alias ? item.alias.slice(0,256) : item.user,
        enabled: typeof item.on === 'boolean' ? item.on : typeof item.enabled === 'boolean' ? item.enabled : null, available: typeof item.available === 'boolean' ? item.available : null }];
    });
  }

  async accountSnapshot({ modelId } = {}) {
    const capability = await this.accountCapabilities();
    let hideKeys = value => value;
    const [cached, local] = await Promise.allSettled([this.cachedAccounts(), capability.pinned ? readKeyAccounts({ url: this.url, configDir: this.configDir, onRedact: redact => { hideKeys = redact; } }) : Promise.resolve({ accounts: [], warning: '' })]);
    this.#keyRedactor = hideKeys;
    const keys = local.status === 'fulfilled' ? local.value : { accounts: [], warning: '本机 API Key 配置暂不可读，请在 Magpie 检查后刷新。' };
    if (cached.status === 'rejected' && !keys.accounts.length) throw cached.reason;
    const registered = (cached.status === 'fulfilled' ? cached.value : []).filter(account => hideKeys(account.id) === account.id && hideKeys(account.provider) === account.provider).map(account => ({ ...account, name: hideKeys(account.name) }));
    const accounts = [...registered, ...keys.accounts];
    const identities = new Map();
    for (const account of accounts) {
      const identity = account.provider + '\0' + account.id;
      identities.set(identity, (identities.get(identity) || 0) + 1);
    }
    for (const account of accounts) {
      if (identities.get(account.provider + '\0' + account.id) > 1) Object.assign(account, { available: false, unavailableReason: '账号标识冲突，请在 Magpie 检查账号配置' });
      else if (modelId && account.modelIds && !account.modelIds.includes(modelId)) Object.assign(account, { available: false, unavailableReason: '此 Key 未允许使用当前模型，请在 Magpie 调整模型范围' });
    }
    const redact = keys.warning ? hideUnreadableDiagnostics : error => this.redact(error, hideKeys);
    return { accounts, warning: [cached.status === 'rejected' ? '已注册账号缓存暂不可读，当前只显示本机 API Key。' : '', keys.warning].filter(Boolean).join(' '), redact };
  }

  async accounts(options) { return (await this.accountSnapshot(options)).accounts; }

  async accountCapabilities() {
    if (!this.hostCapability) this.hostCapability = (async () => {
      const res = await fetch(this.url + '/', { headers: this.headers, signal: AbortSignal.timeout(2500), redirect: 'error' });
      if (!res.ok) { await res.body?.cancel(); return { pinned: false, reason: '无法核实宿主账号路由能力' }; }
      const body = JSON.parse((await boundedBytes(res, 262144)).toString('utf8'));
      const version = String(body.version || '').replace(/^v/,''), match = /^0\.1\.(\d+)$/.exec(version);
      return { pinned: String(body.name || '').toLowerCase() === 'magpie' && Boolean(match && Number(match[1]) >= 4530), hostVersion: version,
        reason: '固定账号按 Magpie X-Magpie-Account 契约请求；实际账号仅在可信 ID 证据匹配时验证', cachedStates: true };
    })().catch(() => ({ pinned: false, reason: '无法核实宿主账号路由能力' })).then(result => {
      if (!result.hostVersion) this.hostCapability = null;
      return result;
    });
    return this.hostCapability;
  }
  async bindAccount(provider, account, modelId) {
    account = normalizeAccount(account);
    if (account.mode === 'auto') return { account, header: '' };
    if (modelId && modelId.split('/')[0] !== provider) throw invalid('账号供应商与模型不一致', 409);
    const capability = await this.accountCapabilities();
    if (!capability.pinned) throw invalid('当前宿主未确认固定账号路由能力，请保留自动路由或升级宿主', 409);
    const snapshot = await this.accountSnapshot({ modelId }), found = snapshot.accounts.find(item => item.provider === provider && item.id === account.id);
    if (!found) throw invalid('固定账号不存在或不属于该模型供应商', 409);
    if (found.enabled === false || found.available === false) throw invalid(found.unavailableReason || '固定账号已停用或当前不可用', 409);
    return { account: { ...account, name: found.name }, header: accountHeader(found.kind === 'key' ? found.routingId : account.id), redact: snapshot.redact };
  }
  async assertAccount(provider, account, modelId) { return (await this.bindAccount(provider, account, modelId)).account; }
  async resolveAccount(modelId, account) {
    const binding = await this.bindAccount(modelId?.split('/')[0], account, modelId);
    if (binding.header) return binding;
    let hideKeys = value => value;
    const result = await readKeyAccounts({ url: this.url, configDir: this.configDir, redactOnly: true, onRedact: redact => { hideKeys = redact; } });
    return { ...binding, redact: result.warning ? hideUnreadableDiagnostics : error => this.redact(error, hideKeys) };
  }

  async route(session, signal, binding) {
    const response = await fetch(`${this.url}/v1/magpie/route?session=${encodeURIComponent(session)}`, {
      headers: this.headers, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(2500)]) : AbortSignal.timeout(2500), redirect: "error",
    });
    if (!response.ok) { await response.body?.cancel(); throw invalid(`路由信息不可用（HTTP ${response.status}）`, 502); }
    const bytes = await boundedBytes(response, 256 * 1024);
    let body;
    try { body = JSON.parse(bytes.toString('utf8')); } catch { throw invalid('路由响应格式不正确', 502); }
    const value = body?.route || body;
    const evidence = { ...(typeof value?.model === "string" ? { model: value.model } : {}), ...(typeof value?.provider === "string" ? { provider: value.provider } : {}),
      ...(validAccountId(value?.accountId) ? { accountId: value.accountId } : {}), ...(validAccountId(value?.providerAccount) ? { providerAccount: value.providerAccount } : {}) };
    const redact = binding?.redact || (text => this.redact(text));
    for (const [field, text] of Object.entries(evidence)) if (redact(text) !== text) delete evidence[field];
    if (/^key:[a-f0-9]{64}$/.test(binding?.account?.id || '')) {
      for (const field of ['accountId', 'providerAccount']) if (evidence[field] === binding.header) {
        // A lone Key's provider seat gives no Key identity evidence.
        if (!binding.header.includes('#')) delete evidence[field];
        else evidence[field] = binding.account.id;
      }
    }
    return evidence;
  }

  async generate(payload, { signal, onChunk = () => {}, account = { mode: 'auto' }, session = randomUUID(), beforeFetch, onFetch } = {}) {
    signal?.throwIfAborted(); let binding = beforeFetch && normalizeAccount(account).mode === 'auto' ? null : await this.resolveAccount(payload.model, account); signal?.throwIfAborted();
    await beforeFetch?.(); signal?.throwIfAborted();
    if (beforeFetch) binding = await this.resolveAccount(payload.model, account);
    signal?.throwIfAborted(); account = binding.account;
    const redact = binding.redact || (error => this.redact(error));
    const headers = { ...this.headers, 'x-magpie-session': session, ...(binding.header ? { 'x-magpie-account': binding.header } : {}) };
    onFetch?.();
    const response = await fetch(`${this.url}/v1/chat/completions`, {
      method: "POST", headers, body: JSON.stringify(payload), signal, redirect: "error",
    });
    if (!response.ok) throw await upstreamFailure('生成失败', response, redact);
    let finishReason = "", usage = null, ended = false;
    const requestId = requestIdOf(response, redact);
    for await (const item of parseSSE(response.body)) {
      if (item.data === "[DONE]") { ended = true; break; }
      let chunk;
      try { chunk = JSON.parse(item.data); } catch { throw invalid("网关返回了无效的流式 JSON", 502); }
      if (chunk.error || item.event === "error") throw invalid(redact(chunk.error?.message || chunk.message || "网关流式请求失败"), 502);
      const choice = chatChoice(chunk);
      if (choice?.finish_reason != null) finishReason = finishCode(choice.finish_reason) || finishReason;
      if (chunk.usage) usage = mergeUsage(usage, chunk.usage);
      const delta = choice?.delta || {};
      const content = typeof delta.content === "string" ? delta.content : "";
      const reasoning = typeof delta.reasoning_content === "string" ? delta.reasoning_content : typeof delta.reasoning === "string" ? delta.reasoning : "";
      const modelEvent = isModelEvent(chunk, "chat_completions");
      if (content || reasoning || chunk.usage || modelEvent) onChunk({ content, reasoning, modelEvent, ...(chunk.usage ? { usage } : {}) });
    }
    if (!ended && !finishReason) throw invalid("响应在结束标志之前断开，保留了已收到的输出", 502);
    let evidence = {}; try { evidence = await this.route(session, signal, binding); } catch { /* absent account evidence remains unavailable */ }
    return { finishReason: finishReason || "stop", usage, requestId, routing: routingEvidence(account, evidence, Object.keys(evidence).length ? 'magpie-route' : null) };
  }
}
