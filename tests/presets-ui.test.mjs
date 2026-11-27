import test from "node:test";
import assert from "node:assert/strict";
import { createSettingsUI } from "../ui/settings.mjs";
import { parameterDefaults } from "../lib/test-parameters.mjs";
import { uiHarness } from "./ui-harness.mjs";
import { waitFor } from "./helpers.mjs";

test("loading a preset copies its parameters; deleting the source cannot mutate current or captured parameters", async () => {
  const state = { revision: 0, manual: Object.fromEntries(["pelican", "candy", "fingerprint"].map(k => [k, parameterDefaults(k, "animate")])), presets: [{ id: "preset", kind: "candy", name: "Long", parameters: { maxTokens: 0, timeoutMs: 1800000, concurrency: 1 } }] };
  let fields; const ui = createSettingsUI({ api: async () => ({ settings: state }), readFields: () => fields, writeFields: value => { fields = value; } });
  ui.load(state, { memory: true, presets: true }); ui.switchKind("candy"); await ui.loadPreset("preset"); const captured = ui.capture("candy");
  state.presets[0].parameters.timeoutMs = 0; state.presets = []; assert.equal(fields.timeoutMs, 1800000); assert.equal(captured.timeoutMs, 1800000);
  await assert.rejects(() => ui.loadPreset("preset")); assert.equal(fields.timeoutMs, 1800000); ui.dispose();
});
test("a lost preset creation reply is reconciled to the committed ID without a second create", async () => {
  const state = { revision: 0, manual: Object.fromEntries(["pelican", "candy", "fingerprint"].map(k => [k, parameterDefaults(k, "animate")])), presets: [] }; let fields, writes = 0;
  const ui = createSettingsUI({ api: async (path, options) => {
    if (path === "api/settings") return { settings: state };
    writes++; const value = JSON.parse(options.body).patch.presetUpsert; state.revision = 1; state.presets.push({ ...value, id: "committed-id" }); throw new Error("reply lost");
  }, readFields: () => fields, writeFields: value => { fields = value; } });
  ui.load(state, { memory: true, presets: true });
  const result = await ui.savePatch({ presetUpsert: { name: "Long", kind: "candy", parameters: { maxTokens: 0, timeoutMs: 1800000, concurrency: 1 } } });
  assert.equal(result.state, "saved"); assert.equal(ui.snapshot().presets[0].id, "committed-id"); assert.equal(writes, 1); ui.dispose();
});
test("retry retains an unknown preset command and reconciles its late commit without creating again", async () => {
  const state = { revision: 0, manual: Object.fromEntries(["pelican", "candy", "fingerprint"].map(k => [k, parameterDefaults(k, "animate")])), presets: [] }; let fields, writes = 0, offline = true, submitted;
  const ui = createSettingsUI({ api: async (path, options) => {
    if (path === "api/settings") { if (offline) throw new Error("offline"); return { settings: state }; }
    writes++; submitted = JSON.parse(options.body).patch.presetUpsert; throw new Error("reply lost");
  }, readFields: () => fields, writeFields: value => { fields = value; } });
  ui.load(state, { memory: true, presets: true });
  assert.equal((await ui.savePatch({ presetUpsert: { name: "Late", kind: "candy", parameters: { maxTokens: 0, timeoutMs: 0, concurrency: 1 } } })).state, "failed");
  state.revision = 1; state.presets.push({ ...submitted, id: "late-id" }); offline = false;
  assert.equal((await ui.retry()).state, "saved"); assert.equal(ui.snapshot().presets[0].id, "late-id"); assert.equal(writes, 1); ui.dispose();
});
test("a known preset rejection keeps its error and allows a corrected command", async () => {
  const state = { revision: 0, manual: Object.fromEntries(["pelican", "candy", "fingerprint"].map(k => [k, parameterDefaults(k, "animate")])), presets: [] }; let fields, writes = 0;
  const ui = createSettingsUI({ api: async (path, options) => {
    if (path === "api/settings") return { settings: state };
    const value = JSON.parse(options.body).patch.presetUpsert; writes++;
    if (!value.name.trim()) throw Object.assign(new Error("name required"), { status: 400 });
    state.revision++; const preset = { ...value, id: "fixed" }; state.presets.push(preset); return { revision: state.revision, changed: {}, preset };
  }, readFields: () => fields, writeFields: value => { fields = value; } });
  ui.load(state, { memory: true, presets: true });
  assert.equal((await ui.savePatch({ presetUpsert: { name: " ", kind: "candy", parameters: {} } })).state, "failed");
  const result = await ui.savePatch({ presetUpsert: { name: "Fixed", kind: "candy", parameters: {} } });
  assert.equal(result.state, "saved"); assert.equal(writes, 2); ui.dispose();
});
test("preset management uses the existing drawer and sends a parameter snapshot without selected accounts", async () => {
  const state = { revision: 0, manual: Object.fromEntries(["pelican", "candy", "fingerprint"].map(k => [k, parameterDefaults(k, "animate")])), retention: { days: 7 }, progressNotice: { enabled: true }, presets: [] }; let saved;
  const ui = await uiHarness({ bootstrap: { models: [], runs: [], defaultPrompt: "animate", settings: state, settingsCapabilities: { memory: true, presets: true } }, settings: async (path, options) => {
    if (!options.body) return { settings: state };
    const body = JSON.parse(options.body); if (body.patch.presetUpsert) { saved = body.patch.presetUpsert; state.presets.push({ ...saved, id: "new-preset" }); }
    return { revision: ++state.revision, changed: { presetCatalog: state.presets }, preset: state.presets[0] };
  } });
  await waitFor(() => !ui.elements.get("manage-presets").hidden); await ui.elements.get("manage-presets").fire("click");
  const controls = ui.descendants(ui.elements.get("drawer-content")), name = controls.find(e => e.getAttribute("aria-label") === "方案名称"); name.value = "Animation"; await name.fire("input");
  await ui.descendants(ui.elements.get("drawer-footer"), "button").find(e => e.textContent === "保存为新方案").fire("click"); assert.equal(saved.kind, "pelican"); assert.equal(saved.parameters.timeoutMs, 600000); assert.equal(saved.parameters.prompt, "animate"); assert.equal(Object.hasOwn(saved, "models"), false); assert.equal(Object.hasOwn(saved.parameters, "account"), false);
});

for (const action of ['new', 'switch', 'delete']) for (const cancel of ['button', 'Escape'])
  test(`canceling preset ${action} with ${cancel} retains the draft and restores trigger focus`, async t => {
    const state = { revision: 0, manual: Object.fromEntries(['pelican', 'candy', 'fingerprint'].map(kind => [kind, parameterDefaults(kind, 'animate')])),
      retention: { days: 7 }, progressNotice: { enabled: true }, presets: ['one', 'two'].map(id => ({ id, name: id, kind: 'pelican', parameters: parameterDefaults('pelican', 'animate') })) };
    let writes = 0;
    const ui = await uiHarness({ bootstrap: { models: [], runs: [], defaultPrompt: 'animate', settings: state, settingsCapabilities: { memory: true, presets: true } },
      settings: async (_path, options) => { if (options.body) writes++; return { settings: state }; } });
    t.after(() => ui.closeStream());
    await waitFor(() => !ui.elements.get('manage-presets').hidden); await ui.elements.get('manage-presets').fire('click');
    const controls = ui.descendants(ui.elements.get('drawer-content'));
    const pick = controls.find(control => control.getAttribute('aria-label') === '选择方案');
    const name = controls.find(control => control.getAttribute('aria-label') === '方案名称');
    pick.value = 'one'; await pick.fire('change'); name.value = '尚未保存的草稿'; await name.fire('input');
    const control = action === 'switch' ? pick : controls.find(control => control.tagName === 'BUTTON' && control.textContent === (action === 'new' ? '新建方案' : '删除方案'));
    control.focus(); if (action === 'switch') pick.value = 'two';
    const completion = control.fire(action === 'switch' ? 'change' : 'click');
    await waitFor(() => ui.elements.get('confirm-dialog').open);
    await ui.elements.get(cancel === 'button' ? 'confirm-cancel' : 'confirm-dialog').fire(cancel === 'button' ? 'click' : 'cancel');
    await completion;
    assert.equal(control.disabled, false); assert.equal(ui.elements.get('favorite-drawer').hidden, false);
    assert.equal(name.value, '尚未保存的草稿'); assert.equal(pick.value, 'one'); assert.equal(writes, 0);
    assert.ok(ui.document.activeElement === control, 'The confirmation must return focus to its enabled trigger');
  });
