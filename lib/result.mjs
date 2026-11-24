import { tokenUsage } from "./usage.mjs";
import { createHash } from "node:crypto";
import { failureInfo } from "./diagnostics.mjs";
import { conditionProfile } from "./comparison.mjs";

export const SAVED_SUMMARY = Symbol("saved run summary");

export function extractHTML(text) {
  if (typeof text !== "string") return "";
  const fenced = [...text.matchAll(/```(?:html)?\s*\n([\s\S]*?)```/gi)].map((m) => m[1]);
  for (const candidate of [...fenced, text]) {
    let root = -1, doctype = -1, templates = 0;
    for (const tag of htmlTags(candidate)) {
      if (tag.name === "template") { templates = Math.max(0, templates + (tag.closing ? -1 : 1)); continue; }
      if (templates) continue;
      if (tag.name === "!doctype" && root < 0) doctype = tag.start;
      if (tag.name !== "html") continue;
      if (!tag.closing && root < 0) root = doctype < 0 ? tag.start : doctype;
      if (tag.closing && root >= 0) return candidate.slice(root, tag.end).trim();
    }
  }
  return "";
}

export function classifyResult(content, finishReason) {
  const html = extractHTML(content);
  if (["length", "max_tokens"].includes(finishReason)) return { status: "truncated", html, error: "输出达到 Token 上限；本次结果不自动预览" };
  if (finishReason !== "stop") return { status: "error", html, error: `请求未正常结束：${finishReason || "缺少结束标志"}` };
  if (!html) return { status: "invalid", html: "", error: "回复未包含完整 HTML 文档；原始输出已保留" };
  return { status: "completed", html, error: "" };
}

export function previewDocument(run) {
  const diagnostic = `<script>(()=>{const id=${JSON.stringify(run.id)};const report=(kind,message)=>parent.postMessage({type:'pelican-preview',id,kind,message:String(message||'').slice(0,400)},'*');addEventListener('error',e=>report('error',e.message));addEventListener('unhandledrejection',e=>report('error',e.reason&&e.reason.message||e.reason));addEventListener('load',()=>{report('ready','');requestAnimationFrame(()=>{const root=document.documentElement,body=document.body;parent.postMessage({type:'pelican-preview',id,kind:'size',width:Math.max(innerWidth,root.scrollWidth,body?.scrollWidth||0),height:Math.max(innerHeight,root.scrollHeight,body?.scrollHeight||0)},'*');});});})();</script>`;
  const { at, hasHead } = previewInsertion(run.html);
  if (at < 0) return run.html;
  return run.html.slice(0, at) + (hasHead ? diagnostic : `<head>${diagnostic}</head>`) + run.html.slice(at);
}

function* htmlTags(html) {
  let cursor = 0;
  while (cursor < html.length) {
    const start = html.indexOf("<", cursor); if (start < 0) break;
    if (html.startsWith("<!--", start)) { const end = html.indexOf("-->", start + 4); cursor = end < 0 ? html.length : end + 3; continue; }
    const tag = /^<(\/?)(!doctype|[a-z][\w:-]*)\b/i.exec(html.slice(start));
    if (!tag) { cursor = start + 1; continue; }
    let end = start + tag[0].length, quote = "";
    for (; end < html.length; end++) {
      const ch = html[end];
      if (quote) { if (ch === quote) quote = ""; }
      else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === ">") break;
    }
    if (end >= html.length) break;
    cursor = end + 1;
    const name = tag[2].toLowerCase(), closing = Boolean(tag[1]);
    yield { start, end: cursor, name, closing };
    // HTML treats these contents as text even when they contain apparent opening tags.
    if (!closing && ["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "noscript"].includes(name)) {
      const ending = new RegExp(`</${name}\\s*>`, "gi"); ending.lastIndex = cursor;
      const match = ending.exec(html); cursor = match ? match.index + match[0].length : html.length;
    } else if (!closing && name === "plaintext") cursor = html.length;
  }
}

function previewInsertion(html) {
  let root = -1, templates = 0;
  for (const { name, closing, end } of htmlTags(html)) {
    if (name === "template") { templates = Math.max(0, templates + (closing ? -1 : 1)); continue; }
    if (!closing && !templates) {
      if (name === "head") return { at: end, hasHead: true };
      if (name === "html" && root < 0) root = end;
      if (name === "body") break;
    }
  }
  return { at: root, hasHead: false };
}

export function summary(run) {
  if (run[SAVED_SUMMARY]) return { ...run[SAVED_SUMMARY] };
  const question = run.kind === "fingerprint" ? Array.isArray(run.challenges) && run.challenges.length === 3 && run.challenges.every(challenge => typeof challenge?.prompt === "string" && Number.isSafeInteger(challenge.expected_count))
    ? JSON.stringify(run.challenges.map(challenge => [challenge.prompt, challenge.expected_count])) : null : typeof run.prompt === "string" && run.prompt.trim() ? run.prompt : null;
  const questionHash = question ? createHash("sha256").update(question).digest("hex") : run.kind === "fingerprint" ? null : run.promptHash;
  const insights = { diagnostic: failureInfo(run), conditions: conditionProfile({ ...run, conditions: undefined, questionHash }) };
  if (run.kind === "fingerprint") {
    const { samples = [], challenges, analysis, content, reasoning, html, payload, previewKey, ...meta } = run;
    return { ...meta, ...insights, tokens: tokenUsage(run), hasHTML: false, contentChars: samples.reduce((sum, sample) => sum + (sample.raw_text?.length || 0), 0), reasoningChars: samples.reduce((sum, sample) => sum + (sample.reasoningChars || 0), 0),
      fingerprint: { samples: samples.map(sample => ({ state: sample.state, count: sample.count, expectedCount: sample.expected_count,
        ...(sample.progress ? { progress: sample.progress, startedAt: sample.startedAt, finishedAt: sample.finishedAt, elapsedMs: sample.elapsed_ms } : {}), ...(sample.progressWarning ? { progressWarning: sample.progressWarning } : {}) })),
        completed: samples.filter(sample => !["queued", "waiting", "streaming"].includes(sample.state)).length,
        valid: samples.filter(sample => ["complete", "truncated"].includes(sample.state)).length,
        prediction: analysis?.results?.[0]?.display_name || "", family: analysis?.family_prediction_name || "", decision: analysis?.decision || "",
        probability: analysis?.probability ?? null, verified: samples.length > 0 && samples.every(sample => sample.provenance?.verified),
        mismatch: samples.some(sample => sample.provenance?.mismatch) } };
  }
  const { content, reasoning, html, payload, previewKey, samples, ...meta } = run;
  return { ...meta, ...insights, tokens: tokenUsage(run), hasHTML: Boolean(html), contentChars: content?.length || 0, reasoningChars: reasoning?.length || 0 };
}
