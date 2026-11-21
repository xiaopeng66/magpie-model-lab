import { randomUUID } from "node:crypto";
import { buildRequest, parseNumbers } from "../vendor/lmfpd-sdk/index.js";
import { boundedBytes, parseSSE, invalid, safeError } from "./gateway.mjs";
import { mergeUsage } from "./usage.mjs";

const responseText = body => (Array.isArray(body?.output) ? body.output : []).filter(item => item.type === "message")
  .flatMap(item => Array.isArray(item.content) ? item.content : []).filter(item => item.type === "output_text").map(item => typeof item.text === "string" ? item.text : "").join("");

export function fingerprintApi(configured, model) {
  if (configured && configured !== "auto") return configured;
  const endpoints = (model.nativeEndpoints || []).filter(value => typeof value === "string").join(" ").toLowerCase();
  return endpoints.includes("responses") ? "responses" : /chat(?:_|\/)completions/.test(endpoints) ? "chat_completions" : endpoints.includes("messages") ? "messages" : "chat_completions";
}

export async function sampleFingerprint(gateway, config, challenge, { signal, onUpdate = () => {} } = {}) {
  // Messages requires a positive cap; Magpie's Chat adapter can use the provider default.
  if (config.maxTokens === 0 && config.api === "messages") config = { ...config, api: "chat_completions" };
  const own = new AbortController(), combined = signal ? AbortSignal.any([signal, own.signal]) : own.signal;
  const session = randomUUID(), started = Date.now();
  const sample = { state: "waiting", text: "", raw_text: "", reasoningChars: 0, count: 0, expected_count: challenge.expected_count, first_byte_ms: null,
    response_model: null, response_id: null, error: null, usage: null, finishReason: "", requestId: "",
    provenance: { session, requestedModel: config.model, requestedProvider: config.model.split("/")[0], verified: false, mismatch: false } };
  let terminal = false, truncated = false, prefixReady = false, stoppedEarly = false, response = null, bytes = 0, reasoningBytes = 0;
  const notify = () => onUpdate({ ...sample });
  const meta = body => {
    if (typeof body?.model === "string") sample.response_model = body.model;
    if (typeof body?.id === "string") sample.response_id = body.id;
    if (body?.usage) sample.usage = mergeUsage(sample.usage, body.usage);
  };
  const think = value => {
    if (typeof value !== "string") return;
    reasoningBytes += Buffer.byteLength(value);
    if (bytes + reasoningBytes > 4 * 1024 * 1024) throw invalid("指纹采样输出超过 4 MiB，已停止", 502);
    sample.reasoningChars += value.length;
  };
  const accept = (value, final = false) => {
    if (typeof value !== "string") return;
    if (Buffer.byteLength(value) + reasoningBytes > 4 * 1024 * 1024) throw invalid("指纹采样输出超过 4 MiB，已停止", 502);
    sample.raw_text = value;
    const numbers = parseNumbers(final ? value : value.replace(/[+\-\u2212]?(?:\d+\.?\d*|\.\d+)(?:[eE][+\-]?\d*)?$/, "")); sample.count = numbers.length; sample.text = value;
    prefixReady = !config.strict && numbers.length >= challenge.expected_count;
    truncated = prefixReady && numbers.length > challenge.expected_count;
    if (prefixReady) {
      sample.count = challenge.expected_count; sample.text = numbers.slice(0, challenge.expected_count).join(", ");
    }
  };
  const append = value => {
    if (typeof value !== "string") return;
    bytes += Buffer.byteLength(value); if (bytes + reasoningBytes > 4 * 1024 * 1024) throw invalid("指纹采样输出超过 4 MiB，已停止", 502);
    accept(sample.raw_text + value);
  };
  const event = body => {
    if (body?.error || body?.type === "error") throw invalid(safeError(body.error?.message || body.message || "采样接口返回错误"), 502);
    meta(body);
    if (config.api === "chat_completions") {
      const choice = body.choices?.find(item => item.index === 0) || body.choices?.[0];
      if (choice?.delta?.refusal) throw invalid("模型拒绝了采样请求", 502);
      think(choice?.delta?.reasoning_content || choice?.delta?.reasoning);
      if (choice?.finish_reason) sample.finishReason = choice.finish_reason;
      append(choice?.delta?.content);
    } else if (config.api === "messages") {
      if (body.type === "message_start") meta(body.message);
      if (body.type === "content_block_start" && body.content_block?.type === "text") append(body.content_block.text);
      if (body.type === "content_block_start" && body.content_block?.type === "thinking") think(body.content_block.thinking);
      if (body.type === "content_block_delta" && body.delta?.type === "text_delta") append(body.delta.text);
      if (body.delta?.type === "thinking_delta") think(body.delta.thinking);
      if (body.type === "message_delta") sample.finishReason = body.delta?.stop_reason || sample.finishReason;
      if (body.type === "message_stop") terminal = true;
    } else {
      if (["response.created", "response.in_progress"].includes(body.type)) meta(body.response);
      if (["response.reasoning_text.delta", "response.reasoning_summary_text.delta"].includes(body.type)) think(body.delta);
      if (body.type === "response.output_text.delta") append(body.delta);
      if (body.type === "response.output_text.done" && !sample.raw_text) accept(body.text, true);
      if (body.type === "response.completed") {
        meta(body.response); terminal = true; sample.finishReason = body.response?.status || "completed";
        const full = responseText(body.response); if (full) accept(full, true);
      }
      if (["response.failed", "response.incomplete"].includes(body.type)) { meta(body.response); throw invalid("Responses 采样未完整结束", 502); }
      if (body.type === "response.refusal.delta") throw invalid("模型拒绝了采样请求", 502);
    }
    if (bytes + reasoningBytes > 4 * 1024 * 1024) throw invalid("指纹采样输出超过 4 MiB，已停止", 502);
    if (["refusal", "content_filter"].includes(sample.finishReason)) throw invalid("模型拒绝了采样请求", 502);
    notify();
  };
  notify();
  try {
    combined.throwIfAborted();
    if (!Number.isSafeInteger(config.maxTokens) || config.maxTokens < 0) throw invalid("输出上限需为非负整数，0 表示不设上限");
    const built = buildRequest({ baseUrl: gateway.url + "/v1", apiKey: "local", model: config.model, api: config.api, effort: config.effort,
      serviceTier: config.serviceTier || "default", strict: config.strict, stream: true }, challenge.prompt);
    if (built.error) throw invalid(built.error);
    const cap = config.api === "responses" ? "max_output_tokens" : "max_tokens";
    if (config.maxTokens > 0) built.body[cap] = config.maxTokens; else delete built.body[cap];
    const headers = { ...built.headers, ...gateway.headers, "x-magpie-session": session };
    delete headers["x-api-key"]; delete headers.Authorization;
    if (config.api === "messages") headers["x-api-key"] = gateway.headers.authorization.replace(/^Bearer\s+/i, "");
    if (config.account) headers["x-magpie-account"] = /^[\x20-\x7e]+$/.test(config.account) ? config.account : encodeURIComponent(config.account);
    response = await fetch(built.url, { method: "POST", headers, body: JSON.stringify(built.body), signal: combined, redirect: "error" });
    sample.requestId = response.headers.get("x-request-id") || response.headers.get("x-magpie-request-id") || "";
    for (const [header, key] of [["x-magpie-provider", "provider"], ["x-magpie-model", "model"]]) {
      const value = response.headers.get(header); if (value) { sample.provenance[key] = value; sample.provenance.verified = true; }
    }
    if (!response.ok) throw invalid(safeError(`采样失败（HTTP ${response.status}）：${(await boundedBytes(response, 65536)).toString("utf8").slice(0, 1200)}`), 502);
    if (/text\/event-stream/i.test(response.headers.get("content-type") || "")) {
      let grace = null;
      try {
        for await (const frame of parseSSE(response.body, () => {
          if (sample.first_byte_ms === null) { sample.first_byte_ms = Date.now() - started; sample.state = "streaming"; notify(); }
        })) {
          if (frame.data.trim() === "[DONE]") { terminal = true; break; }
          let body; try { body = JSON.parse(frame.data); } catch { throw invalid("采样流包含无效 JSON", 502); }
          if (!prefixReady) event(body);
          else { try { event(body); } catch { stoppedEarly = true; break; } }
          if (terminal) break;
          if (prefixReady && !grace) grace = setTimeout(() => { stoppedEarly = true; own.abort(); }, 1500);
        }
      } catch (error) { if (!prefixReady || signal?.aborted) throw error; stoppedEarly = true; }
      finally { clearTimeout(grace); }
      // Magpie sometimes omits [DONE] after an explicit stop.
      if (["stop", "end_turn", "completed"].includes(sample.finishReason)) terminal = true;
    } else {
      const body = JSON.parse((await boundedBytes(response)).toString("utf8")); meta(body);
      sample.first_byte_ms = Date.now() - started;
      if (body.error) throw invalid(safeError(body.error.message || "采样失败"), 502);
      let value = "";
      if (config.api === "responses") {
        value = responseText(body); sample.finishReason = body.status;
        for (const item of body.output || []) if (item.type === "reasoning") for (const part of [...(item.summary || []), ...(item.content || [])]) think(part.text);
      }
      else if (config.api === "messages") {
        value = (body.content || []).filter(item => item.type === "text").map(item => item.text || "").join(""); sample.finishReason = body.stop_reason;
        for (const item of body.content || []) if (item.type === "thinking") think(item.thinking);
      }
      else { const message = body.choices?.[0]?.message; value = message?.content || ""; sample.finishReason = body.choices?.[0]?.finish_reason; think(message?.reasoning_content || message?.reasoning); }
      terminal = ["stop", "end_turn", "completed"].includes(sample.finishReason);
      if (!terminal) { sample.raw_text = value; sample.text = value; sample.count = parseNumbers(value).length; throw invalid(`采样未正常结束：${sample.finishReason || "缺少结束状态"}`, 502); }
      accept(value, true);
    }
    if (signal?.aborted) throw signal.reason;
    if (terminal && ["stop", "end_turn", "completed"].includes(sample.finishReason) && !stoppedEarly) accept(sample.raw_text, true);
    else if (prefixReady) truncated = true;
    else throw invalid(`采样未正常结束：${sample.finishReason || "响应中断"}`, 502);
    if (sample.count < Math.max(80, Math.ceil(challenge.expected_count * .55))) throw invalid(`有效数字不足：${sample.count}/${challenge.expected_count}`, 502);
    sample.state = truncated ? "truncated" : "complete";
  } catch (error) {
    sample.state = signal?.aborted ? "cancelled" : "failed";
    sample.error = signal?.aborted ? "采样已取消，已收到的回答保留" : gateway.redact(error);
  } finally {
    own.abort(); await response?.body?.cancel().catch(() => {});
    if (!signal?.aborted) {
      try { Object.assign(sample.provenance, await gateway.route(session, signal)); sample.provenance.verified ||= Boolean(sample.provenance.model || sample.provenance.provider); }
      catch (error) { sample.provenance.routeError = gateway.redact(error); }
    }
    sample.provenance.mismatch = Boolean((sample.provenance.model && sample.provenance.model !== config.model) || (sample.provenance.provider && sample.provenance.provider !== config.model.split("/")[0]));
    if (sample.usage && sample.usage.total_tokens == null && Number.isFinite(sample.usage.input_tokens) && Number.isFinite(sample.usage.output_tokens)) sample.usage.total_tokens = sample.usage.input_tokens + sample.usage.output_tokens;
    sample.elapsed_ms = Date.now() - started; notify();
  }
  return sample;
}
