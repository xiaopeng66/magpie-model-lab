import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Annotations } from "../lib/annotations.mjs";
import { temporary } from "./helpers.mjs";

test("protection persists with its own CAS and an explicit null after removal", async t => {
  const dir = await temporary(t), a = new Annotations(dir), id = randomUUID(); await a.init();
  const saved = await a.save({ runId: id, expectedRevision: 0, protected: true }); assert.equal(saved.revision, 1); assert.equal(a.isProtected(id), true);
  await assert.rejects(() => a.save({ runId: id, expectedRevision: 0, protected: false }), e => e.status === 409); await a.close();
  const restored = new Annotations(dir); await restored.init(); assert.equal(restored.isProtected(id), true);
  const cleared = await restored.save({ runId: id, expectedRevision: 1, protected: false }); assert.equal(cleared.annotation, null); assert.equal(cleared.revision, 2); await restored.close();
  assert.equal(JSON.parse(await readFile(join(dir, ".annotations/state.previous.json"), "utf8")).revision, 1);
});
test("damaged or missing protection index stays read-only, preserving original files", async t => {
  for (const body of ["bad", null, JSON.stringify({ schema: 88 })]) {
    const dir = await temporary(t); await mkdir(join(dir, ".annotations")); if (body !== null) await writeFile(join(dir, ".annotations/state.json"), body);
    const a = new Annotations(dir); await a.init(); assert.ok(a.recoveryError);
    await assert.rejects(() => a.save({ runId: randomUUID(), expectedRevision: 0, protected: true }), e => e.status === 503);
    if (body !== null) assert.equal(await readFile(join(dir, ".annotations/state.json"), "utf8"), body); await a.close();
  }
});
