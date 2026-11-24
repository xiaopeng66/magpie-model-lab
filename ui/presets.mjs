import { normalizeParameters, parameterDefaults, generationTimeoutFromSeconds } from '../lib/test-parameters.mjs';

export function createPresetManager({ document, $, settingsUI, openDrawer, closeDrawer, confirmAction, getKind, models, defaultPrompt }) {
  let panel = null;
  const clone = value => structuredClone(value);
  const node = (tag, text, className = '') => { const out = document.createElement(tag); out.className = className; if (text !== undefined) out.textContent = text; return out; };
  const option = (select, value, label) => { const out = node('option', label); out.value = value; select.append(out); };
  const field = (host, label, input, accessible) => { const row = node('label', undefined, 'editor-field'); input.setAttribute('aria-label', accessible || label); row.append(node('span', label), input); host.append(row); return input; };

  function updateCatalog() { panel?.updateCatalog(); }
  async function open() {
    const kind = getKind(), label = { pelican: '动画', candy: '糖果', fingerprint: '指纹' }[kind];
    const content = openDrawer('常用参数', $('manage-presets'), 'compact', () => { panel = null; });
    content.classList.add('phase-tool-content');
    const current = panel = {}, pick = node('select'), name = node('input'), status = node('p', '', 'help'), fields = [], effortRows = [];
    let selectedId = '', base = null, busy = true, dirty = false, hasEffortMap = false;
    content.append(node('p', `直接添加或修改${label}方案的名称与参数。保存后可选择“应用到测试”，也可在主界面选择方案载入。`, 'help'));
    field(content, '已保存方案', pick, '选择方案'); field(content, '方案名称 · 1–40 字', name, '方案名称'); name.maxLength = 80; name.placeholder = '例如：长时间推理';
    const parameters = node('div', undefined, 'phase-preset-fields editor-columns'); content.append(parameters);
    const numberField = (label, accessible, unit, timeout = false) => {
      const input = node('input'); input.type = 'number'; input.min = '0'; input.step = timeout ? '0.001' : '1'; if (timeout) input.max = '2147483.647';
      const row = node('div', undefined, 'phase-preset-number'); field(row, label, input, accessible); row.append(node('p', `单位：${unit}；0 = 不设${timeout ? '超时' : label.includes('输出') ? '输出上限' : '并行上限'}`, 'help')); parameters.append(row); fields.push(input); return input;
    };
    const timeout = numberField('生成超时', '方案生成超时', '秒', true), tokens = numberField('输出上限', '方案输出上限', 'Token'), concurrency = numberField('每批并行数', '方案每批并行数', '个');
    let prompt, api, tier, strict;
    if (kind === 'pelican') { prompt = node('textarea'); prompt.rows = 4; prompt.maxLength = 12000; field(content, '动画提示词', prompt, '方案动画提示词'); fields.push(prompt); }
    if (kind === 'fingerprint') {
      const options = node('div', undefined, 'editor-columns'); content.append(options); api = node('select'); tier = node('select');
      for (const [value, text] of [['auto', '自动'], ['responses', 'Responses'], ['chat_completions', 'Chat'], ['messages', 'Messages']]) option(api, value, text);
      for (const [value, text] of [['default', '默认'], ['flex', 'Flex'], ['fast', 'Fast'], ['ultrafast', 'Ultrafast']]) option(tier, value, text);
      field(options, '请求接口', api, '方案请求接口'); field(options, '服务档位', tier, '方案服务档位'); strict = node('input'); strict.type = 'checkbox'; strict.setAttribute('aria-label', '方案严格采样');
      const check = node('label', undefined, 'check-row'); check.append(strict, node('span', '严格采样')); content.append(check); fields.push(api, tier, strict);
    }
    const effortSection = node('section', undefined, 'phase-preset-efforts'), effortList = node('div', undefined, 'phase-preset-effort-list');
    effortSection.append(node('h3', '模型思考档位（可选）'), node('p', '只为需要单独指定档位的模型添加设置。这里的模型用于保存档位，不会勾选测试模型或账号。', 'help'), effortList); content.append(effortSection);
    const changed = event => { dirty = true; event?.target?.removeAttribute('aria-invalid'); status.textContent = '有未保存修改'; updateControls(); };
    const button = (label, action, className = '') => { const out = node('button', label, className); out.type = 'button'; out.addEventListener('click', action); return out; };
    const addEffort = (id, value = '') => {
      const root = node('div', undefined, 'phase-preset-effort-row'), controls = node('div', undefined, 'editor-columns'), model = node('select'), effort = node('select');
      const catalog = models(); for (const item of catalog) option(model, item.id, item.name || item.id);
      if (id && !catalog.some(item => item.id === id)) option(model, id, `已保存模型 · ${id}`); model.value = id || catalog[0]?.id || '';
      const fill = selected => { effort.replaceChildren(); option(effort, '', '默认'); for (const entry of new Set([...(catalog.find(item => item.id === model.value)?.efforts || []), ...(selected ? [selected] : [])])) option(effort, entry, entry); effort.value = selected; };
      fill(value); field(controls, '模型', model, '方案档位模型'); field(controls, '思考档位', effort, '方案模型思考档位');
      const row = { root, model, effort }; root.append(controls, button('移除此档位', () => { if (busy) return; root.remove(); effortRows.splice(effortRows.indexOf(row), 1); changed(); }));
      model.addEventListener('change', () => { fill(''); changed(); }); effort.addEventListener('change', changed); effortList.append(root); effortRows.push(row);
    };
    const add = button('添加模型思考档位', () => {
      if (busy) return; const model = models().find(item => !effortRows.some(row => row.model.value === item.id)); if (!model) return;
      addEffort(model.id); changed();
    }); effortSection.append(add);
    status.id = 'phase-preset-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); status.setAttribute('tabindex', '-1'); content.append(status);
    const actions = node('div', undefined, 'phase-settings-actions phase-preset-actions'); content.append(actions);
    const showError = error => { if (panel === current) { status.textContent = `${error.message}；输入已保留。`; status.focus(); } };
    const numeric = (input, label) => { const value = input.value.trim() ? Number(input.value) : NaN; if (!Number.isSafeInteger(value) || value < 0) { input.setAttribute('aria-invalid', 'true'); throw new Error(`${label}需为非负整数，0 表示不设上限`); } return value; };
    const readParameters = () => {
      let milliseconds;
      try { milliseconds = generationTimeoutFromSeconds(timeout.value); }
      catch (error) { timeout.setAttribute('aria-invalid', 'true'); throw error; }
      const effortByModel = {};
      for (const row of effortRows) { if (!row.model.value || Object.hasOwn(effortByModel, row.model.value)) throw new Error('思考档位需选择模型，同一模型只能设置一次'); effortByModel[row.model.value] = row.effort.value; }
      return normalizeParameters(kind, { timeoutMs: milliseconds, maxTokens: numeric(tokens, '输出上限'), concurrency: numeric(concurrency, '每批并行数'),
        ...(prompt ? { prompt: prompt.value } : {}), ...(api ? { api: api.value, serviceTier: tier.value, strict: strict.checked } : {}),
        ...(hasEffortMap || effortRows.length ? { effortByModel } : {}) }, { defaultPrompt: defaultPrompt() });
    };
    const writeParameters = value => {
      timeout.value = String(value.timeoutMs / 1000); tokens.value = String(value.maxTokens); concurrency.value = String(value.concurrency);
      if (prompt) prompt.value = value.prompt; if (api) { api.value = value.api; tier.value = value.serviceTier; strict.checked = value.strict; }
      effortList.replaceChildren(); effortRows.length = 0; hasEffortMap = Object.hasOwn(value, 'effortByModel'); for (const [id, effort] of Object.entries(value.effortByModel || {})) addEffort(id, effort);
      for (const input of fields) input.removeAttribute('aria-invalid');
    };
    const runAction = handler => async () => {
      if (busy || panel !== current) return; busy = true; updateControls();
      try { await handler(); } catch (error) { pick.value = selectedId; showError(error); }
      finally { if (panel === current) { busy = false; updateControls(); } }
    };
    const discard = async () => !dirty || await confirmAction('切换方案', '当前方案有未保存修改，是否放弃这些修改并切换？', '放弃并切换');
    const choose = async id => {
      if (!await discard() || panel !== current) { pick.value = selectedId; return; }
      if (id) {
        const snapshot = await settingsUI.refresh(); if (panel !== current) return;
        const stored = snapshot.presets.find(item => item.id === id && item.kind === kind); if (!stored) throw new Error('所选方案已不存在，请重新选择');
        const value = normalizeParameters(kind, stored.parameters, { defaultPrompt: defaultPrompt() }); base = clone(stored); name.value = stored.name; writeParameters(value);
      } else { base = null; name.value = ''; writeParameters(parameterDefaults(kind, defaultPrompt())); }
      selectedId = id; dirty = false; pick.value = id; status.textContent = id ? '可直接修改名称和参数，完成后保存修改。' : '填写方案名称与参数，保存为新方案。';
    };
    const fresh = button('新建方案', runAction(() => choose(''))), apply = button('应用到测试', runAction(async () => {
      if (!selectedId || dirty) return; await settingsUI.loadPreset(selectedId, { isCurrent: () => panel === current }); if (panel === current) status.textContent = '方案已应用到主界面，可继续调整测试参数。';
    })), remove = button('删除方案', runAction(async () => {
      const wanted = selectedId; if (!wanted) return;
      if (!await confirmAction('删除方案', `删除“${name.value}”？`, '确认删除') || panel !== current) return;
      const result = await settingsUI.savePatch({ presetDelete: { id: wanted } }); if (panel !== current) return;
      if (result.state !== 'saved') throw new Error(result.message || '删除尚未确认'); selectedId = ''; dirty = false; base = null; name.value = ''; writeParameters(parameterDefaults(kind, defaultPrompt())); current.updateCatalog(); status.textContent = '方案已删除，可添加新方案。';
    }), 'danger');
    const save = button('保存为新方案', runAction(async () => {
      const title = name.value.trim(); if (!title || [...title].length > 40 || /[\x00-\x1f\x7f]/.test(title)) { name.setAttribute('aria-invalid', 'true'); throw new Error('方案名称需为 1–40 字'); }
      const parameters = readParameters(), id = selectedId;
      if (id) { const snapshot = await settingsUI.refresh(); if (panel !== current) return; const stored = snapshot.presets.find(item => item.id === id); if (JSON.stringify(stored) !== JSON.stringify(base)) throw new Error('方案已被其他页面修改或删除，请重新选择并核对后保存'); }
      if (panel !== current) return;
      const result = await settingsUI.savePatch({ presetUpsert: { ...(id ? { id } : {}), name: title, kind, parameters } }); if (panel !== current) return;
      if (result.state !== 'saved') throw new Error(result.message || '保存尚未确认');
      const stored = settingsUI.snapshot().presets.find(item => id ? item.id === id : item.kind === kind && item.name === title);
      if (!stored) throw new Error('保存结果尚未确认，请重新读取方案'); selectedId = stored.id; base = clone(stored); name.value = stored.name; dirty = false; current.updateCatalog(); status.textContent = '方案已保存到本地；可应用到测试。';
    }), 'primary');
    actions.append(fresh, apply, remove); content.append(node('p', '最多保存 50 套方案。模型、账号和重复轮数按本次测试选择执行。', 'help'));
    $('drawer-footer').append(button('关闭', closeDrawer), save);
    function updateControls() {
      const exists = settingsUI.snapshot().presetCatalog.some(item => item.id === selectedId && item.kind === kind);
      for (const input of [pick, name, ...fields, ...effortRows.flatMap(row => [row.model, row.effort])]) input.disabled = busy;
      for (const control of effortList.querySelectorAll('button')) control.disabled = busy;
      fresh.disabled = save.disabled = busy; apply.disabled = busy || !exists || dirty; remove.disabled = busy || !exists;
      add.disabled = busy || !models().some(item => !effortRows.some(row => row.model.value === item.id)); save.textContent = selectedId ? '保存修改' : '保存为新方案';
      apply.title = dirty ? '先保存修改，再应用到测试' : '把已保存方案载入主界面';
    }
    current.updateCatalog = () => {
      pick.replaceChildren(); option(pick, '', '新建方案（默认参数）'); for (const stored of settingsUI.snapshot().presetCatalog.filter(item => item.kind === kind)) option(pick, stored.id, stored.name);
      pick.value = selectedId; updateControls();
    };
    name.addEventListener('input', changed); for (const input of fields) { input.addEventListener(input.tagName === 'SELECT' || input.type === 'checkbox' ? 'change' : 'input', changed); input.addEventListener('blur', () => { if (busy || panel !== current) return; try { readParameters(); } catch (error) { showError(error); } }); }
    pick.addEventListener('change', async () => { const id = pick.value; if (busy) { pick.value = selectedId; return; } await runAction(() => choose(id))(); });
    writeParameters(parameterDefaults(kind, defaultPrompt())); current.updateCatalog();
    try { await settingsUI.refresh(); } catch (error) { showError(error); }
    finally { if (panel === current) { busy = false; current.updateCatalog(); } }
  }
  return { open, updateCatalog };
}
