import { failureInfo } from "../lib/diagnostics.mjs";
import { recentTrend } from "../lib/comparison.mjs";

const duration = value => value === null ? "—" : `${(value / 1000).toFixed(1)} s`;
const tokens = value => value === null ? "—" : value.toLocaleString("en-US", { maximumFractionDigits: 1 });

export function createResultInsights(document, { onSource, timeZone } = {}) {
  const node = (tag, className = "", value) => { const element = document.createElement(tag); element.className = className; if (value !== undefined) element.textContent = value; return element; };
  const text = (element, value) => { if (element.textContent !== value) element.textContent = value; };
  const when = at => new Date(at).toLocaleString("zh-CN", { timeZone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const root = node("section", "result-insights"), diagnosis = node("section", "result-diagnosis"), label = node("strong", "diagnosis-label"), advice = node("p", "diagnosis-advice");
  diagnosis.hidden = true; diagnosis.setAttribute("role", "status"); diagnosis.setAttribute("aria-live", "polite"); diagnosis.append(label, advice);
  const trend = node("details", "result-trend"), toggle = node("summary", "trend-toggle", "同模型近期趋势"), body = node("div", "trend-body"), metrics = node("div", "trend-metrics");
  const rate = node("strong", "trend-rate"), rateLabel = node("span"), elapsed = node("strong"), elapsedLabel = node("span"), total = node("strong"), totalLabel = node("span");
  for (const [value, caption] of [[rate, rateLabel], [elapsed, elapsedLabel], [total, totalLabel]]) { const metric = node("div", "trend-metric"); metric.append(value, caption); metrics.append(metric); }
  const note = node("p", "help trend-note"), candidate = node("p", "help trend-candidates"), track = node("div", "trend-track"), help = node("p", "help trend-help");
  track.setAttribute("role", "group"); track.setAttribute("aria-label", "同条件记录，由早到晚；点击查看对应历史");
  const scroll = node("div", "trend-table-scroll"), table = node("table", "trend-table"), head = node("thead"), row = node("tr"), rows = node("tbody");
  scroll.setAttribute("role", "region"); scroll.setAttribute("aria-label", "同模型近期记录"); scroll.setAttribute("tabindex", "0"); table.setAttribute("aria-label", "相同条件下的近期结果");
  for (const title of ["时间", "结果", "耗时", "总 Token"]) { const cell = node("th", "", title); cell.setAttribute("scope", "col"); row.append(cell); }
  head.append(row); table.append(head, rows); scroll.append(table); body.append(metrics, note, candidate, track, help, scroll); trend.append(toggle, body); root.append(diagnosis, trend);
  trend.open = false;
  let signature = ""; const controls = new Map();
  return { root, update(run, records, context = {}) {
    const cause = failureInfo(run, context); diagnosis.hidden = !cause;
    if (cause) { diagnosis.dataset.cause = cause.code; diagnosis.dataset.tone = cause.tone; text(label, cause.label); text(advice, cause.advice); }
    const values = recentTrend(run, records), next = JSON.stringify(values);
    if (next === signature) return; signature = next;
    text(toggle, `同模型近期趋势 · ${values.available ? `${values.attempts} 条${values.insufficient ? " · 样本不足" : ""}` : "原条件不完整"}`);
    const denominator = run.kind === "candy" ? values.valid : values.attempts;
    text(rate, values.rate === null ? "—" : `${Math.round(values.rate)}%`); text(rateLabel, `${values.rateLabel} · ${values.successes}/${denominator}`);
    text(elapsed, duration(values.elapsedMedian)); text(elapsedLabel, `耗时中位数 · ${values.elapsedCount} 条`);
    text(total, tokens(values.tokenMedian)); text(totalLabel, `总 Token 中位数 · ${values.tokenCount} 条`);
    const validLabel = run.kind === "candy" ? "可判定" : run.kind === "fingerprint" ? "可评分" : "已生成";
    text(note, !values.available ? "原记录缺少完整条件，暂不汇总趋势。" : !values.attempts ? "暂无同条件的已结束记录。" :
      `${validLabel} ${values.valid} 条${run.kind === "candy" ? "（含不匹配）" : ""} · 异常 ${values.exceptions} 条${values.insufficient ? ` · 少于 3 条${validLabel}记录，仅展示现有结果` : ""}`);
    text(candidate, values.candidates.map(item => `${item.name} ${item.count}/${values.valid}`).join(" · ")); candidate.hidden = !values.candidates.length;
    text(help, "仅当前保留历史中最近 20 条同模型、同题面、同参数记录；不计进行中或已取消。耗时与用量仅统计有效结果，部分 Token 不计入中位数。由左至右从早到晚，点击色条查看原记录。" +
      (run.kind === "fingerprint" ? "指纹需同一组原题和参考库，候选不能证明模型身份。" : (run.kind || "pelican") === "pelican" ? "生成完成率不代表动画运行正确。" : ""));
    metrics.hidden = track.hidden = scroll.hidden = !values.available || !values.attempts;
    const focused = track.contains(document.activeElement) ? document.activeElement : null, retained = new Set(values.points.map(point => point.id));
    rows.replaceChildren();
    for (const [index, point] of values.points.entries()) {
      let control = controls.get(point.id);
      if (!control) { control = node("button", "trend-point"); controls.set(point.id, control); control.addEventListener("click", () => onSource?.(point.id)); }
      const moment = when(point.at);
      control.type = "button"; control.dataset.runId = point.id; control.dataset.tone = point.tone; control.disabled = !onSource;
      control.title = `${moment} · ${point.label} · 耗时 ${duration(point.elapsedMs)} · 总 Token ${tokens(point.tokens)}`;
      control.setAttribute("aria-label", `查看 ${control.title} 的原记录`);
      if (track.children[index] !== control) track.insertBefore(control, track.children[index] || null);
      const row = node("tr"), result = node("td", "", point.label); result.dataset.tone = point.tone; result.title = point.label;
      row.append(node("td", "", moment), result, node("td", "", duration(point.elapsedMs)), node("td", "", tokens(point.tokens))); rows.append(row);
    }
    for (const [id, control] of controls) if (!retained.has(id)) { control.remove(); controls.delete(id); }
    if (focused) {
      if (!retained.has(focused.dataset.runId)) toggle.focus({ preventScroll: true });
      else if (document.activeElement !== focused) focused.focus({ preventScroll: true });
    }
  } };
}
