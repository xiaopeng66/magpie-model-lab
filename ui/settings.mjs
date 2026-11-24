import { normalizeParameters, parameterDefaults } from "../lib/test-parameters.mjs";

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const clone = value => structuredClone(value);
const kinds = ["pelican", "candy", "fingerprint"];
export function createSettingsUI({ api, defaultPrompt = "", readFields, writeFields, setSaveStatus = () => {}, onStateChange = () => {}, timers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id) } }) {
  let kind = "pelican", revision = 0, sequence = 0, debounce, job = null, failedJob = null, pendingCommand = null, stopped = false, disposed = false, state = "saved", message = "", recoveryError = "";
  let capabilities = { memory: false }, server = { manual: Object.fromEntries(kinds.map(k => [k, parameterDefaults(k, defaultPrompt)])), retention: { days: 7 }, progressNotice: { enabled: true }, presets: [], presetCatalog: [] };
  const drafts = new Map(), dirty = new Map();
  const status = (next, detail = "") => { state = next; message = detail; setSaveStatus({ state, message, revision, kind }); onStateChange(snapshot()); };
  const snapshot = () => ({ ...clone(server), revision, capabilities: { ...capabilities }, dirty: [...dirty.keys()], state, message, recoveryError });
  const bounded = async (path, options, milliseconds, controller = new AbortController()) => {
    let timer, rejectAbort;
    const abandon = new Promise((_, reject) => {
      rejectAbort = () => reject(Object.assign(new Error("设置请求已放弃，需读取服务器状态确认"), { abandoned: true }));
      controller.signal.addEventListener("abort", rejectAbort, { once: true });
      timer = timers.setTimeout(() => { controller.abort(); }, milliseconds);
    });
    try { return await Promise.race([Promise.resolve().then(() => api(path, { ...options, signal: controller.signal })), abandon]); }
    finally { timers.clearTimeout(timer); controller.signal.removeEventListener("abort", rejectAbort); }
  };
  function applyServer(value) {
    if (!value || value.revision < revision) return;
    revision = value.revision;
    for (const key of ["retention", "progressNotice", "presets", "presetCatalog", 'queue']) if (value[key] !== undefined) server[key] = clone(value[key]);
    if (value.presets) server.presetCatalog = value.presets.map(({ id, name, kind, createdAt, updatedAt }) => ({ id, name, kind, createdAt, updatedAt }));
    for (const k of kinds) if (value.manual?.[k]) {
      server.manual[k] = clone(value.manual[k]);
      if (!dirty.has(k)) drafts.set(k, clone(value.manual[k]));
    }
    if (capabilities.memory && !dirty.has(kind)) writeFields(clone(drafts.get(kind) || server.manual[kind]), kind);
    onStateChange(snapshot());
  }
  function record() {
    if (!capabilities.memory || disposed) return;
    const value = clone(readFields(kind)); if (same(value, drafts.get(kind))) return; drafts.set(kind, value);
    if (same(value, server.manual[kind]) && !job) dirty.delete(kind);
    else dirty.set(kind, ++sequence);
  }
  function acknowledge(current, result) {
    current.confirmed = true;
    revision = Math.max(revision, result.revision);
    if (current.kind) {
      server.manual[current.kind] = clone(current.value);
      if (dirty.get(current.kind) === current.sequence) dirty.delete(current.kind);
    }
    const changed = result.changed || {};
    applyServer({ revision, ...changed, manual: changed.manual });
    if (result.preset) server.presets = [...server.presets.filter(p => p.id !== result.preset.id), clone(result.preset)];
    if (current.patch?.presetDelete) server.presets = server.presets.filter(p => p.id !== current.patch.presetDelete.id);
    if (result.preset || current.patch?.presetDelete) {
      server.presetCatalog = server.presets.map(({ id, name, kind, createdAt, updatedAt }) => ({ id, name, kind, createdAt, updatedAt }));
      onStateChange(snapshot());
    }
  }
  function commandState(current, remote) {
    const patch = current.patch;
    if (patch.presetUpsert) {
      const wanted = patch.presetUpsert, found = (remote.presets || []).find(p => wanted.id ? p.id === wanted.id : p.kind === wanted.kind && p.name === wanted.name.trim());
      if (found && found.name === wanted.name.trim() && same(found.parameters, wanted.parameters)) return "applied";
      const old = current.base.presets.find(p => wanted.id ? p.id === wanted.id : p.kind === wanted.kind && p.name === wanted.name.trim());
      return same(found, old) ? "unchanged" : "conflict";
    }
    if (patch.presetDelete) return remote.presets.some(p => p.id === patch.presetDelete.id) ? same(remote.presets.find(p => p.id === patch.presetDelete.id), current.base.presets.find(p => p.id === patch.presetDelete.id)) ? "unchanged" : "conflict" : "applied";
    const groups = Object.keys(patch);
    if (groups.every(group => same(remote[group], patch[group]))) return "applied";
    return groups.every(group => same(remote[group], current.base[group])) ? "unchanged" : "conflict";
  }
  async function reconcile(current) {
    const loaded = await bounded("api/settings", {}, 5000);
    if (loaded.recoveryError) throw new Error(loaded.recoveryError);
    const remote = loaded.settings;
    const disposition = current.kind ? same(remote.manual[current.kind], current.value) ? "applied" : same(remote.manual[current.kind], current.base) ? "unchanged" : "conflict" : commandState(current, remote);
    applyServer(remote);
    if (disposition === "applied") {
      current.confirmed = true;
      if (current.kind && dirty.get(current.kind) === current.sequence) dirty.delete(current.kind);
      return true;
    }
    if (disposition === "unchanged" && current.outcome !== "conflict" && !current.retried && !current.patch?.retention) { current.retried = true; current.expectedRevision = revision; return false; }
    failedJob = current; stopped = true;
    if (disposition === "conflict" || current.outcome === "conflict") {
      current.outcome = "conflict"; status("conflict", "同一组设置已变化，草稿已保留；请核对后选择使用本地或服务器参数");
    } else { current.outcome = "unknown"; status("failed", "原操作尚未确认，已停止自动重发；请核对服务器状态后重试"); }
    return null;
  }
  async function execute(current) {
    const pendingTimer = timers.setTimeout(() => { if (job === current) status("pending", "保存尚未确认，生成可继续；草稿已保留"); }, 5000);
    try {
      for (;;) {
        try {
          const result = await bounded("api/settings/save", { method: "POST", body: JSON.stringify({ expectedRevision: current.expectedRevision, patch: current.patch, ...(current.previewToken ? { previewToken: current.previewToken } : {}) }) }, 10000, current.controller = new AbortController());
          if (disposed) return;
          if (result.revision < revision) {
            const reconciled = await reconcile(current); if (reconciled === null) return; if (!reconciled) continue;
          } else acknowledge(current, result);
          failedJob = null; break;
        } catch (error) {
          if (disposed) return;
          if ([400, 404, 413, 503].includes(error.status) || current.patch.retention && error.status === 409) { current.outcome = "rejected"; throw error; }
          const reconciled = await reconcile(current);
          if (reconciled === null) return;
          if (reconciled) { failedJob = null; break; }
        }
      }
      if (!disposed) status(dirty.size || pendingCommand ? "pending" : "saved", dirty.size ? "正在保存最新草稿…" : "参数已保存到本地");
    } catch (error) { if (!disposed) { failedJob = current; current.outcome ||= "unknown"; stopped = true; status("failed", `${error.message}；${current.outcome === "rejected" ? "本次未保存，请修改后重新提交" : "草稿已保留，点击重试先核对服务器状态"}`); } }
    finally { timers.clearTimeout(pendingTimer); if (job === current) job = null; if (!stopped && !disposed) pump(); current.settleFeedback?.(); }
  }
  function pump() {
    if (job || stopped || disposed || recoveryError) return;
    let current = pendingCommand;
    if (current) pendingCommand = null;
    else {
      const k = dirty.keys().next().value;
      if (!k) { status("saved", "参数已保存到本地"); return; }
      let value;
      try { value = normalizeParameters(k, drafts.get(k), { defaultPrompt }); }
      catch (error) { status("failed", error.message); return; }
      current = { kind: k, value, sequence: dirty.get(k), base: clone(server.manual[k]), patch: { manual: { [k]: value } } };
    }
    current.expectedRevision = revision; job = current; status("pending", "正在保存到本地…"); current.promise = execute(current);
  }
  async function waitFeedback(current = job, completion = current?.promise) {
    if (!current) return { state, revision, message };
    let timer;
    try { await Promise.race([completion, new Promise(resolve => { timer = timers.setTimeout(resolve, 5000); })]); }
    finally { timers.clearTimeout(timer); }
    return { state, revision, message };
  }
  return {
    load(value, enabled = {}, error = "") {
      capabilities = { ...enabled }; recoveryError = error; if (value) applyServer(value);
      if (recoveryError) { stopped = true; status("failed", `${recoveryError}；手动测试使用明确的默认值或当前草稿`); }
    },
    switchKind(next) { if (next === kind) return; record(); kind = next; if (capabilities.memory) writeFields(clone(drafts.get(kind) || server.manual[kind]), kind); },
    changed() { record(); timers.clearTimeout(debounce); if (!stopped && !disposed) debounce = timers.setTimeout(pump, 600); },
    capture(k = kind) { if (k === kind && capabilities.memory) record(); return normalizeParameters(k, k === kind ? readFields(k) : drafts.get(k) || server.manual[k], { defaultPrompt }); },
    async flush() { timers.clearTimeout(debounce); pump(); return waitFeedback(); },
    snapshot,
    async refresh() {
      const loaded = await bounded("api/settings", {}, 5000); if (loaded.recoveryError) throw new Error(loaded.recoveryError);
      applyServer(loaded.settings); return snapshot();
    },
    async invalidate() {
      if (stopped) return;
      if (dirty.size || job) { status("pending", "其他页面更新了设置；当前草稿已保留，保存时会核对冲突"); return; }
      try { await this.refresh(); } catch (error) { status("failed", error.message); }
    },
    async retry() {
      if (job || disposed || recoveryError) return { state, revision, message };
      try {
        if (failedJob && failedJob.outcome !== "rejected") {
          const current = failedJob, reconciled = await reconcile(current);
          if (reconciled === null) return { state, revision, message };
          failedJob = null; stopped = false;
          if (!reconciled) { job = current; status("pending", "核对后重试保存…"); current.promise = execute(current); return waitFeedback(); }
          pump(); return waitFeedback();
        }
        const loaded = await bounded("api/settings", {}, 5000); if (loaded.recoveryError) throw new Error(loaded.recoveryError);
        const remote = loaded.settings;
        const conflict = [...dirty.keys()].some(k => !same(remote.manual[k], server.manual[k]) && !same(remote.manual[k], drafts.get(k)));
        applyServer(remote);
        for (const k of [...dirty.keys()]) if (same(remote.manual[k], drafts.get(k))) dirty.delete(k);
        if (conflict) { stopped = true; status("conflict", "服务器也修改了同一模式，草稿已保留，请选择参数来源"); return { state, revision, message }; }
        if (failedJob && !failedJob.kind) { status("failed", "原操作已被拒绝，本次未保存；请修改后重新提交"); return { state, revision, message }; }
        failedJob = null;
        stopped = false; pump(); return waitFeedback();
      } catch (error) { stopped = true; status("failed", `${error.message}；草稿已保留`); return { state, revision, message }; }
    },
    resolveConflict(source) {
      if (job || !["local", "server"].includes(source) || state !== "conflict") return;
      if (source === "server") { for (const k of dirty.keys()) drafts.set(k, clone(server.manual[k])); dirty.clear(); pendingCommand = null; writeFields(clone(server.manual[kind]), kind); }
      else if (failedJob && !failedJob.kind) pendingCommand = { patch: clone(failedJob.patch), base: clone(server), previewToken: failedJob.previewToken };
      failedJob = null;
      stopped = false; pump();
    },
    async savePatch(patch, { previewToken } = {}) {
      if (failedJob?.outcome === "rejected" && !job) { failedJob = null; stopped = false; }
      if (pendingCommand || job && !job.kind || stopped || recoveryError) return { state: "failed", message: "请先完成或重试当前设置保存" };
      const command = pendingCommand = { patch: clone(patch), base: clone(server), previewToken };
      command.feedback = new Promise(resolve => { command.settleFeedback = resolve; }); pump();
      const feedback = await waitFeedback(command, command.feedback); return command.confirmed ? { state: 'saved', revision, message: '本组设置已保存到本地' } : feedback;
    },
    async loadPreset(id, { isCurrent = () => true } = {}) {
      if (!capabilities.presets) throw new Error("当前后端未开放参数预设");
      const requestedKind = kind, loaded = await bounded("api/settings", {}, 5000);
      if (loaded.recoveryError) throw new Error(loaded.recoveryError);
      const preset = loaded.settings.presets?.find(p => p.id === id);
      if (!preset || preset.kind !== requestedKind) throw new Error("预设已删除或不属于当前测试模式，当前输入已保留");
      const value = normalizeParameters(requestedKind, clone(preset.parameters), { defaultPrompt });
      if (disposed || kind !== requestedKind || !isCurrent()) throw new Error("操作已结束或测试模式已切换，未载入方案");
      record(); applyServer(loaded.settings); writeFields(clone(value), kind); record();
      timers.clearTimeout(debounce); if (!stopped) debounce = timers.setTimeout(pump, 600);
      return clone(value);
    },
    read(path, options = {}) { return bounded(path, options, 5000); },
    dispose() { disposed = true; timers.clearTimeout(debounce); job?.controller?.abort(); },
  };
}
