import test from "node:test";
import assert from "node:assert/strict";
import { uiHarness } from "./ui-harness.mjs";
import { waitFor, FIXTURE_HTML } from "./helpers.mjs";

const animationId = "7301d12e-faf8-4e8e-84bc-294c76c3dd55", fingerprintId = "b4110b18-37f3-42e0-8244-96c073312361";
const model = { id: "fixture/chat", name: "A very long model name · Fixture", provider: "fixture", providerName: "Fixture", efforts: ["low", "high"] };
const animation = { id: animationId, batchId: animationId, model: model.id, modelName: model.name, status: "completed", hasHTML: true, createdAt: "2026-11-13T02:00:00Z" };
const fingerprint = { id: fingerprintId, batchId: fingerprintId, kind: "fingerprint", model: model.id, modelName: model.name, providerName: "Fixture", status: "completed", hasHTML: false, createdAt: "2026-11-13T01:00:00Z", revision: 5,
  fingerprint: { completed: 3, valid: 3, samples: [0, 1, 2].map(() => ({ state: "complete", count: 300, expectedCount: 300 })), prediction: "Reference A", family: "Family A", probability: .8, decision: "scored", verified: false } };
const boot = (runs = []) => ({ version: "0.2.0", models: [model], runs, defaultPrompt: "animation prompt", dataDir: "fixture-dir", batchCleanup: true, batchExport: true, batchCancel: true, fingerprintAvailable: true,
  bankStatus: { state: "missing", meta: null }, retentionDays: 7 });
const details = id => id === animationId ? { ...animation, html: FIXTURE_HTML, previewUrl: `preview/${id}?key=fixture`, content: FIXTURE_HTML } : { ...fingerprint,
  analysis: { decision: "scored", prediction: "reference/a", prediction_name: "Reference A", probability: .8, family_prediction_name: "Family A", results: [{ model: "reference/a", display_name: "Reference A", score: 1.3, probability: .8 }] },
  samples: [0, 1, 2].map(() => ({ state: "complete", text: "17, 300, 29", raw_text: "17, 300, 29", count: 300, expected_count: 300, provenance: { verified: false } })), bank: { builtAt: "fixture-bank", sha256: "a".repeat(64), sdkVersion: "0.2.0" } };
const buttons = (ui, container) => ui.descendants(ui.elements.get(container), "button");
const exportControl = (ui, batchId) => buttons(ui, "history-list").find(item => item.dataset.icon === "export" && item.parent.parent.dataset.batchId === batchId);
const exportSource = ui => ui.descendants(ui.elements.get("drawer-content"), "textarea")[0];
const exportCopy = ui => buttons(ui, "drawer-tools").find(item => item.textContent === "复制 JSON");

test("long fingerprint candidates and families remain available on hover and update with new results", async () => {
  const prediction = "Very long reference model candidate with a full experimental version", family = "Very long model family name";
  const saved = { ...fingerprint, fingerprint: { ...fingerprint.fingerprint, prediction, family } };
  const ui = await uiHarness({ bootstrap: boot([saved]), detail: details });
  const candidate = await waitFor(() => ui.descendants(ui.elements.get("fingerprint-results")).find(item => item.className === "fingerprint-prediction"));
  const familyName = ui.descendants(ui.elements.get("fingerprint-results")).find(item => item.className === "fingerprint-family");
  assert.equal(candidate.title, prediction); assert.equal(familyName.title, family);
  ui.event("run", { run: { ...saved, revision: 6, fingerprint: { ...saved.fingerprint, prediction: "New candidate", family: "New family" } } });
  await waitFor(() => candidate.textContent === "New candidate");
  assert.equal(candidate.title, "New candidate"); assert.equal(familyName.title, "New family");
});

test("each mode preserves its concurrency while history disables generation", async () => {
  const requests = [];
  const ui = await uiHarness({ bootstrap: boot(), detail: details, create: async body => {
    requests.push(body); return { runs: [body.kind === "fingerprint" ? fingerprint : animation] };
  } });
  await waitFor(() => ui.descendants(ui.elements.get("model-list"), "input").length);
  const pick = ui.descendants(ui.elements.get("model-list"), "input")[0]; pick.checked = true; await pick.fire("change");
  await ui.elements.get("generate").fire("click");
  await ui.elements.get("fingerprint-tab").fire("click"); await ui.elements.get("generate").fire("click");
  assert.deepEqual(requests.map(request => request.concurrency), [2, 3]);
  ui.elements.get("concurrency").value = "9"; await ui.elements.get("concurrency").fire("input");
  await ui.elements.get("current-tab").fire("click");
  ui.elements.get("concurrency").value = "7"; await ui.elements.get("concurrency").fire("input");
  await ui.elements.get("history-tab").fire("click"); await ui.elements.get("generate").fire("click");
  assert.equal(ui.elements.get("generate").disabled, true); assert.equal(requests.length, 2);
  await ui.elements.get("current-tab").fire("click"); assert.equal(ui.elements.get("generate").disabled, false);
  await ui.elements.get("generate").fire("click");
  await ui.elements.get("fingerprint-tab").fire("click"); await ui.elements.get("history-tab").fire("click");
  await ui.elements.get("generate").fire("click");
  assert.equal(ui.elements.get("generate").disabled, true); assert.equal(requests.length, 3);
  await ui.elements.get("fingerprint-tab").fire("click"); assert.equal(ui.elements.get("generate").disabled, false);
  await ui.elements.get("generate").fire("click");
  assert.deepEqual(requests.map(request => request.concurrency), [2, 3, 7, 9]);
});

test("history restored on startup cannot generate or become enabled after an async settings update", async t => {
  let release, calls = 0;
  const pendingBank = new Promise(resolve => { release = () => resolve({ state: "ready", meta: { modelCount: 70 } }); });
  t.after(release);
  const ui = await uiHarness({ bootstrap: boot(), detail: details, search: "?mode=fingerprint&view=history", bank: () => pendingBank,
    create: async () => { calls++; return { runs: [fingerprint] }; } });
  await waitFor(() => ui.descendants(ui.elements.get("model-list"), "input").length);
  assert.equal(ui.elements.get("history-tab").attributes["aria-selected"], "true");
  assert.equal(ui.elements.get("generate").disabled, true);
  const pick = ui.descendants(ui.elements.get("model-list"), "input")[0]; pick.checked = true; await pick.fire("change");
  const refresh = ui.elements.get("bank-refresh").fire("click"); release(); await refresh;
  assert.equal(ui.elements.get("generate").disabled, true); await ui.elements.get("generate").fire("click"); assert.equal(calls, 0);
});

test("a late creation response keeps the chosen history view and the test button disabled", async t => {
  let release, calls = 0;
  const reply = new Promise(resolve => { release = () => resolve({ runs: [fingerprint] }); });
  t.after(release);
  const ui = await uiHarness({ bootstrap: boot(), detail: details, create: () => { calls++; return reply; } });
  await waitFor(() => ui.descendants(ui.elements.get("model-list"), "input").length);
  const pick = ui.descendants(ui.elements.get("model-list"), "input")[0]; pick.checked = true; await pick.fire("change");
  await ui.elements.get("fingerprint-tab").fire("click");
  const pending = ui.elements.get("generate").fire("click");
  await ui.elements.get("history-tab").fire("click"); release(); await pending;
  assert.equal(ui.elements.get("history-tab").attributes["aria-selected"], "true");
  assert.equal(ui.elements.get("generate").disabled, true); await ui.elements.get("generate").fire("click"); assert.equal(calls, 1);
  assert.equal(ui.elements.get("history-count").textContent, "1 批");
  await ui.elements.get("fingerprint-tab").fire("click"); assert.equal(ui.elements.get("generate").disabled, false);
  assert.equal(ui.descendants(ui.elements.get("fingerprint-results"), "article")[0].dataset.runId, fingerprintId);
});

test("fingerprint titles omit only the provider suffix in current and historical cards", async () => {
  const saved = { ...fingerprint, model: "xingchi-api/gpt-6.1-sol", modelName: "GPT-6.1 Sol · v2 · XingChi API", provider: "xingchi-api", providerName: "XingChi API" };
  const ui = await uiHarness({ bootstrap: { ...boot([saved]), models: [] }, detail: () => ({ ...details(fingerprintId), ...saved }) });
  await waitFor(() => buttons(ui, "history-list").some(item => item.className === "history-row"));
  await buttons(ui, "history-list").find(item => item.className === "history-row").fire("click");
  for (const area of ["fingerprint-results", "history-results"]) {
    const title = ui.descendants(ui.elements.get(area), "h3")[0];
    assert.equal(title.textContent, "GPT-6.1 Sol · v2");
    assert.equal(title.title, `${saved.modelName}\n${saved.model}`);
    assert.equal(ui.descendants(ui.elements.get(area)).find(item => item.className === "card-provider").textContent, "XingChi API");
  }
});

test("clear selection removes picks, efforts and fixed accounts across providers while preserving results", async () => {
  const second = { ...model, id: "other/sol", name: "Sol · Other", provider: "other", providerName: "Other" }, sent = [];
  const ui = await uiHarness({ bootstrap: { ...boot([fingerprint]), models: [model, second] }, detail: details, accounts: () => [],
    create: body => { sent.push(body); return { runs: [fingerprint] }; } });
  await waitFor(() => ui.descendants(ui.elements.get("model-list"), "input").length === 2);
  const clear = ui.elements.get("clear-selection"); assert.ok(clear, "Selection needs a clear-all button"); assert.equal(clear.disabled, true);
  await ui.elements.get("fingerprint-tab").fire("click");
  const pin = ui.elements.get("fp-pin"); pin.checked = true; await pin.fire("change");
  for (const pick of ui.descendants(ui.elements.get("model-list"), "input")) { pick.checked = true; await pick.fire("change"); }
  const effort = ui.descendants(ui.elements.get("selected-models"), "select")[0]; effort.value = "high"; await effort.fire("change");
  const account = ui.descendants(ui.elements.get("selected-models"), "input")[0]; account.value = "account-a"; await account.fire("input");
  const provider = ui.elements.get("provider"), search = ui.elements.get("model-search"); provider.value = "other"; await provider.fire("change");
  search.value = "Sol"; await search.fire("input");
  assert.equal(clear.disabled, false); await clear.fire("click");
  assert.equal(clear.disabled, true); assert.equal(ui.elements.get("selection-count").textContent, "已选 0");
  assert.equal(ui.elements.get("selected-models").children.length, 0);
  assert.equal(ui.descendants(ui.elements.get("model-list"), "input").every(pick => !pick.checked), true);
  assert.equal(provider.value, "other"); assert.equal(search.value, "Sol");
  assert.equal(ui.elements.get("history-count").textContent, "1 批"); assert.equal(ui.descendants(ui.elements.get("fingerprint-results"), "article").length, 1);
  await ui.elements.get("generate").fire("click"); assert.equal(sent.length, 0);
  provider.value = ""; await provider.fire("change");
  assert.equal(ui.descendants(ui.elements.get("model-list"), "input").every(pick => !pick.checked), true);
  const pick = ui.descendants(ui.elements.get("model-list"), "input").find(item => item.value === model.id); pick.checked = true; await pick.fire("change");
  assert.equal(ui.descendants(ui.elements.get("selected-models"), "select")[0].value, "");
  assert.equal(ui.descendants(ui.elements.get("selected-models"), "input")[0].value, "");
  await ui.elements.get("generate").fire("click"); assert.equal(sent[0].models[0].effort, ""); assert.equal(sent[0].models[0].account, undefined);
});

test("history export opens the shared reader and clipboard denial selects its JSON", async () => {
  const ui = await uiHarness({ bootstrap: boot([fingerprint]), detail: details, search: "?view=history",
    exportBatch: () => ({ batchId: fingerprintId, kind: "fingerprint", runs: [details(fingerprintId)] }),
    writeClipboard: async () => { throw new Error("Clipboard unavailable"); } });
  const control = await waitFor(() => exportControl(ui, fingerprintId));
  ui.elements.get("history-scroll").scrollTop = 46;
  await control.fire("click");
  assert.equal(ui.elements.get("favorite-drawer").hidden, false);
  assert.equal(ui.elements.get("favorite-drawer").dataset.mode, "reading");
  assert.ok(exportSource(ui).readOnly);
  await exportCopy(ui).fire("click");
  const output = exportSource(ui);
  assert.equal(ui.document.activeElement, output);
  assert.equal(output.selectionStart, 0); assert.equal(output.selectionEnd, output.value.length);
  assert.equal(JSON.parse(output.value).batchId, fingerprintId);
  assert.equal(ui.elements.get("drawer-status").dataset.tone, "note");
  await ui.elements.get("favorite-drawer").fire("keydown", { key: "Escape" });
  assert.equal(exportSource(ui), undefined); assert.equal(ui.document.activeElement, control);
  assert.equal(ui.elements.get("history-scroll").scrollTop, 46);
});

test("a late export cannot overwrite the more recently requested batch", async t => {
  const replies = new Map();
  const ui = await uiHarness({ bootstrap: boot([animation, fingerprint]), detail: details, search: "?view=history",
    exportBatch: batchId => new Promise(resolve => replies.set(batchId, () => resolve({ batchId, runs: [details(batchId)] }))) });
  t.after(() => { for (const reply of replies.values()) reply(); });
  await waitFor(() => exportControl(ui, animationId));
  const first = exportControl(ui, animationId).fire("click"); await waitFor(() => replies.has(animationId));
  await ui.elements.get("drawer-close").fire("click");
  const second = exportControl(ui, fingerprintId).fire("click"); await waitFor(() => replies.has(fingerprintId));
  replies.get(fingerprintId)(); await second; replies.get(animationId)(); await first;
  assert.equal(JSON.parse(exportSource(ui).value).batchId, fingerprintId);
});

test("closing a pending export restores its opener and late data stays closed", async t => {
  let release;
  const reply = new Promise(resolve => { release = () => resolve({ batchId: fingerprintId, runs: [details(fingerprintId)] }); });
  t.after(release);
  const ui = await uiHarness({ bootstrap: boot([fingerprint]), detail: details, exportBatch: () => reply, search: "?view=history" });
  await waitFor(() => exportControl(ui, fingerprintId));
  const control = exportControl(ui, fingerprintId), pending = control.fire("click");
  await ui.elements.get("history-filter").fire("change"); assert.equal(exportCopy(ui).disabled, true);
  await ui.elements.get("drawer-close").fire("click"); assert.equal(ui.document.activeElement, control); release(); await pending;
  assert.equal(ui.elements.get("favorite-drawer").hidden, true); assert.equal(exportSource(ui), undefined);
});

test("export failure offers a retry and delayed clipboard failure cannot change a newer export", async t => {
  let attempts = 0, failCopy;
  const pendingCopy = new Promise((_resolve, reject) => { failCopy = () => reject(new Error("Clipboard unavailable")); });
  t.after(failCopy);
  const ui = await uiHarness({ bootstrap: boot([animation, fingerprint]), detail: details, search: "?view=history", writeClipboard: () => pendingCopy,
    exportBatch: batchId => { if (++attempts === 1) throw new Error("Temporary read failure"); return { batchId, runs: [details(batchId)] }; } });
  await waitFor(() => exportControl(ui, fingerprintId));
  await exportControl(ui, fingerprintId).fire("click");
  assert.equal(exportCopy(ui).disabled, true);
  assert.match(ui.elements.get("drawer-status").textContent, /Temporary read failure/);
  assert.equal(ui.elements.get("drawer-status").dataset.tone, "error");
  await buttons(ui, "drawer-content").find(item => item.textContent === "重试读取").fire("click");
  assert.equal(ui.elements.get("drawer-status").hidden, true);
  const copying = exportCopy(ui).fire("click");
  await ui.elements.get("drawer-close").fire("click");
  await exportControl(ui, animationId).fire("click"); failCopy(); await copying;
  assert.equal(JSON.parse(exportSource(ui).value).batchId, animationId);
  assert.equal(ui.elements.get("drawer-status").hidden, true);
  assert.equal(exportCopy(ui).disabled, false);
});

test("deleting an exported batch clears its displayed evidence and disables copying", async () => {
  const ui = await uiHarness({ bootstrap: boot([fingerprint]), detail: details, search: "?view=history",
    exportBatch: () => ({ batchId: fingerprintId, runs: [details(fingerprintId)] }) });
  await waitFor(() => exportControl(ui, fingerprintId)); await exportControl(ui, fingerprintId).fire("click");
  ui.event("removed", { ids: [fingerprintId] }); await waitFor(() => ui.elements.get("history-count").textContent === "0 批");
  assert.equal(ui.elements.get("favorite-drawer").hidden, true); assert.equal(exportSource(ui), undefined);
  assert.equal(exportCopy(ui), undefined);
  assert.equal(ui.copied.length, 0);
});

test("unchecking account pinning hides a pending account message and preserves cached picks for later", async t => {
  let release, count = 0;
  const reply = new Promise(resolve => { release = () => resolve([{ provider: "fixture", id: "main", name: "Main" }]); });
  t.after(release);
  const ui = await uiHarness({ bootstrap: boot(), detail: details, accounts: () => { count++; return reply; } });
  await waitFor(() => ui.descendants(ui.elements.get("model-list"), "input").length);
  await ui.elements.get("fingerprint-tab").fire("click");
  const pin = ui.elements.get("fp-pin"); pin.checked = true; const loading = pin.fire("change");
  pin.checked = false; await pin.fire("change"); assert.equal(ui.elements.get("account-status").hidden, true);
  release(); await loading; assert.equal(ui.elements.get("account-status").hidden, true);
  pin.checked = true; await pin.fire("change"); assert.equal(count, 1); assert.equal(ui.elements.get("account-status").hidden, true);
});

test("reference refresh reports failure without a ready state and can be retried", async () => {
  let calls = 0;
  const ready = { state: "ready", meta: { builtAt: "fixture", modelCount: 70, sha256: "a".repeat(64) } };
  const ui = await uiHarness({ bootstrap: { ...boot(), bankStatus: ready }, detail: details,
    bank: () => { if (++calls === 1) throw new Error("Download unavailable"); return ready; } });
  await waitFor(() => ui.descendants(ui.elements.get("model-list"), "input").length);
  await ui.elements.get("fingerprint-tab").fire("click"); await ui.elements.get("bank-refresh").fire("click");
  assert.equal(ui.elements.get("bank-status").dataset.state, "error"); assert.equal(ui.elements.get("bank-refresh").disabled, false);
  await ui.elements.get("bank-refresh").fire("click"); assert.equal(calls, 2);
  assert.equal(ui.elements.get("bank-status").dataset.state, "ready"); assert.equal(ui.elements.get("notice").hidden, true);
});

test("reopening fingerprint details retries a failed read without resampling", async () => {
  let reads = 0;
  const ui = await uiHarness({ bootstrap: boot([fingerprint]), detail: id => {
    if (++reads === 1) throw new Error("Temporary read failure"); return details(id);
  } });
  await waitFor(() => buttons(ui, "fingerprint-results").length);
  const disclose = buttons(ui, "fingerprint-results").find(item => item.attributes["aria-label"] === "指纹详情");
  await disclose.fire("click");
  await waitFor(() => ui.descendants(ui.elements.get("drawer-content")).some(item => item.textContent === "Temporary read failure"));
  assert.equal(reads, 1, "A failed read must wait for the user to retry");
  await ui.elements.get("drawer-close").fire("click"); await disclose.fire("click");
  await waitFor(() => ui.descendants(ui.elements.get("drawer-content")).some(item => item.textContent.includes("17, 300, 29")));
  assert.equal(reads, 2);
});

test("model names and providers occupy separate rows without a full-name disclosure", async () => {
  const ui = await uiHarness({ bootstrap: boot(), detail: details });
  await waitFor(() => ui.descendants(ui.elements.get("model-list"), "strong").length);
  assert.equal(ui.descendants(ui.elements.get("model-list"), "strong")[0].textContent, "A very long model name");
  assert.equal(ui.descendants(ui.elements.get("model-list"), "small")[0].textContent, "Fixture");
  assert.equal(ui.elements.get("model-names-toggle"), undefined);
  ui.elements.get("provider").value = "fixture"; await ui.elements.get("provider").fire("change");
  assert.equal(ui.descendants(ui.elements.get("model-list"), "small").length, 0);
});

test("test views preserve batches while hidden animations unload and history cannot start tests", async () => {
  let sent;
  const ui = await uiHarness({ bootstrap: boot([animation, fingerprint]), detail: details, create: async body => { sent = body; return { runs: [{ ...fingerprint, status: "queued", revision: 0 }] }; } });
  await waitFor(() => ui.descendants(ui.elements.get("results"), "iframe").length === 1);
  const frame = ui.descendants(ui.elements.get("results"), "iframe")[0];
  const tab = ui.elements.get("fingerprint-tab"); assert.ok(tab, "Fingerprint needs a separate current view"); await tab.fire("click");
  assert.equal(ui.descendants(ui.elements.get("results"), "iframe").length, 0);
  assert.equal(ui.elements.get("generate-label").textContent, "开始检测"); assert.equal(ui.elements.get("animation-settings").hidden, true);
  assert.equal(ui.elements.get("fingerprint-settings").hidden, false); assert.equal(ui.descendants(ui.elements.get("fingerprint-results"), "article").length, 1);
  assert.equal(ui.descendants(ui.elements.get("fingerprint-results"), "iframe").length, 0);
  await ui.elements.get("history-tab").fire("click"); assert.equal(ui.elements.get("generate-label").textContent, "开始检测");
  const pick = ui.descendants(ui.elements.get("model-list"), "input")[0]; pick.checked = true; await pick.fire("change");
  ui.elements.get("prompt").value = ""; ui.elements.get("max-tokens").value = "131072"; ui.elements.get("concurrency").value = "12";
  await ui.elements.get("generate").fire("click");
  assert.equal(sent, undefined); assert.equal(ui.elements.get("generate").disabled, true);
  await tab.fire("click"); await ui.elements.get("generate").fire("click");
  assert.equal(sent.kind, "fingerprint"); assert.equal(sent.prompt, undefined); assert.equal(sent.concurrency, 12); assert.equal(sent.maxTokens, 131072);
  assert.equal(tab.attributes["aria-selected"], "true");
  await ui.elements.get("current-tab").fire("click"); assert.equal(ui.descendants(ui.elements.get("results"), "iframe")[0].src, frame.src);
});

test("fingerprint cards reveal evidence on demand and history supports mode filtering and JSON export", async () => {
  const reads = [], exports = [];
  const ui = await uiHarness({ bootstrap: boot([animation, fingerprint]), detail: id => { reads.push(id); return details(id); },
    exportBatch: id => { exports.push(id); return { batchId: id, kind: "fingerprint", runs: [details(fingerprintId)] }; } });
  await waitFor(() => ui.elements.get("history-count").textContent === "2 批");
  await ui.elements.get("fingerprint-tab").fire("click");
  assert.equal(reads.includes(fingerprintId), false, "Overview already has the ranking and must not load raw samples");
  const disclose = buttons(ui, "fingerprint-results").find(item => item.attributes["aria-label"] === "指纹详情"); assert.ok(disclose); await disclose.fire("click");
  await waitFor(() => ui.descendants(ui.elements.get("drawer-content")).some(item => item.textContent.includes("17, 300, 29")));
  assert.ok(reads.includes(fingerprintId));
  await ui.elements.get("drawer-close").fire("click");
  const filter = ui.elements.get("history-filter"); assert.ok(filter); filter.value = "fingerprint"; await filter.fire("change");
  const rows = buttons(ui, "history-list").filter(item => item.className === "history-row"); assert.equal(rows.length, 1); await rows[0].fire("click");
  const exportButton = buttons(ui, "history-list").find(item => item.attributes["aria-label"]?.startsWith("导出")); assert.ok(exportButton); await exportButton.fire("click");
  assert.deepEqual(exports, [fingerprintId]); assert.equal(ui.elements.get("favorite-drawer").hidden, false);
  assert.equal(JSON.parse(exportSource(ui).value).batchId, fingerprintId);
  await exportCopy(ui).fire("click"); assert.equal(JSON.parse(ui.copied[0]).kind, "fingerprint");
  assert.equal(ui.elements.get("drawer-status").dataset.tone, "success");
  assert.equal(ui.descendants(ui.elements.get("history-results"), "iframe").length, 0);
});

test("reference updates and cached account loading are explicit and per-model account picks survive provider changes", async () => {
  const calls = [], accountCalls = [], creates = [];
  const ui = await uiHarness({ bootstrap: boot(), detail: details, bank: async path => { calls.push(path); return { state: "ready", meta: { builtAt: "test-bank", modelCount: 70, sha256: "a".repeat(64) } }; },
    accounts: async () => { accountCalls.push(1); return [{ provider: "fixture", id: "北冥", name: "Main" }]; }, create: async body => { creates.push(body); return { runs: [{ ...fingerprint, status: "queued", revision: 0 }] }; } });
  await waitFor(() => ui.descendants(ui.elements.get("model-list"), "input").length === 1);
  assert.deepEqual(calls, []); assert.deepEqual(accountCalls, []);
  await ui.elements.get("fingerprint-tab").fire("click"); assert.deepEqual(calls, []);
  await ui.elements.get("bank-refresh").fire("click"); assert.deepEqual(calls, ["api/fingerprint/bank/refresh"]);
  assert.ok(ui.elements.get("bank-status").textContent.includes("就绪"));
  const pick = ui.descendants(ui.elements.get("model-list"), "input")[0]; pick.checked = true; await pick.fire("change");
  const pin = ui.elements.get("fp-pin"); pin.checked = true; await pin.fire("change"); assert.deepEqual(accountCalls, [1]);
  const account = ui.descendants(ui.elements.get("selected-models"), "input").find(item => item.attributes["aria-label"]?.includes("固定账号")); assert.ok(account);
  account.value = "北冥"; await account.fire("input"); ui.elements.get("provider").value = "fixture"; await ui.elements.get("provider").fire("change");
  ui.elements.get("fp-strict").checked = true; ui.elements.get("fp-api").value = "messages";
  await ui.elements.get("generate").fire("click");
  assert.equal(creates[0].models[0].account, "北冥"); assert.equal(creates[0].strict, true); assert.equal(creates[0].api, "messages");
});

test("the upstream update marker stays inline and clears only after the user refreshes the bank", async () => {
  const ui = await uiHarness({ bootstrap: { ...boot(), bankStatus: { state: "ready", updateAvailable: true, meta: { modelCount: 70 } } }, detail: details,
    bank: async path => path.endsWith("/refresh") ? { state: "ready", updateAvailable: false, meta: { modelCount: 70 } } : { state: "ready", updateAvailable: true, meta: { modelCount: 70 } } });
  const badge = ui.elements.get("bank-update-badge");
  await waitFor(() => !badge.hidden);
  assert.equal(badge.hidden, false); assert.equal(badge.textContent, "有更新");
  assert.equal(ui.elements.get("bank-refresh").getAttribute("aria-label"), "有更新，更新参考库");
  await ui.elements.get("bank-refresh").fire("click");
  assert.equal(badge.hidden, true, "The marker clears when the selected upstream snapshot is installed");
});

test("reference check failures remain visible alongside the usable cached bank and last successful check", async () => {
  const lastSuccessfulCheckAt = Date.parse("2026-11-27T08:00:00Z");
  const ui = await uiHarness({ bootstrap: { ...boot(), bankStatus: { state: "ready", checkError: "参考库检查 HTTP 503", lastCheckedAt: lastSuccessfulCheckAt + 300000, lastSuccessfulCheckAt, meta: { modelCount: 70 } } }, detail: details });
  await waitFor(() => ui.elements.get("bank-status").textContent.includes("就绪"));
  assert.ok(ui.elements.get("bank-status").textContent.includes("检查失败"), "The failure must be visible even while bank details are collapsed");
  assert.ok(ui.elements.get("bank-meta").textContent.includes("检查失败"));
  assert.ok(ui.elements.get("bank-meta").textContent.includes("503"));
  assert.ok(ui.elements.get("bank-meta").textContent.includes("最近成功"));
  assert.equal(ui.elements.get("bank-refresh").disabled, false);
});

test("an older backend explains unavailable fingerprint detection without sending new endpoints", async () => {
  const calls = [];
  const ui = await uiHarness({ bootstrap: { ...boot(), fingerprintAvailable: false, batchExport: false, batchCancel: false }, detail: details, create: async body => { calls.push(body); return {}; } });
  await waitFor(() => ui.descendants(ui.elements.get("model-list"), "input").length);
  await ui.elements.get("fingerprint-tab").fire("click"); assert.equal(ui.elements.get("generate").disabled, true);
  assert.ok(ui.elements.get("fingerprint-unavailable").textContent.includes("重新开启"));
  assert.equal(ui.elements.get("bank-refresh").disabled, true); assert.deepEqual(calls, []);
  await ui.elements.get("current-tab").fire("click"); assert.equal(ui.elements.get("generate").disabled, false);
});

test("a provider-menu fingerprint action selects that provider only when sent by the Magpie parent", async () => {
  const ui = await uiHarness({ bootstrap: boot(), detail: details });
  await waitFor(() => ui.descendants(ui.elements.get("model-list"), "input").length);
  const action = { magpie: 1, event: "action", data: { id: "fingerprint", provider: { id: "fixture", name: "Fixture" } } };
  ui.message({ source: {}, data: action }); assert.equal(ui.elements.get("provider").value, "");
  ui.message({ source: ui.parent, data: action });
  assert.equal(ui.elements.get("provider").value, "fixture"); assert.equal(ui.elements.get("fingerprint-tab").attributes["aria-selected"], "true");
});
