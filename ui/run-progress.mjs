import { validProgress } from "../lib/progress.mjs";

const active = run => ["queued", "running"].includes(run.status);
const labels = { queued: "排队中", waiting_response: "等待响应", reasoning: "返回思考", output: "返回正文", saving: "保存中", ended: "已结束" };
const number = value => Number.isFinite(value) && value >= 0;
const samplesOf = run => run.fingerprint?.samples || run.samples || [];
export function mergeProgress(current, incoming) {
  if (!validProgress(incoming)) return current;
  if (validProgress(current) && (incoming.revision <= current.revision || current.phase === "ended" && incoming.phase !== "ended")) return current;
  return { ...incoming };
}
function describeOne(progress, { working, elapsedMs, timeoutMs, timing, noticesEnabled, connected }) {
  const p = validProgress(progress) ? progress : null, phase = p?.phase;
  const moving = working && phase && !["queued", "ended"].includes(phase);
  const synchronized = Boolean(moving && timing?.progressRevision === p.revision && [timing.elapsedMs, timing.silenceMs].every(number));
  const elapsed = phase === "queued" ? null : moving ? synchronized ? timing.elapsedMs : null : number(elapsedMs) ? elapsedMs : null;
  const remainingMs = moving && synchronized && timeoutMs !== 0 ? Math.max(0, timeoutMs - elapsed) : null;
  const silenceMs = synchronized ? timing.silenceMs : null;
  return { label: p ? labels[working ? phase : "ended"] : "进度暂不可用", phase, elapsedMs: elapsed, remainingMs, silenceMs, synchronized: moving ? synchronized && connected : !working,
    limitLabel: phase === "queued" ? "尚未开始计时" : !working || phase === "ended" ? "已结束" : !synchronized || !connected ? "计时待同步" : timeoutMs === 0 ? "不设超时" : remainingMs === 0 ? "等待服务端终态" : `剩余超时 ${(remainingMs / 1000).toFixed(1)} 秒`,
    stalled: Boolean(moving && phase !== "saving" && synchronized && connected && noticesEnabled && silenceMs >= 120000), progress: p };
}
export function describeProgress(run, { timings, noticesEnabled = true, connected = true } = {}) {
  const working = active(run), timeoutMs = run.timeoutMs ?? 600000;
  if (run.kind !== "fingerprint") return { ...describeOne(run.progress, { working, elapsedMs: run.elapsedMs, timeoutMs, timing: timings, noticesEnabled, connected }), samples: [] };
  const samples = samplesOf(run).map((sample, index) => ({ ...describeOne(sample.progress, { working: working && sample.progress?.phase !== "ended", elapsedMs: sample.elapsedMs ?? sample.elapsed_ms, timeoutMs, timing: timings?.[index], noticesEnabled, connected }), count: sample.count, expectedCount: sample.expectedCount ?? sample.expected_count }));
  const counts = { ended: samples.filter(s => s.phase === "ended").length, inFlight: samples.filter(s => s.phase && !["ended", "queued"].includes(s.phase)).length, queued: samples.filter(s => s.phase === "queued").length };
  return { label: labels[working ? run.progress?.phase : "ended"] || "进度暂不可用", elapsedMs: null, remainingMs: null, stalled: samples.some(s => s.stalled), samples, counts, synchronized: samples.every(s => !s.phase || ["queued", "ended"].includes(s.phase) || s.synchronized) };
}
export function createRuntimeClock({ now = () => performance.now() } = {}) {
  const entries = new Map();
  const key = (run, index) => `${run.id}:${index ?? "run"}`;
  const readOne = (run, index) => {
    const item = entries.get(key(run, index)); if (!item) return null;
    const delta = Math.max(0, now() - item.at), elapsedMs = item.value.elapsedMs + delta;
    return { ...item.value, elapsedMs, silenceMs: item.value.silenceMs + delta, remainingMs: item.timeoutMs === 0 ? null : Math.max(0, item.timeoutMs - elapsedMs) };
  };
  const forget = id => { for (const name of entries.keys()) if (name.startsWith(`${id}:`)) entries.delete(name); };
  return {
    observe(run, timings = run.runtimeTiming) {
      if (!active(run)) { forget(run.id); return; }
      const accept = (progress, incoming, index) => {
        const name = key(run, index);
        if (!validProgress(progress) || ["queued", "ended"].includes(progress.phase)) { entries.delete(name); return; }
        if (!incoming || incoming.progressRevision !== progress.revision || ![incoming.elapsedMs, incoming.silenceMs].every(number)) return;
        const previous = entries.get(name), advanced = readOne(run, index);
        if (previous && incoming.progressRevision < previous.value.progressRevision) return;
        const sameData = previous && (incoming.progressRevision === previous.value.progressRevision || previous.lastDataAt === progress.lastDataAt);
        entries.set(name, { at: now(), timeoutMs: run.timeoutMs ?? 600000, lastDataAt: progress.lastDataAt,
          value: { ...incoming, elapsedMs: Math.max(advanced?.elapsedMs || 0, incoming.elapsedMs), silenceMs: sameData ? Math.max(advanced.silenceMs, incoming.silenceMs) : incoming.silenceMs } });
      };
      if (run.kind === "fingerprint") samplesOf(run).forEach((sample, index) => accept(sample.progress, timings?.[index], index));
      else accept(run.progress, timings, null);
    },
    read(run) { if (!active(run)) return run.kind === "fingerprint" ? samplesOf(run).map(() => null) : null; return run.kind === "fingerprint" ? samplesOf(run).map((_, index) => readOne(run, index)) : readOne(run, null); },
    forget,
  };
}

export function createRunProgressView(document, { readState, timers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id) } }) {
  let disposed = false, timer = null, lastState;
  const node = (tag, className, value) => { const out = document.createElement(tag); out.className = className || ""; if (value !== undefined) out.textContent = value; return out; };
  const text = (out, value) => { if (out.textContent !== value) out.textContent = value; };
  const root = node("div", "phase-live-progress"), body = node("div", "phase-progress-body"), rows = [];
  root.append(body);
  const format = value => value == null ? "—" : `${(value / 1000).toFixed(1)} 秒`;
  const makeRow = () => {
    const section = node("section", "phase-progress-sample"), timing = node("p", "help"), notice = node("p", "phase-progress-notice");
    notice.setAttribute("role", "status"); notice.setAttribute("aria-live", "polite"); notice.hidden = true;
    section.append(timing, notice); body.append(section); const row = { section, timing, notice }; rows.push(row); return row;
  };
  function render() {
    if (disposed) return;
    const state = readState() || lastState; if (!state?.run) return; lastState = state;
    const run = state.run, shown = describeProgress(run, state);
    root.hidden = !active(run);
    const items = shown.samples.length ? shown.samples : [shown];
    items.forEach((item, index) => {
      const row = rows[index] || makeRow(); row.section.hidden = false;
      text(row.timing, `${shown.samples.length ? `采样 ${index + 1} · ` : ''}${item.label} · ${item.elapsedMs === null ? "" : `已用 ${format(item.elapsedMs)} · `}${item.limitLabel}`);
      row.notice.hidden = !item.stalled;
      text(row.notice, item.stalled ? "已连续 120 秒未收到有效模型数据。请求仍在运行，总生成超时按原设置执行。" : "");
    });
    rows.slice(items.length).forEach(row => { row.section.hidden = true; });
    timers.clearTimeout(timer); timer = null;
    if (!root.hidden && document.visibilityState !== "hidden" && items.some(item => item.elapsedMs !== null && !["queued", "ended"].includes(item.phase))) timer = timers.setTimeout(render, 1000);
  }
  return { root, update: render, dispose() { disposed = true; timers.clearTimeout(timer); timer = null; } };
}
