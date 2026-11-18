const clocks = new Map();
const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
function historyClock(timeZone) {
  if (!clocks.has(timeZone)) clocks.set(timeZone, {
    date: new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }),
    time: new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
  });
  return clocks.get(timeZone);
}
export function scheduledTime(run) {
  const at = typeof run.scheduledAt === "string" ? Date.parse(run.scheduledAt) : NaN;
  return new Date(Number.isFinite(at) ? at : Date.parse(run.createdAt)).toISOString();
}
export const historyTime = (at, timeZone = localZone) => historyClock(timeZone).time.format(new Date(at));
export const batchKey = run => run.roundId || run.batchId || run.id;

export function historyBatches(runs, timeZone = localZone) {
  const clock = historyClock(timeZone), manual = new Map(), modelDays = new Map(), days = new Map();
  const times = new Map(), date = at => clock.date.format(new Date(at));
  for (const run of runs) {
    if (run.source !== "automatic") {
      const id = batchKey(run);
      if (!manual.has(id)) manual.set(id, { id, source: run.favoriteId ? "favorites" : "manual", runs: [] });
      manual.get(id).runs.push(run);
      continue;
    }
    const at = scheduledTime(run), day = date(at), kind = run.kind || "pelican", key = JSON.stringify([day, kind, run.model]);
    if (!modelDays.has(key)) modelDays.set(key, { date: day, kind, model: run.model, runs: [], times: new Set() });
    const modelDay = modelDays.get(key); modelDay.runs.push(run); modelDay.times.add(at); times.set(run.id, at);
  }
  for (const modelDay of modelDays.values()) {
    const slots = [...modelDay.times].sort(), key = JSON.stringify([modelDay.date, modelDay.kind, slots]);
    if (!days.has(key)) days.set(key, { date: modelDay.date, kind: modelDay.kind, source: "automatic", times: slots, modelIds: [], runs: [] });
    const day = days.get(key); day.modelIds.push(modelDay.model); day.runs.push(...modelDay.runs);
  }
  for (const day of days.values()) {
    day.id = `daily:${JSON.stringify([day.date, day.kind, [...day.modelIds].sort()])}`;
    const order = new Map(day.modelIds.map((model, index) => [model, index]));
    day.runs.sort((a, b) => times.get(b.id).localeCompare(times.get(a.id)) || order.get(a.model) - order.get(b.model) || b.createdAt.localeCompare(a.createdAt));
    day.createdAt = day.runs[0].createdAt;
  }
  for (const group of manual.values()) {
    group.modelIds = [...new Set(group.runs.map(run => run.model))];
    group.createdAt = group.runs.reduce((latest, run) => run.createdAt > latest ? run.createdAt : latest, group.runs[0].createdAt);
    group.date = date(group.createdAt);
  }
  return [...days.values(), ...manual.values()].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}

export function recentTestBatches(groups, kind, currentBatchId, preferredModelOrder) {
  const order = new Map(preferredModelOrder.map((model, index) => [model, index]));
  return groups.filter(group => group.source !== "automatic" && group.id !== currentBatchId && group.runs.some(run => (run.kind || "pelican") === kind)
      && !group.runs.some(run => run.status === "queued" || run.status === "running"))
    .slice(0, 3).map(group => ({ ...group, runs: group.runs.filter(run => (run.kind || "pelican") === kind)
      .sort((a, b) => (order.get(a.model) ?? order.size) - (order.get(b.model) ?? order.size)) }));
}
