import { conditionProfile, executedRun } from './comparison.mjs';
import { readRunTarget } from './targets.mjs';
import { readGrade } from './suites.mjs';
const invalid = message => Object.assign(new Error(message), { status: 400 });
export function repetitionCount(repeat) {
  if (repeat == null) return 1;
  if (!repeat || typeof repeat !== 'object' || Array.isArray(repeat) || Object.keys(repeat).some(key => key !== 'count') || !Number.isSafeInteger(repeat.count) || repeat.count < 1) throw invalid('重复次数需为可精确表示的正整数');
  return repeat.count;
}
export const median = values => { const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2); return !sorted.length ? null : sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; };
export function experimentStats(anchor, records) {
  const target = readRunTarget(anchor).targetKey, profile = JSON.stringify(conditionProfile(anchor));
  const group = records.filter(run => run.experimentId === anchor.experimentId && readRunTarget(run).targetKey === target && JSON.stringify(conditionProfile(run)) === profile);
  const executed = group.filter(executedRun), completed = group.filter(run => run.status === 'completed'), gradable = completed.filter(run => run.routing?.verification !== 'mismatch' && ['match', 'mismatch'].includes(readGrade(run)?.verdict)), matches = gradable.filter(run => readGrade(run).verdict === 'match');
  const valid = completed.filter(run => run.routing?.verification !== 'mismatch' && (run.kind !== 'candy' || ['match', 'mismatch'].includes(readGrade(run)?.verdict)));
  const durations = valid.map(run => run.elapsedMs).filter(value => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  return { submitted: group.length, executed: executed.length, completed: completed.length, gradable: gradable.length, matches: matches.length,
    failed: group.filter(run => ['error', 'invalid', 'truncated', 'interrupted'].includes(run.status)).length, cancelled: group.filter(run => run.status === 'cancelled').length,
    matchRate: gradable.length ? matches.length / gradable.length * 100 : null, executedMatchRate: executed.length ? matches.length / executed.length * 100 : null,
    elapsedCount: durations.length, elapsedMedian: median(durations), minMs: durations[0] ?? null, maxMs: durations.at(-1) ?? null, p90Ms: durations.length >= 10 ? durations[Math.ceil(durations.length * .9) - 1] : null,
    runIds: group.map(run => run.id) };
}
