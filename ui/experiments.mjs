import { repetitionCount } from '../lib/experiments.mjs';
import { readRunTarget } from '../lib/targets.mjs';

export function repeatedResultGroups(records) {
  if (!records.some(run => run.experiment?.repeatCount > 1)) return null;
  const groups = new Map();
  const ordered = [...records].sort((a, b) => (a.executionIndex ?? Number.MAX_SAFE_INTEGER) - (b.executionIndex ?? Number.MAX_SAFE_INTEGER));
  for (const run of ordered) {
    const key = JSON.stringify([run.kind || 'pelican', readRunTarget(run).targetKey]);
    if (!groups.has(key)) groups.set(key, { key, runs: [] });
    groups.get(key).runs.push(run);
  }
  for (const group of groups.values()) group.runs.sort((a, b) => (a.repetitionIndex ?? 0) - (b.repetitionIndex ?? 0) || (a.executionIndex ?? 0) - (b.executionIndex ?? 0));
  return [...groups.values()];
}

export function createExperimentControls({ $, kind, targetCount }) {
  let enabled = false;
  const countFor = () => {
    const count = repetitionCount({ count: Number($('repeat-count').value) }), total = targetCount() * count * (kind() === 'fingerprint' ? 3 : 1);
    if (!Number.isSafeInteger(total)) throw new Error('本批请求数量超出可精确计算的范围，请减少目标或重复次数');
    return count;
  };
  const changed = () => {
    try {
      const count = countFor(), targets = targetCount();
      $('experiment-estimate').textContent = `${targets * count} 份结果 · 最多 ${targets * count * (kind() === 'fingerprint' ? 3 : 1)} 次生成请求${kind() === 'fingerprint' ? '（每份 3 次采样）' : ''}`;
    } catch (error) { $('experiment-estimate').textContent = error.message; }
  };
  $('repeat-count').addEventListener('input', changed);
  return { load(boot) {
    enabled = boot.experimentsAvailable === true; $('experiment-controls').hidden = !enabled; $('experiment-estimate').hidden = !enabled; changed();
  }, update: changed, capture() {
    if (!enabled) return {};
    const count = countFor();
    return count > 1 ? { repeat: { count } } : {};
  } };
}
