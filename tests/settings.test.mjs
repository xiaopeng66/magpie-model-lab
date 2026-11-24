import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Settings } from "../lib/settings.mjs";
import { temporary } from "./helpers.mjs";

test("CAS commits exactly one writer, keeps previous state, and restores mode parameters", async t => {
  const dir = await temporary(t), settings = new Settings(dir, { defaultPrompt: "animate" }); await settings.init();
  assert.equal(settings.snapshot().revision, 0);
  const outcomes = await Promise.allSettled([0, 1].map(() => settings.save({ expectedRevision: 0, patch: { manual: { candy: { maxTokens: 0, timeoutMs: 1800000, concurrency: 0 } } } })));
  assert.equal(outcomes.filter(x => x.status === "fulfilled").length, 1); assert.equal(outcomes.find(x => x.status === "rejected").reason.status, 409);
  assert.equal(JSON.parse(await readFile(join(dir, ".settings/state.previous.json"), "utf8")).revision, 0);
  const copy = settings.snapshot(); copy.manual.candy.timeoutMs = 7; assert.equal(settings.snapshot().manual.candy.timeoutMs, 1800000);
  await settings.close(); const restored = new Settings(dir, { defaultPrompt: "animate" }); await restored.init();
  assert.equal(restored.snapshot().manual.candy.timeoutMs, 1800000); assert.equal(restored.snapshot().manual.pelican.prompt, "animate"); await restored.close();
});
test("damaged, missing and unknown schema settings remain read-only with original bytes intact", async t => {
  for (const value of ["bad json", JSON.stringify({ schema: 99 }), null]) {
    const dir = await temporary(t); await mkdir(join(dir, ".settings"));
    if (value !== null) await writeFile(join(dir, ".settings/state.json"), value);
    const settings = new Settings(dir, { defaultPrompt: "animate" }); await settings.init(); assert.ok(settings.recoveryError);
    await assert.rejects(() => settings.save({ expectedRevision: 0, patch: { progressNotice: { enabled: false } } }), e => e.status === 503);
    if (value !== null) assert.equal(await readFile(join(dir, ".settings/state.json"), "utf8"), value);
    await settings.close();
  }
});
test("unimplemented retention cannot accept extension, permanent or shorter policy", async t => {
  const settings = new Settings(await temporary(t), { defaultPrompt: "animate" }); await settings.init();
  for (const days of [30, null, 1]) await assert.rejects(() => settings.save({ expectedRevision: 0, patch: { retention: { days } } }), e => e.status === 409);
  assert.equal(settings.snapshot().revision, 0); await settings.close();
});
test("invalid groups and writes fail without changing memory; accepted writes drain on close", async t => {
  const dir = await temporary(t), settings = new Settings(dir, { defaultPrompt: "animate" }); await settings.init();
  for (const patch of [{ unknown: true }, { manual: { candy: { account: "x" } } }, { manual: { candy: {}, fingerprint: {} } }, { progressNotice: { enabled: null } }]) await assert.rejects(() => settings.save({ expectedRevision: 0, patch }), e => e.status === 400);
  const save = settings.save({ expectedRevision: 0, patch: { manual: { pelican: { prompt: "中文".repeat(6000), maxTokens: 0, timeoutMs: 0, concurrency: 1 } } } });
  await settings.close(); await save; assert.equal(settings.snapshot().revision, 1);
  await assert.rejects(() => settings.save({ expectedRevision: 1, patch: { progressNotice: { enabled: true } } }), e => e.status === 503);
  const reopened = new Settings(dir, { defaultPrompt: "animate" }); await reopened.init();
  await rm(join(dir, ".settings/state.json")); await mkdir(join(dir, ".settings/state.json"));
  await assert.rejects(() => reopened.save({ expectedRevision: 1, patch: { progressNotice: { enabled: false } } }));
  assert.equal(reopened.snapshot().revision, 1); await reopened.close();
});
