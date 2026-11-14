import { tokenUsage } from "./usage.mjs";

export function extractHTML(text) {
  if (typeof text !== "string") return "";
  const fenced = [...text.matchAll(/```(?:html)?\s*\n([\s\S]*?)```/gi)].map((m) => m[1]);
  for (const candidate of [...fenced, text]) {
    const start = candidate.match(/(?:<!doctype\s+html[^>]*>\s*)?<html\b[^>]*>/i);
    if (!start) continue;
    const offset = start.index + start[0].length;
    // Root closing tags inside comments and raw-text elements are document content.
    const endings = candidate.slice(offset).matchAll(/<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)|<\/html\s*>/gi);
    for (const ending of endings) {
      if (/^<\/html\s*>$/i.test(ending[0])) return candidate.slice(start.index, offset + ending.index + ending[0].length).trim();
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
  if (/<head\b[^>]*>/i.test(run.html)) return run.html.replace(/<head\b[^>]*>/i, (head) => head + diagnostic);
  return run.html.replace(/<html\b[^>]*>/i, (root) => root + "<head>" + diagnostic + "</head>");
}

export function summary(run) {
  if (run.kind === "fingerprint") {
    const { samples = [], challenges, analysis, content, reasoning, html, payload, previewKey, ...meta } = run;
    return { ...meta, tokens: tokenUsage(run), hasHTML: false, contentChars: samples.reduce((sum, sample) => sum + (sample.raw_text?.length || 0), 0), reasoningChars: samples.reduce((sum, sample) => sum + (sample.reasoningChars || 0), 0),
      fingerprint: { samples: samples.map(sample => ({ state: sample.state, count: sample.count, expectedCount: sample.expected_count })),
        completed: samples.filter(sample => !["queued", "waiting", "streaming"].includes(sample.state)).length,
        valid: samples.filter(sample => ["complete", "truncated"].includes(sample.state)).length,
        prediction: analysis?.results?.[0]?.display_name || "", family: analysis?.family_prediction_name || "", decision: analysis?.decision || "",
        probability: analysis?.probability ?? null, verified: samples.length > 0 && samples.every(sample => sample.provenance?.verified),
        mismatch: samples.some(sample => sample.provenance?.mismatch) } };
  }
  const { content, reasoning, html, payload, previewKey, ...meta } = run;
  return { ...meta, tokens: tokenUsage(run), hasHTML: Boolean(html), contentChars: content?.length || 0, reasoningChars: reasoning?.length || 0 };
}
