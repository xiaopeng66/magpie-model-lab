import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";

// RYP: isolated UI evidence, real project components, synthetic records and no model/data APIs.
const root = process.env.AUDIT_SOURCE_ROOT || fileURLToPath(new URL("../", import.meta.url));
const { previewDocument } = await import(pathToFileURL(join(root, "lib/result.mjs")));
const assets = new Map([
  ["/ui/style.css", "text/css; charset=utf-8"], ["/ui/polish.css", "text/css; charset=utf-8"], ["/ui/enhancements.css", "text/css; charset=utf-8"],
  ["/ui/result-insights.mjs", "text/javascript; charset=utf-8"], ["/lib/comparison.mjs", "text/javascript; charset=utf-8"], ["/lib/diagnostics.mjs", "text/javascript; charset=utf-8"],
]);
const definitions = (await readFile(join(root, "ui/index.html"), "utf8")).match(/<svg class="icon-defs"[\s\S]*?<\/svg>/)[0];
const icon = (label, name) => `<button type="button" class="icon-button" aria-label="${label}"><svg class="icon" aria-hidden="true"><use href="#i-${name}"></use></svg></button>`;
const card = (width, status, label) => `<article class="result-card" data-width="${width}" data-state="${status}"><div class="card-header"><div class="card-model"><h3>窄卡排版样例</h3><p class="card-provider">虚构供应商 · 长名称换行检查</p></div></div><div class="preview-zone"><div class="preview-placeholder">预览示例</div></div><div class="usage-strip"><span class="usage-metric"><span class="usage-label">耗时</span><span class="usage-value">2.3</span><span class="usage-unit">s</span></span></div><div class="card-footer"><span class="badge ${status}">${label}</span><div class="card-actions">${status === "completed" ? icon("重播", "replay") + icon("在浏览器打开", "external") : status === "running" ? icon("取消本次", "close") : ""}<button type="button" class="quiet detail-button" aria-label="源码与详情">查看详情</button></div></div></article>`;
const docs = {
  ordinary: '<!doctype html><html><head><title>普通 HTML</title></head><body><h1>普通 HTML</h1><script>setTimeout(()=>{throw new Error("isolated-ordinary")},120)</script></body></html>',
  commented: '<!doctype html><html><!-- documentation example: <head> --><head data-hint="a > b"><title>含注释 HTML</title></head><body><h1>含注释 HTML</h1><script>setTimeout(()=>{throw new Error("isolated-commented")},120)</script></body></html>',
  nohead: '<!doctype html><!-- root example: <html> --><html data-hint="a > b"><body><h1>省略 head</h1><script>setTimeout(()=>{throw new Error("isolated-nohead")},120)</script></body></html>',
};
const css = '<link rel="stylesheet" href="/ui/style.css"><link rel="stylesheet" href="/ui/polish.css"><link rel="stylesheet" href="/ui/enhancements.css">';
const markup = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>RYP 修复验证 · 窄卡与预览</title>${css}</head><body style="padding:24px;overflow:auto">${definitions}<h1>窄卡与预览诊断</h1><p class="help" style="margin:8px 0">使用实际源码、虚构内容，未连接模型网关或正式插件数据。</p><button id="theme-toggle" type="button">切换深色主题</button><div style="display:flex;flex-wrap:wrap;gap:20px;margin:16px 0">${[180, 200, 220].map(width => `<section><h2 style="margin-bottom:10px">${width}px · 同类等高</h2><div class="results-grid" style="grid-template-columns:${width}px">${[["completed", "已完成"], ["invalid", "无效输出"], ["running", "生成中"]].map(([status, label]) => card(width, status, label)).join("")}</div></section>`).join("")}</div><h2>预览诊断的三组对照</h2><div style="display:flex;flex-wrap:wrap;gap:16px;margin-top:12px">${Object.keys(docs).map(id => `<iframe title="${id}" sandbox="allow-scripts" referrerpolicy="no-referrer" src="/preview/${id}" style="width:240px;height:160px"></iframe>`).join("")}</div><pre id="messages" class="source-view" style="height:180px;margin-top:12px"></pre><script>const messages=[];addEventListener('message',event=>{if(event.data?.type!=='pelican-preview')return;messages.push(event.data);document.getElementById('messages').textContent=JSON.stringify(messages,null,2)});document.getElementById('theme-toggle').addEventListener('click',()=>{const dark=document.documentElement.dataset.theme!=='dark';document.documentElement.dataset.theme=dark?'dark':'light';document.getElementById('theme-toggle').textContent=dark?'切换浅色主题':'切换深色主题'});</script></body></html>`;
const focus = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>RYP 修复验证 · 趋势焦点</title>${css}</head><body style="padding:24px;max-width:680px;margin:0 auto;overflow:auto"><h1>趋势刷新与原生焦点</h1><p class="help" style="margin:8px 0">虚构记录，按钮只记录查看意图；不访问真实历史。</p><div><button id="remove-other" type="button">4 秒后移除其他记录</button><button id="remove-focused" type="button">4 秒后移除聚焦记录</button><button id="reorder" type="button">4 秒后调整记录顺序</button></div><p id="phase" class="help" style="margin:8px 0">展开趋势，安排刷新后点击第一条色条，让它取得原生焦点。</p><div id="insights"></div><p id="source-status" role="status"></p><pre id="focus-evidence" class="source-view" style="height:260px;margin-top:12px"></pre><script type="module">
import { createResultInsights } from '/ui/result-insights.mjs';
const conditions={version:1,kind:'pelican',question:'fixture-same-prompt',effort:'',maxTokens:1000,concurrency:1};
let records=['older-kept','middle-removed','anchor-kept'].map((name,index)=>({id:name,kind:'pelican',status:'completed',model:'fixture/one',createdAt:'2026-11-20T0'+(index+1)+':00:00Z',conditions,elapsedMs:1000+index*100,tokens:{total:120+index*10}}));
const anchor=records.at(-1),insights=createResultInsights(document,{timeZone:'UTC',onSource:id=>{document.getElementById('source-status').textContent='查看意图：'+id}});
document.getElementById('insights').append(insights.root);insights.update(anchor,records);
const describe=element=>({tag:element?.tagName,runId:element?.dataset.runId||null,connected:Boolean(element?.isConnected)});
for(const action of ['remove-other','remove-focused','reorder'])document.getElementById(action).addEventListener('click',()=>{
document.getElementById('phase').textContent='4 秒后更新，请让第一条色条取得焦点。';
setTimeout(()=>{const focused=document.activeElement,before=describe(focused),scroll=insights.root.querySelector('.trend-table-scroll'),scrollBefore=scroll.scrollTop;
if(action==='remove-other')records=records.filter(record=>record.id!=='middle-removed');
if(action==='remove-focused')records=records.filter(record=>record.id!==before.runId);
if(action==='reorder')records=records.map(record=>record.id===before.runId?{...record,createdAt:'2026-11-20T04:00:00Z'}:record);
insights.update(anchor,records);const replacement=[...insights.root.querySelectorAll('.trend-point')].find(point=>point.dataset.runId===before.runId);
document.getElementById('focus-evidence').textContent=JSON.stringify({action,before,after:describe(document.activeElement),retained:records.some(record=>record.id===before.runId),sameElement:replacement===focused,disclosureOpen:insights.root.querySelector('details').open,scrollBefore,scrollAfter:scroll.scrollTop,pointIds:[...insights.root.querySelectorAll('.trend-point')].map(point=>point.dataset.runId)},null,2);
document.getElementById('phase').textContent='更新已完成，原生焦点证据如下。';},4000);});
</script></body></html>`;
const previewPolicy = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, "http://127.0.0.1").pathname;
    if (path === "/" || path === "/focus") { response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); return response.end(path === "/focus" ? focus : markup); }
    if (assets.has(path)) { response.writeHead(200, { "content-type": assets.get(path), "cache-control": "no-store" }); return response.end(await readFile(join(root, path.slice(1)))); }
    if (path.startsWith("/preview/") && Object.hasOwn(docs, path.slice(9))) { const id = path.slice(9); response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": previewPolicy }); return response.end(previewDocument({ id, html: docs[id] })); }
    if (path === "/__audit_shutdown" && request.method === "POST") { response.end("stopped"); server.close(); return; }
    response.writeHead(404); response.end();
  } catch (error) { response.writeHead(500); response.end(String(error)); }
});
server.listen(0, "127.0.0.1", () => console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/`, source: root })));
