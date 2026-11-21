import test from "node:test";
import assert from "node:assert/strict";
import { uiHarness } from "./ui-harness.mjs";
import { waitFor } from "./helpers.mjs";

const model = id => ({ id, name: id, provider: "fixture", providerName: "Fixture", efforts: [] });
const record = (id, batchId, kind, status, at, name = "one") => ({ id, batchId, kind, status, createdAt: at, model: `fixture/${name}`, modelName: name, provider: "fixture" });
const at = "2026-11-17T09:00:00.000Z";
const bootstrap = runs => ({ models: [model("fixture/one"), model("fixture/two")], runs, defaultPrompt: "prompt", candyAvailable: true, historyTimeZone: "UTC" });
const childrenWith = (ui, id, name) => ui.descendants(ui.elements.get(id)).filter(element => element.className === name);

test("daily animation endpoint buttons send every model lane directly to the oldest or newest end", async () => {
  const runs = ["one", "two"].flatMap(name => ["09", "12", "18"].map(hour => {
    const time = `2026-11-17T${hour}:00:00.000Z`;
    return { ...record(`${name}-${hour}`, `batch-${hour}`, "pelican", "completed", time, name), source: "automatic", scheduledAt: time };
  }));
  const ui = await uiHarness({ bootstrap: bootstrap(runs), detail: id => runs.find(run => run.id === id), search: "?view=history" });
  const row = await waitFor(() => childrenWith(ui, "history-list", "history-row")[0]); await row.fire("click");
  const controls = ui.descendants(ui.elements.get("history-results"), "button");
  const newest = controls.find(control => control.textContent === "最新"), oldest = controls.find(control => control.textContent === "最早");
  assert.ok(newest && oldest, "History gallery needs direct endpoint controls");
  const lanes = ui.descendants(ui.elements.get("history-results")).filter(element => element.className.split(/\s+/).includes("history-animation-lane"));
  assert.equal(lanes.length, 2); assert.equal(newest.disabled, true);
  for (const lane of lanes) lane.scrollLeft = 210;
  await oldest.fire("click");
  for (const lane of lanes) assert.equal(lane.scrollLeft, lane.scrollWidth - lane.clientWidth, "The oldest button must not stop at a partial page");
  assert.equal(oldest.disabled, true); assert.equal(newest.disabled, false);
  await newest.fire("click");
  for (const lane of lanes) assert.equal(lane.scrollLeft, 0);
  assert.equal(newest.disabled, true); assert.equal(oldest.disabled, false);
  assert.equal(ui.elements.get("history-filter").value, "");
});

test("a history row closes its result when pressed again", async () => {
  const run = record("manual-run", "manual-batch", "candy", "completed", at);
  const ui = await uiHarness({ bootstrap: bootstrap([run]), detail: async () => run, search: "?view=history" });
  const row = await waitFor(() => childrenWith(ui, "history-list", "history-row")[0]);
  await row.fire("click");
  assert.equal(ui.elements.get("history-detail").hidden, false);
  assert.equal(row.getAttribute("aria-pressed"), "true");
  await row.fire("click");
  assert.equal(ui.elements.get("history-detail").hidden, true);
  assert.equal(row.getAttribute("aria-pressed"), "false");
});

test("a daily candy stripe selects only its own model and time", async () => {
  const scheduled = (name, hour) => {
    const time = `2026-11-17T${hour}:00:00.000Z`;
    return { ...record(`${name}-${hour}`, `daily-${hour}`, "candy", "completed", `2026-11-17T${hour}:05:00.000Z`, name), source: "automatic", scheduledAt: time };
  };
  const runs = [scheduled("one", "09"), scheduled("two", "09"), scheduled("one", "11"), scheduled("two", "11"), scheduled("other", "10"), scheduled("other", "11")];
  const ui = await uiHarness({ bootstrap: bootstrap(runs), detail: id => runs.find(run => run.id === id), search: "?view=history" });
  const rows = await waitFor(() => { const list = childrenWith(ui, "history-list", "history-row"); return list.length === 2 && list; });
  await rows.find(row => row.getAttribute("aria-label").includes("2 个模型")).fire("click");
  const bars = () => childrenWith(ui, "history-results", "candy-bar");
  const slot = (name, hour) => bars().find(bar => bar.title.includes(`${name} · ${hour}:00`));
  const selected = () => bars().filter(bar => bar.getAttribute("aria-pressed") === "true");
  const cards = () => ui.descendants(ui.elements.get("history-results"), "article").map(card => card.dataset.runId).filter(Boolean);

  assert.equal(bars().length, 4);
  assert.deepEqual(cards(), [], "opening the day does not choose a time for every model");
  await slot("one", "09").fire("click");
  assert.deepEqual(selected(), [slot("one", "09")]);
  assert.deepEqual(cards(), ["one-09"]);
  await slot("two", "09").fire("click");
  assert.deepEqual(selected(), [slot("two", "09")]);
  assert.deepEqual(cards(), ["two-09"], "a different model at the same time switches the card");
  assert.match(childrenWith(ui, "history-results", "history-time-selection")[0].children[0].textContent, /09:00/);
  await slot("two", "11").fire("click");
  assert.deepEqual(cards(), ["two-11"]);
  await slot("two", "11").fire("click");
  assert.equal(selected().length, 0);
  assert.deepEqual(cards(), []);

  await rows.find(row => row.getAttribute("aria-label").includes("1 个模型")).fire("click");
  assert.equal(bars().length, 2);
  assert.equal(slot("other", "09"), undefined);
  await slot("other", "10").fire("click");
  assert.deepEqual(cards(), ["other-10"]);
});

test("a dense hourly history keeps missing hours visible without adding results or focus stops", async () => {
  const runs = Array.from({ length: 13 }, (_, i) => {
    const hour = String(i + 6).padStart(2, '0'), time = `2026-11-17T${hour}:00:00.000Z`;
    return { ...record(`run-${hour}`, `batch-${hour}`, "candy", "completed", time), source: "automatic", scheduledAt: time, candy: { verdict: "match" } };
  });
  const ui = await uiHarness({ bootstrap: bootstrap(runs), detail: id => runs.find(run => run.id === id), search: "?view=history" });
  const row = await waitFor(() => childrenWith(ui, "history-list", "history-row")[0]); await row.fire("click");
  const bars = childrenWith(ui, "history-results", "candy-bar");
  assert.equal(bars.length, 24);
  assert.match(bars[0].title, /00:00 · 无结果/);
  assert.match(bars[23].title, /23:00 · 无结果/);
  assert.equal(bars.filter(bar => !bar.disabled).length, 13);
  assert.equal(childrenWith(ui, "history-results", "candy-ratio")[0].textContent, "100%");
  await bars[6].fire("keydown", { key: "End" });
  assert.equal(ui.document.activeElement, bars[18]);
});

test("an older active manual batch stays reachable and joins the five recent batches when it finishes", async () => {
  const current = [record("new", "new-batch", "candy", "running", "2026-11-17T11:00:00Z", "two"), record("new-2", "new-batch", "candy", "running", "2026-11-17T11:00:00Z")];
  const running = record("older", "older-batch", "candy", "running", "2026-11-17T10:00:00Z");
  const finished = Array.from({ length: 6 }, (_, index) => [record(`one-${index}`, `batch-${index}`, "candy", "completed", `2026-11-17T09:0${6 - index}:00Z`),
    record(`two-${index}`, `batch-${index}`, "candy", "completed", `2026-11-17T09:0${6 - index}:00Z`, "two")]).flat();
  const runs = [...current, running, ...finished];
  const ui = await uiHarness({ bootstrap: bootstrap(runs), detail: async id => runs.find(run => run.id === id), search: "?view=candy" });
  const queue = () => childrenWith(ui, "running-batch-list", "running-batch");
  await waitFor(() => ui.elements.get("candy-tab").getAttribute("aria-selected") === "true");
  assert.deepEqual(queue().map(entry => entry.dataset.batchId), ["new-batch", "older-batch"]);
  const recent = () => childrenWith(ui, "candy-recent", "recent-batch");
  assert.deepEqual(recent().map(entry => entry.dataset.batchId), ["batch-0", "batch-1", "batch-2", "batch-3", "batch-4"]);
  const firstGrid = recent()[0].children.find(element => element.className === "results-grid");
  assert.deepEqual(firstGrid.children.map(card => card.dataset.runId), ["two-0", "one-0"]);
  ui.event("run", { run: { ...running, status: "completed" } });
  await waitFor(() => recent()[0].dataset.batchId === "older-batch");
  assert.deepEqual(queue().map(entry => entry.dataset.batchId), ["new-batch"]);
  assert.deepEqual(recent().map(entry => entry.dataset.batchId), ["older-batch", "batch-0", "batch-1", "batch-2", "batch-3"]);
});

for (const [view, kind, label] of [["current", "pelican", "鹈鹕动画"], ["fingerprint", "fingerprint", "模型指纹"], ["candy", "candy", "糖果测试"]]) {
  test(`${kind} results show the five latest finished batches without the current, active or automatic batches`, async () => {
    const current = record("current-run", "current-batch", kind, "completed", "2026-11-17T12:00:00Z");
    const older = Array.from({ length: 6 }, (_, index) => record(`older-${index}`, `batch-${index}`, kind, "completed", `2026-11-17T09:0${6 - index}:00Z`));
    const running = record("running-run", "running-batch", kind, "running", "2026-11-17T11:00:00Z");
    const automatic = { ...record("automatic-run", "automatic-batch", kind, "completed", "2026-11-17T13:00:00Z"), source: "automatic", scheduledAt: at };
    const different = record("different-run", "different-batch", kind === "candy" ? "fingerprint" : "candy", "completed", "2026-11-17T14:00:00Z");
    const runs = [current, automatic, different, running, ...older];
    const ui = await uiHarness({ bootstrap: bootstrap(runs), detail: id => runs.find(run => run.id === id), search: `?view=${view}` });
    const recent = await waitFor(() => { const entries = childrenWith(ui, `${view}-recent`, "recent-batch"); return entries.length && entries; });
    assert.deepEqual(recent.map(entry => entry.dataset.batchId), ["batch-0", "batch-1", "batch-2", "batch-3", "batch-4"]);
    assert.equal(ui.elements.get(`${view}-history-footer`)?.hidden, false, "The history shortcut follows the recent results");
    const shortcut = ui.elements.get(`${view}-history-link`);
    assert.ok(shortcut, "Each result page needs its own shortcut");
    const description = ui.elements.get(shortcut.getAttribute("aria-describedby"));
    assert.ok(description?.textContent.includes(label));
    assert.match(description.textContent, /手动测试/);
  });

  test(`${kind} history shortcut selects its own mode and manual source from different existing filters`, async () => {
    const otherKind = kind === "candy" ? "fingerprint" : "candy";
    const own = record("own-run", "own-batch", kind, "completed", at);
    const earlier = record("earlier-run", "earlier-batch", kind, "completed", "2026-11-17T08:00:00Z");
    const runs = [own, earlier, record("other-run", "other-batch", otherKind, "completed", at),
      { ...record("automatic-run", "automatic-batch", otherKind, "completed", at), source: "automatic", scheduledAt: at },
      { ...record("own-automatic-run", "own-automatic-batch", kind, "completed", at), source: "automatic", scheduledAt: at },
      { ...record("favorite-run", "favorite-batch", kind, "completed", at), favoriteId: "saved-model" }];
    const ui = await uiHarness({ bootstrap: bootstrap(runs), detail: id => runs.find(run => run.id === id), search: "?view=history" });
    await waitFor(() => childrenWith(ui, "history-list", "history-row").length === 6);
    ui.elements.get("history-filter").value = otherKind;
    ui.elements.get("history-source").value = "automatic";
    await ui.elements.get("history-source").fire("change");
    ui.elements.get("history-scroll").scrollTop = 275;
    await childrenWith(ui, "history-list", "history-row")[0].fire("click");
    ui.flushFrames();
    assert.equal(ui.elements.get("history-detail").hidden, false);
    await ui.elements.get(`${view}-tab`).fire("click");
    const shortcut = ui.elements.get(`${view}-history-link`);
    assert.ok(shortcut, "The result page needs a history shortcut");
    await shortcut.fire("click");
    ui.flushFrames();
    assert.equal(ui.elements.get("history-tab").getAttribute("aria-selected"), "true");
    assert.equal(ui.elements.get("history-filter").value, kind);
    assert.equal(ui.elements.get("history-source").value, "manual");
    assert.deepEqual(childrenWith(ui, "history-list", "history-item").map(entry => entry.dataset.batchId), ["own-batch", "earlier-batch"]);
    assert.equal(ui.elements.get("history-detail").hidden, true, "A previous automatic preview must not remain open");
    assert.equal(ui.elements.get("history-scroll").scrollTop, 0, "The filtered list opens at its newest batch");
    assert.equal(ui.document.activeElement, ui.elements.get("history-filter"), "Keyboard focus follows the destination");
  });
}

test("the history shortcut clears a previous matching manual preview without restoring its old scroll position", async () => {
  const runs = [record("current-run", "current-batch", "candy", "completed", at), record("older-run", "older-batch", "candy", "completed", "2026-11-17T08:00:00Z")];
  const ui = await uiHarness({ bootstrap: bootstrap(runs), detail: id => runs.find(run => run.id === id), search: "?view=history" });
  await waitFor(() => childrenWith(ui, "history-list", "history-row").length === 2);
  ui.elements.get("history-filter").value = "candy";
  ui.elements.get("history-source").value = "manual";
  await ui.elements.get("history-source").fire("change");
  ui.elements.get("history-scroll").scrollTop = 310;
  await childrenWith(ui, "history-list", "history-row")[1].fire("click");
  ui.flushFrames();
  await ui.elements.get("candy-tab").fire("click");
  const shortcut = ui.elements.get("candy-history-link");
  assert.ok(shortcut);
  await shortcut.fire("click");
  ui.flushFrames();
  assert.equal(ui.elements.get("history-detail").hidden, true);
  assert.equal(childrenWith(ui, "history-list", "history-row").some(row => row.getAttribute("aria-pressed") === "true"), false);
  assert.equal(ui.elements.get("history-scroll").scrollTop, 0);
});

test("the history shortcut is available after the first manual batch even without any older batches", async () => {
  const run = record("first-run", "first-batch", "candy", "completed", at);
  const ui = await uiHarness({ bootstrap: bootstrap([run]), detail: () => run, search: "?view=candy" });
  await waitFor(() => ui.descendants(ui.elements.get("candy-results"), "article").length === 1);
  assert.equal(ui.elements.get("candy-recent").hidden, true);
  assert.equal(ui.elements.get("candy-history-footer")?.hidden, false);
  assert.equal(ui.elements.get("current-history-footer")?.hidden, true, "An empty result page does not offer an unrelated history shortcut");
  await ui.elements.get("candy-history-link").fire("click");
  assert.deepEqual(childrenWith(ui, "history-list", "history-item").map(entry => entry.dataset.batchId), ["first-batch"]);
});
