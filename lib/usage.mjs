const valid = value => Number.isSafeInteger(value) && value >= 0;
const details = new Set(["prompt_tokens_details", "completion_tokens_details", "input_tokens_details", "output_tokens_details"]);

// Usage frames are cumulative snapshots; merge missing fields instead of adding frames.
export function mergeUsage(previous, incoming) {
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) return previous || null;
  const next = { ...previous };
  for (const [key, value] of Object.entries(incoming)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) continue;
    if (valid(value)) next[key] = value;
    else if (details.has(key) && value && typeof value === "object" && !Array.isArray(value)) {
      const fields = Object.fromEntries(Object.entries(value).filter(([name, count]) => !["__proto__", "constructor", "prototype"].includes(name) && valid(count)));
      next[key] = { ...next[key], ...fields };
    }
  }
  return Object.keys(next).length ? next : null;
}

export function sumUsage(samples) {
  const total = {};
  for (const sample of samples) for (const [key, value] of Object.entries(mergeUsage(null, sample.usage) || {})) {
    if (valid(value)) total[key] = (total[key] || 0) + value;
    else if (details.has(key)) {
      total[key] ||= {};
      for (const [name, count] of Object.entries(value)) total[key][name] = (total[key][name] || 0) + count;
    }
  }
  return Object.keys(total).length ? total : null;
}

function counts(usage) {
  const first = (...values) => values.find(valid) ?? null;
  const output = first(usage?.completion_tokens, usage?.output_tokens);
  const input = first(usage?.prompt_tokens, usage?.input_tokens);
  return {
    reasoning: first(usage?.completion_tokens_details?.reasoning_tokens, usage?.output_tokens_details?.reasoning_tokens, usage?.reasoning_tokens),
    output, total: first(usage?.total_tokens, input !== null && output !== null ? input + output : null),
  };
}

export function tokenUsage(run) {
  const sources = run.kind === "fingerprint" && run.samples?.length ? run.samples : [run];
  const values = sources.map(sample => counts(sample.usage)), result = { reasoning: null, output: null, total: null, partial: [] };
  for (const key of ["reasoning", "output", "total"]) {
    const reported = values.map(value => value[key]).filter(valid);
    if (!reported.length) continue;
    const sum = reported.reduce((sum, count) => sum + count, 0);
    if (!valid(sum)) continue;
    result[key] = sum;
    if (reported.length < sources.length) result.partial.push(key);
  }
  return result;
}
