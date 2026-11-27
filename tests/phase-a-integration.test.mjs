import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, lstat, symlink, unlink, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { Settings } from "../lib/settings.mjs";
import { StateFile } from "../lib/state-file.mjs";
import { acquireDataOwner } from "../lib/data-owner.mjs";
import { fakeGateway, temporary, waitFor, startTestServer, FIXTURE_HTML } from "./helpers.mjs";

async function authenticated(service) {
  await service.ready; const html = await (await fetch(service.url)).text();
  const headers = { "x-pelican-token": html.match(/name="pelican-token" content="([^"]+)"/)[1], "content-type": "application/json" };
  return async (path, body) => {
    const response = await fetch(service.url + path, body === undefined ? { headers } : { headers, method: "POST", body: JSON.stringify(body) });
    const result = await response.json(); assert.ok(response.ok, result.error || `${path}: ${response.status}`); return result;
  };
}
test("phase A authenticated flow freezes queued presets, protects cleanup, restores settings and retests original conditions", async t => {
  const dir = await temporary(t), holds = [], upstream = await fakeGateway(t, value => { holds.push(value); }); let service, now = Date.now();
  const start = async () => { service = await startTestServer({ port: 0, dataDir: dir, gatewayUrl: upstream.url, retentionNow: () => now }); return authenticated(service); }; t.after(() => service?.close());
  let call = await start(), revision = 0;
  const groups = { pelican: { prompt: "captured animation", maxTokens: 0, timeoutMs: 1800000, concurrency: 1, effortByModel: { "fixture/one": "high" } }, candy: { maxTokens: 0, timeoutMs: 0, concurrency: 0 }, fingerprint: { maxTokens: 64000, timeoutMs: 900000, concurrency: 3, api: "responses", strict: true, serviceTier: "flex" } };
  for (const [kind, value] of Object.entries(groups)) revision = (await call("api/settings/save", { expectedRevision: revision, patch: { manual: { [kind]: value } } })).revision;
  const created = await call("api/settings/save", { expectedRevision: revision, patch: { presetUpsert: { name: "Queue copy", kind: "pelican", parameters: groups.pelican } } }); revision = created.revision;
  const { effortByModel, ...parameters } = structuredClone(created.preset.parameters);
  const submitted = await call("api/runs", { ...parameters, models: [{ id: "fixture/one", effort: "high" }, { id: "fixture/two" }] }); await waitFor(() => holds.length === 1);
  assert.equal((await call(`api/runs/${submitted.runs[1].id}`)).progress.phase, "queued");
  revision = (await call("api/settings/save", { expectedRevision: revision, patch: { presetUpsert: { id: created.preset.id, name: "Changed", kind: "pelican", parameters: { prompt: "changed", timeoutMs: 0, maxTokens: 10, concurrency: 3 } } } })).revision;
  revision = (await call("api/settings/save", { expectedRevision: revision, patch: { presetDelete: { id: created.preset.id } } })).revision;
  holds[0].complete(FIXTURE_HTML); await waitFor(() => holds.length === 2); holds[1].complete(FIXTURE_HTML);
  await waitFor(async () => (await call("api/runs")).runs.every(run => run.status === "completed"));
  assert.ok(upstream.seen.requests.every(payload => payload.messages[0].content === "captured animation" && payload.max_tokens === undefined));
  for (const run of submitted.runs) { const detail = await call(`api/runs/${run.id}`); assert.equal(detail.timeoutMs, 1800000); assert.equal(detail.concurrency, 1); assert.equal(detail.progress.phase, "ended"); assert.equal(detail.runtimeTiming, undefined); }
  const protectedId = submitted.runs[0].id; await call("api/runs/annotations", { runId: protectedId, expectedRevision: 0, protected: true });
  revision = (await call("api/settings/save", { expectedRevision: revision, patch: { retention: { days: 30 } } })).revision;
  now += 8 * 86400000; const preview = await call("api/retention/preview", { days: 7 }); assert.equal(preview.candidateCount, 1); assert.equal(preview.skippedProtected, 1);
  revision = (await call("api/settings/save", { expectedRevision: revision, patch: { retention: { days: 7 } }, previewToken: preview.previewToken })).revision;
  assert.equal((await call("api/runs")).runs.length, 2); await service.close(); call = await start(); const boot = await call("api/bootstrap");
  assert.deepEqual(boot.runs.map(run => run.id), [protectedId]); assert.equal(boot.annotations.byRunId[protectedId].protected, true); assert.equal(boot.retentionDays, 7); assert.equal(boot.settings.revision, revision);
  const restored = await call("api/settings"); assert.equal(restored.settings.presets.length, 0);
  for (const [kind, value] of Object.entries(groups)) for (const [key, wanted] of Object.entries(value)) assert.deepEqual(restored.settings.manual[kind][key], wanted);
  const retest = await call("api/retests", { operationId: randomUUID(), runIds: [protectedId] }); await waitFor(() => holds.length === 3);
  assert.equal(upstream.seen.requests[2].messages[0].content, "captured animation"); assert.equal(upstream.seen.requests[2].reasoning_effort, "high"); assert.equal(retest.runs[0].timeoutMs, 1800000);
  holds[2].complete(FIXTURE_HTML); await waitFor(async () => (await call(`api/runs/${retest.runs[0].id}`)).status === "completed");
  const cleanup = await call("api/runs/cleanup", { mode: "all" }); assert.equal(cleanup.skippedProtected, 1); assert.deepEqual(cleanup.removed, [retest.runs[0].id]);
  assert.ok(await lstat(join(dir, protectedId, "run.json"))); assert.equal(upstream.seen.requests.length, 3);
  for (const path of ["settings.mjs", "run-progress.mjs", "lib/test-parameters.mjs", "lib/progress.mjs"]) { const response = await fetch(service.url + path); assert.equal(response.status, 200); assert.match(response.headers.get("content-type"), /javascript/); }
});
test("invalid UTF-8 and incomplete stored preset parameters preserve their original bytes and pause recovery", async t => {
  for (const corruption of ["utf8", "preset"]) {
    const dir = await temporary(t), settings = new Settings(dir, { capabilities: { presets: true } }); await settings.init();
    await settings.save({ expectedRevision: 0, patch: { presetUpsert: { name: "one", kind: "pelican", parameters: { prompt: "abc" } } } }); await settings.close();
    const path = join(dir, ".settings", "state.json"); let bytes = await readFile(path);
    if (corruption === "utf8") { const at = bytes.indexOf('"abc"'); bytes[at + 1] = 0xff; }
    else { const value = JSON.parse(bytes); value.presets[0].parameters = {}; bytes = Buffer.from(JSON.stringify(value)); }
    await writeFile(path, bytes); const restored = new Settings(dir); await restored.init();
    assert.ok(restored.recoveryError); assert.deepEqual(await readFile(path), bytes); await assert.rejects(() => restored.save({ expectedRevision: 0, patch: { manual: { candy: {} } } })); await restored.close();
  }
});
test("external state replacement detected during a write pauses cleanup rather than continuing with stale settings", async t => {
  const dir = await temporary(t), settings = new Settings(dir); await settings.init(); const path = join(dir, ".settings", "state.json"), external = settings.snapshot(); external.retention.days = null; external.revision++;
  await writeFile(path, JSON.stringify(external)); await assert.rejects(() => settings.save({ expectedRevision: 0, patch: { manual: { candy: { timeoutMs: 0 } } } }), e => e.status === 409);
  assert.ok(settings.recoveryError); assert.deepEqual(JSON.parse(await readFile(path, "utf8")), external); await settings.close();
});
test("close cancels live generation before a slow accepted settings write drains", async t => {
  const dir = await temporary(t), upstream = await fakeGateway(t, ({ res }) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders(); });
  const service = await startTestServer({ port: 0, dataDir: dir, gatewayUrl: upstream.url }); const call = await authenticated(service);
  const original = StateFile.prototype.replace; let release, gated = false;
  StateFile.prototype.replace = async function(path, value) {
    if (this.dir === join(dir, '.settings') && path === this.path && value.revision === 1) { gated = true; await new Promise(resolve => { release = resolve; }); }
    return original.call(this, path, value);
  };
  t.after(async () => { release?.(); StateFile.prototype.replace = original; await service.close(); });
  const saving = call("api/settings/save", { expectedRevision: 0, patch: { manual: { candy: { timeoutMs: 0 } } } }).catch(() => null); await waitFor(() => gated);
  await call("api/runs", { prompt: "hold", models: [{ id: "fixture/one" }], timeoutMs: 0 }); await waitFor(() => upstream.seen.requests.length === 1);
  const closing = service.close(); await waitFor(() => upstream.seen.aborted === 1); assert.ok(release); release(); await closing; await saving;
  assert.equal(JSON.parse(await readFile(join(dir, ".settings", "state.json"), "utf8")).revision, 1); await (await acquireDataOwner(dir)).release();
});
test("an abnormal writer exit is recoverable on Windows and junction paths remain refused", async t => {
  const dir = await temporary(t), moduleURL = new URL("../lib/data-owner.mjs", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `import {acquireDataOwner} from ${JSON.stringify(moduleURL)}; await acquireDataOwner(process.argv[1]); process.exit(9);`, dir], { stdio: "ignore", windowsHide: true });
  const code = await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); }); assert.equal(code, 9);
  if (process.platform === "win32") await (await acquireDataOwner(dir)).release();
  else {
    await assert.rejects(() => acquireDataOwner(dir), e => e.status === 503);
    await unlink(join(dir, ".data-owner", "owner.json")); await rmdir(join(dir, ".data-owner")); await (await acquireDataOwner(dir)).release();
  }
  const external = await temporary(t), link = join(dir, "linked"); await symlink(external, link, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(() => acquireDataOwner(link), e => e.status === 503);
});
