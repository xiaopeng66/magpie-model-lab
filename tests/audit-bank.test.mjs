import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { FingerprintBank } from "../lib/fingerprint-bank.mjs";
import { temporary } from "./helpers.mjs";
import { referenceFixture } from "./fingerprint-helpers.mjs";

const LIMIT = 128 * 1024 * 1024;
function frame(bytes, size = bytes.length, width = size < 256 ? 1 : 4) {
  const header = Buffer.alloc(5 + width + 3); header.writeUInt32LE(0xfd2fb528);
  header[4] = 32 | ({ 1: 0, 2: 1, 4: 2, 8: 3 }[width] << 6);
  if (width === 8) header.writeBigUInt64LE(BigInt(size), 5); else header.writeUIntLE(size - (width === 2 ? 256 : 0), 5, width);
  header.writeUIntLE((bytes.length << 3) | 1, header.length - 3, 3);
  return Buffer.concat([header, bytes]);
}
function skip(bytes = Buffer.from("fixture metadata")) {
  const header = Buffer.alloc(8); header.writeUInt32LE(0x184d2a5a); header.writeUInt32LE(bytes.length, 4); return Buffer.concat([header, bytes]);
}
async function fixtureBank(t, parts) {
  const fixture = referenceFixture("audit-multiframe", true), dir = await temporary(t), originalFetch = globalThis.fetch;
  const data = { parts: parts || [fixture.compressed], downloads: [] };
  const bundle = () => { const value = JSON.parse(fixture.bundle); value.files["shared_detector.bin"].parts = data.parts.map((_value, index) => `part${index}.zst`);
    value.files["shared_detector.bin"].bytes = data.parts.reduce((size, bytes) => size + bytes.length, 0); return Buffer.from(JSON.stringify(value)); };
  globalThis.fetch = async input => {
    const url = new URL(String(input)); assert.equal(url.origin, "http://audit.invalid"); data.downloads.push(url.pathname);
    if (url.pathname === "/data/bundle.json") return new Response(bundle());
    const match = /^\/data\/chunks\/part(\d+)\.zst$/.exec(url.pathname); assert.ok(match, `Unexpected reference request: ${url.pathname}`);
    return new Response(data.parts[Number(match[1])]);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const bank = new FingerprintBank({ dir: join(dir, "cache"), source: "http://audit.invalid/data/" }); t.after(() => bank.close());
  return { bank, fixture, data, dir, bundle };
}
const halves = bytes => { const middle = Math.floor(bytes.length / 2); return [bytes.subarray(0, middle), bytes.subarray(middle)]; };

test("014: a single standard frame split across download parts remains byte-identical", async t => {
  const { bank, fixture, data, bundle } = await fixtureBank(t);
  data.parts = [fixture.compressed.subarray(0, 7), fixture.compressed.subarray(7)];
  const loaded = await bank.refresh(); assert.equal(loaded.meta.modelCount, 2);
  assert.deepEqual(await bank.snapshotBytes(loaded.meta.sha256), bank.pack(bundle(), fixture.detector));
  assert.deepEqual(data.downloads, ["/data/bundle.json", "/data/chunks/part0.zst", "/data/chunks/part1.zst"]);
});

test("014: independent concatenated frames load the real detector and preserve complete output hashes", async t => {
  const { bank, fixture, data, bundle } = await fixtureBank(t); data.parts = halves(fixture.detector).map(bytes => frame(bytes));
  const loaded = await bank.refresh(); assert.equal(loaded.meta.modelCount, 2);
  assert.deepEqual(await bank.snapshotBytes(loaded.meta.sha256), bank.pack(bundle(), fixture.detector));
});

test("014: the SDK fallback handles empty, skippable and multiple independent frames", async t => {
  const original = zlib.zstdDecompressSync; zlib.zstdDecompressSync = undefined; t.after(() => { zlib.zstdDecompressSync = original; });
  const { bank, fixture, data, bundle } = await fixtureBank(t), [first, second] = halves(fixture.detector);
  data.parts = [frame(Buffer.alloc(0)), frame(first), skip(), frame(second)];
  const loaded = await bank.refresh(); assert.equal(loaded.meta.modelCount, 2);
  assert.deepEqual(await bank.snapshotBytes(loaded.meta.sha256), bank.pack(bundle(), fixture.detector));
});

test("014: two-, four- and eight-byte declared lengths are accepted per frame", async t => {
  const { bank, fixture, data } = await fixtureBank(t);
  const part = Math.floor(fixture.detector.length / 3);
  data.parts = [frame(fixture.detector.subarray(0, part), part, 2), frame(fixture.detector.subarray(part, part * 2), part, 4), frame(fixture.detector.subarray(part * 2), fixture.detector.length - part * 2, 8)];
  assert.equal((await bank.refresh()).meta.modelCount, 2);
});

test("014: a damaged final frame never replaces the previously verified bank or pointer", async t => {
  const { bank, fixture, data, dir } = await fixtureBank(t), loaded = await bank.refresh();
  const pointer = await readFile(join(dir, "cache", "current.json")), [first, second] = halves(fixture.detector), last = frame(second);
  data.parts = [frame(first), last.subarray(0, last.length - 1)];
  await assert.rejects(() => bank.refresh(), /压缩.*(?:不完整|截断)/);
  assert.equal((await bank.load()).meta.sha256, loaded.meta.sha256); assert.deepEqual(await readFile(join(dir, "cache", "current.json")), pointer);
});

test("014: the combined output limit is enforced before any frame is inflated", async t => {
  const { bank, fixture, data } = await fixtureBank(t), loaded = await bank.refresh(), first = halves(fixture.detector)[0];
  let calls = 0; const original = zlib.zstdDecompressSync;
  zlib.zstdDecompressSync = () => { calls++; throw new Error("Unexpected inflation before size validation"); };
  t.after(() => { zlib.zstdDecompressSync = original; });
  data.parts = [frame(first), frame(Buffer.alloc(8), LIMIT - first.length + 1)];
  await assert.rejects(() => bank.refresh(), /检测器.*(?:大小|总长度)/);
  assert.equal(calls, 0); assert.equal((await bank.load()).meta.sha256, loaded.meta.sha256);
});

test("014: malformed headers, oversized windows and trailing bytes retain the old bank", async t => {
  const { bank, fixture, data } = await fixtureBank(t), loaded = await bank.refresh();
  const reserved = Buffer.from(fixture.compressed); reserved[4] |= 8;
  const unknown = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 0, 1, 0, 0]);
  const wide = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x80, 0xa8, 8, 0, 0, 0, 1, 0, 0]);
  const invalidBlock = frame(Buffer.alloc(8)); invalidBlock[6] |= 6;
  for (const value of [reserved, unknown, wide, invalidBlock, skip().subarray(0, 9), Buffer.concat([fixture.compressed, Buffer.from([0])])]) {
    data.parts = [value]; await assert.rejects(() => bank.refresh(), /参考库更新失败/);
    assert.equal((await bank.load()).meta.sha256, loaded.meta.sha256);
  }
});
