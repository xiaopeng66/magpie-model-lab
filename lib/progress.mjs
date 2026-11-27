const phases = new Set(["queued", "waiting_response", "reasoning", "output", "saving", "ended"]);
const timestamps = ["firstEventAt", "firstReasoningAt", "firstOutputAt", "lastDataAt"];
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const time = value => typeof value === "string" && Number.isFinite(Date.parse(value));

export function newProgress() {
  return { schema: 1, revision: 0, phase: "queued", firstEventAt: null, firstReasoningAt: null, firstOutputAt: null, lastDataAt: null };
}
export function validProgress(value) {
  return object(value) && value.schema === 1 && Number.isSafeInteger(value.revision) && value.revision >= 0 && phases.has(value.phase) &&
    Object.keys(value).every(key => ["schema", "revision", "phase", ...timestamps].includes(key)) && timestamps.every(key => Object.hasOwn(value, key) && (value[key] === null || time(value[key]))) &&
    (value.phase !== "reasoning" || value.firstReasoningAt !== null) && (value.phase !== "output" || value.firstOutputAt !== null);
}
export function advanceProgress(progress, event, { at } = {}) {
  if (!validProgress(progress) || !time(at) || !["start", "model_event", "reasoning", "output", "saving", "end"].includes(event)) throw new Error("运行进度事件无效");
  if (progress.phase === "ended" || progress.phase === "saving" && event !== "end") return { ...progress };
  const next = { ...progress };
  if (event === "start" && next.phase === "queued") next.phase = "waiting_response";
  if (["model_event", "reasoning", "output"].includes(event)) {
    next.firstEventAt ??= at; next.lastDataAt = at;
    if (next.phase === "queued") next.phase = "waiting_response";
    if (event === "reasoning") { next.firstReasoningAt ??= at; if (next.phase !== "output") next.phase = "reasoning"; }
    if (event === "output") { next.firstOutputAt ??= at; next.phase = "output"; }
  }
  if (event === "saving") next.phase = "saving";
  if (event === "end") next.phase = "ended";
  if (["phase", ...timestamps].some(key => next[key] !== progress[key])) next.revision++;
  return next;
}
export function readRuntimeTiming({ startedMonoMs, lastDataMonoMs, timeoutMs, progressRevision }, { monoNow = performance.now() } = {}) {
  const elapsedMs = Math.max(0, monoNow - startedMonoMs), silenceMs = Math.max(0, monoNow - (lastDataMonoMs ?? startedMonoMs));
  return { progressRevision, elapsedMs, silenceMs, remainingMs: timeoutMs === 0 ? null : Math.max(0, timeoutMs - elapsedMs) };
}
export function hasModelUsage(usage) {
  if (!object(usage)) return false;
  const count = value => Number.isSafeInteger(value) && value >= 0;
  return ["prompt_tokens", "completion_tokens", "total_tokens", "input_tokens", "output_tokens", "reasoning_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"].some(key => count(usage[key])) ||
    ["prompt_tokens_details", "completion_tokens_details", "input_tokens_details", "output_tokens_details"].some(key => object(usage[key]) && ["reasoning_tokens", "cached_tokens", "audio_tokens"].some(name => count(usage[key][name])));
}
export function chatChoice(body) {
  if (!Array.isArray(body?.choices)) return null;
  // Some adapters omit indices; an explicitly different candidate is never a fallback.
  return body.choices.find(choice => choice?.index === 0) || body.choices.find(choice => object(choice) && choice.index == null) || null;
}
export function isModelEvent(body, api, stream = true) {
  if (!object(body) || body.error || ["ping", "error"].includes(body.type)) return false;
  if (api === "chat_completions") {
    if (body.type || body.object && !["chat.completion.chunk", "chat.completion"].includes(body.object)) return false;
    const choice = chatChoice(body), message = stream ? choice?.delta : choice?.message;
    return Boolean(hasModelUsage(body.usage) || typeof choice?.finish_reason === "string" && choice.finish_reason || object(message) &&
      (["content", "reasoning_content", "reasoning"].some(key => typeof message[key] === "string") || message.role === "assistant" || Array.isArray(message.tool_calls) && message.tool_calls.length));
  }
  if (api === "messages") {
    if (!stream) return Array.isArray(body.content) && (body.type === "message" || typeof body.stop_reason === "string");
    if (body.type === "message_start") return object(body.message);
    if (body.type === "content_block_start") return ["text", "thinking", "tool_use", "redacted_thinking"].includes(body.content_block?.type);
    if (body.type === "content_block_delta") return Object.entries({ text_delta: "text", thinking_delta: "thinking", signature_delta: "signature", input_json_delta: "partial_json" }).some(([type, field]) => body.delta?.type === type && typeof body.delta[field] === "string");
    if (body.type === "message_delta") return hasModelUsage(body.usage) || typeof body.delta?.stop_reason === "string";
    return ["content_block_stop", "message_stop"].includes(body.type);
  }
  if (api === "responses") {
    if (!stream) return Array.isArray(body.output) && ["completed", "in_progress", "incomplete", "failed"].includes(body.status);
    if (["response.created", "response.queued", "response.in_progress", "response.completed"].includes(body.type)) return object(body.response);
    if (["response.output_item.added", "response.output_item.done"].includes(body.type)) return object(body.item);
    if (["response.content_part.added", "response.content_part.done", "response.reasoning_summary_part.added", "response.reasoning_summary_part.done"].includes(body.type)) return object(body.part);
    if (["response.output_text.delta", "response.reasoning_text.delta", "response.reasoning_summary_text.delta"].includes(body.type)) return typeof body.delta === "string";
    if (["response.output_text.done", "response.reasoning_text.done", "response.reasoning_summary_text.done"].includes(body.type)) return typeof body.text === "string";
  }
  return false;
}
