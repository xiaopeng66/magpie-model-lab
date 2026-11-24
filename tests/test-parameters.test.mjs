import test from "node:test";
import assert from "node:assert/strict";
import { normalizeParameters, parameterDefaults, generationTimeout } from "../lib/test-parameters.mjs";
import * as timeoutHelpers from "../lib/test-parameters.mjs";

test("each mode preserves zero limits and independent defaults", () => {
  assert.deepEqual(normalizeParameters("candy", { maxTokens: 0, timeoutMs: 0, concurrency: 0 }), { maxTokens: 0, timeoutMs: 0, concurrency: 0 });
  assert.equal(parameterDefaults("pelican", "animate").concurrency, 2);
  assert.equal(parameterDefaults("fingerprint").concurrency, 3);
  assert.equal(parameterDefaults("candy").timeoutMs, 600000);
  assert.equal(generationTimeout(2147483647), 2147483647);
  for (const value of [null, -1, .5, "600000", NaN, Infinity, 2147483648]) assert.throws(() => generationTimeout(value), e => e.status === 400);
});
test("settings reject targets, incompatible fields and malformed parameter values", () => {
  for (const patch of [{ maxTokens: null }, { concurrency: "3" }, { account: "x" }, { models: [] }, { prompt: "fixed" }, { api: "responses" }]) {
    assert.throws(() => normalizeParameters("candy", patch), e => e.status === 400);
  }
  assert.throws(() => normalizeParameters("pelican", { prompt: " " }, { defaultPrompt: "ok" }), e => e.status === 400);
  assert.throws(() => normalizeParameters("fingerprint", { strict: 1 }), e => e.status === 400);
  const source = { effortByModel: { "fixture/one": "high" } }, result = normalizeParameters("candy", source);
  source.effortByModel["fixture/one"] = "low"; assert.equal(result.effortByModel["fixture/one"], "high");
});

test('seconds input preserves millisecond precision, zero and the full timeout range', () => {
  assert.equal(typeof timeoutHelpers.generationTimeoutFromSeconds, 'function');
  for (const milliseconds of [0, 1, 1001, 2003, 999999, 600000, 2147483647]) {
    assert.equal(timeoutHelpers.generationTimeoutFromSeconds(String(milliseconds / 1000)), milliseconds);
  }
  for (const value of ['', ' ', null, undefined, 'bad', '-1', '0.0001', '1.0009', '2147483.648', 'Infinity']) {
    assert.throws(() => timeoutHelpers.generationTimeoutFromSeconds(value), error => error.status === 400);
  }
});
