import { batchKey, historyBatches, historyTime, recentTestBatches } from '../lib/history-groups.mjs';
import { renderDailyHistory } from './history-preview.mjs';
import { createBatchRetest } from './batch-retest.mjs';
import { openRetestDrawer } from './retest.mjs';
import { failureInfo } from '../lib/diagnostics.mjs';
import { createResultInsights } from './result-insights.mjs';

(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const token = document.querySelector('meta[name="pelican-token"]')?.content || "";
  const models = new Map(), selected = new Map(), selectedAccounts = new Map(), runs = new Map(), cards = new Map();
  const removed = new Set(), deleting = new Set(), historyItems = new Map(), pendingRenders = new Set(), previewCards = new WeakMap();
  const historyDays = new Map(), runningItems = new Map();
  let historyGroups = new Map(), historyKeys = new Map(), dailyPreview = null, historyTimeZone;
  let historyPosition = null, historyScrollFrame = null;
  let resultDetail = null;
  const views = {
    current: { batchId: "", ids: [], recentIds: [], results: "results", scroll: "preview-scroll", note: "batch-note", empty: "empty-state", cancel: "cancel-all" },
    fingerprint: { batchId: "", ids: [], recentIds: [], results: "fingerprint-results", scroll: "fingerprint-scroll", note: "fingerprint-note", empty: "fingerprint-empty", cancel: "fingerprint-cancel" },
    candy: { batchId: "", ids: [], recentIds: [], results: "candy-results", scroll: "candy-scroll", note: "candy-note", empty: "candy-empty", cancel: "candy-cancel" },
    favorites: { batchId: "", ids: [], results: "favorite-results", scroll: "favorite-scroll", empty: "favorite-empty" },
    history: { batchId: "", ids: [], results: "history-results", scroll: "history-preview-scroll", note: "history-batch-note", empty: "history-empty", cancel: "history-cancel" },
  };
  const states = { queued: "排队中", running: "生成中", completed: "已完成", invalid: "非完整 HTML", truncated: "输出截断", cancelled: "已取消", error: "生成失败", interrupted: "已中断" };
  const sampleStates = { queued: "排队中", waiting: "等待响应", streaming: "采样中", complete: "已完成", truncated: "已截取", failed: "失败", cancelled: "已取消" };
  const active = (run) => ["queued", "running"].includes(run.status);
  let defaults = "", activeView = "current", batchCleanup = false, openDataDir = false, cleaning = false, streaming = false, reconnecting = false, renderFrame = null;
  let executionView = "current", creating = false, addingFavorites = false, fingerprintAvailable = false, batchCancel = false, batchExport = false, retestAvailable = false, bankUpdating = false, cachedAccounts = [], accountsLoaded = false, accountsLoading = false;
  const concurrencyDrafts = { current: "2", fingerprint: "3", candy: "3" };
  const tokenLabel = value => value === 0 ? "不设输出上限" : `${value ?? 64000} Token`;
  const timeoutLabel = value => value === 0 ? "不设超时" : `超时 ${(value ?? 600000) / 1000} 秒`;
  const concurrencyLabel = run => run.concurrency === 0 ? "不设并行上限" : `并行 ${run.concurrency ?? (run.kind === "fingerprint" || run.kind === "candy" ? 3 : 2)}`;
  const kindLabel = kind => ({ pelican: "动画", fingerprint: "指纹", candy: "糖果" })[kind || "pelican"];
  const candyVerdict = run => run.status === "completed" ? run.candy?.verdict || "review" : "incomplete";
  const candyVerdictLabel = run => ({ match: "答案匹配", mismatch: "答案不符", review: "待复核", incomplete: ({ error: "请求失败", cancelled: "已取消", interrupted: "已中断", truncated: "已截断" })[run.status] || "未完成" })[candyVerdict(run)];
  let favoritesAvailable = false, candyAvailable = false;
  let initialized = false, bootstrapping = false;
  let exportedBatch = "", confirmPending = null;
  let connectionNotice = "";
  const query = new URLSearchParams(location.search);
  let dark = query.get("theme") ? query.get("theme") === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  const setTheme = () => { document.documentElement.dataset.theme = dark ? "dark" : "light"; };
  setTheme();

  function rememberView(values) {
    const params = new URLSearchParams(location.search);
    for (const [key, value] of Object.entries(values)) params.set(key, value);
    try { history.replaceState(null, "", `?${params}`); } catch {}
  }

  const node = (tag, className, text) => {
    const out = document.createElement(tag); if (className) out.className = className;
    if (text !== undefined) out.textContent = text;
    return out;
  };
  const text = (element, value) => { const next = String(value ?? ""); if (element.textContent !== next) element.textContent = next; };
  const button = (text, action, className = "quiet") => {
    const out = node("button", className, text); out.type = "button"; out.addEventListener("click", action); return out;
  };
  const setIcon = (out, name, label) => {
    if (out.dataset.icon === name && out.title === label) return;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"), use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    svg.setAttribute("class", "icon"); svg.setAttribute("aria-hidden", "true"); svg.setAttribute("focusable", "false");
    use.setAttribute("href", `#i-${name}`); svg.append(use); out.replaceChildren(svg);
    out.dataset.icon = name; out.setAttribute("aria-label", label); out.title = label;
  };
  const iconButton = (name, label, action) => { const out = button("", action, "icon-button"); setIcon(out, name, label); return out; };
  const notice = (text) => { $("notice").textContent = text; $("notice").hidden = !text; };
  const error = (text) => { $("form-error").textContent = text; $("form-error").hidden = !text; if (text) { if ($("setup-sidebar").hidden) notice(text); else $("form-error").focus(); } };
  const seconds = (value) => value === null || value === undefined ? "—" : (value / 1000).toFixed(1) + " s";
  const when = (value) => new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const batchWhen = value => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const compactCount = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

  function makeUsage() {
    const strip = node("div", "usage-strip"); strip.fields = {};
    for (const [key, label] of [["reasoning", "思考"], ["output", "输出"]]) {
      const item = node("span", "usage-metric"), value = node("span", "usage-value", "—");
      item.append(node("span", "usage-label", label), value); strip.append(item); strip.fields[key] = { item, value, label };
    }
    strip.unit = node("span", "usage-unit", "Token"); strip.append(strip.unit); return strip;
  }
  function renderUsage(strip, run = {}) {
    const tokens = run.tokens || { reasoning: run.usage?.completion_tokens_details?.reasoning_tokens ?? run.usage?.output_tokens_details?.reasoning_tokens ?? run.usage?.reasoning_tokens,
      output: run.usage?.completion_tokens ?? run.usage?.output_tokens };
    for (const [key, { item, value, label }] of Object.entries(strip.fields)) {
      const reported = Number.isSafeInteger(tokens[key]) && tokens[key] >= 0, partial = reported && tokens.partial?.includes(key);
      const chars = key === "reasoning" ? run.reasoningChars ?? run.reasoning?.length : run.contentChars ?? run.content?.length;
      const count = reported ? tokens[key] : chars, unit = reported ? "Token" : "字";
      const known = reported || Number.isFinite(count) && count > 0;
      const compact = known ? count >= 1000 ? compactCount.format(count) : count.toLocaleString() : "—";
      text(value, known ? `${partial ? "≥" : ""}${compact}${reported ? "" : " 字"}` : "—");
      item.title = known ? `${label}：${count.toLocaleString()} ${unit}${partial ? "（仅汇总已返回用量的采样）" : ""}${reported ? key === "output" ? "；接口原值，可能包含思考 Token" : "" : "；接口未提供 Token，显示已收到的文本字符数"}` : `${label}：尚无用量数据`;
      item.setAttribute("aria-label", item.title);
    }
    strip.unit.hidden = ![tokens.reasoning, tokens.output].some(value => Number.isSafeInteger(value) && value >= 0);
  }
  function makeStats(card, firstLabel) {
    const stats = node("div", "card-stats"); card.metrics = [];
    for (const label of ["总耗时", firstLabel, "总 Token"]) {
      const metric = node("div"), value = node("span", "stat-value", "—");
      metric.append(node("span", "stat-label", label), value); stats.append(metric); card.metrics.push(value);
    }
    return stats;
  }
  function renderStats(card, run) {
    text(card.metrics[0], seconds(active(run) && run.startedAt ? Date.now() - Date.parse(run.startedAt) : run.elapsedMs));
    text(card.metrics[1], seconds(run.firstContentMs));
    const total = run.tokens?.total ?? run.usage?.total_tokens;
    text(card.metrics[2], total == null ? "—" : `${run.tokens?.partial?.includes("total") ? "≥" : ""}${Number(total).toLocaleString()}`);
  }

  async function request(path, options = {}) {
    const response = await fetch(path, { ...options, headers: { ...options.headers, "x-pelican-token": token } });
    if (response.status === 403 && (await response.clone().json().catch(() => ({}))).reload) {
      if (!reconnecting) {
        reconnecting = true;
        const params = new URLSearchParams(location.search);
        if (views.current.ids[0]) params.set("run", views.current.ids[0]); else params.delete("run");
        const historyRun = views.history.visibleIds?.[0] || views.history.ids[0];
        if (historyRun) params.set("history", historyRun); else params.delete("history");
        if (views.fingerprint.ids[0]) params.set("fingerprint", views.fingerprint.ids[0]); else params.delete("fingerprint");
        if (views.candy.ids[0]) params.set("candy", views.candy.ids[0]); else params.delete("candy");
        params.set("mode", executionView);
        params.set("view", activeView);
        params.set("theme", dark ? "dark" : "light");
        // The host's opaque sandbox can navigate to the UI, but cannot read its token through fetch.
        location.replace(`./?${params}`);
      }
      throw new Error("正在重新连接插件…");
    }
    return response;
  }

  async function api(path, options = {}) {
    const response = await request(path, { ...options, headers: { "content-type": "application/json", ...options.headers } });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `请求失败 ${response.status}`);
    return body;
  }

  function modelLabel(model, all) {
    const id = typeof model.id === "string" ? model.id : "", route = typeof model.provider === "string" ? model.provider : "";
    const provider = typeof model.providerName === "string" && model.providerName || route;
    const name = typeof model.name === "string" && model.name || id || "未知模型", suffix = ` · ${provider}`;
    const short = provider && name.endsWith(suffix) ? name.slice(0, -suffix.length) : name === id && route && id.startsWith(route + "/") ? name.slice(route.length + 1) : name;
    return all && provider ? `${short} · ${provider}` : short;
  }

  function renderModels() {
    const provider = $("provider").value;
    $("model-search").disabled = !models.size;
    const needle = $("model-search").value.toLowerCase().trim();
    const matches = [...models.values()].filter((m) => (!provider || m.provider === provider) && (m.id + " " + m.name + " " + m.providerName).toLowerCase().includes(needle));
    const container = $("model-list"); container.replaceChildren();
    container.dataset.all = String(!provider);
    for (const model of matches) {
      const label = node("label", "model-option");
      const input = document.createElement("input"); input.type = "checkbox"; input.value = model.id; input.checked = selected.has(model.id);
      input.addEventListener("change", () => {
        if (input.checked) selected.set(model.id, ""); else { selected.delete(model.id); selectedAccounts.delete(model.id); }
        error(""); renderSelected();
      });
      input.setAttribute("aria-label", `${modelLabel(model, true)} (${model.id})`); label.title = model.id;
      const labelText = node("span", "model-text"); labelText.append(node("strong", "model-name", modelLabel(model, false)));
      if (!provider) labelText.append(node("small", "model-provider", model.providerName || model.provider));
      label.append(input, labelText); container.append(label);
    }
    if (!matches.length) container.append(node("p", "help model-count", !models.size ? "模型列表暂不可用，请刷新" : "没有匹配的模型"));
    text($("model-visible-count"), `${matches.length} 个可选`);
  }

  function renderSelected() {
    $("selection-count").textContent = `已选 ${selected.size}`;
    $("clear-selection").disabled = !selected.size;
    $("favorite-selected").disabled = !selected.size || !favoritesAvailable || addingFavorites;
    const container = $("selected-models"); container.replaceChildren();
    for (const [id, effort] of selected) {
      const model = models.get(id); if (!model) continue;
      const row = node("div", "selected-row");
      const label = node("span", "selected-name"); label.title = modelLabel(model, true);
      label.append(node("span", "selected-model-title", modelLabel(model, false)), node("span", "selected-provider", model.providerName || model.provider)); row.append(label);
      const select = document.createElement("select"); select.setAttribute("aria-label", `${modelLabel(model, true)} 的思考档位`);
      for (const level of ["", ...model.efforts]) { const option = node("option", "", level || "默认"); option.value = level; select.append(option); }
      select.value = effort; select.addEventListener("change", () => selected.set(id, select.value));
      const remove = iconButton("close", `移除 ${id}`, () => {
        const position = [...selected.keys()].indexOf(id);
        selected.delete(id); selectedAccounts.delete(id); renderSelected(); renderModels();
        const remaining = [...container.querySelectorAll('.icon-button')];
        (remaining[Math.min(position, remaining.length - 1)] || $('model-search')).focus({ preventScroll: true });
      });
      row.append(select, remove); container.append(row);
      if (executionView === "fingerprint" && $("fp-pin").checked) {
        const accountRow = node("div", "account-row"), account = node("input"), datalist = node("datalist");
        datalist.id = `accounts-${[...selected.keys()].indexOf(id)}`;
        account.setAttribute("list", datalist.id); account.setAttribute("aria-label", `${modelLabel(model, true)} 的固定账号`);
        account.placeholder = "账号 ID，可选"; account.value = selectedAccounts.get(id) || ""; account.maxLength = 256;
        datalist.dataset.provider = model.provider; renderAccountOptions(datalist);
        account.addEventListener("input", () => selectedAccounts.set(id, account.value.trim()));
        accountRow.append(account, datalist); row.append(accountRow);
      }
    }
  }

  function renderAccountOptions(datalist) {
    datalist.replaceChildren();
    for (const item of cachedAccounts.filter(item => item.provider === datalist.dataset.provider)) {
      const option = node("option", "", item.name); option.value = item.id; datalist.append(option);
    }
  }

  function updateModels(list) {
    models.clear(); for (const model of list) models.set(model.id, model);
    for (const [id, effort] of selected) {
      const model = models.get(id);
      if (!model) { selected.delete(id); selectedAccounts.delete(id); } else if (effort && !model.efforts.includes(effort)) selected.set(id, "");
    }
    const providers = new Map();
    for (const model of models.values()) {
      const value = providers.get(model.provider) || { name: model.providerName || model.provider, count: 0 };
      value.count++; providers.set(model.provider, value);
    }
    const control = $("provider"), current = control.value;
    control.replaceChildren();
    const placeholder = node("option", "", "全部供应商"); placeholder.value = ""; control.append(placeholder);
    for (const [id, value] of [...providers].sort((a, b) => a[1].name.localeCompare(b[1].name, "zh-CN"))) {
      const option = node("option", "", `${value.name} (${value.count})`); option.value = id; control.append(option);
    }
    const initial = !modelsInitialized && query.get("provider");
    control.value = providers.has(initial || current) ? initial || current : ""; modelsInitialized = true;
    control.disabled = !providers.size;
    renderModels(); renderSelected();
  }

  let modelsInitialized = false;

  function renderHistory() {
    const all = historyBatches(runs.values(), historyTimeZone);
    historyGroups = new Map(all.map(group => [group.id, group]));
    historyKeys = new Map(all.flatMap(group => group.runs.map(run => [run.id, group.id])));
    const filter = $("history-filter").value;
    const sourceFilter = $("history-source").value;
    const batches = new Map(all.filter(group => (!filter || group.runs.some(run => (run.kind || "pelican") === filter)) && (!sourceFilter || group.source === sourceFilter)).map(group => [group.id, group]));
    let selectedBatch = views.history.batchId;
    if (selectedBatch && !batches.has(selectedBatch)) {
      selectedBatch = views.history.ids.map(id => historyKeys.get(id)).find(id => batches.has(id));
      if (!selectedBatch) clearHistorySelection(false);
    }
    text($("history-count"), `${all.length} 批`);
    const container = $("history-list");
    for (const [id, item] of historyItems) if (!batches.has(id)) { item.root.remove(); historyItems.delete(id); }
    if (exportedBatch && !batches.has(exportedBatch)) favoritesUI.closeDrawer();
    if (batches.size) container.querySelector('.history-list-empty')?.remove();
    const dayCounts = new Map();
    for (const group of batches.values()) dayCounts.set(group.date, (dayCounts.get(group.date) || 0) + 1);
    for (const [date, day] of historyDays) if (!dayCounts.has(date)) { day.root.remove(); historyDays.delete(date); }
    const dayIndices = new Map(); let dayIndex = 0;
    for (const [batchId, group] of batches) {
      const members = group.runs, daily = group.source === "automatic";
      let day = historyDays.get(group.date);
      if (!day) { const root = node('section', 'history-day'), heading = node('h3', 'history-day-heading'), list = node('div', 'history-day-items'); root.append(heading, list); day = { root, heading, list }; historyDays.set(group.date, day); }
      if (!dayIndices.has(group.date)) {
        text(day.heading, `${group.date} · ${dayCounts.get(group.date)} 批`);
        if (container.children[dayIndex] !== day.root) container.insertBefore(day.root, container.children[dayIndex] || null);
        dayIndices.set(group.date, 0); dayIndex++;
      }
      const completed = members.filter(run => run.status === "completed").length;
      const unfinished = members.filter(active).length;
      const status = unfinished ? (members.some(run => run.status === "running") ? "running" : "queued") : completed === members.length ? "completed" : "error";
      let item = historyItems.get(batchId);
      if (!item) {
        const root = node("div", "history-item"); root.dataset.batchId = batchId;
        const row = button("", () => { if (views.history.batchId === batchId) clearHistorySelection(); else { if (activeView !== 'history') setView('history'); showBatch(batchId, "history"); } }, "history-row");
        const name = node("span", "history-name"), subtitle = node("span", "history-subtitle"), badge = node("span", "badge"), time = node("time"); row.append(name, subtitle, badge, time);
        const remove = button("删除", () => deleteBatch(batchId), "history-delete");
        const exportButton = iconButton("export", `查看 / 导出批次 JSON ${batchId}`, () => exportHistory(batchId));
        const actions = node("div", "history-actions"); actions.append(exportButton, remove); root.append(row, actions);
        item = { root, row, name, subtitle, badge, time, remove, exportButton }; historyItems.set(batchId, item);
      }
      const { root, row, name, badge, time, remove } = item;
      root.dataset.selected = String(selectedBatch === batchId);
      const label = unfinished ? `${states[status]} · ${completed}/${members.length}` : `${completed}/${members.length} 完成`;
      row.title = members.map(run => `${run.modelName || run.model}：${states[run.status]}`).join("\n");
      const modelCount = group.modelIds.length;
      const batchTitle = daily ? `${group.date} ${kindLabel(group.kind)}每日批次` : `${when(members[0].createdAt)} ${kindLabel(members[0].kind)}批次`;
      row.setAttribute("aria-label", `${batchTitle}，${modelCount} 个模型，${members.length} 份结果，${label}`);
      row.setAttribute("aria-pressed", String(selectedBatch === batchId));
      row.setAttribute('aria-expanded', String(selectedBatch === batchId)); row.setAttribute('aria-controls', 'history-detail');
      const kinds = [...new Set(members.map(run => run.kind || "pelican"))].map(kindLabel).join(" / ");
      const source = members[0].source === "automatic" ? "自动测试" : members[0].favoriteId ? "收藏记录" : "手动测试";
      const modelNames = [...new Set(members.map(run => modelLabel({ id: run.model, name: run.modelName, provider: run.provider, providerName: run.providerName }, false)))];
      text(name, modelNames.join("、")); text(item.subtitle, `${source} · ${kinds}${daily ? '每日批次' : ''} · ${modelCount} 个模型`); badge.className = `badge ${status}`; text(badge, label);
      const timeRange = daily ? [group.times[0], group.times.at(-1)].slice(0, group.times.length === 1 ? 1 : 2).map(at => historyTime(at, historyTimeZone)).join('–') : when(group.createdAt);
      text(time, timeRange); time.dateTime = daily ? group.date : group.createdAt;
      text(remove, deleting.has(batchId) ? "删除中…" : "删除");
      remove.setAttribute("aria-label", `删除 ${batchTitle}及 ${members.length} 份结果文件`);
      remove.disabled = !batchCleanup || unfinished > 0 || deleting.has(batchId) || cleaning;
      remove.title = !batchCleanup ? "重新开启插件后可删除单批记录" : unfinished ? "本批任务结束后可删除" : "删除本批记录和生成文件";
      item.exportButton.hidden = !batchExport; item.exportButton.disabled = unfinished > 0 || deleting.has(batchId) || cleaning;
      item.exportButton.setAttribute("aria-label", `导出 ${batchTitle}：${modelNames.join('、')} JSON`); item.exportButton.title = item.exportButton.getAttribute('aria-label');
      const index = dayIndices.get(group.date); if (day.list.children[index] !== root) day.list.insertBefore(root, day.list.children[index] || null); dayIndices.set(group.date, index + 1);
    }
    if (!batches.size) {
      const placeholder = container.querySelector('.history-list-empty') || node('p', 'help history-list-empty');
      text(placeholder, filter || sourceFilter ? '暂无匹配记录' : '暂无记录');
      if (!placeholder.isConnected) container.append(placeholder);
    }
    if (selectedBatch) showBatch(selectedBatch, 'history', false);
    if (dailyPreview) dailyPreview.update(historyGroups.get(views.history.batchId));
    renderRunningBatches();
    for (const name of ['current', 'fingerprint', 'candy']) renderRecentBatches(name);
    refreshResultInsights();
  }

  function historyNotice(text, failed = false) { $("history-status").textContent = text; $("history-status").hidden = !text; $("history-status").dataset.error = String(failed); }

  function exportHistory(batchId) {
    if (!batchExport || exportedBatch) return;
    const item = historyItems.get(batchId), group = historyGroups.get(batchId); if (!group || !item || item.exportButton.disabled) return;
    exportedBatch = batchId;
    const type = [...new Set(group.runs.map(run => kindLabel(run.kind)))].join(" / ");
    return favoritesUI.showJSON(group, type, item.exportButton, () => { exportedBatch = ""; });
  }

  function confirmAction(title, message, label) {
    if (confirmPending) return Promise.resolve(false);
    const dialog = $("confirm-dialog"), opener = document.activeElement;
    text($("confirm-title"), title); text($("confirm-message"), message); text($("confirm-accept"), label);
    dialog.showModal(); $("confirm-cancel").focus({ preventScroll: true });
    return new Promise(resolve => { confirmPending = value => {
      confirmPending = null; dialog.close();
      if (opener?.isConnected && !opener.disabled) opener.focus({ preventScroll: true });
      resolve(value);
    }; });
  }
  $("confirm-cancel").addEventListener("click", () => confirmPending?.(false));
  $("confirm-accept").addEventListener("click", () => confirmPending?.(true));
  $("confirm-dialog").addEventListener("cancel", event => { event.preventDefault(); confirmPending?.(false); });

  async function deleteBatch(batchId) {
    if (!batchCleanup || cleaning || deleting.has(batchId)) return;
    const group = historyGroups.get(batchId);
    if (!group || group.runs.some(active)) return;
    const request = group.source === "automatic" ? { mode: "daily", runIds: group.runs.map(run => run.id) } : { mode: "batch", batchId };
    if (!await confirmAction("删除批次", `将删除这个批次的 ${group.runs.length} 份结果及生成文件。`, "删除批次")) return;
    deleting.add(batchId); renderHistory(); cleanupControls(); historyNotice("正在删除本批记录和文件…");
    try {
      const outcome = await api("api/runs/cleanup", { method: "POST", body: JSON.stringify(request) });
      removeRuns(outcome.removed);
      historyNotice(outcome.errors.length ? `已删除 ${outcome.removed.length} 份，${outcome.errors.length} 份删除失败：${outcome.errors[0].error}` : `已删除本批 ${outcome.removed.length} 份记录及文件`, outcome.errors.length > 0);
    } catch (err) { historyNotice(err.message, true); }
    finally { deleting.delete(batchId); renderHistory(); cleanupControls(); }
  }

  function setView(name) {
    closeCalendar();
    if ((resultDetail || exportedBatch) && name !== activeView) favoritesUI.closeDrawer();
    const returningToFavorites = name === "favorites" && activeView !== "favorites";
    if (returningToFavorites) favoritesUI.resetAnimationPosition();
    activeView = name;
    for (const view of ["current", "fingerprint", "candy", "favorites", "history"]) {
      $(`${view}-panel`).hidden = view !== name;
      $(`${view}-tab`).setAttribute("aria-selected", String(view === name));
      $(`${view}-tab`).setAttribute("tabindex", view === name ? "0" : "-1");
    }
    const tab = $(`${name}-tab`), tabs = tab.parentElement;
    if (tabs.scrollWidth > tabs.clientWidth) {
      const item = tab.getBoundingClientRect(), bounds = tabs.getBoundingClientRect();
      tabs.scrollLeft += Math.max(0, item.right - bounds.right + 3) + Math.min(0, item.left - bounds.left - 3);
    }
    if (!["history", "favorites"].includes(name)) {
      const changed = executionView !== name;
      if (changed) { concurrencyDrafts[executionView] = $("concurrency").value; $("concurrency").value = concurrencyDrafts[name]; $("concurrency").removeAttribute("aria-invalid"); }
      executionView = name; if (changed) renderSelected();
    }
    $("setup-sidebar").hidden = ["history", "favorites"].includes(name); $("workspace").dataset.wide = String($("setup-sidebar").hidden);
    if (name !== "favorites") favoritesUI.closeDrawer(); else { favoritesUI.render(); favoritesUI.refresh(); }
    updateSettings();
    for (const card of [...cards.values()]) { renderCard(card.id, card.view); if (card.view === name) fitPreview(card); }
    renderRunningBatches();
    if (initialized && !bootstrapping) rememberView({ view: name, mode: executionView });
  }

  function updateSettings() {
    const fingerprint = executionView === "fingerprint";
    const candy = executionView === "candy";
    const generate = $("generate");
    $("animation-settings").hidden = fingerprint || candy; $("fingerprint-settings").hidden = !fingerprint; $("fp-options").hidden = !fingerprint; $("candy-settings").hidden = !candy;
    text($("test-mode-label"), candy ? "糖果测试" : fingerprint ? "模型指纹" : "鹈鹕动画");
    generate.hidden = ["history", "favorites"].includes(activeView);
    generate.disabled = generate.hidden || !initialized || creating || (fingerprint && !fingerprintAvailable) || (candy && !candyAvailable);
    text($("generate-label"), creating ? "创建中…" : candy ? "开始测试" : fingerprint ? "开始检测" : "开始生成");
    $("fingerprint-unavailable").hidden = fingerprintAvailable;
    $("bank-refresh").disabled = !fingerprintAvailable || bankUpdating;
    for (const view of Object.values(views)) {
      view.retest?.setBusy(creating);
      for (const entry of view.recentItems?.values() || []) entry.retest.setBusy(creating);
    }
    if (resultDetail) resultDetail.retest.disabled = creating || active(runs.get(resultDetail.id) || {});
  }

  function refreshView(name) {
    if (name === "favorites") return;
    const view = views[name];
    $(view.empty).hidden = view.ids.length > 0;
    $(view.note).textContent = view.ids.length ? `${new Set(view.ids.map(id => runs.get(id)?.model)).size} 个模型 · ${view.ids.length} 份结果` : "";
    if (view.recentIds && view.ids.length) $(view.note).textContent = `${batchWhen(runs.get(view.ids[0]).createdAt)} · ${$(view.note).textContent}`;
    $(view.cancel).hidden = !view.ids.some(id => active(runs.get(id) || {}));
    if (name === "history") {
      $("history-detail").hidden = !view.ids.length;
      const group = historyGroups.get(view.batchId); text($('history-preview-title'), group?.source === 'automatic' ? `${kindLabel(group.kind)}每日预览` : '批次预览');
    }
    refreshBatchRetest(name);
  }

  function locateResultCard(id, name) {
    const root = cards.get(`${name}:${id}`)?.root, scroll = $(views[name].scroll); if (!root) return;
    const top = root.getBoundingClientRect().top;
    if (innerWidth <= 720) window.scrollBy({ top: top - 12, behavior: "instant" });
    else scroll.scrollTop = Math.max(0, scroll.scrollTop + top - scroll.getBoundingClientRect().top - 12);
    root.setAttribute("tabindex", "-1"); root.focus({ preventScroll: true }); root.dataset.sourceFocus = "true";
    setTimeout(() => { delete root.dataset.sourceFocus; }, 1200);
  }

  function openSourceRecord(id) {
    const run = runs.get(id); if (!run) return;
    $("history-filter").value = run.kind || "pelican";
    $("history-source").value = run.source === "automatic" ? "automatic" : run.favoriteId ? "favorites" : "manual";
    setView("history"); renderHistory(); showBatch(historyKeys.get(id), "history");
    dailyPreview?.revealRun?.(id); locateResultCard(id, "history"); rememberView({ history: id });
  }

  function makeBatchRetest() {
    const retest = createBatchRetest(document, { onRetest: openRetest, onSource: openSourceRecord });
    retest.setBusy(creating); return retest;
  }

  function refreshBatchRetest(name) {
    const view = views[name], actions = $(`${name}-batch-actions`), sourceHost = $(`${name}-batch-source`); if (!actions) return;
    const members = view.ids.map(id => runs.get(id)).filter(Boolean), automatic = name === "history" && members.some(run => run.source === "automatic");
    if (!view.retest) { view.retest = makeBatchRetest(); actions.prepend(view.retest.button); sourceHost.append(view.retest.source); }
    const source = members.find(run => run.retest)?.retest;
    view.retest.update(automatic ? [] : members, { canRetest: retestAvailable, sourceAvailable: runs.has(source?.sourceRunId) });
    sourceHost.hidden = view.retest.source.hidden;
  }

  function openRetest(runIds, origin) {
    if (!retestAvailable || creating || !runIds.length) return;
    return openRetestDrawer({ document, openDrawer: favoritesUI.openDrawer, closeDrawer: favoritesUI.closeDrawer, api, runIds, origin,
      names: resultNames, kindLabel, onSubmitting: value => { creating = value; updateSettings(); }, onError: message => notice(`复测未创建：${message}`),
      onCreated: (result, wasOpen) => {
        for (const run of result.runs) updateRun(run, false);
        renderHistory();
        if (!wasOpen) { notice("复测批次已创建，可在正在生成的列表或历史记录中查看。"); return; }
        const kind = result.runs[0]?.kind || "pelican", target = kind === "pelican" ? "current" : kind;
        setView(target); showBatch(result.batchId, target); $(views[target].scroll).scrollTop = 0;
      } });
  }

  function renderRunningBatches() {
    const groups = [...historyGroups.values()].filter(group => group.source !== 'automatic' && group.runs.some(active)), list = $('running-batch-list');
    $('running-batches').hidden = !groups.length;
    for (const [id, entry] of runningItems) if (!groups.some(group => group.id === id)) {
      if (entry.root.contains(document.activeElement)) $(`${activeView}-tab`).focus({ preventScroll: true });
      entry.root.remove(); runningItems.delete(id);
    }
    for (const [index, group] of groups.entries()) {
      const target = group.runs[0].kind === 'pelican' || !group.runs[0].kind ? 'current' : group.runs[0].kind;
      let entry = runningItems.get(group.id);
      if (!entry) {
        const root = button('', () => { showBatch(group.id, target); setView(target); }, 'running-batch'), dot = node('span', 'running-batch-dot'), name = node('span', 'running-batch-name'), label = node('span', 'running-batch-kind'), progress = node('span', 'running-batch-progress');
        dot.setAttribute('aria-hidden', 'true');
        root.append(dot, name, label, progress); entry = { root, name, label, progress }; runningItems.set(group.id, entry);
      }
      const names = [...new Set(group.runs.map(run => modelLabel({ id: run.model, name: run.modelName, provider: run.provider, providerName: run.providerName }, false)))].join('、');
      const done = group.runs.filter(run => !active(run)).length, state = group.runs.some(run => run.status === 'running') ? 'running' : 'queued';
      text(entry.name, names); text(entry.label, kindLabel(group.runs[0].kind)); text(entry.progress, `${done}/${group.runs.length}`);
      entry.root.dataset.state = state; entry.root.dataset.batchId = group.id;
      entry.root.title = `${batchWhen(group.createdAt)} · ${states[state]}\n${group.runs.map(run => `${run.modelName || run.model}：${states[run.status]}`).join('\n')}\n进度计入已结束的任务，包括失败或取消。`;
      entry.root.setAttribute('aria-label', `查看${kindLabel(group.runs[0].kind)}测试：${names}，${batchWhen(group.createdAt)}，${states[state]}，${done}/${group.runs.length} 已结束`);
      entry.root.setAttribute('aria-pressed', String(activeView === target && views[target].batchId === group.id));
      if (list.children[index] !== entry.root) list.insertBefore(entry.root, list.children[index] || null);
    }
  }

  function renderRecentBatches(name) {
    const view = views[name], container = $(`${name}-recent`), items = view.recentItems ||= new Map();
    const preferredModelOrder = [...new Set(view.ids.map(id => runs.get(id)?.model).filter(Boolean))];
    for (const model of models.keys()) if (!preferredModelOrder.includes(model)) preferredModelOrder.push(model);
    const groups = recentTestBatches([...historyGroups.values()], name === 'current' ? 'pelican' : name, view.batchId, preferredModelOrder);
    const ids = groups.flatMap(group => group.runs.map(run => run.id));
    for (const id of view.recentIds) if (!ids.includes(id) && !view.ids.includes(id)) removeCard(id, name);
    view.recentIds = ids; container.hidden = !groups.length;
    $(`${name}-history-footer`).hidden = !view.ids.length && !groups.length;
    for (const [id, entry] of items) if (!groups.some(group => group.id === id)) { entry.root.remove(); items.delete(id); }
    for (const [index, group] of groups.entries()) {
      let entry = items.get(group.id);
      if (!entry) {
        const root = node('section', 'recent-batch'), heading = node('div', 'recent-batch-heading'), title = node('h3'), meta = node('span', 'help'), grid = node('div', 'results-grid');
        const retest = makeBatchRetest();
        root.dataset.batchId = group.id; heading.append(title, meta, retest.button); root.append(heading, retest.source, grid);
        entry = { root, title, meta, grid, retest }; items.set(group.id, entry);
      }
      text(entry.title, `历史批次 ${index + 1}`);
      text(entry.meta, `${batchWhen(group.createdAt)} · ${group.modelIds.length} 个模型 · ${group.runs.length} 份结果`);
      const source = group.runs.find(run => run.retest)?.retest;
      entry.retest.update(group.runs, { canRetest: retestAvailable, sourceAvailable: runs.has(source?.sourceRunId) });
      entry.root.setAttribute('aria-label', `${entry.title.textContent}，${entry.meta.textContent}`);
      for (const [cardIndex, run] of group.runs.entries()) {
        renderCard(run.id, name); const root = cards.get(`${name}:${run.id}`)?.root;
        if (root && entry.grid.children[cardIndex] !== root) entry.grid.insertBefore(root, entry.grid.children[cardIndex] || null);
      }
      if (container.children[index] !== entry.root) container.insertBefore(entry.root, container.children[index] || null);
    }
  }

  function renderShown(id) {
    pendingRenders.delete(id);
    for (const [name, view] of Object.entries(views)) if (view.ids.includes(id) || view.recentIds?.includes(id)) {
      renderCard(id, name); view.retest?.updateRun(runs.get(id));
      for (const entry of view.recentItems?.values() || []) entry.retest.updateRun(runs.get(id));
    }
    if (resultDetail?.id === id) renderResultDetail(); else refreshResultInsights();
    favoritesUI.progress(id);
  }

  function scheduleRender(id) {
    pendingRenders.add(id);
    if (renderFrame !== null) return;
    renderFrame = requestAnimationFrame(() => {
      renderFrame = null;
      for (const id of [...pendingRenders]) renderShown(id);
    });
  }

  function updateRun(value, updateHistory = true) {
    if (removed.has(value.id)) return;
    const prior = runs.get(value.id) || {};
    if (prior.status && value.status === "queued" && prior.status !== "queued") return;
    if (prior.status && !active(prior) && ["queued", "running"].includes(value.status)) return;
    const changed = Object.hasOwn(value, "status") && value.status !== prior.status;
    if (value.kind === "fingerprint" && Number.isFinite(value.revision) && Number.isFinite(prior.revision) && value.revision < prior.revision) return;
    const historyChanged = !prior.id || ["status", "batchId", "roundId", "scheduledAt", "createdAt", "model", "modelName", "source", "kind"].some(key => Object.hasOwn(value, key) && value[key] !== prior[key]);
    Object.assign(prior, value);
    if (changed && !active(prior)) { prior.loaded = false; prior.loadError = ""; }
    runs.set(value.id, prior);
    for (const [name, view] of Object.entries(views)) {
      if ((name === 'history' ? historyKeys.get(prior.id) : batchKey(prior)) === view.batchId && (name === "history" || name === "favorites" || (prior.kind || "pelican") === (name === "current" ? "pelican" : name)) && !view.ids.includes(value.id)) view.ids.push(value.id);
      refreshView(name);
    }
    renderShown(value.id);
    if (historyChanged && updateHistory) renderHistory();
    else renderRunningBatches();
    if (prior.favoriteId) favoritesUI.render();
  }

  function removeCard(id, view) {
    const key = `${view}:${id}`, card = cards.get(key);
    if (card) { if (card.zone) { previewObserver?.unobserve(card.zone); visibilityObserver?.unobserve(card.zone); } card.root.remove(); cards.delete(key); }
  }

  function removeRuns(ids) {
    const affectsExport = exportedBatch && ids.some(id => historyKeys.get(id) === exportedBatch);
    if (resultDetail && ids.includes(resultDetail.id)) favoritesUI.closeDrawer();
    for (const id of ids) { removed.add(id); runs.delete(id); pendingRenders.delete(id); }
    for (const [name, view] of Object.entries(views)) {
      for (const id of ids) removeCard(id, name);
      view.ids = view.ids.filter(id => runs.has(id));
      if (name === 'history' && !view.ids.length) { clearHistorySelection(false); continue; }
      if (!view.ids.length) view.batchId = "";
      refreshView(name);
    }
    renderHistory(); favoritesUI.render();
    if (affectsExport && exportedBatch) favoritesUI.closeDrawer();
    if (ids.length) favoritesUI.refresh();
  }

  function clearHistorySelection(updateList = true) {
    const view = views.history, position = historyPosition;
    historyPosition = null; cancelAnimationFrame(historyScrollFrame); historyScrollFrame = null;
    for (const id of view.ids) removeCard(id, 'history');
    dailyPreview?.dispose?.();
    view.ids = []; view.batchId = ''; view.visibleIds = null; dailyPreview = null;
    $(view.results).replaceChildren(); refreshView('history');
    if (updateList) renderHistory();
    if (position) historyScrollFrame = requestAnimationFrame(() => {
      historyScrollFrame = null;
      if (view.ids.length) return;
      $('history-scroll').scrollTop = position.list;
      if (activeView === 'history') window.scrollTo({ top: position.page, behavior: 'instant' });
    });
  }

  function openManualHistory(name) {
    $('history-filter').value = name === 'current' ? 'pelican' : name;
    $('history-source').value = 'manual';
    historyPosition = null;
    clearHistorySelection(false);
    renderHistory(); setView('history');
    $('history-scroll').scrollTop = 0;
    window.scrollTo({ top: 0, behavior: 'instant' });
    $('history-filter').focus({ preventScroll: true });
  }

  function revealHistoryRow(batchId) {
    cancelAnimationFrame(historyScrollFrame);
    historyScrollFrame = requestAnimationFrame(() => {
      historyScrollFrame = null;
      if (activeView !== 'history' || views.history.batchId !== batchId) return;
      const list = $('history-scroll'), row = historyItems.get(batchId)?.root;
      if (!row) return;
      const bounds = list.getBoundingClientRect(), selectedBounds = row.getBoundingClientRect();
      const bottom = bounds.top + list.clientHeight - 6, top = bounds.top + 2;
      if (selectedBounds.bottom > bottom) list.scrollTop += selectedBounds.bottom - bottom;
      else if (selectedBounds.top < top) list.scrollTop += selectedBounds.top - top;
      const detailTop = $('history-detail').getBoundingClientRect().top;
      if (matchMedia('(max-width: 720px)').matches && (detailTop > innerHeight - 180 || detailTop < 0 || row.getBoundingClientRect().top < 0)) {
        window.scrollBy({ top: list.getBoundingClientRect().top - 16, behavior: 'instant' });
      }
    });
  }

  function mountHistoryRuns(ids, targets) {
    const view = views.history;
    for (const id of view.visibleIds || []) if (!ids.includes(id)) removeCard(id, 'history');
    view.visibleIds = ids;
    for (const id of ids) {
      renderCard(id, 'history'); const root = cards.get(`history:${id}`)?.root, target = targets.get(id);
      if (root && target && !target.contains(root)) target.append(root);
    }
  }

  function showBatch(batchId, name = "current", updateList = true) {
    const view = views[name];
    const group = name === 'history' ? historyGroups.get(batchId) : null;
    const members = group?.runs || [...runs.values()].filter(r => batchKey(r) === batchId && (name === "history" || (r.kind || "pelican") === (name === "current" ? "pelican" : name))).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const ids = members.map(r => r.id);
    const selectionChanged = view.batchId !== batchId;
    if (!selectionChanged && view.ids.join('|') === ids.join('|')) return;
    const results = $(view.results);
    const daily = group?.source === 'automatic' && ['candy', 'pelican'].includes(group.kind);
    if (name === 'history' && ids.length && !historyPosition) historyPosition = { list: $('history-scroll').scrollTop, page: window.scrollY };
    const reset = selectionChanged || (name === 'history' && Boolean(dailyPreview) !== Boolean(daily));
    for (const id of view.ids) if (reset || !ids.includes(id)) removeCard(id, name);
    if (reset) { results.replaceChildren(); $(view.scroll).scrollTop = 0; view.visibleIds = null; }
    view.batchId = batchId; view.ids = ids;
    refreshView(name);
    if (name === 'history') {
      results.dataset.layout = daily ? `daily-${group.kind}` : 'runs';
      if (reset) {
        dailyPreview?.dispose?.();
        dailyPreview = daily ? renderDailyHistory(group, results, { node, text, button, modelLabel, active, timeZone: historyTimeZone, mount: mountHistoryRuns }) : null;
      }
      if (!daily) for (const id of ids) renderCard(id, name);
      if (updateList) renderHistory();
      if (selectionChanged) revealHistoryRow(batchId);
    } else {
      for (const id of view.ids) {
        renderCard(id, name); const root = cards.get(`${name}:${id}`)?.root;
        if (root && !$(view.results).contains(root)) $(view.results).append(root);
      }
      renderRecentBatches(name);
    }
    renderRunningBatches();
  }

  function makeCard(id, view) {
    const root = node("article", "result-card"); root.dataset.runId = id;
    const header = node("div", "card-header"), model = node("div", "card-model");
    const title = node("h3"), provider = node("p", "card-provider"), badge = node("span", "badge"); model.append(title, provider); header.append(model);
    const card = { id, view, root, title, provider, badge, frame: null, stopped: false, reloading: false, opening: false, cancelling: false, previewError: "", width: 960, height: 600 };
    const controls = node("div", "card-actions");
    card.play = iconButton("pause", "停止预览", () => {
      if (card.stopped) return replay(card);
      card.stopped = true; renderShown(id);
    });
    card.restart = iconButton("replay", "重播", () => replay(card));
    card.open = iconButton("external", "在浏览器打开", async () => {
      if (card.opening || card.open.disabled) return;
      card.opening = true; card.previewError = ""; renderCard(id, view);
      try { await api(`api/runs/${id}/open`, { method: "POST" }); }
      catch (err) { card.previewError = err.message; renderCard(id, view); }
      finally { card.opening = false; renderCard(id, view); }
    });
    card.cancel = iconButton("close", "取消生成", async () => {
      if (card.cancelling || !active(runs.get(id) || {})) return;
      card.cancelling = true; card.cancel.disabled = true;
      try { updateRun(await api(`api/runs/${id}/cancel`, { method: "POST" })); }
      catch (err) { notice(err.message); }
      finally { card.cancelling = false; renderCard(id, view); }
    });
    card.disclose = detailButton(card, "源码与详情");
    controls.append(card.restart, card.open, card.cancel, card.disclose);
    card.zone = node("div", "preview-zone"); card.placeholder = node("div", "preview-placeholder"); card.zone.append(card.placeholder);
    previewCards.set(card.zone, card);
    card.inViewport = !visibilityObserver; visibilityObserver?.observe(card.zone);
    card.usage = makeUsage();
    card.errorSummary = node("div", "error-summary"); card.errorSummary.hidden = true;
    card.errorLabel = node("strong");
    card.errorHint = node("span", "card-error-hint");
    card.errorButton = button("查看错误详情", () => { openResultDetail(id, card.errorButton, card); });
    card.errorButton.setAttribute("aria-haspopup", "dialog"); card.errorButton.setAttribute("aria-controls", "favorite-drawer");
    card.errorSummary.append(card.errorLabel, card.errorHint, card.errorButton); card.zone.append(card.errorSummary);
    const footer = node("div", "card-footer"); footer.append(badge, controls);
    root.classList.add("animation-card"); root.append(header, card.zone, card.usage, footer);
    cards.set(`${view}:${id}`, card); $(views[view].results).append(root); return card;
  }

  function makeFingerprintCard(id, view) {
    const root = node("article", "result-card fingerprint-card"); root.dataset.runId = id;
    const header = node("div", "card-header"), model = node("div", "card-model");
    const title = node("h3"), provider = node("p", "card-provider"); model.append(title, provider); header.append(model);
    const card = { id, view, root, title, provider, cancelling: false };
    card.zone = node("div", "fingerprint-zone"); card.caption = node("span", "fingerprint-caption"); card.prediction = node("strong", "fingerprint-prediction"); card.family = node("span", "fingerprint-family");
    const dots = node("div", "sample-dots"); card.dots = [0, 1, 2].map(index => { const dot = node("span", "sample-dot"); dot.setAttribute("aria-label", `采样 ${index + 1}`); dots.append(dot); return dot; });
    card.zone.append(card.caption, card.prediction, card.family, dots);
    card.badge = node("span", "badge");
    card.cancel = iconButton("close", "取消指纹检测", async () => {
      if (card.cancelling || !active(runs.get(id) || {})) return;
      card.cancelling = true; renderCard(id, view);
      try { updateRun(await api(`api/runs/${id}/cancel`, { method: "POST" })); } catch (err) { notice(err.message); }
      finally { card.cancelling = false; renderCard(id, view); }
    });
    card.disclose = detailButton(card, "指纹详情");
    const controls = node("div", "card-actions"), footer = node("div", "card-footer"); controls.append(card.cancel, card.disclose); footer.append(card.badge, controls);
    card.usage = makeUsage(); root.append(header, card.zone, card.usage, footer);
    cards.set(`${view}:${id}`, card); $(views[view].results).append(root); return card;
  }

  function renderCandyCard(id, view) {
    const run = runs.get(id); let card = cards.get(`${view}:${id}`);
    if (!card) {
      const root = node("article", "result-card candy-card"), header = node("div", "card-header"), names = node("div", "card-model");
      root.dataset.runId = id;
      card = { id, view, root, title: node("h3"), provider: node("p", "card-provider") };
      names.append(card.title, card.provider); header.append(names); card.zone = node("div", "candy-zone"); card.answer = node("strong", "candy-answer"); card.verdict = node("span");
      card.placeholder = node("div", "preview-placeholder"); card.progress = node("div", "progress-line"); card.progress.setAttribute("aria-hidden", "true"); card.loadingLabel = node("strong");
      card.placeholder.append(card.progress, card.loadingLabel); card.zone.append(card.placeholder, card.answer, card.verdict);
      card.disclose = detailButton(card, "糖果详情");
      card.cancel = iconButton("close", "取消糖果测试", async () => {
        if (card.cancel.disabled || !active(runs.get(id))) return; card.cancel.disabled = true;
        try { updateRun(await api(`api/runs/${id}/cancel`, { method: "POST" })); } catch (err) { notice(err.message); } finally { card.cancel.disabled = false; }
      });
      const footer = node("div", "card-footer"); card.time = node("span", "help"); const controls = node("div", "card-actions"); controls.append(card.cancel, card.disclose); footer.append(card.time, controls);
      card.usage = makeUsage(); root.append(header, card.zone, card.usage, footer);
      cards.set(`${view}:${id}`, card); $(views[view].results).append(root);
    }
    renderCardHeading(card, run); renderUsage(card.usage, run); card.root.dataset.state = run.status;
    card.zone.dataset.verdict = candyVerdict(run);
    card.placeholder.hidden = !active(run); card.progress.hidden = run.status !== "running";
    card.answer.hidden = card.verdict.hidden = active(run); text(card.loadingLabel, states[run.status]);
    text(card.answer, String(run.candy?.answer ?? "—"));
    card.answer.title = String(run.candy?.answer ?? "—");
    const diagnostic = failureInfo(run);
    text(card.verdict, diagnostic?.label || candyVerdictLabel(run)); card.verdict.title = diagnostic?.advice || candyVerdictLabel(run);
    card.verdict.dataset.tone = diagnostic?.tone || (candyVerdict(run) === "match" ? "success" : "muted");
    text(card.time, when(run.createdAt)); card.cancel.hidden = !active(run);
  }

  function resultNames(run) {
    const provider = run.provider || (typeof run.model === "string" ? run.model.split("/")[0] : "未知供应商");
    return [modelLabel({ id: run.model, name: run.modelName, provider, providerName: run.providerName }, false), run.providerName || provider];
  }

  function renderCardHeading(card, run) {
    const [name, provider] = resultNames(run);
    text(card.title, name);
    card.title.title = `${run.modelName || run.model || name}${run.model ? `\n${run.model}` : ""}`;
    text(card.provider, provider); card.provider.title = provider;
  }

  function renderFingerprintCard(id, view) {
    const run = runs.get(id), card = cards.get(`${view}:${id}`) || makeFingerprintCard(id, view), info = run.fingerprint || {};
    const diagnostic = failureInfo(run);
    renderCardHeading(card, run); renderUsage(card.usage, run);
    card.root.dataset.state = run.status;
    const label = active(run) ? run.status === "running" ? "采样中" : "排队中" : info.decision === "partial" ? "部分结果" : info.decision === "scored" ? "已完成" : run.status === "invalid" ? "无法评分" : ({ cancelled: "已取消", error: "检测失败", interrupted: "已中断" })[run.status] || "已完成";
    card.badge.className = `badge ${run.status}`; text(card.badge, diagnostic?.label || label); card.badge.title = diagnostic?.advice || label;
    text(card.caption, active(run) ? `采样 ${info.completed || 0}/3` : info.prediction ? "最接近的候选" : "检测结果");
    text(card.prediction, active(run) ? (run.status === "running" ? "正在采样" : "等待采样") : diagnostic?.label || info.prediction || label);
    card.prediction.dataset.tone = diagnostic?.tone || "muted";
    text(card.family, active(run) ? `${info.valid || 0} 条有效回答` : diagnostic?.advice || info.family || "3 次独立采样");
    card.prediction.title = card.prediction.textContent; card.family.title = card.family.textContent;
    for (const [index, dot] of card.dots.entries()) {
      const sample = info.samples?.[index]; dot.dataset.state = sample?.state || "queued";
      const count = `${sample?.count ?? 0}/${sample?.expectedCount ?? "—"}`;
      text(dot, count); dot.title = `采样 ${index + 1}：${count} · ${sampleStates[dot.dataset.state] || dot.dataset.state}`;
      dot.setAttribute("aria-label", dot.title);
    }
    card.cancel.hidden = !active(run); card.cancel.disabled = card.cancelling;
  }

  function fitPreview(card) {
    if (!card.frame) return;
    const scale = Math.min((card.zone.clientWidth || 200) / card.width, (card.zone.clientHeight || 120) / card.height);
    Object.assign(card.frame.style, { width: `${card.width}px`, height: `${card.height}px`, transform: `translate(-50%, -50%) scale(${scale})` });
  }
  const previewObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(entries => { for (const entry of entries) { const card = previewCards.get(entry.target); if (card) fitPreview(card); } });
  const visibilityObserver = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(entries => {
    for (const entry of entries) { const card = previewCards.get(entry.target); if (!card) continue; card.inViewport = entry.isIntersecting; renderCard(card.id, card.view); }
  }, { rootMargin: "120px" });
  const visibleCard = card => card.view === activeView && document.visibilityState !== "hidden" && card.inViewport !== false;
  document.addEventListener?.("visibilitychange", () => { for (const card of [...cards.values()]) renderCard(card.id, card.view); });
  addEventListener("resize", () => { for (const card of cards.values()) fitPreview(card); });

  function detailButton(card, label) {
    const control = button("查看详情", () => { openResultDetail(card.id, card.disclose, card); }, "quiet detail-button");
    control.title = label; control.setAttribute("aria-label", label);
    control.setAttribute("aria-controls", "favorite-drawer"); control.setAttribute("aria-haspopup", "dialog");
    return control;
  }

  function openResultDetail(id, origin, card) {
    const run = runs.get(id); if (!run) return;
    const kind = run.kind || "pelican";
    const failure = kind === "pelican" ? node("details", "editor-details") : null;
    const fromError = Boolean(failure && origin && origin === card?.errorButton);
    const message = failure ? node("pre", "source-view") : node("p", "form-error");
    const detail = { id: run.id, card, kind, tabs: new Map(), usage: makeUsage(), source: node("pre", "source-view"), message, failure, elapsed: node("span"), phase: node("span", "running-label") };
    const [name, provider] = resultNames(run);
    const content = favoritesUI.openDrawer({ pelican: "动画详情", fingerprint: "指纹详情", candy: "糖果结果" }[kind], origin, "reading", () => {
      if (detail.preview) previewObserver?.unobserve(detail.preview.zone);
      resultDetail = null;
    });
    resultDetail = detail;
    const choices = kind === "pelican" ? [["preview", "动画预览", "复制源码"], ["html", "HTML 源码", "复制源码"], ["content", "原始输出", "复制输出"]] :
      kind === "fingerprint" ? [["samples", "采样", "复制采样"], ["analysis", "评分", "复制评分"], ["route", "路由", "复制路由"]] :
      [["answer", "完整回答", "复制回答"], ["reasoning", "思考", "复制思考"], ["params", "参数", "复制参数"]];
    detail.mode = choices[0][0];
    const metadata = node("div", "detail-meta"), tabs = node("div", "segments reading-tabs");
    metadata.append(node("span", "", provider), node("span", "", when(run.createdAt)), detail.elapsed, detail.phase);
    tabs.setAttribute("role", "group"); tabs.setAttribute("aria-label", "详情内容");
    detail.copyLabel = new Map(choices.map(([mode, , label]) => [mode, label]));
    for (const [mode, label] of choices) {
      const tab = button(label, () => {
        detail.mode = mode; detail.source.scrollTop = 0; detail.fallback.hidden = true;
        text(detail.copy, detail.copyLabel.get(mode)); renderResultDetail();
      });
      detail.tabs.set(mode, tab); tabs.append(tab);
    }
    detail.copy = button(detail.copyLabel.get(detail.mode), async () => {
      const { mode, copyText } = detail; if (!copyText) return;
      try { await navigator.clipboard.writeText(copyText); if (resultDetail === detail && detail.mode === mode) text(detail.copy, "已复制"); }
      catch { if (resultDetail === detail && detail.mode === mode) { detail.fallback.hidden = false; detail.fallback.value = copyText; detail.fallback.focus(); detail.fallback.select(); } }
    }, "primary");
    $("drawer-tools").append(detail.copy);
    detail.fallback = node("textarea", "source-view"); detail.fallback.readOnly = true; detail.fallback.hidden = true; detail.fallback.setAttribute("aria-label", "请手动复制");
    detail.source.setAttribute("tabindex", "0");
    detail.stats = makeStats(detail, kind === "fingerprint" ? "首次响应" : "首次正文");
    detail.parameters = node("p", "help detail-evidence"); detail.file = node("p", "path");
    detail.insights = createResultInsights(document, { onSource: openSourceRecord, timeZone: historyTimeZone });
    content.append(node("h3", "detail-name", name), metadata, detail.usage, detail.insights.root, tabs);
    if (failure) {
      failure.append(node("summary", "", "原始错误详情"), message);
      failure.open = fromError; failure.hidden = true;
      if (fromError) content.insertBefore(failure, tabs);
    }
    const footer = $("drawer-footer");
    detail.retest = button("复测此条", () => openRetest([run.id], detail.retest));
    detail.retest.hidden = !retestAvailable; footer.append(detail.retest);
    if (kind === "pelican") {
      detail.preview = { id: run.id, zone: node("div", "preview-zone reading-preview"), width: card.width, height: card.height };
      content.append(detail.preview.zone); previewCards.set(detail.preview.zone, detail.preview);
      previewObserver?.observe(detail.preview.zone); footer.append(card.play);
    }
    if (kind === "candy") {
      detail.headline = node("div", "record-headline"); detail.answer = node("strong"); detail.verdict = node("span");
      detail.headline.append(detail.answer, detail.verdict); content.append(detail.headline);
    }
    content.append(detail.source, detail.fallback);
    if (!fromError) content.append(failure || message);
    detail.retry = button("重试读取", () => { run.loadError = ""; return renderResultDetail(); });
    content.append(detail.retry);
    if (kind === "fingerprint") { detail.ranking = node("div", "fingerprint-ranking"); content.append(detail.ranking); }
    content.append(detail.stats, detail.parameters, detail.file);
    if (!card && kind === "candy") {
      detail.cancel = button("取消本次", async () => {
        if (!active(run) || detail.cancel.disabled) return;
        detail.cancel.disabled = true;
        try {
          updateRun(await api(`api/runs/${id}/cancel`, { method: "POST" }));
          if (resultDetail === detail) favoritesUI.closeDrawer();
        }
        catch (error) { if (resultDetail === detail) { text(detail.message, error.message); detail.message.hidden = false; } }
        finally { detail.cancel.disabled = false; }
      }, "danger");
      footer.append(detail.cancel);
    }
    footer.append(button("关闭详情", favoritesUI.closeDrawer));
    if (!fromError) run.loadError = "";
    const loaded = renderResultDetail();
    if (fromError && !failure.hidden) failure.firstElementChild.focus({ preventScroll: true });
    return loaded;
  }

  function renderResultDetail() {
    const detail = resultDetail, run = runs.get(detail?.id); if (!run) return;
    const { mode, kind, card, preview } = detail;
    detail.retest.disabled = active(run) || creating;
    detail.retest.title = active(run) ? "测试结束后可按原条件复测" : "读取本条原条件，核对后重新测试";
    for (const [key, tab] of detail.tabs) tab.setAttribute("aria-pressed", String(key === mode));
    renderUsage(detail.usage, run); renderStats(detail, run);
    text(detail.elapsed, `耗时 ${detail.metrics[0].textContent}`);
    detail.phase.hidden = !active(run); text(detail.phase, active(run) ? states[run.status] : "");
    const parameters = [run.model, run.effort || "默认档位", tokenLabel(run.maxTokens), timeoutLabel(run.timeoutMs), concurrencyLabel(run)].join(" · ");
    let output = run.content || "", placeholder = run.loadError ? "读取失败" : active(run) ? "等待结果…" : run.loaded ? "暂无输出" : "正在读取…";
    if (kind === "pelican") {
      if (mode !== "content") output = run.html || "";
      if (mode === "preview" && run.status === "completed" && !run.loadError) placeholder = card.stopped ? "已停止" : run.loaded ? "暂无动画预览" : "正在读取预览…";
      const url = mode === "preview" && run.status === "completed" && !card.stopped ? run.previewUrl : "";
      if (preview.sourceUrl !== run.previewUrl) { preview.error = ""; preview.sourceUrl = run.previewUrl; }
      if (preview.url !== url) { preview.frame?.remove(); preview.frame = null; }
      preview.zone.hidden = !url; preview.url = url;
      if (url && !preview.frame) {
        preview.frame = node("iframe"); preview.frame.title = `${card.title.textContent} 的动画预览`;
        preview.frame.setAttribute("sandbox", "allow-scripts"); preview.frame.referrerPolicy = "no-referrer";
        preview.frame.src = url; preview.zone.append(preview.frame); fitPreview(preview);
      }
      detail.source.hidden = Boolean(url); card.play.hidden = run.status !== "completed" || mode !== "preview";
      text(detail.parameters, parameters); text(detail.file, run.files?.html || run.files?.response);
    } else if (kind === "fingerprint") {
      const info = run.fingerprint || {};
      output = mode === "route" ? JSON.stringify((run.samples || []).map(sample => sample.provenance || {}), null, 2) : mode === "analysis" ? (run.analysis ? JSON.stringify(run.analysis, null, 2) : "") :
        (run.samples || []).map((sample, index) => `采样 ${index + 1} · ${sample.count ?? "—"}/${sample.expected_count ?? run.challenges?.[index]?.expected_count ?? "—"} · ${sampleStates[sample.state] || "状态未知"}\n${sample.raw_text || "暂无回答"}${sample.error ? "\n" + sample.error : ""}`).join("\n\n");
      if (run.analysis !== detail.renderedAnalysis) {
        detail.renderedAnalysis = run.analysis; detail.ranking.replaceChildren();
        for (const [index, item] of (run.analysis?.results || []).slice(0, 5).entries()) { const row = node("div", "ranking-row"), name = item.display_name || item.model || "未命名候选"; row.title = item.model || name;
          row.append(node("span", "", `${index + 1}. ${name}`), node("span", "", Number.isFinite(item.probability) ? `${(item.probability * 100).toFixed(1)}%` : Number.isFinite(item.score) ? `分数 ${item.score.toFixed(2)}` : "—")); detail.ranking.append(row); }
      }
      const probability = info.probability == null ? "概率不可用" : `库内概率 ${(info.probability * 100).toFixed(1)}%`;
      text(detail.parameters, `${parameters} · ${run.api || "自动接口"}\n${probability} · ${info.verified ? "路由已核实" : "路由未核实"}\n参考库 ${run.bank?.builtAt || "—"}\n${run.bank?.sha256 || ""}\n候选仅供参考库内比较，不能证明模型身份。`);
      text(detail.file, run.files?.samples || run.files?.metadata);
    } else {
      if (detail.cancel) detail.cancel.hidden = !active(run);
      detail.headline.hidden = mode !== "answer" || active(run);
      detail.headline.dataset.verdict = candyVerdict(run);
      text(detail.answer, run.candy?.answer ?? "—"); text(detail.verdict, candyVerdictLabel(run));
      if (mode === "reasoning") { output = run.reasoning || ""; if (run.loaded && !active(run)) placeholder = "暂无思考内容"; }
      if (mode === "params") output = `${parameters}\n题目 ${run.candy?.version || "—"}${run.promptHash ? `\n${run.promptHash}` : ""}${run.prompt ? `\n\n${run.prompt}` : ""}`;
      text(detail.parameters, "仅核对最终数值，推理需人工复核。");
    }
    text(detail.source, mode === "preview" ? placeholder : output || placeholder);
    detail.copyText = output; detail.copy.disabled = !output;
    text(detail.message, run.error || run.loadError || preview?.error || card?.previewError || "");
    (detail.failure || detail.message).hidden = !detail.message.textContent;
    detail.retry.hidden = !run.loadError;
    refreshResultInsights();
    if (!run.loaded && !run.loading && !run.loadError) return loadDetail(detail.id);
  }

  function refreshResultInsights() {
    const detail = resultDetail, run = runs.get(detail?.id); if (!run || !detail.insights) return;
    detail.insights.update(run, [...runs.values()], { loadError: run.loadError, previewError: detail.preview?.error || detail.card?.previewError });
  }

  async function replay(card) {
    const run = runs.get(card.id); if (!run || run.loading || card.reloading) return;
    card.reloading = true; card.stopped = false; card.previewError = "";
    if (card.frame) { card.frame.remove(); card.frame = null; }
    run.previewUrl = ""; run.loaded = false; run.loadError = "";
    const loaded = loadDetail(card.id); renderShown(card.id);
    await loaded;
    card.reloading = false; if (cards.get(`${card.view}:${card.id}`) === card) renderShown(card.id);
  }

  async function loadDetail(id) {
    const run = runs.get(id); if (!run || run.loading) return;
    const startedActive = active(run);
    run.loading = true;
    try {
      const detail = await api(`api/runs/${id}`);
      if (runs.get(id) !== run) return;
      if (run.kind === "fingerprint" && Number.isFinite(run.revision) && Number.isFinite(detail.revision) && detail.revision < run.revision) { run.loading = false; run.loaded = false; renderShown(id); return; }
      if (!active(run) && active(detail)) {
        run.loading = false; renderShown(id); return;
      }
      if (run.status === "running" && detail.status === "queued") { detail.status = "running"; detail.startedAt = run.startedAt; }
      if ((detail.usageRevision || 0) < (run.usageRevision || 0)) {
        for (const key of ["usage", "tokens", "usageRevision"]) detail[key] = run[key];
      }
      // A detail snapshot may have been captured before later streaming chunks arrived.
      for (const [field, count] of run.kind === "fingerprint" ? [] : [["content", "contentChars"], ["reasoning", "reasoningChars"]]) {
        if (typeof detail[field] !== "string") continue;
        const previous = run[field] || "", total = run[count] || previous.length;
        const snapshotLength = detail[field].length;
        if (active(detail) && total > snapshotLength) {
          const suffixStart = total - previous.length;
          detail[field] += previous.slice(Math.max(0, snapshotLength - suffixStart));
          detail[count] = total;
        } else detail[count] = snapshotLength;
      }
      Object.assign(run, detail, { loaded: true, loading: false, loadError: "" });
      renderShown(id);
    } catch (err) {
      if (runs.get(id) !== run) return;
      run.loading = false; run.loadError = startedActive && !active(run) ? "" : err.message;
      if (!run.loadError) run.loaded = false;
      renderShown(id);
    }
  }

  function renderCard(id, view = "current") {
    const run = runs.get(id); if (!run || !views[view].ids.includes(id) && !views[view].recentIds?.includes(id)) return;
    if (view === 'history' && views.history.visibleIds && !views.history.visibleIds.includes(id)) return;
    if (run.kind === "fingerprint") { renderFingerprintCard(id, view); return; }
    if (run.kind === "candy") { renderCandyCard(id, view); return; }
    const card = cards.get(`${view}:${id}`) || makeCard(id, view);
    renderCardHeading(card, run); renderUsage(card.usage, run);
    card.root.dataset.state = run.status;
    card.badge.className = `badge ${run.status}`; text(card.badge, ({ invalid: "无效输出", truncated: "已截断" })[run.status] || states[run.status] || run.status);
    card.badge.title = states[run.status] || run.status;
    const message = run.error || run.loadError || card.previewError;
    const diagnostic = failureInfo(run, { loadError: run.loadError, previewError: card.previewError });
    card.errorSummary.hidden = !message && !diagnostic?.abnormal;
    card.errorSummary.dataset.tone = diagnostic?.tone || "error";
    text(card.errorLabel, diagnostic?.label || (message ? run.status === "completed" ? "预览异常" : states[run.status] : ""));
    text(card.errorHint, diagnostic?.advice || ""); card.errorHint.title = diagnostic?.advice || "";
    card.cancel.hidden = !active(run);
    card.cancel.disabled = card.cancelling;
    card.restart.hidden = card.open.hidden = run.status !== "completed";
    card.play.disabled = card.restart.disabled = Boolean(run.loading || card.reloading);
    card.open.disabled = Boolean(run.loading || card.opening);
    setIcon(card.play, card.stopped ? "play" : "pause", card.stopped ? "播放预览" : "停止预览");
    if (visibleCard(card) && !active(run) && !run.loaded && !run.loading && !run.loadError) loadDetail(id);
    if (run.status === "completed" && run.previewUrl && !card.stopped && visibleCard(card)) {
      if (!card.frame) {
        card.placeholder.hidden = true;
        card.frame = document.createElement("iframe"); card.frame.title = `${run.modelName || run.model} 的鹈鹕动画`;
        card.frame.setAttribute("sandbox", "allow-scripts"); card.frame.referrerPolicy = "no-referrer";
        card.frame.src = run.previewUrl; card.zone.append(card.frame); fitPreview(card); previewObserver?.observe(card.zone);
      }
      return;
    }
    if (card.frame) { card.frame.remove(); card.frame = null; }
    card.placeholder.hidden = Boolean(message);
    const placeholderState = active(run) ? run.status : card.stopped ? "stopped" : run.status === "completed" ? "loading" : run.status;
    if (card.placeholderState === placeholderState) return;
    card.placeholderState = placeholderState; card.placeholder.replaceChildren();
    if (active(run)) {
      if (run.status === "running") card.placeholder.append(node("div", "progress-line"));
      card.placeholder.append(node("strong", "", states[run.status]));
    } else if (card.stopped) { card.placeholder.append(node("strong", "", "已停止")); }
    else if (run.status === "completed") { card.placeholder.append(node("strong", "", run.loadError ? "预览加载失败" : "加载中")); }
    else { card.placeholder.append(node("strong", "", states[run.status])); }
  }

  async function events() {
    if (streaming) return; streaming = true;
    let buffer = "", eventName = "message", data = [], reader;
    const knownIds = new Set(runs.keys());
    try {
      const response = await request("api/events");
      if (!response.ok) throw new Error("实时连接失效，请重新打开页面");
      if (connectionNotice && $("notice").textContent === connectionNotice) notice(""); connectionNotice = "";
      $("connection").setAttribute("aria-label", "已连接 Magpie"); $("connection").title = "已连接 Magpie"; $("connection").classList.add("online");
      reader = response.body.getReader(); const decoder = new TextDecoder();
      const receive = () => {
        if (!data.length) return;
        const value = JSON.parse(data.join("\n"));
        if (eventName === "hello") {
          const liveIds = new Set(value.runs.map(run => run.id));
          removeRuns([...knownIds].filter(id => !liveIds.has(id)));
          for (const run of value.runs) updateRun(run, false); renderHistory();
          favoritesUI.refresh();
        }
        if (eventName === "run") { updateRun(value.run); if (value.run.source === "automatic" && !active(value.run)) favoritesUI.refresh(); }
        if (eventName === "removed") removeRuns(value.ids);
        if (eventName === "favorites") favoritesUI.refresh();
        if (eventName === "schedule-error") notice(value.error);
        if (eventName === "delta") {
          const run = runs.get(value.id);
          if (run && active(run)) {
            for (const [field, count] of [["content", "contentChars"], ["reasoning", "reasoningChars"]]) {
              const chunk = value[field] || "", total = value[count];
              // A detail snapshot can already contain this chunk when the SSE message arrives late.
              if (!Number.isFinite(total)) run[field] = (run[field] || "") + chunk;
              else if (total > (run[count] || 0)) {
                const unseen = Math.min(chunk.length, total - (run[count] || 0));
                if (unseen) run[field] = (run[field] || "") + chunk.slice(-unseen);
                run[count] = total;
              }
            }
            if (value.firstContentMs != null) run.firstContentMs = value.firstContentMs;
            if (value.tokens && (value.usageRevision || 0) >= (run.usageRevision || 0)) {
              run.tokens = value.tokens; run.usage = value.usage; run.usageRevision = value.usageRevision || 0;
            }
            scheduleRender(run.id);
          }
        }
      };
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        buffer += decoder.decode(value, { stream: true }); let end;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end).replace(/\r$/, ""); buffer = buffer.slice(end + 1);
          if (!line) { receive(); eventName = "message"; data = []; }
          else if (line.startsWith("event:")) eventName = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        }
      }
      throw new Error("实时连接已断开，正在重连…");
    } catch (err) { $("connection").setAttribute("aria-label", "连接中断"); $("connection").title = "连接中断"; $("connection").classList.remove("online"); connectionNotice = err.message; notice(connectionNotice); }
    finally { await reader?.cancel().catch(() => {}); reader?.releaseLock(); streaming = false; if (!reconnecting) setTimeout(events, 2500); }
  }

  function mountFavoriteRuns(ids, targets = new Map()) {
    const view = views.favorites;
    for (const id of view.ids) if (!ids.includes(id)) removeCard(id, "favorites");
    view.ids = ids;
    for (const id of ids) {
      renderCard(id, "favorites"); const root = cards.get(`favorites:${id}`)?.root, target = targets.get(id);
      if (root && target && !target.contains(root)) target.append(root);
    }
    return ids.map(id => cards.get(`favorites:${id}`)).filter(Boolean);
  }
  const favoritesUI = createFavoritesUI({ $, node, text, button, iconButton, api, models, runs, modelLabel, active, makeUsage, renderUsage, mount: mountFavoriteRuns, openResultDetail, confirmAction, isVisible: () => activeView === "favorites", initialKind: query.get("automatic"), rememberView });
  const tabViews = ["current", "fingerprint", "candy", "favorites", "history"];
  for (const [index, name] of tabViews.entries()) {
    const tab = $(`${name}-tab`);
    tab.addEventListener("click", () => setView(name));
    tab.addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const target = event.key === "Home" ? "current" : event.key === "End" ? "history" : tabViews[(index + (event.key === "ArrowRight" ? 1 : tabViews.length - 1)) % tabViews.length];
      setView(target); $(`${target}-tab`).focus();
    });
  }
  setView("current");
  $("clear-selection").addEventListener("click", () => {
    if (!selected.size) return;
    selected.clear(); selectedAccounts.clear(); error(""); renderSelected(); renderModels(); $("model-search").focus();
  });
  $("history-filter").addEventListener("change", renderHistory);
  $("history-source").addEventListener("change", renderHistory);
  for (const name of ['current', 'fingerprint', 'candy']) $(`${name}-history-link`).addEventListener('click', () => openManualHistory(name));
  $("favorite-selected").addEventListener("click", async () => {
    const control = $("favorite-selected"); if (control.disabled || addingFavorites || !validateNumber("max-tokens", "输出上限") || !validateNumber("generation-timeout", "生成超时")) return;
    const originView = activeView; addingFavorites = true; control.disabled = true; control.setAttribute("aria-busy", "true");
    try { await favoritesUI.addSelected([...selected], { maxTokens: Number($("max-tokens").value), timeoutMs: Number($("generation-timeout").value) * 1000, prompt: $("prompt").value }); if (activeView === originView) setView("favorites"); }
    catch (err) { error(err.message); } finally { addingFavorites = false; control.removeAttribute("aria-busy"); control.disabled = !selected.size || !favoritesAvailable; }
  });
  function renderBank(value) {
    const ready = value?.state === "ready";
    $("bank-status").dataset.state = value?.state || "missing";
    text($("bank-status"), bankUpdating ? "正在更新参考库…" : ready ? `参考库就绪 · ${value.meta?.modelCount || 0} 模型` : "参考库未下载");
    text($("bank-meta"), value?.meta ? `${value.meta.builtAt}\nSDK ${value.meta.sdkVersion || "0.2.0"}\n${value.meta.sha256}` : "首次检测前自动下载，也可点击更新。");
    $("bank-refresh").setAttribute("aria-label", ready ? "更新参考库" : "下载参考库"); $("bank-refresh").title = ready ? "更新参考库" : "下载参考库";
  }
  $("bank-refresh").addEventListener("click", async () => {
    if (!fingerprintAvailable || bankUpdating) return;
    bankUpdating = true; updateSettings(); $("bank-status").dataset.state = "loading"; text($("bank-status"), "正在更新参考库…");
    try { const value = await api("api/fingerprint/bank/refresh", { method: "POST" }); bankUpdating = false; renderBank(value); notice(""); }
    catch (err) { $("bank-status").dataset.state = "error"; text($("bank-status"), "参考库更新失败"); notice(err.message); }
    finally { bankUpdating = false; updateSettings(); }
  });
  $("fp-pin").addEventListener("change", async () => {
    renderSelected();
    const status = $("account-status"); status.hidden = !$("fp-pin").checked || accountsLoaded || !fingerprintAvailable;
    if (!$("fp-pin").checked || accountsLoaded || accountsLoading || !fingerprintAvailable) return;
    accountsLoading = true; text(status, "正在读取缓存账号…");
    try { cachedAccounts = (await api("api/fingerprint/accounts")).accounts; accountsLoaded = true; status.hidden = true; text(status, ""); for (const datalist of $("selected-models").querySelectorAll("datalist")) renderAccountOptions(datalist); }
    catch { status.hidden = !$("fp-pin").checked; text(status, "未获取缓存账号，可手动输入 ID"); }
    finally { accountsLoading = false; }
  });
  $("provider").addEventListener("change", () => { $("model-search").value = ""; error(""); renderModels(); renderSelected(); });
  $("model-search").addEventListener("input", renderModels);
  $("theme").addEventListener("click", () => { dark = !dark; setTheme(); rememberView({ theme: dark ? "dark" : "light" }); });
  const promptSummary = () => {
    $("prompt-summary").textContent = $("prompt").value === defaults ? "默认" : "已编辑";
    if ($("prompt").value.trim() && $("prompt").getAttribute("aria-invalid") === "true") { $("prompt").removeAttribute("aria-invalid"); error(""); }
  };
  const togglePrompt = (expanded) => {
    $("prompt-editor").hidden = !expanded; $("edit-prompt").setAttribute("aria-expanded", String(expanded));
    $("prompt-toggle-label").textContent = "提示词";
    $("edit-prompt").setAttribute("aria-label", expanded ? "收起提示词" : "编辑提示词");
    if (expanded) $("prompt").focus();
  };
  togglePrompt(false);
  $("edit-prompt").addEventListener("click", () => togglePrompt($("prompt-editor").hidden));
  $("prompt").addEventListener("input", promptSummary);
  $("reset-prompt").addEventListener("click", () => { $("prompt").value = defaults; promptSummary(); });
  $("toggle-data-dir").addEventListener("click", () => {
    const expanded = $("data-dir").hidden;
    $("data-dir").hidden = !expanded; $("toggle-data-dir").setAttribute("aria-expanded", String(expanded));
    $("toggle-data-dir").setAttribute("aria-label", expanded ? "收起保存路径" : "查看保存路径");
  });
  $("open-data-dir").addEventListener("click", async () => {
    const control = $("open-data-dir"); if (!openDataDir || control.disabled) return;
    control.disabled = true; control.setAttribute("aria-busy", "true");
    const status = $("storage-status"); status.hidden = false; status.dataset.error = "false"; text(status, "正在打开文件夹…");
    try { await api("api/storage/open", { method: "POST" }); status.hidden = true; text(status, ""); }
    catch (err) { text(status, err.message); status.dataset.error = "true"; }
    finally { control.disabled = false; control.removeAttribute("aria-busy"); }
  });
  const pad = value => String(value).padStart(2, "0");
  const localDate = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const localTime = date => `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  function parseLocal(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(value.trim()); if (!match) return null;
    const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]), hour = Number(match[4]), minute = Number(match[5]);
    if (year < 1000) return null;
    const parsed = new Date(year, month - 1, day, hour, minute);
    return parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day && parsed.getHours() === hour && parsed.getMinutes() === minute ? parsed : null;
  }
  let calendarDate = new Date();
  function closeCalendar(focus = false) {
    $("cleanup-calendar").hidden = true; $("choose-date").setAttribute("aria-expanded", "false");
    if (focus) $("choose-date").focus();
  }
  function positionCalendar() {
    const popup = $("cleanup-calendar"); if (popup.hidden) return;
    const edge = 12, anchor = $("cleanup-before").getBoundingClientRect(), size = popup.getBoundingClientRect();
    const height = Math.min(size.height, innerHeight - edge * 2);
    const left = Math.max(edge, Math.min(anchor.left, innerWidth - size.width - edge));
    let top = anchor.bottom + 8;
    if (top + height > innerHeight - edge) top = Math.max(edge, anchor.top - height - 8);
    Object.assign(popup.style, { left: `${left}px`, top: `${top}px`, maxHeight: `${Math.max(0, innerHeight - edge * 2)}px` });
  }
  function selectDate(date) {
    const previous = parseLocal($("cleanup-before").value), now = new Date();
    $("cleanup-before").value = `${localDate(date)} ${localTime(previous || now)}`;
    $("cleanup-before").removeAttribute("aria-invalid"); closeCalendar(); $("cleanup-before").focus();
  }
  function renderCalendar() {
    const year = calendarDate.getFullYear(), month = calendarDate.getMonth(), selectedDate = parseLocal($("cleanup-before").value), today = localDate(new Date());
    text($("calendar-month"), `${year}年${month + 1}月`);
    $("calendar-prev").disabled = year <= 1000 && month === 0; $("calendar-next").disabled = year >= 9999 && month === 11;
    const days = $("calendar-days"); days.replaceChildren();
    const offset = (new Date(year, month, 1).getDay() + 6) % 7;
    for (let index = 0; index < offset; index++) days.append(node("span"));
    const focusDay = selectedDate?.getFullYear() === year && selectedDate?.getMonth() === month ? selectedDate.getDate() : 1;
    for (let day = 1; day <= new Date(year, month + 1, 0).getDate(); day++) {
      const date = new Date(year, month, day), value = localDate(date);
      const control = button(String(day), () => selectDate(date), "calendar-day"); control.dataset.date = value;
      control.dataset.today = String(value === today); control.setAttribute("aria-label", `${year}年${month + 1}月${day}日`);
      control.setAttribute("aria-pressed", String(Boolean(selectedDate && value === localDate(selectedDate)))); control.setAttribute("tabindex", day === focusDay ? "0" : "-1");
      control.addEventListener("keydown", event => {
        if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
        event.preventDefault(); const next = new Date(year, month, day);
        const weekday = (next.getDay() + 6) % 7;
        const move = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, Home: -weekday, End: 6 - weekday }[event.key];
        next.setDate(next.getDate() + move); if (next.getFullYear() < 1000 || next.getFullYear() > 9999) return;
        if (next.getMonth() !== month || next.getFullYear() !== year) { calendarDate = new Date(next.getFullYear(), next.getMonth(), 1); renderCalendar(); }
        const target = [...$("calendar-days").children].find(element => element.dataset.date === localDate(next));
        for (const element of $("calendar-days").children) if (element.dataset.date) element.setAttribute("tabindex", element === target ? "0" : "-1");
        target?.focus();
      });
      days.append(control);
    }
    positionCalendar();
  }
  $("choose-date").addEventListener("click", () => {
    if (!$("cleanup-calendar").hidden) { closeCalendar(true); return; }
    if (cleaning) return;
    const date = parseLocal($("cleanup-before").value) || new Date(); calendarDate = new Date(date.getFullYear(), date.getMonth(), 1);
    renderCalendar(); $("cleanup-calendar").hidden = false; $("choose-date").setAttribute("aria-expanded", "true"); positionCalendar();
    [...$("calendar-days").children].find(element => element.getAttribute("tabindex") === "0")?.focus();
  });
  for (const [id, move] of [["calendar-prev", -1], ["calendar-next", 1]]) $(id).addEventListener("click", () => {
    const next = new Date(calendarDate.getFullYear(), calendarDate.getMonth() + move, 1);
    if (next.getFullYear() < 1000 || next.getFullYear() > 9999) return; calendarDate = next; renderCalendar();
  });
  $("calendar-today").addEventListener("click", () => selectDate(new Date()));
  $("calendar-close").addEventListener("click", () => closeCalendar(true));
  $("cleanup-calendar").addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); closeCalendar(true); } });
  $("cleanup-before").addEventListener("input", () => $("cleanup-before").removeAttribute("aria-invalid"));
  for (const id of ["max-tokens", "generation-timeout", "concurrency"]) $(id).addEventListener("input", () => $(id).removeAttribute("aria-invalid"));
  addEventListener("pointerdown", event => { if (!$("cleanup-calendar").hidden && !$("cleanup-calendar").contains(event.target) && !$("choose-date").contains(event.target)) closeCalendar(); });
  addEventListener("focusin", event => { if (!$("cleanup-calendar").hidden && !$("cleanup-calendar").contains(event.target) && !$("choose-date").contains(event.target)) closeCalendar(); });
  addEventListener("scroll", event => { if (!$("cleanup-calendar").contains(event.target)) closeCalendar(); }, true);
  addEventListener("resize", () => closeCalendar());
  $("manage-history").addEventListener("click", () => {
    const open = $("cleanup-panel").hidden; $("cleanup-panel").hidden = !open;
    $("manage-history").setAttribute("aria-expanded", String(open));
    text($("manage-history"), open ? "关闭" : "批量清理");
    if (!open) { closeCalendar(); $("manage-history").focus(); }
  });
  function cleanupControls() {
    const busy = cleaning || deleting.size > 0;
    $("clear-all").disabled = $("clear-before").disabled = busy;
    $("cleanup-before").disabled = $("choose-date").disabled = cleaning;
    $("cleanup-panel").setAttribute("aria-busy", String(cleaning));
  }
  async function cleanup(mode) {
    if (cleaning || deleting.size) return;
    let before;
    if (mode === "before") {
      const parsed = parseLocal($("cleanup-before").value);
      if (!parsed) { $("cleanup-status").textContent = "请选择有效的截止时间（YYYY-MM-DD HH:mm）"; $("cleanup-status").dataset.error = "true"; $("cleanup-before").setAttribute("aria-invalid", "true"); $("cleanup-before").focus(); return; }
      $("cleanup-before").removeAttribute("aria-invalid");
      before = parsed.toISOString();
    }
    if (!await confirmAction(mode === "all" ? "清除全部历史" : "按时间清理", mode === "all" ? "将删除全部已结束的记录及生成文件。" : `将删除 ${$("cleanup-before").value} 之前已结束的记录及生成文件。`, "确认清理")) return;
    cleaning = true; cleanupControls(); closeCalendar(); renderHistory(); $("cleanup-status").textContent = "正在清理记录和文件…"; $("cleanup-status").dataset.error = "false";
    try {
      const outcome = await api("api/runs/cleanup", { method: "POST", body: JSON.stringify({ mode, ...(before ? { before } : {}) }) });
      removeRuns(outcome.removed);
      $("cleanup-status").textContent = `已清除 ${outcome.removed.length} 条记录及文件${outcome.skippedActive ? `，保留 ${outcome.skippedActive} 个未完成任务` : ""}${outcome.errors.length ? `；${outcome.errors.length} 条清理失败：${outcome.errors[0].error}` : ""}`;
      $("cleanup-status").dataset.error = String(outcome.errors.length > 0);
    } catch (err) { $("cleanup-status").textContent = err.message; $("cleanup-status").dataset.error = "true"; }
    finally { cleaning = false; cleanupControls(); renderHistory(); }
  }
  $("clear-all").addEventListener("click", () => cleanup("all"));
  $("clear-before").addEventListener("click", () => cleanup("before"));
  $("refresh-models").addEventListener("click", async () => {
    const control = $("refresh-models"); if (control.disabled) return; control.disabled = true;
    try { updateModels((await api("api/models")).models); notice(""); } catch (err) { notice(err.message); }
    finally { control.disabled = false; }
  });
  function validateNumber(id, label) {
    const control = $(id), value = Number(control.value);
    if (!control.value.trim() || !Number.isSafeInteger(value) || value < 0) {
      $("advanced-settings").open = true; control.setAttribute("aria-invalid", "true"); error(`${label}需为非负整数，0 表示不设上限`); control.focus(); return false;
    }
    if (id === "generation-timeout" && value > 2147483) {
      $("advanced-settings").open = true; control.setAttribute("aria-invalid", "true"); error("生成超时最多 2147483 秒，0 表示不设超时"); control.focus(); return false;
    }
    control.removeAttribute("aria-invalid"); return true;
  }
  // Magpie's sandbox blocks native submission before a form's submit event can run.
  $("generate").addEventListener("click", async () => {
    if (["history", "favorites"].includes(activeView) || $("generate").disabled) return;
    error("");
    if (!selected.size) { error("请选择至少一个模型"); return; }
    if (executionView === "current" && !$("prompt").value.trim()) { togglePrompt(true); error("请填写测试提示词"); $("prompt").setAttribute("aria-invalid", "true"); return; }
    $("prompt").removeAttribute("aria-invalid");
    for (const [id, label] of [["max-tokens", "输出上限"], ["generation-timeout", "生成超时"], ["concurrency", "每批并行数"]]) {
      if (!validateNumber(id, label)) return;
    }
    const mode = executionView; creating = true; updateSettings();
    try {
      const body = await api("api/runs", { method: "POST", body: JSON.stringify({
        ...(mode === "fingerprint" ? { kind: "fingerprint", strict: $("fp-strict").checked, api: $("fp-api").value || "auto", serviceTier: $("fp-tier").value || "default" } : mode === "candy" ? { kind: "candy" } : { prompt: $("prompt").value }),
        maxTokens: Number($("max-tokens").value), timeoutMs: Number($("generation-timeout").value) * 1000, concurrency: Number($("concurrency").value), models: [...selected].map(([id, effort]) => ({ id, effort,
          ...(mode === "fingerprint" && $("fp-pin").checked && selectedAccounts.get(id) ? { account: selectedAccounts.get(id) } : {}) })),
      }) });
      for (const run of body.runs) updateRun(run, false); renderHistory();
      showBatch(batchKey(body.runs[0]), mode); notice("");
      if (mode === "fingerprint" && body.runs[0].bank) renderBank({ state: "ready", meta: body.runs[0].bank });
    } catch (err) { error(err.message); }
    finally { creating = false; updateSettings(); }
  });
  for (const view of Object.values(views).filter(view => view !== views.favorites)) $(view.cancel).addEventListener("click", async () => {
    const control = $(view.cancel); if (control.disabled) return; control.disabled = true;
    try {
      if (batchCancel && view.batchId && !view.batchId.startsWith("daily:")) { const body = await api(`api/batches/${view.batchId}/cancel`, { method: "POST" }); for (const run of body.runs) updateRun(run); }
      else for (const id of [...view.ids]) if (active(runs.get(id) || {})) updateRun(await api(`api/runs/${id}/cancel`, { method: "POST" }));
    } catch (err) { notice(err.message); } finally { control.disabled = false; }
  });
  addEventListener("message", (event) => {
    const data = event.data;
    if (event.source === parent && data?.magpie === 1 && data.event === "action" && data.data?.id === "fingerprint") {
      const provider = data.data.provider?.id;
      if (typeof provider === "string" && [...models.values()].some(model => model.provider === provider)) {
        $("provider").value = provider; $("model-search").value = ""; renderModels();
      }
      setView("fingerprint"); return;
    }
    if (!data || data.type !== "pelican-preview") return;
    const reading = resultDetail?.preview;
    const card = reading?.id === data.id && reading.frame?.contentWindow === event.source ? reading : [...cards.values()].find(card => card.id === data.id && card.frame?.contentWindow === event.source);
    if (!card) return;
    if (data.kind === "size" && Number.isFinite(data.width) && Number.isFinite(data.height) && data.width > 0 && data.height > 0) {
      card.width = Math.ceil(data.width); card.height = Math.ceil(data.height); fitPreview(card);
    }
    if (data.kind === "error") {
      const message = `预览运行错误：${String(data.message).slice(0, 400)}`;
      if (card === reading) { card.error = message; renderResultDetail(); }
      else { card.previewError = message; renderCard(data.id, card.view); }
    }
  });
  setInterval(() => {
    const run = runs.get(resultDetail?.id);
    if (run && active(run) && run.startedAt) { renderStats(resultDetail, run); text(resultDetail.elapsed, `耗时 ${resultDetail.metrics[0].textContent}`); }
  }, 1000);

  async function bootstrap() {
    if (bootstrapping) return; bootstrapping = true; notice("");
    $("connection").setAttribute("aria-label", "正在连接"); $("connection").title = "正在连接";
    try {
    const boot = await api("api/bootstrap"); initialized = true;
    defaults = boot.defaultPrompt; $("prompt").value = defaults; $("data-dir").textContent = boot.dataDir; $("version").textContent = boot.version;
    promptSummary();
    $("retention-note").textContent = `保留 ${boot.retentionDays || 7} 天`;
    const now = new Date(); $("cleanup-before").value = `${localDate(now)} ${localTime(now)}`;
    $("cleanup-panel").hidden = true;
    text($("manage-history"), "批量清理"); closeCalendar(); cleanupControls();
    batchCleanup = boot.batchCleanup === true;
    favoritesAvailable = boot.favoritesAvailable === true; candyAvailable = boot.candyAvailable === true;
    text($("candy-prompt"), boot.candyPrompt || "重新开启插件后加载题面"); text($("candy-version"), `可选形状版 · ${boot.candyVersion || "v1"}`);
    fingerprintAvailable = boot.fingerprintAvailable === true; batchCancel = boot.batchCancel === true; batchExport = boot.batchExport === true; retestAvailable = boot.retestAvailable === true;
    renderBank(boot.bankStatus); updateSettings();
    openDataDir = boot.openDataDir === true; $("open-data-dir").disabled = !openDataDir;
    $("open-data-dir").title = openDataDir ? `打开保存文件夹：${boot.dataDir}` : "重新开启插件后可打开保存文件夹";
    $("toggle-data-dir").title = boot.dataDir; $("data-dir").hidden = true;
    if (!batchCleanup) historyNotice("单批删除需要重新开启插件；当前仍可查看历史和使用批量清理。");
    historyTimeZone = boot.historyTimeZone;
    updateModels(boot.models); for (const run of boot.runs) runs.set(run.id, run); renderHistory(); favoritesUI.init(boot);
    const startupErrors = [boot.error, boot.favoritesError ? `${boot.favoritesError}。自动测试已停用，原配置已保留；历史和手动测试仍可使用。恢复配置后请重新开启插件。` : ""].filter(Boolean);
    if (startupErrors.length) notice(startupErrors.join("；"));
    for (const [name, kind, param] of [["current", "pelican", "run"], ["fingerprint", "fingerprint", "fingerprint"], ["candy", "candy", "candy"]]) {
      const pinned = runs.get(query.get(param)), matches = run => run.source !== "automatic" && (run.kind || "pelican") === kind;
      const run = pinned && matches(pinned) ? pinned : boot.runs.find(matches); if (run) showBatch(batchKey(run), name);
    }
    if (["fingerprint", "candy"].includes(query.get("mode"))) setView(query.get("mode"));
    if (tabViews.includes(query.get("view"))) setView(query.get("view"));
    const historyRun = query.get("history"), historyId = historyKeys.get(historyRun);
    if (historyId) { showBatch(historyId, "history"); dailyPreview?.revealRun?.(historyRun); }
    events();
    } catch (err) {
      initialized = false; updateSettings(); notice(err.message); $("connection").setAttribute("aria-label", "连接失败"); $("connection").title = "连接失败";
      if (!reconnecting) $("notice").append(button("重试连接", bootstrap, "quiet retry-connection"));
    } finally { bootstrapping = false; }
  }
  bootstrap();
})();
