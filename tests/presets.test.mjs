import test from "node:test";
import assert from "node:assert/strict";
import { Settings } from "../lib/settings.mjs";
import { temporary } from "./helpers.mjs";

test("presets preserve IDs on edit, capture copies, reject duplicate names and never contain targets", async t => {
  const settings = new Settings(await temporary(t), { defaultPrompt: "animate", capabilities: { presets: true } }); await settings.init();
  const parameters = { maxTokens: 64000, timeoutMs: 1800000, concurrency: 3 };
  const saved = await settings.save({ expectedRevision: 0, patch: { presetUpsert: { name: " 长推理 ", kind: "candy", parameters } } });
  const capture = structuredClone(saved.preset.parameters); assert.equal(saved.preset.name, "长推理");
  const edited = await settings.save({ expectedRevision: 1, patch: { presetUpsert: { id: saved.preset.id, name: "长推理", kind: "candy", parameters: { ...parameters, timeoutMs: 0 } } } });
  assert.equal(edited.preset.id, saved.preset.id); assert.equal(edited.preset.createdAt, saved.preset.createdAt); assert.equal(capture.timeoutMs, 1800000);
  for (const preset of [{ name: " ", kind: "candy", parameters }, { name: "bad\nname", kind: "candy", parameters }, { name: "x".repeat(41), kind: "candy", parameters }, { name: "长推理", kind: "candy", parameters }, { name: "bad", kind: "candy", parameters: { ...parameters, account: "secret" } }, { name: "bad", kind: "candy", parameters, models: ["one"] }]) {
    await assert.rejects(() => settings.save({ expectedRevision: 2, patch: { presetUpsert: preset } }), e => e.status === 400); assert.equal(settings.snapshot().revision, 2);
  }
  await settings.close();
});
test("preset capacity limits fail before committing and deleted presets survive restart as deleted", async t => {
  const dir = await temporary(t), settings = new Settings(dir, { capabilities: { presets: true } }); await settings.init();
  let first;
  for (let i = 0; i < 50; i++) { const result = await settings.save({ expectedRevision: i, patch: { presetUpsert: { name: `p${i}`, kind: "candy", parameters: { maxTokens: 0, timeoutMs: 0, concurrency: 0 } } } }); first ||= result.preset; }
  await assert.rejects(() => settings.save({ expectedRevision: 50, patch: { presetUpsert: { name: "overflow", kind: "candy", parameters: {} } } }), e => e.status === 400);
  await settings.save({ expectedRevision: 50, patch: { presetDelete: { id: first.id } } }); await settings.close();
  const restored = new Settings(dir); await restored.init(); assert.equal(restored.snapshot().presets.length, 49); assert.equal(restored.snapshot().presets.some(p => p.id === first.id), false); await restored.close();
});
test("one MiB total settings cap cannot be bypassed by many individually valid long presets", async t => {
  const settings = new Settings(await temporary(t), { capabilities: { presets: true } }); await settings.init(); let revision = 0, rejected = false;
  for (let i = 0; i < 40; i++) {
    try { await settings.save({ expectedRevision: revision, patch: { presetUpsert: { name: `large${i}`, kind: "pelican", parameters: { prompt: "中".repeat(12000) } } } }); revision++; }
    catch (error) { assert.equal(error.status, 413); rejected = true; break; }
  }
  assert.equal(rejected, true); assert.equal(settings.snapshot().revision, revision); await settings.close();
});
