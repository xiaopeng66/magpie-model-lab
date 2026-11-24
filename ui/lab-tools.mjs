import { generationTimeoutFromSeconds } from '../lib/test-parameters.mjs';
import { accountLabel } from '../lib/targets.mjs';

export function createLabTools({ document, $, api, settingsUI, openDrawer, closeDrawer, confirmAction, models, records, filteredIds, readFilters, setFilters, onUpdated }) {
  let capabilities = {}, generation = 0;
  const node = (tag, value, className = '') => { const out = document.createElement(tag); out.className = className; if (value !== undefined) out.textContent = value; return out; };
  const button = (value, action, className = '') => { const out = node('button', value, className); out.type = 'button'; out.addEventListener('click', action); return out; };
  const field = (parent, label, value = '', type = 'text') => { const row = node('label', undefined, 'editor-field'), input = node('input'); input.type = type; input.value = String(value ?? ''); input.setAttribute('aria-label', label); if (type === 'number') { input.min = '0'; input.step = '1'; } row.append(node('span', label), input); parent.append(row); return input; };
  const select = (parent, label, options, value = '') => { const row = node('label', undefined, 'editor-field'), input = node('select'); input.setAttribute('aria-label', label); for (const [key, text] of options) { const item = node('option', text); item.value = key; input.append(item); } input.value = value; row.append(node('span', label), input); parent.append(row); return input; };
  const check = (parent, label, value = false) => { const row = node('label', undefined, 'check-row'), input = node('input'); input.type = 'checkbox'; input.checked = value; input.setAttribute('aria-label', label); row.append(input, node('span', label)); parent.append(row); return input; };
  const section = (parent, title) => { const root = node('section', undefined, 'phase-tool-section'); root.append(node('h3', title)); const body = node('div', undefined, 'phase-form-body'); root.append(body); parent.append(root); return body; };
  const columns = parent => { const grid = node('div', undefined, 'phase-form-grid'); parent.append(grid); return grid; };
  const status = parent => { const value = node('p', '', 'help'); value.setAttribute('role', 'status'); parent.append(value); return value; };
  const integer = (input, label) => { const value = Number(input.value); if (!input.value.trim() || !Number.isSafeInteger(value) || value < 0) { input.setAttribute('aria-invalid', 'true'); input.focus(); throw new Error(`${label}需为非负整数`); } input.removeAttribute('aria-invalid'); return value; };
  const dateValue = input => {
    if (!input.value) return undefined;
    const date = new Date(input.value + 'T00:00:00'), parts = input.value.split('-').map(Number);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.value) || !Number.isFinite(date.getTime()) || date.getFullYear() !== parts[0] || date.getMonth() + 1 !== parts[1] || date.getDate() !== parts[2]) { input.setAttribute('aria-invalid', 'true'); input.focus(); throw Error('筛选日期无效，请重新选择'); }
    input.removeAttribute('aria-invalid'); return date.toISOString();
  };
  const dateDisplay = value => {
    if (!value) return '';
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` : '';
  };
  const post = (path, value) => api(path, { method: 'POST', body: JSON.stringify(value) });
  const opening = (title, origin, mode = 'compact') => { const content = openDrawer(title, origin, mode, () => { generation++; }), version = ++generation; content.classList.add('phase-tool-content'); $('drawer-footer').append(button('关闭', closeDrawer, 'quiet')); return { version, content, alive: () => version === generation }; };

  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const providerName = id => models().find(model => model.provider === id)?.providerName || id;
  const intervalValue = (input, label) => {
    try { const value = generationTimeoutFromSeconds(input.value); input.removeAttribute('aria-invalid'); return value; }
    catch (error) { input.setAttribute('aria-invalid', 'true'); input.focus(); throw Error(error.message.replace('生成超时', label).replace('不设超时', '无启动间隔')); }
  };
  const intervalField = (host, label, value) => { const input = field(host, label, value / 1000, 'number'); input.step = '0.001'; input.max = '2147483.647'; return input; };

  function requestPolicySettings(content, afterSave) {
    const fallback = { providerConcurrency: 0, accountConcurrency: 0, minIntervalMs: 0, providers: {}, accounts: {} };
    const snapshot = () => settingsUI.snapshot().queue || fallback;
    const defaults = value => ({ providerConcurrency: value.providerConcurrency, accountConcurrency: value.accountConcurrency, minIntervalMs: value.minIntervalMs });
    const writable = value => ({ ...defaults(value), providers: structuredClone(value.providers || {}), accounts: structuredClone(value.accounts || {}) });
    const ruleFor = (value, group, key) => Object.hasOwn(value[group] || {}, key) ? value[group][key] : undefined;
    let base = structuredClone(snapshot()), busy = false, editor = null, openingRevision = 0;
    const body = section(content, '默认请求限制');
    body.append(node('p', '同时作用于本插件的手动批次和自动计划。每批并行数仍在测试设置中调整。', 'help'));
    const grid = columns(body);
    const first = field(grid, '供应商并行上限', base.providerConcurrency, 'number');
    const second = field(grid, '固定账号并行上限', base.accountConcurrency, 'number');
    const third = intervalField(grid, '请求间隔 · 秒', base.minIntervalMs);
    third.parentElement.classList.add('phase-form-wide');
    body.append(node('p', '并行上限按每个供应商、每个固定账号分别计算；间隔限制相邻请求的启动时间。0 表示不额外限制。', 'help'));
    const defaultActions = node('div', undefined, 'phase-settings-actions'), defaultFeedback = status(body);
    const saveDefaults = button('保存默认限制', () => persist(async current => {
      const value = { providerConcurrency: integer(first, '供应商并行上限'), accountConcurrency: integer(second, '固定账号并行上限'), minIntervalMs: intervalValue(third, '请求间隔') };
      if (!same(defaults(current), defaults(base)) && !same(defaults(current), value)) throw Error('默认设置已被其他页面修改；输入已保留，请重新打开并核对');
      return { ...writable(current), ...value };
    }, defaultFeedback, () => { base = structuredClone(snapshot()); ruleFeedback.textContent = ''; defaultFeedback.textContent = '默认限制已保存，接下来发出的请求使用这些限制。'; }), 'primary');
    defaultActions.append(saveDefaults); body.append(defaultActions);
    for (const input of [first, second, third]) input.addEventListener('input', () => { input.removeAttribute('aria-invalid'); defaultFeedback.textContent = '默认设置有未保存修改'; });

    const ruleBody = section(content, '供应商与账号规则'), list = node('div', undefined, 'phase-rule-list'), ruleActions = node('div', undefined, 'phase-settings-actions'), editorHost = node('div', undefined, 'phase-rule-editor-host'), ruleFeedback = status(ruleBody);
    ruleBody.append(node('p', '单独规则替代该对象的默认限制；0 可取消对应限制。删除规则后恢复默认值。', 'help'));
    const addProvider = button('新增供应商规则', () => startEditor('providers')), addAccount = button('新增账号规则', () => startEditor('accounts'));
    ruleActions.append(addProvider, addAccount); ruleBody.append(list, ruleActions, editorHost, ruleFeedback);
    content.insertBefore(ruleBody.parentElement, body.parentElement);
    const accountNames = new Map();
    const identity = (group, key) => {
      if (group === 'providers') return `供应商 · ${providerName(key)}`;
      const [provider, account] = JSON.parse(key); return `固定账号 · ${providerName(provider)} · ${accountNames.get(key) || accountLabel({ mode: 'pinned', id: account })}`;
    };
    function lock(value) {
      busy = value;
      for (const host of [body, ruleBody]) for (const tag of ['button', 'input', 'select']) for (const control of host.querySelectorAll(tag)) control.disabled = busy;
      addProvider.disabled = addAccount.disabled = busy || !models().length;
      editor?.updateControls();
    }
    async function persist(makeValue, feedback, acknowledge) {
      if (busy || !content.isConnected) return; lock(true); feedback.textContent = '正在保存…';
      try {
        await settingsUI.refresh(); if (!content.isConnected) return;
        const value = await makeValue(snapshot()); if (!value || !content.isConnected) { feedback.textContent = ''; return; }
        const result = await settingsUI.savePatch({ queue: value }); if (!content.isConnected) return;
        if (result.state !== 'saved') { feedback.textContent = result.message || '保存尚未确认，输入已保留；请稍后核对再保存。'; return; }
        acknowledge(); render(); afterSave?.();
      } catch (error) { if (content.isConnected) feedback.textContent = `${error.message}；输入已保留。`; }
      finally { if (content.isConnected) lock(false); }
    }
    function render() {
      list.replaceChildren();
      for (const group of ['providers', 'accounts']) for (const [key, rule] of Object.entries(snapshot()[group] || {})) {
        const row = node('div', undefined, 'phase-rule-row'), title = identity(group, key), text = node('div', undefined, 'phase-rule-identity');
        const name = node('span', title, 'phase-rule-name'); name.title = title;
        text.append(name, node('span', `并行 ${rule.concurrency || '不限'} · ${rule.intervalMs ? '启动间隔 ' + rule.intervalMs / 1000 + ' 秒' : '无启动间隔'}`, 'help'));
        const actions = node('div', undefined, 'phase-settings-actions phase-rule-actions'), edit = button('编辑规则', () => startEditor(group, key)), remove = button('删除规则', () => {
          const expected = structuredClone(rule);
          return persist(async current => {
            const existing = ruleFor(current, group, key);
            if (!same(existing, expected) && existing !== undefined) throw Error('此规则已被其他页面修改，请重新打开并核对');
            if (!await confirmAction('删除规则', `${title}。删除后恢复默认请求限制。`, '确认删除')) return null;
            const value = writable(current); delete value[group][key]; return value;
          }, ruleFeedback, () => { if (editor?.group === group && editor.key === key) { editorHost.replaceChildren(); editor = null; } ruleFeedback.textContent = '规则已删除。'; });
        }, 'danger');
        edit.setAttribute('aria-label', `编辑规则：${title}`); remove.setAttribute('aria-label', `删除规则：${title}`); actions.append(edit, remove); row.append(text, actions); list.append(row);
      }
      if (!list.children.length) list.append(node('p', '还没有单独规则，所有对象使用下方默认限制。', 'help'));
    }
    async function startEditor(group, key = '') {
      if (busy) return; const revision = ++openingRevision;
      if (editor?.dirty && !await confirmAction('切换规则', '当前规则有未保存修改，是否放弃并切换？', '放弃并切换')) return;
      if (!content.isConnected || revision !== openingRevision) return;
      const initial = structuredClone(snapshot()), rule = key ? ruleFor(initial, group, key) : null;
      if (key && !rule) { ruleFeedback.textContent = '此规则已不存在，请重新打开设置。'; return; }
      editorHost.replaceChildren(); const form = node('div', undefined, 'phase-rule-editor phase-form-body'); editorHost.append(form);
      const current = editor = { group, key, dirty: false, updateControls() {} };
      form.append(node('h4', `${key ? '编辑' : '新增'}${group === 'providers' ? '供应商' : '账号'}规则`));
      const providers = [...new Map(models().map(model => [model.provider, model.providerName || model.provider])).entries()], targetProvider = key ? group === 'providers' ? key : JSON.parse(key)[0] : '';
      const provider = key ? null : select(form, '规则供应商', providers, providers[0]?.[0] || '');
      if (key) form.append(node('p', identity(group, key), 'phase-rule-name'));
      const account = group === 'accounts' && !key ? select(form, '规则账号', [['', '请选择账号']], '') : null, accountHint = account ? status(form) : null;
      const inputs = columns(form), a = field(inputs, '单独并行数', rule?.concurrency || 0, 'number');
      const b = intervalField(inputs, '单独间隔 · 秒', rule?.intervalMs || 0);
      form.append(node('p', '0 表示取消此对象的对应限制。', 'help'));
      const feedback = status(form), actions = node('div', undefined, 'phase-settings-actions'); let loading = Boolean(account), loaded = !account, loadRevision = 0;
      const changed = event => { current.dirty = true; event?.target?.removeAttribute('aria-invalid'); feedback.textContent = '规则有未保存修改'; };
      const save = button('保存规则', () => persist(currentPolicy => {
        const id = targetProvider || provider.value;
        if (!id || account && (!loaded || !account.value)) throw Error('请选择供应商与可选择的账号');
        const target = key || (group === 'providers' ? id : JSON.stringify([id, account.value]));
        if (!key && Object.hasOwn(initial[group], target)) throw Error('此对象已有规则，请使用列表中的编辑按钮');
        const first = integer(a, '单独并行数'), second = intervalValue(b, '单独间隔');
        const value = { concurrency: first, intervalMs: second };
        const existing = ruleFor(currentPolicy, group, target);
        if (!same(existing, rule || undefined) && !same(existing, value)) throw Error('此规则已被其他页面修改或删除，请重新打开并核对');
        const next = writable(currentPolicy); next[group] = { ...next[group], [target]: value }; return next;
      }, feedback, () => { editorHost.replaceChildren(); editor = null; ruleFeedback.textContent = '规则已保存，接下来发出的请求使用此规则。'; }), 'primary');
      const cancel = button('取消编辑', () => { if (busy) return; editorHost.replaceChildren(); editor = null; ruleFeedback.textContent = ''; });
      actions.append(save, cancel); form.append(actions);
      current.updateControls = () => { save.disabled = busy || loading || Boolean(account && (!loaded || !account.value)); if (account) account.disabled = busy || !loaded; };
      const load = async () => {
        if (!account) return; const revision = ++loadRevision; loading = true; loaded = false; account.replaceChildren(); const empty = node('option', '请选择账号'); empty.value = ''; account.append(empty); account.value = ''; account.title = ''; accountHint.textContent = '正在读取供应商账号…'; current.updateControls();
        try {
          const result = await api('api/accounts?provider=' + encodeURIComponent(provider.value)); if (editor !== current || revision !== loadRevision || !form.isConnected) return;
          if (result.capabilities?.pinned === false) { accountHint.textContent = result.capabilities.reason || '宿主未确认固定账号路由能力'; return; }
          for (const item of result.accounts || []) {
            if (item.enabled === false || item.available === false) continue;
            const label = accountLabel({ mode: 'pinned', id: item.id, name: item.name }), option = node('option', label); option.value = item.id; option.title = item.kind === 'key' ? label : `${item.name || item.id} · ${item.id}`; account.append(option); accountNames.set(JSON.stringify([provider.value, item.id]), label);
          }
          loaded = true; accountHint.textContent = [result.warning, account.children.length > 1 ? '仅对明确选择此账号的请求生效；自动分配不受账号规则限制。' : '当前供应商没有可选择的账号。'].filter(Boolean).join(' ');
        } catch (error) { if (editor === current && revision === loadRevision && form.isConnected) accountHint.textContent = error.message; }
        finally { if (editor === current && revision === loadRevision && form.isConnected) { loading = false; current.updateControls(); } }
      };
      provider?.addEventListener('change', event => { changed(event); return load(); });
      account?.addEventListener('change', event => { changed(event); const option = [...account.children].find(item => item.value === account.value); account.title = option?.title || ''; current.updateControls(); });
      for (const input of [a, b]) input.addEventListener('input', changed);
      ruleFeedback.textContent = ''; current.updateControls(); (provider || a).focus(); await load();
    }
    render(); lock(false);
  }

  function queueSettings(content) {
    requestPolicySettings(content, () => refresh());
    const body = section(content, '当前等待'), summary = node('div', undefined, 'phase-status-box'); summary.setAttribute('role', 'status'); body.append(summary);
    const refreshButton = button('刷新等待状态', refresh); body.append(refreshButton);
    async function refresh() {
      if (refreshButton.disabled || !body.isConnected) return; refreshButton.disabled = true;
      try {
        const value = await api('api/queue/status'); if (!body.isConnected) return; summary.replaceChildren();
        const labels = { concurrency: '等待本批并行空位', provider_limit: '等待供应商并行空位', account_limit: '等待账号并行空位', cooldown: '等待请求间隔或限流恢复', queue_storage: '本地等待状态不可写' };
        if (value.recoveryError) summary.append(node('p', value.recoveryError, 'form-error'));
        summary.append(node('p', value.queued?.length || value.cooldowns?.length ? `${value.queued?.length || 0} 个请求排队${value.cooldowns?.length ? ` · ${value.cooldowns.length} 个目标等待限流恢复` : ''}` : '当前没有排队请求或限流等待。', 'help'));
        for (const item of (value.queued || []).slice(0, 100)) {
          const run = records().find(run => run.id === item.runId), account = run?.accountTarget;
          const target = [run?.modelName || run?.model || item.runId, accountLabel(account) || (account?.mode === 'auto' ? '自动分配' : '')].filter(Boolean).join(' · ');
          summary.append(node('p', `${target} · ${labels[item.reason] || item.reason}${item.until ? ' · ' + new Date(item.until).toLocaleString('zh-CN') : ''}`, 'help'));
        }
        if (value.queued?.length > 100) summary.append(node('p', '显示前 100 个等待请求。', 'help'));
        for (const cooling of value.cooldowns || []) {
          let label = cooling.scope;
          if (label.startsWith('provider:')) label = `供应商 · ${providerName(label.slice(9))}`;
          else if (label.startsWith('account:')) { try { const [provider, account] = JSON.parse(label.slice(8)); label = `固定账号 · ${providerName(provider)} · ${accountLabel(records().find(run => run.provider === provider && run.accountTarget?.id === account)?.accountTarget) || accountLabel({ mode: 'pinned', id: account })}`; } catch {} }
          summary.append(node('p', `${label} · 等待至 ${new Date(cooling.until).toLocaleString('zh-CN')}`, 'help'));
        }
        if (value.cooldowns?.length) summary.append(node('p', '收到 HTTP 429 后自动等待恢复，不自动重试已失败的请求。', 'help'));
      } catch (error) { if (body.isConnected) summary.textContent = error.message; }
      finally { if (body.isConnected) refreshButton.disabled = false; }
    }
    return refresh;
  }
  function usageSummary(content) {
    const body = section(content, '今日用量'), summary = node('div', undefined, 'phase-usage-summary'); summary.setAttribute('role', 'status'); body.append(summary);
    body.append(node('p', '统计本插件实际发出的请求，删除历史不会减少用量。Token 以接口返回值为准。', 'help'));
    const toolbar = node('div', undefined, 'phase-usage-toolbar'), date = node('p', '正在读取今日用量…', 'help'), refreshButton = button('刷新今日用量', refresh), feedback = status(body);
    toolbar.append(date, refreshButton); body.insertBefore(toolbar, summary); feedback.hidden = true;
    const format = value => value == null ? '—' : Number(value).toLocaleString('zh-CN');
    const compact = value => {
      if (value == null) return '未提供';
      for (const [scale, unit] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) if (value >= scale) return `${Number((value / scale).toFixed(2))}${unit}`;
      return format(value);
    };
    const usageRow = (label, value, account = false) => {
      const row = node('div', undefined, 'phase-usage-line' + (account ? ' phase-usage-account' : ''));
      const name = node('span', label, 'phase-usage-name'); name.title = label; row.append(name);
      for (const [label, count] of [['请求数', value.knownRequests], ['已知 Token', value.tokens]]) {
        const cell = node('div', undefined, 'phase-usage-value'); cell.append(node('span', label, 'help'), node('strong', format(count))); row.append(cell);
      }
      return row;
    };
    const accountName = (provider, id) => accountLabel(records().find(run => run.provider === provider && run.accountTarget?.id === id)?.accountTarget) || accountLabel({ mode: 'pinned', id });
    async function refresh() {
      if (refreshButton.disabled || !body.isConnected) return; refreshButton.disabled = true;
      try {
        const value = await api('api/usage'); if (!body.isConnected) return; if (!value) throw Error('当前服务未提供今日用量');
        summary.replaceChildren(); feedback.hidden = true; date.textContent = `${value.day} · 本机时区 ${value.timeZone}`;
        const metrics = node('div', undefined, 'phase-usage-grid');
        for (const [label, count] of [['今日请求', value.knownRequests], ['已知 Token', value.tokens], ['未返回 Token', value.unknownUsage || 0]]) { const metric = node('div', undefined, 'phase-usage-metric'); metric.append(node('span', label, 'help'), node('strong', format(count))); metrics.append(metric); }
        summary.append(metrics);
        const details = value.tokenDetails || {}, tokenLine = node('div', undefined, 'phase-usage-tokens'); tokenLine.setAttribute('aria-label', '今日 Token 明细');
        const fields = [['输入', details.input], ['输出', details.output], ['缓存读取', details.cacheRead]];
        if (details.cacheWriteRequests > 0) fields.push(['缓存写入', details.cacheWrite]);
        fields.push(['命中率', details.cacheHitRate]);
        for (const [label, count] of fields) {
          const item = node('span', undefined, 'phase-usage-token');
          const text = label === '命中率' ? count == null ? '未提供' : `${(count * 100).toFixed(2)}%` : compact(count);
          item.title = label === '命中率' ? '缓存读取 ÷ 含缓存输入，仅按有有效明细的请求计算' : `${label} ${count == null ? '未提供' : format(count) + ' Token'}${label === '输入' ? '（含缓存）' : ''}`;
          item.setAttribute('aria-label', label === '命中率' ? `${label} ${text}；${item.title}` : item.title);
          item.append(node('span', label), node('strong', text)); tokenLine.append(item);
        }
        summary.append(tokenLine);
        const coverage = details.cacheCoverageRequests || 0;
        if (value.knownRequests > 0) summary.append(node('p', `缓存明细覆盖 ${coverage}/${value.knownRequests} 次请求；输入含缓存，命中率按有效明细的 Token 数加权。`, 'help'));
        if (value.partial) summary.append(node('p', `今日统计从 ${new Date(value.coverageStartAt).toLocaleTimeString('zh-CN')} 开始，未覆盖此前的请求。`, 'help'));
        if (value.unknownUsage) summary.append(node('p', `${format(value.unknownUsage)} 次请求尚未提供完整 Token，已知 Token 只合计已返回的用量。`, 'help'));
        if (value.usageNeedsReview || value.possibleUnsent) summary.append(node('p', '部分请求的用量或发出状态需要核实，统计保留已观测值。', 'help'));
        summary.append(node('h4', '来源明细', 'phase-usage-heading'));
        const rows = node('div', undefined, 'phase-usage-list');
        for (const item of value.providers || []) {
          const row = node('div', undefined, 'phase-usage-row'), accounts = (value.accounts || []).filter(account => account.provider === item.provider);
          row.append(usageRow(providerName(item.provider), item));
          for (const account of accounts) row.append(usageRow(`固定账号 · ${accountName(item.provider, account.accountId)}`, account, true));
          const automaticRequests = item.knownRequests - accounts.reduce((sum, account) => sum + account.knownRequests, 0);
          if (automaticRequests > 0) {
            const known = (item.knownUsage ?? item.knownRequests - (item.unknownUsage || 0)) - accounts.reduce((sum, account) => sum + (account.knownUsage ?? account.knownRequests - (account.unknownUsage || 0)), 0);
            row.append(usageRow('自动分配', { knownRequests: automaticRequests, tokens: known ? Math.max(0, (item.tokens || 0) - accounts.reduce((sum, account) => sum + (account.tokens || 0), 0)) : null }, true));
          }
          rows.append(row);
        }
        if (!rows.children.length) rows.append(node('p', '今日暂无供应商请求。', 'help')); summary.append(rows);
        if (value.recoveryError) { feedback.textContent = value.recoveryError; feedback.hidden = false; }
      } catch (error) { if (body.isConnected) { feedback.textContent = `${error.message}；已保留上次统计，可重试。`; feedback.hidden = false; } }
      finally { if (body.isConnected) refreshButton.disabled = false; }
    }
    return refresh;
  }
  function configSettings(content) {
    const body = section(content, '转移模型与测试设置'), share = check(body, '导出时去除账号绑定，方便分享', true), feedback = status(body);
    body.append(node('p', '包含模型、常用参数和自动计划。分享时接收者需要重新选择账号；账号专属限制也会省略。', 'help'));
    body.append(node('p', '配置文件不包含历史记录、登录凭据或用量统计。', 'help'));
    const save = button('保存配置 JSON', async () => { save.disabled = true; try { const result = await post('api/config/save', { shareMode: share.checked }); feedback.textContent = result.cancelled ? '已取消保存' : `配置已保存 · ${result.path}`; } catch (error) { feedback.textContent = error.message; } finally { save.disabled = false; } });
    const actions = node('div', undefined, 'phase-settings-actions'); actions.append(save, button('从本地 JSON 导入', () => openConfigImport())); body.append(actions);
  }
  function openConfigImport() {
    const panel = opening('导入配置', $('local-settings')), body = panel.content, file = field(body, '选择配置 JSON · 最大 2 MiB', '', 'file'); file.accept = '.json,application/json';
    const choicesHost = node('div', undefined, 'phase-import-choices'), previewHost = node('div', undefined, 'phase-import-preview'), feedback = status(body); body.append(choicesHost, previewHost);
    let documentValue = null, choices = null, bindings = null, preview = null, readRevision = 0, choiceRevision = 0, previewRequest = 0;
    const invalidate = () => { choiceRevision++; preview = null; apply.disabled = true; previewHost.replaceChildren(); feedback.textContent = '选择已变化，请重新预览'; };
    const previewButton = button('预览配置差异', async () => {
      if (!documentValue) return; previewButton.disabled = true;
      const revision = choiceRevision, requestVersion = ++previewRequest, input = structuredClone({ document: documentValue, choices, bindings });
      try { const memory = await settingsUI.flush(); if (!panel.alive() || revision !== choiceRevision) return; if (memory.state !== 'saved') throw new Error('请先完成当前参数保存，再预览配置'); const result = await post('api/config/import/preview', input); if (!panel.alive() || revision !== choiceRevision) return; preview = result; previewHost.replaceChildren(); previewHost.append(node('p', `目标变化 ${preview.differences.length} 项 · ${preview.pausedPlanIds.length} 个受影响或新计划将暂停`, 'help')); for (const difference of preview.differences) previewHost.append(node('p', `${difference.sourceRef} · ${difference.action}`, 'help')); for (const issue of preview.unresolved) previewHost.append(node('p', `${issue.modelId || issue.sourceRef} · ${issue.reason || ({ binding: '需要选择账号绑定', fingerprint_binding: '需要选择旧指纹账号绑定', duplicate_target: '目标重复，请跳过其中一个', model_unavailable: '模型当前不可用', account_unavailable: '账号当前不可用' })[issue.code] || issue.code}`, 'form-error')); if (preview.retentionImpact) previewHost.append(node('p', `保留期限缩短为 ${preview.retentionImpact.days} 天；固定预览时点有 ${preview.retentionImpact.candidateCount} 条到期候选。保存后未来到期记录也适用。`, 'help')); apply.disabled = !preview.token; feedback.textContent = preview.token ? '差异已预览，5 分钟内可确认应用' : '请解决上述绑定或目标问题，再次预览'; }
      catch (error) { if (!panel.alive() || revision !== choiceRevision) return; feedback.textContent = error.message; preview = null; apply.disabled = true; }
      finally { if (panel.alive() && requestVersion === previewRequest) previewButton.disabled = !documentValue; }
    }, 'primary'); previewButton.disabled = true;
    const apply = button('确认应用导入', async () => {
      if (!preview?.token || apply.disabled) return; const selectedPreview = preview;
      if (!await confirmAction('应用导入配置', `${selectedPreview.pausedPlanIds.length} 个受影响或新计划将暂停。${selectedPreview.retentionImpact ? `保留期限将缩短，当前有 ${selectedPreview.retentionImpact.candidateCount} 条到期候选；下一清理周期和未来到期记录适用。` : ''}请确认已核对账号绑定与覆盖选择。`, '确认应用')) return;
      if (preview !== selectedPreview || !panel.alive()) return; apply.disabled = previewButton.disabled = true;
      try { await post('api/config/import/apply', { token: selectedPreview.token, confirm: true, confirmRetention: Boolean(selectedPreview.retentionImpact) }); await settingsUI.refresh(); await onUpdated(); if (panel.alive()) { feedback.textContent = '配置已应用；受影响或新计划保持暂停，请逐项核对后启用。'; preview = null; } }
      catch (error) { feedback.textContent = error.message + '；请重新预览'; preview = null; }
      finally { previewButton.disabled = false; }
    }, 'primary'); apply.disabled = true; const actions = node('div', undefined, 'phase-settings-actions'); actions.append(previewButton, apply); body.append(actions);
    file.addEventListener('change', async () => {
      const selected = file.files?.[0], revision = ++readRevision; invalidate(); choicesHost.replaceChildren(); documentValue = null; previewButton.disabled = true;
      try {
        if (!selected || selected.size > 2 * 1024 * 1024) throw new Error('请选择 2 MiB 内的配置 JSON'); const value = JSON.parse(await selected.text()); if (!panel.alive() || revision !== readRevision) return;
        if (value?.schema !== 'model-lab-config-v1' || !value.payload || !Array.isArray(value.payload.favorites) || !Array.isArray(value.payload.plans)) throw new Error('不是支持的模型实验室配置文件');
        documentValue = value; choices = { settings: {}, targets: {}, plans: {} }; bindings = {};
        const settings = section(choicesHost, '本地设置选择'), settingsGrid = columns(settings);
        for (const key of Object.keys(value.payload.settings || {}).filter(key => key !== 'budget')) { const labels = { manual: '手动参数', presets: '常用参数方案', retention: '历史保留', progressNotice: '运行提醒', queue: '请求控制' }, input = select(settingsGrid, labels[key] || key, [['keep', '保留本地'], ['overwrite', '使用导入值'], ...(key === 'presets' ? [['merge', '按名称合并方案']] : [])], 'keep'); input.addEventListener('change', () => { choices.settings[key] = input.value; invalidate(); }); }
        const accountCache = new Map(), accounts = modelId => { if (!accountCache.has(modelId)) accountCache.set(modelId, api('api/accounts?provider=' + encodeURIComponent(modelId.split('/')[0]) + '&model=' + encodeURIComponent(modelId))); return accountCache.get(modelId); };
        for (const item of value.payload.favorites) {
          const target = section(choicesHost, `${item.modelId} · ${item.sourceRef}`), action = select(target, '目标冲突选择', [['keep', '保留本地；新目标则新增'], ['overwrite', '覆盖同目标参数'], ['skip', '跳过此目标']], 'keep'); action.addEventListener('change', () => { choices.targets[item.sourceRef] = action.value; invalidate(); });
          for (const [key, accountValue] of [['account', item.account], ['fingerprintAccount', item.fingerprintAccount]]) if (accountValue?.mode === 'rebind') {
            const input = select(target, key === 'account' ? '导入目标账号绑定' : '旧指纹账号绑定', [['', '请选择绑定'], ['auto', '自动分配']], '');
            const accountHint = status(target); accountHint.hidden = true;
            input.addEventListener('change', () => { bindings[item.sourceRef] ||= {}; if (!input.value) delete bindings[item.sourceRef][key]; else bindings[item.sourceRef][key] = input.value === 'auto' ? { mode: 'auto' } : { mode: 'pinned', id: input.value }; invalidate(); });
            try { const cached = await accounts(item.modelId); if (!panel.alive() || revision !== readRevision) return; accountHint.textContent = cached.warning || (cached.capabilities?.pinned === false ? cached.capabilities.reason || '宿主未确认固定账号路由能力' : ''); accountHint.hidden = !accountHint.textContent; for (const account of cached.accounts || []) if (cached.capabilities?.pinned !== false && account.provider === item.modelId.split('/')[0] && account.enabled !== false && account.available !== false) { const label = accountLabel({ mode: 'pinned', id: account.id, name: account.name }), option = node('option', account.kind === 'key' ? label : `${account.name || account.id} · ${account.id}`); option.value = account.id; input.append(option); } } catch (error) { if (!panel.alive() || revision !== readRevision) return; accountHint.textContent = error.message; accountHint.hidden = false; }
          }
          else if (accountValue?.mode === 'pinned') target.append(node('p', `原固定账号：${accountLabel(accountValue)}`, 'help'));
        }
        const plans = section(choicesHost, '计划冲突选择'); for (const item of value.payload.plans) { const input = select(plans, `${item.favoriteRef} · ${item.kind} · ${item.sourceRef}`, [['keep', '保留本地；新计划则暂停新增'], ['overwrite', '使用导入计划并暂停'], ['skip', '跳过计划']], 'keep'); input.addEventListener('change', () => { choices.plans[item.sourceRef] = input.value; invalidate(); }); }
        if (!panel.alive() || revision !== readRevision) return; previewButton.disabled = false; feedback.textContent = '配置已读取，请选择绑定与冲突处理，再预览完整候选。';
      } catch (error) { if (panel.alive() && revision === readRevision) feedback.textContent = error.message; }
    });
  }

  function appendLocal(content, { runtime } = {}) {
    const navigation = node('div', undefined, 'phase-tool-tabs'), forms = node('div', undefined, 'phase-local-panels'), entries = [];
    content.classList.add('phase-local-content');
    forms.setAttribute('role', 'region'); forms.setAttribute('aria-label', '设置内容'); forms.setAttribute('tabindex', '0');
    navigation.setAttribute('role', 'tablist'); navigation.setAttribute('aria-label', '本地设置分类'); content.append(navigation, forms);
    const add = (key, label, build) => {
      const panel = node('div', undefined, 'phase-tool-panel'), index = entries.length;
      panel.id = `phase-local-panel-${key}`; panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', `phase-local-tab-${key}`);
      const control = button(label, () => activate(index)); control.id = `phase-local-tab-${key}`; control.setAttribute('role', 'tab'); control.setAttribute('aria-controls', panel.id);
      control.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? entries.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : entries.length - 1)) % entries.length;
        activate(next); entries[next].control.focus();
      });
      navigation.append(control); forms.append(panel); const refresh = build(panel); entries.push({ control, panel, refresh });
    };
    function activate(index) { entries.forEach((entry, position) => { entry.panel.hidden = position !== index; entry.control.setAttribute('aria-selected', String(position === index)); entry.control.setAttribute('tabindex', position === index ? '0' : '-1'); }); forms.scrollTop = content.scrollTop = 0; if (typeof entries[index]?.refresh === 'function') entries[index].refresh(); }
    if (runtime) add('runtime', '运行提醒', panel => panel.append(runtime));
    if (capabilities.queueAvailable) add('queue', '请求控制', queueSettings);
    if (settingsUI.snapshot().capabilities.usage) add('usage', '每日用量', usageSummary);
    if (capabilities.configAvailable) add('config', '配置迁移', configSettings);
    navigation.hidden = entries.length < 2; activate(0);
  }

  function openHistoryFilters() {
    const panel = opening('筛选历史', $('history-tools')), body = panel.content;
    body.append(node('p', '组合条件筛选历史。模型和账号可填名称或标识，也可按备注内容查找。', 'help'));
    const filters = readFilters(), filterBody = section(body, '筛选条件'), grid = columns(filterBody);
    const model = field(grid, '模型名称或标识', filters.model), account = field(grid, '账号名称或标识', filters.account), from = field(grid, '开始日期 · 含当天', dateDisplay(filters.from), 'date'), to = field(grid, '结束日期 · 不含当天', dateDisplay(filters.to), 'date');
    const result = select(grid, '结果或诊断', [['', '全部结果'], ['completed', '完成'], ['error', '失败'], ['cancelled', '取消'], ['interrupted', '中断'], ['match', '答案匹配'], ['mismatch', '答案不匹配'], ['review', '待复核'], ['timeout', '超时'], ['rate-limit', '限流'], ['authentication', '认证'], ['storage', '本地保存失败']], filters.result || '');
    const protectedValue = select(grid, '保护状态', [['', '全部'], ['yes', '受保护'], ['no', '未保护']], filters.protected === true ? 'yes' : filters.protected === false ? 'no' : '');
    const note = field(grid, '备注包含文字', filters.note), filterStatus = status(filterBody), actions = node('div', undefined, 'phase-settings-actions'); filterBody.append(actions);
    actions.append(button('应用筛选', () => {
      try {
        const value = { model: model.value, account: account.value, result: result.value, note: note.value, from: dateValue(from), to: dateValue(to), ...(protectedValue.value ? { protected: protectedValue.value === 'yes' } : {}) };
        if (value.from && value.to && value.from >= value.to) throw Error('结束日期需晚于开始日期');
        setFilters(value); filterStatus.textContent = `${filteredIds().length} 条记录符合筛选，关闭面板即可查看。`;
      } catch (error) { filterStatus.textContent = error.message; }
    }, 'primary'), button('清除筛选', () => { setFilters({}, true); for (const input of [model, account, from, to, note]) input.value = ''; result.value = protectedValue.value = ''; filterStatus.textContent = '筛选已清除'; }));
  }
  return { load(boot) { capabilities = boot; }, appendLocal, openHistoryFilters };
}
