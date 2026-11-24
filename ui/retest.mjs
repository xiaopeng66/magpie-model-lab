import { failureInfo } from "../lib/diagnostics.mjs";
import { accountLabel } from '../lib/targets.mjs';

export async function openRetestDrawer({ document, openDrawer, closeDrawer, api, runIds, origin, names, kindLabel, onCreated, onSubmitting, onError }) {
  const node = (tag, className = "", value) => { const element = document.createElement(tag); element.className = className; if (value !== undefined) element.textContent = value; return element; };
  const text = (element, value) => { const next = String(value ?? ""); if (element.textContent !== next) element.textContent = next; };
  const button = (label, action, className = "quiet") => { const control = node("button", className, label); control.type = "button"; control.addEventListener("click", action); return control; };
  const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body) });
  const $ = id => document.getElementById(id);
  let alive = true, submitting = false, operation = null, kind = "", items = [];
  const content = openDrawer("按原条件复测", origin, "compact", () => { alive = false; });
  const feedback = $("drawer-status"), caption = node("p", "help", "正在读取原条件…"), list = node("div", "retest-records");
  content.append(caption);
  const fail = message => { if (!alive) return; text(feedback, message); feedback.hidden = false; feedback.dataset.tone = "error"; };
  const clearFailure = () => { text(feedback, ""); feedback.hidden = true; };
  let start, shortcuts, types, causes;
  const selected = () => items.filter(item => item.kind === kind && item.available && item.control.checked);
  const update = () => {
    const picks = selected(), requests = picks.length * (kind === "fingerprint" ? 3 : 1);
    text(start, `开始复测（${picks.length} 条）`); start.disabled = submitting || !picks.length; start.setAttribute("aria-busy", String(submitting));
    text(caption, `${kindLabel(kind)} · ${items.filter(item => item.kind === kind).length} 条原记录 · 本次 ${requests} 个请求${kind === "fingerprint" ? "（每条三组采样）" : ""}`);
    for (const item of items) { item.root.hidden = item.kind !== kind; item.control.disabled = submitting || !item.available; }
    for (const control of shortcuts.children) control.disabled = submitting;
    for (const control of types.children) { control.disabled = submitting; control.setAttribute("aria-pressed", String(control.dataset.kind === kind)); }
    for (const control of causes.children) {
      const matches = items.filter(item => item.kind === kind && item.available && item.diagnostic?.code === control.dataset.cause);
      control.hidden = !matches.length; control.disabled = submitting || !matches.length;
      text(control, `${control.dataset.label} ${matches.length}`);
      control.setAttribute("aria-pressed", String(matches.length > 0 && picks.length === matches.length && matches.every(item => item.control.checked)));
    }
    causes.hidden = ![...causes.children].some(control => !control.hidden);
  };
  const choose = predicate => { for (const item of items) if (item.kind === kind) item.control.checked = item.available && predicate(item); clearFailure(); update(); };
  start = button("开始复测（0 条）", async () => {
    if (!alive || submitting || start.disabled) return;
    const picks = selected(), key = picks.map(item => item.id).sort().join("|");
    if (!picks.length) return;
    if (operation?.key !== key) operation = { key, id: crypto.randomUUID() };
    submitting = true; clearFailure(); update(); onSubmitting(true);
    try {
      const result = await post("api/retests", { runIds: picks.map(item => item.id), operationId: operation.id });
      const wasOpen = alive; if (wasOpen) closeDrawer(); onCreated(result, wasOpen);
    } catch (error) { if (alive) fail(error.message); else onError(error.message); }
    finally { submitting = false; onSubmitting(false); if (alive) update(); }
  }, "primary");
  start.disabled = true;
  $("drawer-footer").append(node("span", "help", "原记录保留"), button("取消", closeDrawer), start);
  try {
    const preview = await post("api/retests/preview", { runIds }); if (!alive) return;
    types = node("div", "segments retest-types"); types.setAttribute("role", "group"); types.setAttribute("aria-label", "复测类型");
    shortcuts = node("div", "segments retest-shortcuts"); shortcuts.setAttribute("role", "group"); shortcuts.setAttribute("aria-label", "选择复测记录");
    causes = node("div", "segments retest-causes"); causes.setAttribute("role", "group"); causes.setAttribute("aria-label", "按异常原因选择复测记录");
    shortcuts.append(button("全部可复测", () => choose(() => true)), button("仅选异常", () => choose(item => item.abnormal)), button("清空", () => choose(() => false)));
    const kinds = ["pelican", "fingerprint", "candy"].filter(value => preview.items.some(item => item.kind === value)); kind = kinds[0];
    for (const value of kinds) { const control = button(kindLabel(value), () => { kind = value; clearFailure(); update(); }); control.dataset.kind = value; types.append(control); }
    types.hidden = kinds.length < 2;
    content.append(types, shortcuts, causes, list);
    items = preview.items.map(item => {
      const root = node("section", "retest-record"), heading = node("label", "retest-record-heading"), control = node("input"), identity = node("span", "retest-identity");
      control.type = "checkbox"; control.checked = item.available && item.run.status !== "cancelled";
      const [name, provider] = names(item.run); identity.append(node("strong", "", name), node("span", "card-provider", provider));
      const repeatCount = item.run.experiment?.repeatCount, roundIndex = item.run.repetitionIndex;
      const round = Number.isSafeInteger(repeatCount) && repeatCount > 1 && Number.isSafeInteger(roundIndex) && roundIndex >= 0 && roundIndex < repeatCount ? `第 ${roundIndex + 1}/${repeatCount} 轮` : "";
      if (round) identity.append(node("span", "help retest-round", round));
      control.setAttribute("aria-label", [`复测 ${name}`, provider, round].filter(Boolean).join(" · ")); heading.append(control, identity);
      const result = node("span", "retest-original-result", ({ queued: "排队中", running: "生成中", completed: "已完成", error: "请求失败", invalid: "无效输出", truncated: "输出截断", cancelled: "已取消", interrupted: "已中断" })[item.run.status] || "—");
      if (item.run.status === "completed" && item.kind === "candy") text(result, ({ match: "命中 · 21", mismatch: `答错 · ${item.run.candy?.answer ?? "—"}`, review: "待复核" })[item.run.candy?.verdict] || "待复核");
      const diagnostic = failureInfo(item.run);
      if (diagnostic && item.run.status !== "completed") text(result, diagnostic.label);
      result.dataset.tone = diagnostic?.tone || (["error", "invalid"].includes(item.run.status) ? "error" : item.abnormal ? "warning" : item.run.status === "completed" && item.run.candy?.verdict === "mismatch" ? "error" :
        item.run.status === "completed" && item.run.candy?.verdict === "match" ? "success" : "muted");
      heading.append(result); root.append(heading);
      if (diagnostic?.abnormal) root.append(node("p", "help retest-cause-advice", diagnostic.advice));
      if (item.conditions) {
        const conditions = item.conditions, details = node("details", "retest-evidence"), summary = node("summary", "", "查看原题面与条件");
        const cap = conditions.maxTokens === 0 ? "不设输出上限" : `输出上限 ${conditions.maxTokens.toLocaleString()} Token`;
        const timeout = conditions.timeoutMs === 0 ? "不设超时" : `超时 ${(conditions.timeoutMs ?? 600000) / 1000} 秒`;
        root.append(node("p", "retest-condition-line help", `思考 ${conditions.effort || "默认"} · ${cap} · ${timeout} · ${conditions.concurrency === 0 ? "不设并行上限" : `并行 ${conditions.concurrency}`}`));
        const evidence = item.kind === "fingerprint" ? `${conditions.api} · ${conditions.strict ? "严格采样" : "普通采样"} · ${conditions.serviceTier}\n账号 ${accountLabel(conditions.accountTarget) || conditions.account || "自动分配"}\n参考库 ${conditions.bank?.builtAt || "—"}\n${conditions.bank?.sha256 || ""}\n\n${(conditions.challenges || []).map((challenge, index) => `采样 ${index + 1} · ${challenge.expected_count} 个数字\n${challenge.prompt}`).join("\n\n")}` : conditions.prompt;
        const original = node("pre", "source-view", evidence); original.setAttribute("tabindex", "0"); details.append(summary, original); root.append(details);
      }
      if (item.reason) root.append(node("p", "inline-error", item.reason));
      control.addEventListener("change", () => { clearFailure(); update(); }); list.append(root);
      return { ...item, diagnostic, root, control };
    });
    const found = new Map(items.filter(item => item.diagnostic?.abnormal).map(item => [item.diagnostic.code, item.diagnostic]));
    for (const [code, diagnostic] of found) {
      const control = button(diagnostic.label, () => choose(item => item.diagnostic?.code === code));
      control.dataset.cause = code; control.dataset.label = diagnostic.label; control.title = diagnostic.advice; causes.append(control);
    }
    content.append(node("p", "help retest-note", "参数只读；复测会创建新的手动批次。"));
    update();
  } catch (error) {
    fail(error.message);
    if (alive) content.append(button("重新核对", () => openRetestDrawer({ document, openDrawer, closeDrawer, api, runIds, origin, names, kindLabel, onCreated, onSubmitting, onError })));
  }
}
