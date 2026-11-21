export function createBatchRetest(document, { onRetest, onSource }) {
  const node = (tag, className = "", value) => { const element = document.createElement(tag); element.className = className; if (value !== undefined) element.textContent = value; return element; };
  const button = node("button", "quiet batch-retest", "原条件复测");
  const source = node("div", "batch-source"), sourceNote = node("span", "help"), sourceLink = node("button", "quiet", "查看原记录");
  let records = [], sourceId = "", busy = false, available = false, sourceAvailable = false;
  const updateState = () => {
    button.hidden = !available || !records.length;
    button.disabled = busy || !records.some(run => !["queued", "running"].includes(run.status));
    const link = records.find(run => run.retest)?.retest;
    source.hidden = !link; sourceId = link?.sourceRunId || ""; sourceLink.hidden = !sourceAvailable;
    if (link) {
      const note = `复测自 ${new Date(link.sourceTime).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })}${sourceAvailable ? "" : " · 原记录已清理"}`;
      if (sourceNote.textContent !== note) sourceNote.textContent = note;
    }
  };
  button.type = sourceLink.type = "button"; button.hidden = source.hidden = true;
  button.title = "核对保存的模型、题面和参数后，创建新的手动测试批次";
  source.append(sourceNote, sourceLink);
  sourceLink.addEventListener("click", () => onSource?.(sourceId));
  button.addEventListener("click", () => { if (!button.disabled) return onRetest?.(records.map(run => run.id), button); });
  return { button, source,
    setBusy(value) { busy = value; updateState(); },
    updateRun(run) {
      const index = records.findIndex(record => record.id === run?.id);
      if (index >= 0) { records[index] = run; updateState(); }
    },
    update(next, { canRetest = false, sourceAvailable: hasSource = false } = {}) {
      records = [...next]; available = canRetest; sourceAvailable = hasSource; updateState();
    }
  };
}
