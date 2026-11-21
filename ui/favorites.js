/* Shared favorites use the same saved runs and preview components as the test pages. */
"use strict";
globalThis.createFavoritesUI = function ({ $, node, text, button, iconButton, api, models, runs, modelLabel, active, makeUsage, renderUsage, mount, openResultDetail, confirmAction, isVisible, initialKind, rememberView }) {
  const labels = { candy: "糖果", pelican: "动画" }, candyCards = new Map(), animationRows = new Map(), pendingActions = new WeakSet(), pendingPlans = new Set();
  let state = { favorites: [], plans: [], enabled: true, concurrency: 3 }, supported = false, kind = initialKind === "pelican" ? "pelican" : "candy", page = 0, opener = null, drawerVersion = 0, refreshTask = null, refreshAgain = false;
  let fieldNumber = 0, disposeDrawer = null, feedbackTimer;
  const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body) });
  const status = (message, panel = false, tone = "error") => {
    const target = $(panel ? "drawer-status" : "favorite-status");
    if (!panel) {
      clearTimeout(feedbackTimer);
      if (message && tone === "success") feedbackTimer = setTimeout(() => { target.hidden = true; }, 3500);
    }
    text(target, message); target.hidden = !message; target.dataset.tone = tone;
  };
  const filtered = () => state.favorites.filter(f => !$("favorite-provider").value || f.provider === $("favorite-provider").value);
  const titleOf = favorite => modelLabel({ id: favorite.modelId, name: favorite.modelName, provider: favorite.provider, providerName: favorite.providerName }, false);
  const verdictOf = run => run.status === "completed" ? run.candy?.verdict || "review" : "incomplete";
  const verdictLabel = run => active(run) ? run.status === "running" ? "生成中" : "排队中" : ({ match: "答案 21", mismatch: `答案 ${run.candy?.answer}`, review: "待复核", incomplete: ({ error: "请求失败", cancelled: "已取消", interrupted: "已中断", truncated: "已截断" })[run.status] || "未完成" })[verdictOf(run)];
  const planOf = favorite => state.plans.find(plan => plan.favoriteIds[0] === favorite.id && plan.kinds[0] === kind);
  const phaseLabel = { waiting: "待运行", paused: "已暂停", missed: "已错过", skipped: "已跳过", started: "结果已清理", error: "请求失败" };
  function animationTarget(slots, now = Date.now()) {
    const scheduled = slots.filter(slot => Number.isFinite(Date.parse(slot.at)));
    return scheduled.find(slot => Date.parse(slot.at) <= now) || scheduled.at(-1) || slots.find(slot => slot.run) || slots[0];
  }
  function recordsFor(favorite, plan, indexed) {
    return (plan?.today?.slots || []).map(slot => {
      const candidate = (slot.runId ? runs.get(slot.runId) : null) || indexed.get(slot.key);
      const run = candidate?.favoriteId === favorite.id && candidate.kind === kind ? candidate : null;
      return { ...slot, run, verdict: run ? active(run) ? run.status : verdictOf(run) : slot.state,
        labelText: `${slot.label} · ${run ? verdictLabel(run) : phaseLabel[slot.state] || "待运行"}${slot.reason ? ` · ${slot.reason}` : ""}` };
    });
  }

  async function perform(control, callback, panel = false, lockForm = false) {
    if (control.disabled || pendingActions.has(control)) return;
    const version = drawerVersion; pendingActions.add(control); control.disabled = true; control.setAttribute("aria-busy", "true"); status("", panel);
    const locked = lockForm ? [$("drawer-content"), $("drawer-footer")].flatMap(root => [...root.querySelectorAll("input, select, textarea, button")]).filter(item => item !== control).map(item => [item, item.disabled]) : [];
    for (const [item] of locked) item.disabled = true;
    try { await callback(version); } catch (error) { if (!panel || version === drawerVersion) status(error.message, panel); }
    finally {
      for (const [item, disabled] of locked) item.disabled = disabled;
      pendingActions.delete(control); control.removeAttribute("aria-busy"); control.disabled = false; if (!panel || version === drawerVersion) control.refreshDisabled?.();
    }
  }
  function action(label, callback, className = "quiet", panel = true, lockForm = false) {
    const control = button(label, () => perform(control, callback, panel, lockForm), className); return control;
  }
  function field(label, type, value) {
    const row = node("label", "editor-field"), control = node(type === "textarea" ? "textarea" : "input");
    if (type !== "textarea") control.type = type;
    control.value = value ?? ""; if (type === "number") { control.min = "1"; control.step = "1"; }
    control.id = `favorite-field-${++fieldNumber}`; row.setAttribute("for", control.id);
    const caption = node("span", "help", label); caption.id = `${control.id}-label`; control.setAttribute("aria-labelledby", caption.id);
    const error = node("small", "inline-error"); error.id = `${control.id}-error`; error.hidden = true; control.setAttribute("aria-describedby", error.id); row.append(caption, control, error); return { row, control, error };
  }
  function selectField(label, values, value) {
    const row = node("label", "editor-field"), control = node("select"); control.setAttribute("aria-label", label);
    for (const [id, name] of values) { const option = node("option", "", name); option.value = id; control.append(option); }
    control.value = value; row.append(node("span", "help", label), control); return { row, control };
  }
  function check(label, checked, change) {
    const row = node("label", "check-row"), control = node("input"); control.type = "checkbox"; control.checked = Boolean(checked);
    control.setAttribute("aria-label", label); if (change) control.addEventListener("change", () => change(control.checked));
    row.append(control, node("span", "", label)); return { row, control };
  }
  function fieldError(item, message) { text(item.error, message); item.error.hidden = !message; item.control.setAttribute("aria-invalid", String(Boolean(message))); }
  function footer(primary, summary = "", secondary = "取消", onSecondary = closeDrawer) { $("drawer-footer").replaceChildren(node("span", "help", summary), button(secondary, onSecondary), ...(primary ? [primary] : [])); }
  function back(label, callback) { const control = $("drawer-back"); control.hidden = false; text(control, `‹ ${label}`); control.onclick = callback; }

  function closeDrawer() {
    if ($("favorite-drawer").hidden) return;
    disposeDrawer?.(); disposeDrawer = null; $("drawer-tools").replaceChildren();
    drawerVersion++; $("favorite-drawer").hidden = true; $("drawer-content").replaceChildren(); $("drawer-footer").replaceChildren(); status("", true);
    delete document.documentElement.dataset.drawerOpen;
    const app = document.querySelector("main.app"); if (app) app.inert = false;
    const target = opener?.getClientRects().length && !opener.disabled ? opener : document.querySelector('.view-tab[aria-selected="true"]');
    target?.focus({ preventScroll: true }); opener = null;
  }
  function openDrawer(title, origin, mode = "compact", dispose = null) {
    if ($("favorite-drawer").hidden) opener = origin || document.activeElement || $("favorite-add");
    disposeDrawer?.(); disposeDrawer = dispose; $("drawer-tools").replaceChildren();
    drawerVersion++; $("drawer-content").scrollTop = 0;
    text($("drawer-title"), title); $("drawer-content").replaceChildren(); $("drawer-footer").replaceChildren(); $("drawer-back").hidden = true; $("drawer-back").onclick = null; status("", true); $("favorite-drawer").dataset.mode = mode; $("favorite-drawer").hidden = false;
    document.documentElement.dataset.drawerOpen = "true";
    const app = document.querySelector("main.app"); if (app) app.inert = true;
    $("drawer-title").focus({ preventScroll: true }); return $("drawer-content");
  }
  for (const id of ["drawer-close", "drawer-backdrop"]) $(id).addEventListener("click", closeDrawer);
  $("favorite-drawer").addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); closeDrawer(); }
    if (event.key === "Tab") {
      const controls = [...($("favorite-drawer").querySelectorAll?.('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, a[href], [tabindex]') || [])].filter(item => item.getClientRects?.().length && !item.disabled && item.getAttribute("tabindex") !== "-1");
      const first = controls[0], last = controls.at(-1);
      if (document.activeElement === $("drawer-title")) { event.preventDefault(); (event.shiftKey ? last : first)?.focus(); return; }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  });

  async function refresh() {
    if (!supported) return;
    if (refreshTask) { refreshAgain = true; return refreshTask; }
    refreshTask = (async () => {
      do { refreshAgain = false; state = await api("api/favorites"); render(); } while (refreshAgain);
    })().catch(error => status(error.message)).finally(() => { refreshTask = null; });
    return refreshTask;
  }
  function daysLabel(days) {
    const value = [...days].sort().join("");
    return value === "0123456" ? "每天" : value === "12345" ? "工作日" : value === "06" ? "周末" : `周${days.map(day => "日一二三四五六"[day]).join("、")}`;
  }
  function cardHeading(favorite) {
    const header = node("div", "favorite-card-header"), names = node("div", "card-model"), title = node("h3", "", titleOf(favorite));
    const provider = node("p", "card-provider"), targetKind = kind; names.append(title, provider);
    const settings = iconButton("settings", `设置 ${titleOf(favorite)} 的${labels[targetKind]}计划`, () => { const current = state.favorites.find(f => f.id === favorite.id); if (current) planEditor(current, settings); });
    header.append(names, settings);
    header.update = value => {
      text(title, titleOf(value)); title.title = `${titleOf(value)}\n${value.modelId}`; text(provider, value.providerName || value.provider); provider.title = provider.textContent;
      settings.setAttribute("aria-label", `设置 ${titleOf(value)} 的${labels[targetKind]}计划`); settings.title = settings.getAttribute("aria-label");
    }; header.update(favorite);
    return header;
  }
  function planControls(favorite, plan) {
    const row = node("div", "card-schedule"), label = node("span", "card-plan-summary"), targetKind = kind;
    const toggle = action("", async () => {
      const current = row.plan; if (!current || pendingPlans.has(current.id)) return;
      pendingPlans.add(current.id);
      try { await post("api/schedules/save", { id: current.id, enabled: !current.enabled }); await refresh(); }
      finally { pendingPlans.delete(current.id); render(); }
    }, "switch", false);
    toggle.append(node("span")); row.append(label, toggle);
    row.update = (current, value = favorite) => {
      favorite = value;
      row.plan = current;
      const summary = !current ? "暂无计划" : current.migrationReason ? "需要重新设置" : current.mode === "times" ? current.times.join(" · ") : `每 ${current.intervalMinutes} 分钟 · ${current.allDay ? "全天" : `${current.start}–${current.end}`}`;
      text(label, summary); label.title = current ? `${daysLabel(current.days)} · ${current.timeZone}\n${summary}${current.migrationReason ? `\n${current.migrationReason}` : ""}` : summary;
      toggle.hidden = !current; toggle.disabled = !current || Boolean(current.migrationReason) || pendingPlans.has(current.id) || pendingActions.has(toggle);
      toggle.setAttribute("aria-pressed", String(Boolean(current?.enabled)));
      toggle.setAttribute("aria-label", `${current?.enabled ? "暂停" : "启用"} ${titleOf(favorite)} 的${labels[targetKind]}计划`);
      toggle.title = current?.enabled ? "暂停计划，已开始的请求继续完成" : "启用此模型的计划";
    };
    toggle.refreshDisabled = () => row.update(row.plan); row.update(plan);
    return row;
  }
  function candyCard(favorite) {
    const root = node("article", "favorite-candy-card"), metric = node("div", "candy-metric"), ratio = node("strong", "candy-ratio"), summary = node("span", "help");
    const schedule = planControls(favorite), bars = node("div", "candy-bars"), foot = node("div", "favorite-card-foot"), date = node("span"), stateLabel = node("span");
    metric.append(node('span', 'metric-caption', '答案命中率'), ratio, summary); foot.append(date, stateLabel);
    bars.setAttribute("role", "group"); bars.setAttribute("aria-label", `${titleOf(favorite)} 的今日糖果计划`);
    const heading = cardHeading(favorite), exceptions = node("p", "exception-summary");
    root.usage = makeUsage(); root.append(heading, schedule, metric, exceptions, bars, root.usage, foot);
    return { root, heading, ratio, summary, schedule, bars, exceptions, foot, date, stateLabel, slots: new Map() };
  }
  function updateCandyCard(card, favorite, plan, slots, current) {
    const records = slots.map(slot => slot.run).filter(Boolean), match = records.filter(run => verdictOf(run) === "match").length, mismatch = records.filter(run => verdictOf(run) === "mismatch").length;
    const working = records.find(run => run.status === "running") || records.find(active) || current;
    const { root, ratio, summary, schedule, bars, date, stateLabel } = card;
    const empty = !favorite.available ? "模型不可用" : !plan ? "等待测试" : plan.migrationReason ? "待设置" : !plan.enabled ? "已暂停" : !slots.length ? "今日休息" : "等待测试";
    text(ratio, match + mismatch ? `${Math.round(match / (match + mismatch) * 100)}%` : working ? verdictLabel(working) : "—");
    ratio.className = "candy-ratio" + (!match && !mismatch && working ? " candy-progress-label" : "");
    text(summary, match + mismatch ? `${match} / ${match + mismatch} 个可判定结果` : working ? "" : empty); schedule.update(plan, favorite); card.heading.update(favorite);
    text(card.exceptions, `请求失败 ${records.filter(run => run.status === "error").length} · 中断 ${records.filter(run => run.status === "interrupted").length}`);
    const hourly = slots.length === 24 && slots.every((slot, index) => slot.label === `${String(index).padStart(2, "0")}:00`), now = Date.now();
    bars.dataset.empty = String(!slots.length); card.exceptions.dataset.empty = String(!records.length); card.foot.dataset.empty = String(!plan?.today && !records.length);
    for (const [key, entry] of card.slots) if (!slots.some(slot => slot.key === key)) { entry.bar.remove(); card.slots.delete(key); }
    for (const [index, slot] of slots.entries()) {
      let entry = card.slots.get(slot.key);
      if (!entry) {
        const bar = button("", () => { if (entry.slot.run) return openResultDetail(entry.slot.run.id, bar); status(entry.slot.labelText, false, "note"); }, "candy-bar");
        bar.append(node("span", "candy-slot"));
        entry = { bar }; card.slots.set(slot.key, entry);
        bar.addEventListener("keydown", event => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault(); const controls = [...bars.children], at = controls.indexOf(bar);
          const next = event.key === "Home" ? 0 : event.key === "End" ? controls.length - 1 : Math.max(0, Math.min(controls.length - 1, at + (event.key === "ArrowRight" ? 1 : -1)));
          controls[next]?.focus();
        });
      }
      entry.slot = slot; const { bar } = entry;
      const elapsed = now - Date.parse(slot.at);
      bar.dataset.verdict = slot.verdict; bar.dataset.current = String(hourly && elapsed >= 0 && elapsed < 3600000);
      bar.title = `${bar.dataset.current === "true" ? "当前时段 · " : ""}${slot.labelText}`; bar.setAttribute("aria-label", bar.title);
      if (bar.dataset.current === "true") bar.setAttribute("aria-current", "time"); else bar.removeAttribute("aria-current");
      if (bars.children[index] !== bar) bars.insertBefore(bar, bars.children[index] || null);
    }
    const latest = working || records.at(-1);
    text(date, plan?.today ? `${plan.today.date.slice(5)} · ${slots.length} 次` : ""); stateLabel.className = working ? "running-label" : "";
    text(stateLabel, working ? match + mismatch ? verdictLabel(working) : "" : plan && !plan.enabled ? "已暂停" : records.length ? `已结束 ${records.filter(run => !active(run)).length} / ${slots.length}` : "");
    root.latestRunId = latest?.id; renderUsage(root.usage, latest); root.usage.dataset.empty = String(!latest); root.dataset.available = String(favorite.available);
  }
  function progress(id) {
    const run = runs.get(id); if (!run) return;
    if (isVisible()) for (const { root } of candyCards.values()) if (root.latestRunId === id) renderUsage(root.usage, run);
  }
  function render() {
    if (!isVisible()) return;
    text($("favorite-count"), String(state.favorites.length));
    const providerControl = $("favorite-provider"), provider = providerControl.value;
    const providers = new Map(state.favorites.map(f => [f.provider, f.providerName || f.provider]));
    const providerSignature = JSON.stringify([...providers]);
    if (providerControl.dataset.options !== providerSignature) {
      providerControl.replaceChildren(); const all = node("option", "", "全部供应商"); all.value = ""; providerControl.append(all);
      for (const [id, name] of providers) { const option = node("option", "", name); option.value = id; providerControl.append(option); }
      providerControl.value = providers.has(provider) ? provider : ""; providerControl.dataset.options = providerSignature;
    }
    const favorites = filtered(), isCandy = kind === "candy", pages = Math.max(1, Math.ceil(favorites.length / 24)); page = Math.min(page, pages - 1);
    const visible = favorites.slice(page * 24, (page + 1) * 24), indexed = new Map(), working = new Map();
    for (const run of runs.values()) if (run.kind === kind && run.favoriteId) {
      if (active(run)) { const prior = working.get(run.favoriteId); if (!prior || prior.status !== "running" && run.status === "running" || prior.status === run.status && run.createdAt > prior.createdAt) working.set(run.favoriteId, run); }
      for (const ref of run.plans || []) if (ref.triggerKey) indexed.set(ref.triggerKey, run);
    }
    for (const key of Object.keys(labels)) $("favorite-" + key).setAttribute("aria-pressed", String(key === kind));
    $("gallery-navigation").hidden = isCandy;
    $('favorite-card-legend').hidden = !isCandy;
    $("favorite-candy-grid").hidden = !isCandy; $("favorite-results").hidden = isCandy; $("favorite-empty").hidden = favorites.length > 0;
    if (isCandy) {
      mount([]); for (const row of animationRows.values()) row.root.remove(); animationRows.clear();
      const container = $("favorite-candy-grid");
      for (const [id, cached] of candyCards) if (!visible.some(f => f.id === id)) { cached.root.remove(); candyCards.delete(id); }
      for (const [index, favorite] of visible.entries()) {
        const plan = planOf(favorite), slots = recordsFor(favorite, plan, indexed), current = working.get(favorite.id);
        let cached = candyCards.get(favorite.id);
        if (!cached) { cached = candyCard(favorite); candyCards.set(favorite.id, cached); }
        updateCandyCard(cached, favorite, plan, slots, current);
        if (cached.root.latestRunId) renderUsage(cached.root.usage, runs.get(cached.root.latestRunId));
        if (container.children[index] !== cached.root) container.insertBefore(cached.root, container.children[index] || null);
      }
    } else {
      for (const { root } of candyCards.values()) root.remove(); candyCards.clear();
      const container = $("favorite-results"), ids = [], targets = new Map();
      for (const [id, row] of animationRows) if (!visible.some(f => f.id === id)) { row.root.remove(); animationRows.delete(id); }
      for (const [index, favorite] of visible.entries()) {
        const plan = planOf(favorite), slots = recordsFor(favorite, plan, indexed).sort((first, second) =>
          Date.parse(second.at) - Date.parse(first.at) || second.label.localeCompare(first.label));
        const signature = JSON.stringify([favorite.modelId, favorite.modelName, favorite.providerName, plan?.id, plan?.today?.date, slots.map(s => [s.key, s.at])]);
        let row = animationRows.get(favorite.id);
        if (!row || row.signature !== signature) {
          row?.root.remove(); const root = node("section", "animation-row"), heading = node("div", "animation-model"), lane = node("div", "animation-lane");
          const schedule = planControls(favorite, plan); heading.append(cardHeading(favorite), schedule); lane.setAttribute("tabindex", "0"); lane.setAttribute("role", "region"); lane.setAttribute("aria-label", `${titleOf(favorite)} 的动画时间长廊`);
          root.append(heading, lane); row = { root, lane, schedule, signature, slots: new Map() }; animationRows.set(favorite.id, row); lane.addEventListener("scroll", updateGalleryButtons);
          for (const slot of slots) { const cell = node("div", "animation-slot"), time = node("div", "animation-time", slot.label), body = node("div", "animation-slot-body"); cell.append(time, body); lane.append(cell); row.slots.set(slot.key, { cell, body, placeholder: null }); }
          if (!slots.length) lane.append(node("p", "help animation-no-plan", !plan ? "暂无计划" : plan.migrationReason || "今日没有测试时刻"));
        }
        row.schedule.update(plan);
        for (const slot of slots) {
          const target = row.slots.get(slot.key);
          if (slot.run) { target.placeholder?.remove(); target.placeholder = null; ids.push(slot.run.id); targets.set(slot.run.id, target.body); }
          else {
            if (!target.placeholder) { target.placeholder = node("div", "animation-placeholder"); target.body.append(target.placeholder); }
            text(target.placeholder, phaseLabel[slot.state] || "待运行"); target.placeholder.title = slot.labelText; target.placeholder.dataset.state = slot.state;
          }
        }
        if (container.children[index] !== row.root) container.insertBefore(row.root, container.children[index] || null);
        const latest = animationTarget(slots);
        const latestKey = latest ? `${latest.key}:${latest.run?.id || ""}` : "";
        row.latestKey = latestKey; row.currentKey = latest?.key;
        if (row.scrolledKey !== latestKey) {
          requestAnimationFrame(() => {
            if (!isVisible() || kind !== "pelican" || animationRows.get(favorite.id) !== row || row.latestKey !== latestKey || row.scrolledKey === latestKey) return;
            row.lane.scrollLeft = currentPeriodLeft(row);
            row.scrolledKey = latestKey; updateGalleryButtons();
          });
        }
      }
      mount(ids, targets);
    }
    text($("favorite-page-info"), favorites.length ? `${favorites.length} 个模型 · ${page + 1} / ${pages}` : "");
    $("favorite-prev").disabled = page === 0; $("favorite-next").disabled = page >= pages - 1;
    requestAnimationFrame(updateGalleryButtons);
  }

  function currentPeriodLeft({ lane, slots, currentKey }) {
    const cell = slots.get(currentKey)?.cell, first = lane.firstElementChild;
    return cell && first ? Math.min(lane.scrollWidth - lane.clientWidth, cell.getBoundingClientRect().left - first.getBoundingClientRect().left) : 0;
  }
  function updateGalleryButtons() {
    if (!isVisible() || kind !== "pelican") return;
    const rows = [...animationRows.values()].filter(row => row.currentKey);
    const offsets = rows.map(row => row.lane.scrollLeft - currentPeriodLeft(row));
    const hasEarlier = offsets.some(offset => offset > 2), hasNewer = offsets.some(offset => offset < -2);
    const earlier = $("gallery-earlier"), newer = $("gallery-newer"), now = $("gallery-now");
    earlier.disabled = rows.every(({ lane }) => lane.scrollLeft >= lane.scrollWidth - lane.clientWidth - 2);
    newer.disabled = rows.every(({ lane }) => lane.scrollLeft <= 2);
    now.disabled = !rows.length;
    earlier.setAttribute("aria-pressed", String(hasEarlier && !hasNewer));
    newer.setAttribute("aria-pressed", String(hasNewer && !hasEarlier));
    now.setAttribute("aria-pressed", String(rows.length > 0 && !hasEarlier && !hasNewer));
  }

  function showJSON(group, type, origin, dispose) {
    const content = openDrawer("批次 JSON", origin, "reading", dispose), version = drawerVersion;
    const source = node("textarea", "source-view export-source");
    source.readOnly = true; source.spellcheck = false; source.setAttribute("aria-label", "批次 JSON 内容");
    const retry = button("重试读取", () => read(true)); retry.hidden = true;
    content.append(node("h3", "detail-name", `${group.date} · ${type}${group.source === "automatic" ? "每日批次" : "批次"}`),
      node("p", "help", `${group.modelIds.length} 个模型 · ${group.runs.length} 份结果`), source, retry);
    const copy = action("复制 JSON", async copyVersion => {
      try {
        await navigator.clipboard.writeText(source.value);
        if (copyVersion === drawerVersion) status("已复制 JSON", true, "success");
      } catch {
        if (copyVersion !== drawerVersion) return;
        source.focus({ preventScroll: true }); source.select(); status("请复制选中的 JSON", true, "note");
      }
    }, "primary");
    const download = action("下载 JSON", async saveVersion => {
      status("请选择 JSON 保存位置…", true, "note");
      const result = group.source === "automatic" ? await post("api/batches/save", { runIds: group.runs.map(run => run.id) })
        : await post(`api/batches/${encodeURIComponent(group.id)}/save`, {});
      if (saveVersion === drawerVersion) status(result.cancelled ? "已取消保存" : `已保存 JSON · ${result.path}`, true, result.cancelled ? "note" : "success");
    });
    copy.disabled = download.disabled = true;
    $("drawer-tools").append(copy);
    $("drawer-footer").append(button("关闭 JSON", closeDrawer), download);
    async function read(fromRetry = false) {
      retry.hidden = source.hidden = true;
      if (fromRetry) $("drawer-title").focus({ preventScroll: true });
      status("正在准备导出…", true, "note");
      try {
        const body = group.source === "automatic" ? await post("api/batches/export", { runIds: group.runs.map(run => run.id) })
          : await api(`api/batches/${encodeURIComponent(group.id)}/export`);
        if (version !== drawerVersion) return;
        source.value = JSON.stringify(body, null, 2); source.hidden = false; copy.disabled = download.disabled = false; status("", true);
      } catch (error) {
        if (version !== drawerVersion) return;
        retry.hidden = false; status(error.message, true);
      }
    }
    return read();
  }

  function addEditor() {
    const content = openDrawer("添加自动测试模型", $("favorite-add")), picked = new Set();
    const providers = [...new Map([...models.values()].map(m => [m.provider, m.providerName || m.provider]))];
    const provider = selectField("供应商", [["", "全部供应商"], ...providers], ""), search = field("模型", "search", ""); search.control.placeholder = "搜索模型";
    const list = node("div", "editor-model-list"); let shown = 60;
    const save = action("添加模型", async version => {
      const ids = [...picked];
      try { for (const modelId of ids) { await post("api/favorites/save", { modelId }); picked.delete(modelId); } }
      finally { await refresh(); if (version === drawerVersion) renderList(); }
      if (version === drawerVersion && !picked.size) closeDrawer(); render();
    }, "primary"); save.disabled = true;
    save.refreshDisabled = () => { save.disabled = !picked.size || pendingActions.has(save); text(save, `添加模型${picked.size ? ` · ${picked.size}` : ""}`); text($("drawer-footer").querySelector(".help"), `已选 ${picked.size} 个模型`); };
    function renderList() {
      const focusedId = list.contains(document.activeElement) ? document.activeElement?.dataset.modelId : null;
      list.replaceChildren(); const needle = search.control.value.toLowerCase().trim();
      const matches = [...models.values()].filter(m => (!provider.control.value || m.provider === provider.control.value) && `${m.id} ${m.name}`.toLowerCase().includes(needle));
      for (const model of matches.slice(0, shown)) {
        const exists = state.favorites.some(f => f.modelId === model.id), item = check(`${modelLabel(model, false)}${provider.control.value ? "" : ` · ${model.providerName || model.provider}`}`, exists || picked.has(model.id), value => {
          if (value) picked.add(model.id); else picked.delete(model.id); save.refreshDisabled();
        }); item.control.disabled = exists; item.row.title = model.id;
        item.control.dataset.modelId = model.id;
        const names = item.row.querySelector('span'); names.className = 'model-text'; names.replaceChildren(node('strong', 'model-name', modelLabel(model, false)));
        if (!provider.control.value) names.append(node('small', 'model-provider', model.providerName || model.provider));
        if (exists) item.row.append(node("small", "added-badge", "已添加")); list.append(item.row);
      }
      if (matches.length > shown) list.append(button("显示更多", () => { shown += 60; renderList(); }, "quiet"));
      if (!matches.length) list.append(node("p", "help", "没有匹配模型"));
      if (focusedId) ([...list.querySelectorAll("input")].find(control => control.dataset.modelId === focusedId && !control.disabled) || search.control).focus({ preventScroll: true });
    }
    provider.control.addEventListener("change", () => { shown = 60; renderList(); }); search.control.addEventListener("input", () => { shown = 60; renderList(); });
    content.append(provider.row, search.row, list); footer(save, "已选 0 个模型"); renderList();
  }

  const parameterValues = favorite => ({ effort: favorite.effort || "", maxTokens: String(favorite.maxTokens ?? 64000),
    timeoutSeconds: favorite.timeoutSeconds ?? String((favorite.timeoutMs ?? 600000) / 1000), prompt: favorite.prompt || "" });
  const numericError = (value, label) => !String(value).trim() || !Number.isSafeInteger(Number(value)) || Number(value) < 0
    ? `${label}需为非负整数，0 表示不设上限` : '';
  const timeoutError = value => numericError(value, "生成超时") || (Number(value) > 2147483 ? "生成超时最多 2147483 秒，0 表示不设超时" : "");
  const parameterError = value => value.prompt.length > 12000 ? "提示词最多 12000 个字符" : numericError(value.maxTokens, "输出上限") || timeoutError(value.timeoutSeconds);
  const parameterPatch = value => ({ effort: value.effort, maxTokens: Number(value.maxTokens), timeoutMs: Number(value.timeoutSeconds) * 1000, prompt: value.prompt });
  const parametersChanged = (first, second) => JSON.stringify(parameterValues(first)) !== JSON.stringify(parameterValues(second));

  function manageEditor(draft) {
    draft ||= { favorites: structuredClone(state.favorites), baseline: structuredClone(state.favorites), concurrency: String(state.concurrency), initialConcurrency: state.concurrency, parameterInputs: {}, shown: 30, scrollTop: 0 };
    const content = openDrawer("管理自动测试模型", $("favorite-manage")), list = node("div", "manager-list");
    const limit = field("自动请求并行数", "number", draft.concurrency); limit.control.min = "0"; limit.control.setAttribute("aria-label", "自动请求并行数");
    const section = node("section", "compact-limit"), caption = node("div"); caption.append(node("h3", "", "并行设置"), node("p", "help", "0 = 不设并行上限")); section.append(caption, limit.row);
    content.append(node("p", "help", "编辑或移除后，点击保存设置统一生效。"), list, section);
    const removed = () => draft.baseline.filter(favorite => !draft.favorites.some(current => current.id === favorite.id));
    const edited = () => draft.favorites.filter(favorite => parametersChanged(favorite, draft.baseline.find(current => current.id === favorite.id)));
    const invalidParameters = () => draft.favorites.some(favorite => draft.parameterInputs[favorite.id] && parameterError(draft.parameterInputs[favorite.id]));
    const save = action("保存设置", async version => {
      if (!validate()) return;
      await post("api/favorites/manage", { edits: edited().map(favorite => ({ id: favorite.id, modelId: favorite.modelId, ...parameterPatch(parameterValues(favorite)) })),
        removeIds: removed().map(favorite => favorite.id), concurrency: Number(limit.control.value) });
      await refresh(); if (version === drawerVersion) { closeDrawer(); status("设置已保存", false, "success"); }
    }, "primary", true, true); footer(save);
    function validate() {
      draft.concurrency = limit.control.value;
      const count = Number(draft.concurrency), message = numericError(draft.concurrency, "并行数");
      fieldError(limit, message);
      const invalid = invalidParameters(), dirty = removed().length || edited().length || count !== draft.initialConcurrency;
      save.disabled = Boolean(message) || invalid || !dirty || pendingActions.has(save);
      text($("drawer-footer").querySelector(".help"), invalid ? "有模型参数待修正" : dirty ? "有未保存修改" : "");
      return !message && !invalid;
    }
    function renderList() {
      list.replaceChildren();
      for (const favorite of draft.favorites.slice(0, draft.shown)) {
        const row = node("div", "editor-list-row"), names = node("div", "card-model");
        const invalid = draft.parameterInputs[favorite.id] && parameterError(draft.parameterInputs[favorite.id]);
        const modelTitle = node("h3", "", titleOf(favorite)); modelTitle.title = `${titleOf(favorite)}\n${favorite.modelId}`;
        names.append(modelTitle, node("p", "card-provider", `${favorite.providerName || favorite.provider}${invalid ? " · 参数待修正" : parametersChanged(favorite, draft.baseline.find(current => current.id === favorite.id)) ? " · 已编辑" : ""}`));
        const edit = button("编辑", () => {
          draft.concurrency = limit.control.value; draft.scrollTop = list.scrollTop;
          editFavorite(favorite, { label: "模型管理", values: draft.parameterInputs[favorite.id], onReturn: values => {
            draft.parameterInputs[favorite.id] = values; if (!parameterError(values)) Object.assign(favorite, parameterPatch(values)); manageEditor(draft);
          } });
        }, ""); edit.setAttribute("aria-label", `编辑 ${titleOf(favorite)}`);
        const remove = button("移除模型", async () => {
          const version = drawerVersion;
          if (!await confirmAction("移除模型", `保存设置后会移除 ${titleOf(favorite)} 的自动计划，已生成的结果仍保留。`, "移除模型")) return;
          if (version !== drawerVersion) return;
          draft.favorites = draft.favorites.filter(current => current.id !== favorite.id); delete draft.parameterInputs[favorite.id]; renderList(); validate(); $("drawer-title").focus();
        }, "history-delete"); remove.setAttribute("aria-label", `移除模型 ${titleOf(favorite)}`);
        row.append(names, edit, remove); list.append(row);
      }
      if (draft.favorites.length > draft.shown) list.append(button("显示更多", () => { draft.shown += 30; renderList(); }, "quiet"));
      if (!draft.favorites.length) list.append(node("p", "help", "暂无模型，可取消后返回添加。"));
      list.scrollTop = draft.scrollTop;
    }
    save.refreshDisabled = validate; limit.control.addEventListener("input", validate); renderList(); validate();
  }

  function editFavorite(favorite, parent) {
    const content = openDrawer("模型参数"), model = models.get(favorite.modelId);
    const values = parent.values || parameterValues(favorite);
    content.append(node("h3", "detail-name", titleOf(favorite)), node("p", "help", favorite.providerName || favorite.provider));
    const effort = selectField("思考档位", [["", "默认"], ...new Set([...(model?.efforts || []), ...(values.effort ? [values.effort] : [])])].map(value => Array.isArray(value) ? value : [value, value]), values.effort);
    const tokens = field("输出上限 · Token", "number", values.maxTokens); tokens.control.min = "0";
    const timeout = field("生成超时 · 秒", "number", values.timeoutSeconds); timeout.control.min = "0"; timeout.control.max = "2147483";
    const fields = node("div", "editor-columns"); fields.append(tokens.row, timeout.row); content.append(effort.row, fields);
    const hint = node("p", "help", "输出上限或生成超时填 0 = 不设对应上限"); hint.title = "实际仍受模型、供应商和网关限制"; content.append(hint);
    const prompt = field("动画提示词", "textarea", values.prompt); prompt.control.rows = 5; prompt.control.maxLength = 12000; content.append(prompt.row);
    const read = () => ({ effort: effort.control.value, maxTokens: tokens.control.value, timeoutSeconds: timeout.control.value, prompt: prompt.control.value });
    const returnToParent = () => parent.onReturn(read());
    const done = button("完成编辑", returnToParent, "primary"); back(`返回${parent.label}`, returnToParent); footer(done, "返回后由上一级统一保存", `返回${parent.label}`, returnToParent);
    function validate() { const current = read(), message = parameterError(current); fieldError(tokens, numericError(current.maxTokens, "输出上限")); fieldError(timeout, timeoutError(current.timeoutSeconds)); fieldError(prompt, current.prompt.length > 12000 ? "提示词最多 12000 个字符" : ""); done.disabled = Boolean(message) || JSON.stringify(current) === JSON.stringify(values); }
    for (const item of [effort, tokens, timeout, prompt]) item.control.addEventListener("input", validate);
    validate();
  }

  function planEditor(favorite, origin) {
    const targetKind = kind, plan = planOf(favorite), baseline = { ...favorite };
    const form = { mode: plan?.mode || "times", times: (plan?.times || ["09:00", "12:30", "18:00"]).join(", "), interval: String(plan?.intervalMinutes || 60), start: plan?.start || "09:00", end: plan?.end || "18:00", allDay: Boolean(plan?.allDay), days: [...(plan?.days || [1, 2, 3, 4, 5])].sort(), zone: plan?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone, enabled: Boolean(plan?.enabled) };
    const content = openDrawer(`${labels[targetKind]}计划`, origin);
    content.append(node("h3", "detail-name", titleOf(favorite)), node("p", "help", favorite.providerName || favorite.provider));
    if (plan?.migrationReason) content.append(node("p", "form-error", plan.migrationReason));
    const mode = selectField("执行方式", [["times", "指定时刻"], ["interval", "固定间隔"]], form.mode);
    const times = field("每天这些时刻 · 逗号分隔", "text", form.times);
    times.control.placeholder = "09:00, 12:30, 18:00";
    const interval = field("间隔 · 分钟", "number", form.interval), start = field("开始时间", "time", form.start), end = field("结束时间", "time", form.end);
    const intervalBox = node("div", "editor-section"), window = node("div", "editor-columns"); window.append(start.row, end.row);
    const allDay = check("全天", form.allDay), counter = node("p", "schedule-capacity"); counter.setAttribute("role", "status");
    intervalBox.append(interval.row, allDay.row, window); content.append(mode.row, times.row, intervalBox, counter);
    const weekdays = new Set(form.days), days = node("div", "weekday-picker"), dayChecks = new Map(), shortcuts = node("div", "editor-shortcuts"), shortcutButtons = [];
    for (const [label, values] of [["每天", [0, 1, 2, 3, 4, 5, 6]], ["工作日", [1, 2, 3, 4, 5]], ["周末", [0, 6]]]) {
      const pick = button(label, () => {
      weekdays.clear(); for (const day of values) weekdays.add(day); for (const [day, control] of dayChecks) control.checked = weekdays.has(day); validate();
      }, "quiet"); shortcuts.append(pick); shortcutButtons.push([pick, values.join("")]);
    }
    for (const day of [1, 2, 3, 4, 5, 6, 0]) { const pick = check("日一二三四五六"[day], weekdays.has(day), value => { if (value) weekdays.add(day); else weekdays.delete(day); validate(); }); pick.control.setAttribute("aria-label", `星期${"日一二三四五六"[day]}`); dayChecks.set(day, pick.control); days.append(pick.row); }
    const dayError = node("p", "inline-error"); dayError.hidden = true; content.append(node("p", "help", "重复日期"), shortcuts, days, dayError);
    const zone = field("时区", "text", form.zone);
    const extra = node("details", "editor-details"); extra.append(node("summary", "", "时区与运行说明"), zone.row,
      node("p", "help", "到点测试，满额排队。需保持插件运行，错过不补跑。"), node("p", "help", "跨午夜按开始日计算；结束后不再启动排队任务。")); content.append(extra);
    const enable = check("启用此模型的计划", form.enabled); content.append(enable.row);
    const readForm = () => ({ mode: mode.control.value, times: times.control.value, interval: interval.control.value, start: start.control.value, end: end.control.value, allDay: allDay.control.checked, days: [...weekdays].sort(), zone: zone.control.value, enabled: enable.control.checked });
    const parameters = node("section", "plan-parameters"), values = parameterValues(favorite);
    const effort = selectField("思考档位", [["", "默认"], ...new Set([...(models.get(favorite.modelId)?.efforts || []), ...(values.effort ? [values.effort] : [])])].map(value => Array.isArray(value) ? value : [value, value]), values.effort);
    const tokens = field("输出上限 · Token", "number", values.maxTokens); tokens.control.min = "0";
    const timeout = field("生成超时 · 秒", "number", values.timeoutSeconds); timeout.control.min = "0"; timeout.control.max = "2147483";
    const parameterFields = node("div", "editor-columns"); parameterFields.append(tokens.row, timeout.row);
    const prompt = field("动画提示词", "textarea", values.prompt); prompt.control.rows = 3; prompt.control.maxLength = 12000;
    parameters.append(node("h3", "", "模型参数"), effort.row, parameterFields, node("p", "help", "输出上限或生成超时填 0 = 不设对应上限"));
    if (targetKind === 'pelican') parameters.append(prompt.row);
    content.append(parameters);
    const readParameters = () => ({ effort: effort.control.value, maxTokens: tokens.control.value, timeoutSeconds: timeout.control.value, prompt: prompt.control.value });
    const save = action("保存计划", async version => {
      if (!validate()) return;
      await post("api/schedules/save", { ...(plan ? { id: plan.id } : {}), name: `${titleOf(favorite)} · ${labels[targetKind]}`.slice(0, 80), favoriteIds: [favorite.id], kinds: [targetKind],
        ...(parametersChanged(readParameters(), baseline) ? { parameters: parameterPatch(readParameters()) } : {}),
        mode: mode.control.value, times: mode.control.value === "times" ? readTimes() : plan?.times || ["09:00"],
        ...(mode.control.value === "interval" ? { intervalMinutes: Number(interval.control.value), allDay: allDay.control.checked,
          ...(allDay.control.checked ? {} : { start: start.control.value, end: end.control.value }) } : {}),
        days: [...weekdays], timeZone: zone.control.value.trim(), enabled: enable.control.checked });
      await refresh(); if (version === drawerVersion) { closeDrawer(); status("计划已保存", false, "success"); }
    }, "primary", true, true);
    footer(save);
    if (plan) {
      const removal = action("删除计划", async version => {
        if (!await confirmAction("删除计划", `取消 ${titleOf(favorite)} 之后的${labels[targetKind]}计划，已生成的结果仍保留。`, "删除计划")) return;
        if (version !== drawerVersion) return;
        await post("api/schedules/remove", { id: plan.id }); await refresh(); if (version === drawerVersion) closeDrawer();
      }, "history-delete plan-delete"); $('drawer-footer').prepend(removal);
    }
    const readTimes = () => [...new Set(times.control.value.split(/[,，;；\s]+/).filter(Boolean))].sort();
    function validate() {
      const byTimes = mode.control.value === "times", cap = state.maxDailySlots || 24;
      times.row.hidden = !byTimes; intervalBox.hidden = byTimes; window.hidden = allDay.control.checked;
      let count = 0, message = "", duration = 0;
      for (const item of [times, interval, start, end, zone]) fieldError(item, "");
      const validClock = value => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value), minute = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
      if (byTimes) { const values = readTimes(); count = values.length; if (!count || values.some(value => !validClock(value))) { message = "请输入 HH:mm 格式的时刻"; fieldError(times, message); } }
      else {
        const step = Number(interval.control.value), begin = minute(start.control.value), finish = minute(end.control.value);
        duration = allDay.control.checked ? 1440 : finish > begin ? finish - begin : 1440 - begin + finish;
        if (!interval.control.value.trim() || !Number.isSafeInteger(step) || step < 1) { message = "间隔需为正整数"; fieldError(interval, message); }
        else if (!allDay.control.checked && (!validClock(start.control.value) || !validClock(end.control.value) || begin === finish)) { message = "请设置不同的开始和结束时间"; fieldError(start, message); fieldError(end, message); }
        else count = Math.ceil(duration / step);
      }
      if (!message && count > cap) { message = `每天 ${count} 次，最多 ${cap} 次${duration ? `；间隔至少 ${Math.ceil(duration / cap)} 分钟` : ""}`; fieldError(byTimes ? times : interval, message); }
      text(dayError, weekdays.size ? "" : "请选择重复日期"); dayError.hidden = Boolean(weekdays.size); if (!weekdays.size) message ||= "请选择重复日期";
      const dateSignature = [...weekdays].sort().join(""); for (const [control, signature] of shortcutButtons) control.setAttribute("aria-pressed", String(signature === dateSignature));
      try { if (!zone.control.value.trim()) throw new Error(); new Intl.DateTimeFormat("en", { timeZone: zone.control.value.trim() }); } catch { const zoneMessage = "请输入有效时区，如 Asia/Shanghai"; fieldError(zone, zoneMessage); message ||= zoneMessage; }
      const currentParameters = readParameters(), invalidParameter = parameterError(currentParameters);
      fieldError(tokens, numericError(currentParameters.maxTokens, "输出上限")); fieldError(timeout, timeoutError(currentParameters.timeoutSeconds)); fieldError(prompt, currentParameters.prompt.length > 12000 ? "提示词最多 12000 个字符" : ""); message ||= invalidParameter;
      const dirty = !plan || parametersChanged(currentParameters, baseline) || JSON.stringify(readForm()) !== JSON.stringify(form);
      save.disabled = Boolean(message) || !dirty || pendingActions.has(save); counter.dataset.invalid = String(Boolean(message)); text(counter, message || `每天 ${count} 次 / 最多 ${cap} 次`);
      text($("drawer-footer").querySelector(".help"), dirty ? "有未保存修改" : ""); return !message;
    }
    save.refreshDisabled = validate;
    for (const item of [mode, times, interval, start, end, zone, effort, tokens, timeout, prompt]) { item.control.addEventListener("input", validate); item.control.addEventListener("change", validate); }
    allDay.control.addEventListener("change", validate); enable.control.addEventListener("change", validate); validate();
  }

  for (const id of ["favorite-add", "favorite-empty-add"]) $(id).addEventListener("click", addEditor);
  $("favorite-manage").addEventListener("click", () => manageEditor());
  for (const [id, direction] of [["gallery-earlier", 1], ["gallery-newer", -1]]) $(id).addEventListener("click", () => {
    const behavior = matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
    for (const { lane } of animationRows.values()) lane.scrollBy({ left: direction * Math.max(250, lane.clientWidth * .75), behavior });
  });
  $("gallery-now").addEventListener("click", () => {
    for (const row of animationRows.values()) { row.lane.scrollLeft = currentPeriodLeft(row); row.scrolledKey = row.latestKey; }
    updateGalleryButtons();
  });
  for (const key of Object.keys(labels)) $("favorite-" + key).addEventListener("click", () => { if (kind === key) return; kind = key; page = 0; $("favorite-scroll").scrollTop = 0; rememberView({ view: "favorites", automatic: kind }); status(""); render(); });
  $("favorite-provider").addEventListener("change", () => { page = 0; $("favorite-scroll").scrollTop = 0; render(); });
  for (const [id, direction] of [["favorite-prev", -1], ["favorite-next", 1]]) $(id).addEventListener("click", () => { page = Math.max(0, page + direction); $("favorite-scroll").scrollTop = 0; render(); });
  setInterval(() => { if (isVisible()) refresh(); }, 60000);
  return {
    init(boot) {
      supported = boot.favoritesAvailable === true; if (boot.favorites) state = boot.favorites;
      for (const id of ["favorite-add", "favorite-empty-add", "favorite-manage"]) $(id).disabled = !supported;
      if (!supported) status("重新开启插件以加载自动测试功能", false, "note"); render();
    },
    render, refresh, openDrawer, closeDrawer, progress, showJSON,
    resetAnimationPosition() {
      for (const row of animationRows.values()) row.scrolledKey = "";
    },
    async addSelected(picks, settings) {
      if (!supported) throw new Error("重新开启插件以加载自动测试功能");
      for (const [modelId, effort] of picks) await post("api/favorites/save", { modelId, effort, ...settings });
      await refresh();
    },
  };
};
