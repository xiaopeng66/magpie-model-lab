const valid = value => Number.isSafeInteger(value) && value >= 0;
const details = new Set(["prompt_tokens_details", "completion_tokens_details", "input_tokens_details", "output_tokens_details"]);
const nativeCache = ['cache_read_input_tokens', 'cache_creation_input_tokens'];

// Usage frames are cumulative snapshots; merge missing fields instead of adding frames.
export function mergeUsage(previous, incoming) {
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) return previous || null;
  const next = { ...previous };
  for (const [key, value] of Object.entries(incoming)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) continue;
    if (valid(value)) next[key] = value;
    else if (nativeCache.includes(key) && !valid(next[key])) next[key] = null;
    else if (details.has(key) && value && typeof value === "object" && !Array.isArray(value)) {
      const fields = Object.fromEntries(Object.entries(value).filter(([name, count]) => !["__proto__", "constructor", "prototype"].includes(name) && valid(count)));
      next[key] = { ...next[key], ...fields };
    }
  }
  return Object.keys(next).length ? next : null;
}

export function sumUsage(samples) {
  const total = {};
  const add = (target, key, count) => {
    if (target[key] === null) return; // null keeps an overflowed count unknown across later samples.
    const sum = (target[key] ?? 0) + count;
    target[key] = valid(sum) ? sum : null;
  };
  for (const sample of samples) for (const [key, value] of Object.entries(mergeUsage(null, sample.usage) || {})) {
    if (valid(value)) add(total, key, value);
    else if (nativeCache.includes(key) && value === null) total[key] = null;
    else if (details.has(key)) {
      total[key] ||= {};
      for (const [name, count] of Object.entries(value)) add(total[key], name, count);
    }
  }
  return Object.keys(total).length ? total : null;
}

function counts(usage) {
  const first = (...values) => values.find(valid) ?? null;
  const output = first(usage?.completion_tokens, usage?.output_tokens);
  const cacheRead = first(usage?.prompt_tokens_details?.cached_tokens, usage?.input_tokens_details?.cached_tokens,
    usage?.cache_read_input_tokens, usage?.prompt_cache_hit_tokens);
  const cacheWrite = first(usage?.prompt_tokens_details?.cache_write_tokens, usage?.input_tokens_details?.cache_write_tokens,
    usage?.cache_creation_input_tokens);
  let input = first(usage?.prompt_tokens, usage?.input_tokens);
  // Native Messages reports uncached input separately; OpenAI cache counts are input subsets.
  if (!valid(usage?.prompt_tokens) && input !== null && nativeCache.some(key => Object.hasOwn(usage, key))) {
    const native = nativeCache.map(key => Object.hasOwn(usage, key) ? usage[key] : 0);
    const inclusive = native.every(valid) ? input + native[0] + native[1] : null;
    input = valid(inclusive) ? inclusive : null;
  }
  const derived = input !== null && output !== null ? input + output : null;
  return {
    reasoning: first(usage?.completion_tokens_details?.reasoning_tokens, usage?.output_tokens_details?.reasoning_tokens, usage?.reasoning_tokens),
    input, output, cacheRead, cacheWrite, total: first(usage?.total_tokens, derived),
  };
}

export function usageBreakdown(usage) {
  const { input, output, cacheRead, cacheWrite, total } = counts(usage);
  return { input, output, cacheRead, cacheWrite, total };
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
