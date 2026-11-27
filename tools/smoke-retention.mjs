export async function pruneSmokeRuns(store, runner) {
  const finished = runner.list().filter(run => !["queued", "running"].includes(run.status));
  const removed = [];
  for (const run of finished.slice(5)) {
    await store.remove(run.id);
    runner.runs.delete(run.id);
    removed.push(run.id);
  }
  return removed;
}
