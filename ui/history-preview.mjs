import { scheduledTime, historyTime } from '../lib/history-groups.mjs';

export function renderDailyHistory(group, container, { node, text, button, modelLabel, active, timeZone, mount }) {
  const title = run => modelLabel({ id: run.model, name: run.modelName, provider: run.provider, providerName: run.providerName }, false);
  const when = at => historyTime(at, timeZone);
  const heading = run => {
    const root = node('div', 'card-model'), name = node('h3', '', title(run)), provider = node('p', 'card-provider', run.providerName || run.provider);
    name.title = `${title(run)}\n${run.model}`; provider.title = provider.textContent;
    root.append(name, provider); return root;
  };
  if (group.kind === 'pelican') {
    const gallery = node('div', 'animation-gallery history-animation-gallery'), rows = new Map();
    const navigation = node('div', 'gallery-navigation'), navigationButtons = node('div', 'segments');
    navigationButtons.setAttribute('role', 'group'); navigationButtons.setAttribute('aria-label', '历史动画时段');
    const move = direction => { for (const { lane } of rows.values()) lane.scrollBy({ left: direction * Math.max(210, lane.clientWidth * .75), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }); };
    navigationButtons.append(button('较新时段', () => move(-1)), button('回到最新', () => { for (const { lane } of rows.values()) lane.scrollLeft = 0; }), button('较早时段', () => move(1)));
    navigation.append(node('span', 'help', '每个模型一行 · 向右查看更早时段'), navigationButtons);
    for (const model of group.modelIds) {
      const run = group.runs.find(record => record.model === model), row = node('section', 'animation-row history-animation-row'), lane = node('div', 'animation-lane history-animation-lane'), names = heading(run);
      names.classList.add('animation-model'); row.setAttribute('aria-label', `${title(run)} 的每日动画长廊`);
      lane.setAttribute('tabindex', '0'); lane.setAttribute('role', 'region'); lane.setAttribute('aria-label', `${title(run)} 的动画时段`);
      row.append(names, lane); gallery.append(row);
      rows.set(model, { lane, slots: new Map() });
    }
    function update(current) {
      const targets = new Map();
      for (const [model, { lane, slots }] of rows) {
        const records = current.runs.filter(run => run.model === model), ids = new Set(records.map(run => run.id));
        for (const [id, { cell }] of slots) if (!ids.has(id)) { cell.remove(); slots.delete(id); }
        for (const [index, run] of records.entries()) {
          let slot = slots.get(run.id);
          if (!slot) {
            const cell = node('div', 'animation-slot history-animation-slot'), body = node('div', 'animation-slot-body');
            const time = node('div', 'animation-time'); cell.append(time, body); slot = { cell, body, time }; slots.set(run.id, slot);
          }
          text(slot.time, when(scheduledTime(run)));
          if (lane.children[index] !== slot.cell) lane.insertBefore(slot.cell, lane.children[index] || null);
          targets.set(run.id, slot.body);
        }
      }
      mount([...targets.keys()], targets);
    }
    container.append(navigation, gallery); update(group); return { update };
  }

  const summaries = node('div', 'favorite-candy-grid history-daily-candy-grid'), summaryRecords = [];
  const selection = node('section', 'history-time-selection'), note = node('p', 'help'), results = node('div', 'results-grid');
  selection.append(note, results); selection.hidden = true;
  let selectedTime = scheduledTime(group.runs.find(run => run.status === 'completed') || group.runs[0]), byTime = new Map();
  function selectTime(time) {
    selectedTime = selectedTime === time ? '' : time;
    renderSelection();
  }
  function renderSelection() {
    if (!byTime.has(selectedTime)) selectedTime = '';
    for (const { controls } of summaryRecords) for (const control of controls.values()) control.setAttribute('aria-pressed', String(control.dataset.at === selectedTime));
    const records = byTime.get(selectedTime) || [];
    selection.hidden = !records.length; text(note, records.length ? `${new Set(records.map(run => run.model)).size} 个模型 · ${records.length} 份结果` : '');
    mount(records.map(run => run.id), new Map(records.map(run => [run.id, results])));
  }
  for (const model of group.modelIds) {
    const run = group.runs.find(record => record.model === model), card = node('article', 'favorite-candy-card history-candy-summary'), metric = node('div', 'candy-metric');
    const ratio = node('strong', 'candy-ratio'), summary = node('span', 'help'), exceptions = node('p', 'exception-summary'), bars = node('div', 'candy-bars');
    metric.append(node('span', 'metric-caption', '答案命中率'), ratio, summary); card.append(heading(run), metric, exceptions, bars);
    bars.setAttribute('role', 'group'); bars.setAttribute('aria-label', `${title(run)} 的 ${group.date} 糖果结果`);
    summaries.append(card); summaryRecords.push({ model, name: title(run), bars, controls: new Map(), ratio, summary, exceptions });
  }
  const legend = node('p', 'status-legend history-slot-legend');
  for (const [label, type] of [['答案匹配', 'match'], ['答案不匹配', 'mismatch'], ['失败 / 中断', 'failure'], ['无结果', 'pending']]) { const item = node('span'); item.append(node('i', `legend-${type}`), node('span', '', label)); legend.append(item); }
  legend.append(node('span', '', '点击时段查看，再次点击收起'));
  container.append(summaries, legend, selection);
  function update(current) {
    byTime = new Map(current.times.map(at => [at, []]));
    for (const run of current.runs) byTime.get(scheduledTime(run)).push(run);
    for (const { model, name, bars, controls, ratio, summary, exceptions } of summaryRecords) {
      for (const [at, control] of controls) if (!byTime.has(at)) { control.remove(); controls.delete(at); }
      for (const [index, at] of current.times.entries()) {
        let control = controls.get(at);
        if (!control) {
          control = button('', () => selectTime(at), 'candy-bar'); control.dataset.at = at; controls.set(at, control);
          control.addEventListener('keydown', event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault(); const choices = [...bars.children], index = choices.indexOf(control);
            choices[event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : Math.max(0, Math.min(choices.length - 1, index + (event.key === 'ArrowRight' ? 1 : -1)))]?.focus({ preventScroll: true });
          });
        }
        const attempts = byTime.get(at).filter(run => run.model === model), run = attempts.find(record => record.status === 'completed') || attempts[0];
        const verdict = active(run) ? run.status : run.status === 'completed' ? run.candy?.verdict || 'review' : 'incomplete';
        const label = ({ match: '答案匹配', mismatch: '答案不匹配', review: '待复核', running: '测试中', queued: '排队中' })[verdict]
          || ({ error: '请求失败', cancelled: '已取消', interrupted: '已中断', truncated: '已截断' })[run.status] || '未完成';
        control.dataset.verdict = verdict; control.title = `${name} · ${when(at)} · ${label}`; control.setAttribute('aria-label', control.title);
        if (bars.children[index] !== control) bars.insertBefore(control, bars.children[index] || null);
      }
      const records = current.runs.filter(run => run.model === model);
      const match = records.filter(run => run.status === 'completed' && run.candy?.verdict === 'match').length, mismatch = records.filter(run => run.status === 'completed' && run.candy?.verdict === 'mismatch').length;
      text(ratio, match + mismatch ? `${Math.round(match / (match + mismatch) * 100)}%` : '—'); text(summary, `${match} / ${match + mismatch} 个可判定结果`);
      text(exceptions, `请求失败 ${records.filter(run => run.status === 'error').length} · 中断 ${records.filter(run => run.status === 'interrupted').length}`);
    }
    renderSelection();
  }
  update(group);
  return { update };
}
