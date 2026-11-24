import test from "node:test";
import assert from "node:assert/strict";
import { createSettingsUI } from "../ui/settings.mjs";
import { parameterDefaults } from "../lib/test-parameters.mjs";
import { uiHarness } from "./ui-harness.mjs";
import { waitFor } from "./helpers.mjs";

const initial = () => ({ revision: 0, manual: Object.fromEntries(["pelican", "candy", "fingerprint"].map(kind => [kind, parameterDefaults(kind, "animate")])), retention: { days: 7 }, progressNotice: { enabled: true }, presets: [] });
function clock() {
  let now = 0, id = 0; const pending = new Map();
  return { setTimeout(fn, delay) { pending.set(++id, { fn, at: now + delay }); return id; }, clearTimeout(id) { pending.delete(id); },
    async advance(ms) { now += ms; for (let pass = 0; pass < 30; pass++) { const ready = [...pending].filter(([, v]) => v.at <= now); for (const [key, value] of ready) { pending.delete(key); value.fn(); } await Promise.resolve(); } } };
}
function setup(api) {
  const timers = clock(); let fields = parameterDefaults("pelican", "animate"), status;
  const ui = createSettingsUI({ api, defaultPrompt: "animate", readFields: () => structuredClone(fields), writeFields: value => { fields = structuredClone(value); }, setSaveStatus: value => { status = value; }, timers });
  ui.load(initial(), { memory: true });
  return { ui, timers, get fields() { return fields; }, get status() { return status; } };
}
test("600 ms debounce coalesces edits; an old response never clears the newer draft", async () => {
  const jobs = []; const s = setup((_path, options) => new Promise(resolve => jobs.push({ body: JSON.parse(options.body), resolve })));
  s.fields.timeoutMs = 1800000; s.ui.changed(); await s.timers.advance(599); assert.equal(jobs.length, 0);
  await s.timers.advance(1); assert.equal(jobs.length, 1);
  s.fields.timeoutMs = 0; s.ui.changed(); await s.timers.advance(600); assert.equal(jobs.length, 1);
  jobs[0].resolve({ revision: 1, changed: { manual: jobs[0].body.patch.manual } }); await s.timers.advance(0);
  assert.equal(jobs.length, 2); assert.equal(jobs[1].body.patch.manual.pelican.timeoutMs, 0); assert.equal(jobs[1].body.expectedRevision, 1);
  jobs[1].resolve({ revision: 2, changed: { manual: jobs[1].body.patch.manual } }); await s.timers.advance(0);
  assert.equal(s.status.state, "saved"); assert.equal(s.ui.capture("pelican").timeoutMs, 0); s.ui.dispose();
});

test('an acknowledged group save reports success while a newer manual draft remains pending', async () => {
  const jobs = [], s = setup((_path, options) => new Promise(resolve => jobs.push({ body: JSON.parse(options.body), resolve })));
  const saved = s.ui.savePatch({ progressNotice: { enabled: false } }); await s.timers.advance(0);
  s.fields.timeoutMs = 0; s.ui.changed();
  jobs[0].resolve({ revision: 1, changed: { progressNotice: { enabled: false } } }); await s.timers.advance(0);
  assert.equal((await saved).state, 'saved'); assert.equal(s.status.state, 'pending');
  assert.equal(s.ui.snapshot().progressNotice.enabled, false); assert.equal(s.ui.capture().timeoutMs, 0);
  jobs[1].resolve({ revision: 2, changed: { manual: jobs[1].body.patch.manual } }); await s.timers.advance(0);
  assert.equal(s.status.state, 'saved'); s.ui.dispose();
});

test('a group command queued behind a manual save waits for its own acknowledgment', async () => {
  const jobs = [], s = setup((_path, options) => new Promise(resolve => jobs.push({ body: JSON.parse(options.body), resolve })));
  s.fields.timeoutMs = 0; s.ui.changed(); await s.timers.advance(600); let feedback;
  const saved = s.ui.savePatch({ progressNotice: { enabled: false } }).then(value => { feedback = value; }); await s.timers.advance(0);
  assert.equal(jobs.length, 1); jobs[0].resolve({ revision: 1, changed: { manual: jobs[0].body.patch.manual } }); await s.timers.advance(0);
  assert.equal(jobs.length, 2); assert.equal(feedback, undefined); assert.equal(s.ui.snapshot().progressNotice.enabled, true);
  jobs[1].resolve({ revision: 2, changed: { progressNotice: { enabled: false } } }); await s.timers.advance(0); await saved;
  assert.equal(feedback.state, 'saved'); assert.equal(s.ui.snapshot().progressNotice.enabled, false); s.ui.dispose();
});
test("each mode restores its own timeout and concurrency without a save on initialization", async () => {
  const jobs = []; const s = setup(async (_path, options) => { jobs.push(JSON.parse(options.body)); return { revision: jobs.length, changed: jobs.at(-1).patch }; });
  assert.equal(jobs.length, 0); s.fields.timeoutMs = 1800000; s.ui.changed(); s.ui.switchKind("candy");
  s.fields.timeoutMs = 0; s.fields.concurrency = 0; s.ui.changed(); s.ui.switchKind("fingerprint");
  assert.equal(s.fields.timeoutMs, 600000); assert.equal(s.fields.concurrency, 3); s.ui.switchKind("pelican"); assert.equal(s.fields.timeoutMs, 1800000);
  s.ui.switchKind("candy"); assert.equal(s.fields.timeoutMs, 0); assert.equal(s.fields.concurrency, 0); s.ui.dispose();
});
test("different-group CAS retries once while same-group CAS keeps the local draft", async () => {
  for (const same of [false, true]) {
    let writes = 0; const remote = initial(); remote.revision = 1; if (same) remote.manual.pelican.timeoutMs = 300000;
    const s = setup(async (path, options) => {
      if (path === "api/settings") return { settings: remote };
      if (++writes === 1) throw Object.assign(new Error("conflict"), { status: 409 });
      return { revision: 2, changed: JSON.parse(options.body).patch };
    });
    s.fields.timeoutMs = 1800000; s.ui.changed(); await s.timers.advance(600);
    assert.equal(writes, same ? 1 : 2); assert.equal(s.status.state, same ? "conflict" : "saved"); assert.equal(s.ui.capture("pelican").timeoutMs, 1800000); s.ui.dispose();
  }
});
test("retry and invalidation cannot silently resolve a same-group conflict", async () => {
  let writes = 0; const remote = initial(); remote.revision = 1; remote.manual.pelican.timeoutMs = 300000;
  const s = setup(async path => { if (path === "api/settings") return { settings: remote }; writes++; throw Object.assign(new Error("conflict"), { status: 409 }); });
  s.fields.timeoutMs = 1800000; s.ui.changed(); await s.timers.advance(600); assert.equal(s.status.state, "conflict");
  await s.ui.invalidate(); assert.equal(s.status.state, "conflict"); await s.ui.retry(); await s.timers.advance(0);
  assert.equal(s.status.state, "conflict"); assert.equal(writes, 1); assert.equal(s.ui.capture().timeoutMs, 1800000);
  s.ui.resolveConflict("server"); assert.equal(s.ui.capture().timeoutMs, 300000); s.ui.dispose();
});
test("ignored abort is bounded at 10 seconds and failed reconciliation stops automatic looping", async () => {
  let reads = 0, writes = 0; const s = setup(path => { path === "api/settings" ? reads++ : writes++; return new Promise(() => {}); });
  s.fields.timeoutMs = 0; s.ui.changed(); await s.timers.advance(600); await s.timers.advance(5000); assert.equal(s.status.state, "pending");
  await s.timers.advance(5000); assert.equal(reads, 1); await s.timers.advance(5000); assert.equal(s.status.state, "failed");
  s.fields.maxTokens = 0; s.ui.changed(); await s.timers.advance(20000); assert.equal(writes, 1); assert.equal(s.ui.capture("pelican").maxTokens, 0); s.ui.dispose();
});
test("generation freezes the current snapshot and proceeds while a settings save hangs", async () => {
  const boot = { models: [{ id: "fixture/one", name: "One", provider: "fixture", efforts: [] }], runs: [], version: "test", defaultPrompt: "animate", settings: initial(), settingsCapabilities: { memory: true }, candyAvailable: true };
  let submitted;
  const ui = await uiHarness({ bootstrap: boot, settings: async () => new Promise(() => {}), create: async body => { submitted = body; return { runs: [{ id: "run", batchId: "run", kind: "pelican", status: "queued", createdAt: new Date().toISOString(), model: "fixture/one" }] }; }, detail: () => ({}) });
  await waitFor(() => ui.elements.get("generate").disabled === false);
  const pick = ui.descendants(ui.elements.get("model-list"), "input")[0]; pick.checked = true; await pick.fire("change");
  ui.elements.get("generation-timeout").value = "1800"; await ui.elements.get("generation-timeout").fire("input");
  await ui.elements.get("generate").fire("click"); assert.equal(submitted.timeoutMs, 1800000); assert.equal(submitted.prompt, "animate");
});
