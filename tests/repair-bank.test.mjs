import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FingerprintBank } from "../lib/fingerprint-bank.mjs";
import { temporary } from "./helpers.mjs";
import { referenceFixture, numberReply } from "./fingerprint-helpers.mjs";

function modifiedFixture(mutate) {
  const fixture = referenceFixture("repair-scoring", true), length = fixture.detector.readUInt32LE(0);
  const artifact = JSON.parse(fixture.detector.subarray(4, 4 + length)); mutate(artifact);
  const json = Buffer.from(JSON.stringify(artifact)), detector = Buffer.alloc(Math.ceil((4 + json.length) / 4) * 4);
  detector.writeUInt32LE(json.length); json.copy(detector, 4);
  const frame = Buffer.alloc(12); frame.writeUInt32LE(0xfd2fb528); frame[4] = 0xa0; frame.writeUInt32LE(detector.length, 5); frame.writeUIntLE((detector.length << 3) | 1, 9, 3);
  const compressed = Buffer.concat([frame, detector]), bundle = JSON.parse(fixture.bundle);
  bundle.files["shared_detector.bin"].sha256 = createHash("sha256").update(detector).digest("hex"); bundle.files["shared_detector.bin"].bytes = compressed.length;
  return { bundle: Buffer.from(JSON.stringify(bundle)), detector, compressed };
}
const outputs = Array.from({ length: 3 }, () => ({ text: numberReply(320), expected_count: 320 }));
const corruptions = {
  "missing ranker": a => { delete a.ranker; },
  "missing params": a => { a.ranker.full_params = []; },
  "wrong feature dimension": a => { a.ranker.head_params[0].mean.pop(); },
  "empty references": a => { a.ranker.references[0] = []; },
  "short reference vector": a => { a.ranker.references[0][0].pop(); },
  "zero scale": a => { a.ranker.full_params[0].scale[0] = 0; },
  "nonfinite coefficient": a => { a.ranker.lda_weights[0][0] = null; },
  "missing environment": a => { a.ranker.bank.ordered_blocks.environment_centroids = []; },
  "wrong positional weights": a => { a.ranker.positional.weights.pop(); },
};

test("A100-004: malformed scoring structures never replace a healthy local pointer, including after restart", async t => {
  const dir = await temporary(t), source = join(dir, "source"), cache = join(dir, "cache"); await mkdir(source);
  const write = async fixture => { await writeFile(join(source, "unified_bank.json"), fixture.bundle); await writeFile(join(source, "shared_detector.bin"), fixture.detector); };
  await write(referenceFixture("repair-scoring", true));
  const bank = new FingerprintBank({ dir: cache, source }); t.after(() => bank.close());
  const healthy = await bank.refresh(), pointer = await readFile(join(cache, "current.json")), expected = healthy.detector.analyze(outputs);
  assert.equal(expected.results.length, 2);
  for (const [name, mutate] of Object.entries(corruptions)) {
    await write(modifiedFixture(mutate));
    await assert.rejects(() => bank.refresh(), /评分|detector|scor/i, name);
    assert.deepEqual(await readFile(join(cache, "current.json")), pointer, name);
    assert.equal(bank.status().state, "ready"); assert.ok(bank.status().error, name);
    assert.deepEqual((await bank.load()).detector.analyze(outputs), expected, name);
  }
  const restarted = new FingerprintBank({ dir: cache, source }); t.after(() => restarted.close()); await restarted.init();
  assert.deepEqual((await restarted.load()).detector.analyze(outputs), expected);
});

test("A100-004: remote structurally invalid update is rejected after valid digest/decompression", async t => {
  let fixture = referenceFixture("repair-scoring", true);
  t.mock.method(globalThis, "fetch", async input => new Response(String(input).endsWith("bundle.json") ? fixture.bundle : fixture.compressed));
  const bank = new FingerprintBank({ dir: await temporary(t), source: "http://repair.invalid/data/" }); t.after(() => bank.close());
  const healthy = await bank.refresh(); fixture = modifiedFixture(corruptions["missing ranker"]);
  await assert.rejects(() => bank.refresh(), /评分|detector|scor/i);
  assert.equal(bank.status().meta.sha256, healthy.meta.sha256);
  assert.equal((await bank.load()).detector.analyze(outputs).results.length, 2);
});

test("A100-004: invalid cached scoring snapshot is unavailable at startup", async t => {
  const dir = await temporary(t), fixture = modifiedFixture(corruptions["empty references"]), prefix = Buffer.alloc(4); prefix.writeUInt32LE(fixture.bundle.length);
  const cache = Buffer.concat([prefix, fixture.bundle, fixture.detector]), sha256 = createHash("sha256").update(cache).digest("hex");
  await writeFile(join(dir, sha256 + ".bin"), cache); await writeFile(join(dir, "current.json"), JSON.stringify({ sha256 }));
  const bank = new FingerprintBank({ dir }); t.after(() => bank.close()); await bank.init();
  assert.equal(bank.status().state, "missing"); assert.match(bank.status().error, /评分|detector|scor/i);
});
