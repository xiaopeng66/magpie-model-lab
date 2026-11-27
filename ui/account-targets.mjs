import { accountLabel, normalizeAccount } from '../lib/targets.mjs';

export function createAccountTargets({ document, api, openDrawer, closeDrawer, footer, onChange = () => {} }) {
  const bindings = new Map(); let supported = false, generation = 0;
  const node = (tag, text) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; return element; };
  const button = (label, action) => { const element = node('button', label); element.type = 'button'; element.addEventListener('click', action); return element; };
  const read = id => structuredClone(bindings.get(id) || [{ mode: 'auto' }]);
  async function open(model, origin, { initial, onApply } = {}) {
    const content = openDrawer('选择账号', origin, 'compact', () => { generation++; origin?.setAttribute('aria-expanded', 'false'); }), version = ++generation;
    origin?.setAttribute('aria-expanded', 'true'); content.classList.add('phase-tool-content');
    const picked = new Map((initial || read(model.id)).map(account => [account.mode === 'auto' ? '' : account.id, account]));
    const controls = new Map(), available = new Map(); let loading = false, saving = false, loadFailed = false;
    const list = node('div'), feedback = node('p', '正在读取账号…'); list.className = 'phase-account-list'; feedback.className = 'help'; feedback.setAttribute('role', 'status');
    const explanation = node('p', '勾选多个固定账号，可对比同一模型。'); explanation.className = 'help';
    const selection = node('div'), selectLabel = node('label'), selectAll = node('input'), selectionCount = node('span');
    selection.className = 'phase-account-selection'; selectLabel.className = 'check-row phase-account-select-all';
    selectAll.type = 'checkbox'; selectAll.setAttribute('aria-label', '全选可用账号'); selectAll.disabled = true;
    selectionCount.className = 'help'; selectionCount.setAttribute('role', 'status'); selectionCount.setAttribute('aria-atomic', 'true');
    selectLabel.append(selectAll, node('span', '全选可用账号')); selection.append(selectLabel);
    content.append(node('h3', model.name || model.id), explanation, selection, list, feedback);
    const updateSelection = () => {
      const count = [...picked.keys()].filter(id => id && available.has(id)).length;
      selectAll.checked = available.size > 0 && count === available.size;
      selectAll.indeterminate = count > 0 && count < available.size;
      selectAll.disabled = loading || saving || !available.size;
      apply.disabled = loading || saving || loadFailed || !picked.size; refresh.disabled = loading || saving;
      for (const [id, control] of controls) control.disabled = loading || saving || Boolean(id && !available.has(id));
      selectionCount.textContent = loading ? '正在读取账号…' : `已选 ${count} / 可选 ${available.size} 个固定账号${picked.has('') ? ' · 自动分配' : ''}`;
    };
    selectAll.addEventListener('change', () => {
      if (selectAll.disabled || version !== generation) return;
      if (selectAll.checked) { picked.clear(); for (const [id, account] of available) picked.set(id, account); }
      else for (const id of [...picked.keys()]) if (id) picked.delete(id);
      for (const [id, control] of controls) control.checked = picked.has(id);
      updateSelection();
    });
    const apply = button('确认账号选择', async () => {
      if (apply.disabled || loading || version !== generation) return;
      const accounts = [...picked.values()].map(normalizeAccount); if (!accounts.length) { feedback.textContent = '请至少选择自动分配或一个账号'; return; }
      saving = true; updateSelection();
      try { let nextOrigin; if (onApply) await onApply(accounts); else { bindings.set(model.id, accounts); nextOrigin = onChange(model.id); } if (version === generation) { closeDrawer(); if (nextOrigin?.isConnected && !nextOrigin.disabled) nextOrigin.focus({ preventScroll: true }); } }
      catch (error) { if (version === generation) feedback.textContent = error.message; }
      finally { saving = false; if (version === generation) updateSelection(); }
    }); apply.className = 'primary'; footer().append(button('取消', closeDrawer), apply);
    const row = (account, name, disabled = false, state = '', descriptor = {}) => {
      const label = node('label'), input = node('input'); label.className = 'check-row phase-account-option'; input.type = 'checkbox'; input.checked = picked.has(account.mode === 'auto' ? '' : account.id); input.disabled = disabled;
      if (account.id) input.dataset.accountId = account.id;
      const key = account.id || ''; controls.set(key, input);
      if (key && !disabled) available.set(key, account);
      const keyDescription = descriptor.kind === 'key' ? `API Key · ${descriptor.primary ? '主 Key' : '附加 Key'} · ${descriptor.keyPrefix || '…'}${descriptor.disambiguate ? ' · 指纹 ' + descriptor.id.slice(4, 14) : ''}` : '';
      input.setAttribute('aria-label', keyDescription ? name + ' · ' + keyDescription : name); input.addEventListener('change', () => {
        if (input.disabled || version !== generation) return;
        if (input.checked) {
          if (!key) { for (const [id, other] of controls) if (id) other.checked = false; picked.clear(); }
          else { picked.delete(''); if (controls.get('')) controls.get('').checked = false; }
          picked.set(key, account);
        } else picked.delete(key);
        updateSelection();
      });
      const identity = node('span'), title = node('span', name), detail = node('span', account.mode === 'auto' ? '按供应商当前策略分配' : keyDescription || account.id);
      identity.className = 'phase-account-identity'; title.className = 'phase-account-name'; title.title = name; detail.className = 'phase-account-meta' + (keyDescription ? ' phase-account-key-meta' : ''); detail.title = keyDescription || account.id || '';
      identity.append(title, detail);
      if (disabled && descriptor.unavailableReason) {
        const reason = node('span', descriptor.unavailableReason); reason.className = 'phase-account-reason'; reason.id = `phase-account-reason-${version}-${controls.size}`;
        input.setAttribute('aria-describedby', reason.id); identity.append(reason);
      }
      label.append(input, identity);
      if (state) { const badge = node('span', state); badge.className = 'phase-account-state'; label.append(badge); }
      list.append(label);
    };
    const load = async () => {
      if (loading || saving || version !== generation) return;
      loading = true; updateSelection(); list.setAttribute('aria-busy', 'true'); feedback.textContent = '正在读取账号…';
      try {
        const result = await api('api/accounts?provider=' + encodeURIComponent(model.provider) + '&model=' + encodeURIComponent(model.id)); if (version !== generation) return;
        loadFailed = false; list.replaceChildren(); controls.clear(); available.clear(); row({ mode: 'auto' }, '自动分配'); const candidates = result.accounts || [];
        const labelKey = account => JSON.stringify([account.name, account.primary, account.keyPrefix]);
        const labels = new Set(), repeated = new Set();
        for (const account of candidates.filter(item => item.kind === 'key')) { const key = labelKey(account); if (labels.has(key)) repeated.add(key); labels.add(key); }
        for (const account of candidates) {
          const unavailable = account.enabled === false || account.available === false || result.capabilities?.pinned === false;
          if (unavailable) picked.delete(account.id);
          const target = { mode: 'pinned', id: account.id, ...(account.name ? { name: account.name } : {}) };
          if (!unavailable && picked.has(account.id)) picked.set(account.id, target);
          row(target, account.name || account.id, unavailable, unavailable ? '不可用' : '', { ...account, disambiguate: repeated.has(labelKey(account)) });
        }
        for (const id of [...picked.keys()]) if (id && !candidates.some(account => account.id === id)) picked.delete(id);
        const status = result.capabilities?.pinned === false ? result.capabilities.reason || '宿主未确认固定账号路由能力' : candidates.length ? '实际使用的账号以测试结果为准。' : '此供应商暂无可显示的账号，可保留自动分配。';
        feedback.textContent = [result.warning, status].filter(Boolean).join(' ');
      } catch (error) { if (version !== generation) return; loadFailed = true; list.replaceChildren(); controls.clear(); available.clear(); feedback.textContent = `${error.message}。请刷新账号后再确认。`; }
      finally { loading = false; if (version === generation) { updateSelection(); list.setAttribute('aria-busy', 'false'); } }
    };
    const refresh = button('刷新账号', load); selection.append(refresh, selectionCount); await load();
  }
  return { load(value) { supported = value === true; }, get supported() { return supported; }, read, open,
    label(id) { const accounts = read(id); return accounts.length === 1 ? accounts[0].mode === 'auto' ? '自动分配' : accountLabel(accounts[0]) : `${accounts.length} 个固定账号`; },
    remove(id) { bindings.delete(id); }, clear() { bindings.clear(); },
    targets(selected, legacyAccounts) { return [...selected].flatMap(([modelId, effort]) => (bindings.get(modelId) || (legacyAccounts?.get(modelId) ? [{ mode: 'pinned', id: legacyAccounts.get(modelId) }] : [{ mode: 'auto' }])).map(account => ({ modelId, effort, account: structuredClone(account) }))); },
  };
}
