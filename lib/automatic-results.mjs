export function automaticResultKey(favoriteId, model, kind, at) {
  const instant = typeof at === "string" ? Date.parse(at) : NaN;
  return favoriteId && model && Number.isFinite(instant) ? JSON.stringify([favoriteId, model, kind, Math.floor(instant / 60000)]) : null;
}

function rank(run) {
  if (run.status === "completed") return 4;
  if (run.status === "running") return 3;
  if (run.status === "queued") return 1;
  return run.startedAt || run.content || run.reasoning || run.html || run.contentChars || run.reasoningChars || run.hasHTML ? 2 : 0;
}
export function indexAutomaticResults(runs) {
  const indexed = new Map();
  for (const run of runs) {
    if (run.source !== "automatic" || !["candy", "pelican"].includes(run.kind)) continue;
    // scheduledAt stays tied to the intended slot even when the request starts later.
    const key = automaticResultKey(run.favoriteId, run.model, run.kind, run.scheduledAt);
    if (!key) continue;
    const prior = indexed.get(key), priority = prior ? rank(run) - rank(prior) : 1;
    const recency = prior ? Date.parse(run.createdAt) - Date.parse(prior.createdAt) : 0;
    if (priority > 0 || priority === 0 && (recency > 0 || recency === 0 && run.id > prior.id)) indexed.set(key, run);
  }
  return indexed;
}
