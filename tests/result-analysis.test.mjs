import test from "node:test";
import assert from "node:assert/strict";
import { summary } from "../lib/result.mjs";
import { abnormalRetest } from "../lib/retest.mjs";

const diagnostics = await import("../lib/diagnostics.mjs").catch(() => ({}));
const comparison = await import("../lib/comparison.mjs").catch(() => ({}));
const record = (id, fields = {}) => ({ id, model: "fixture/one", provider: "fixture", kind: "candy", status: "completed",
  createdAt: "2026-11-20T01:00:00Z", effort: "", maxTokens: 1200, concurrency: 3, prompt: "原题面 A",
  candy: { version: "shape-choice-v1", expected: 21, verdict: "match", answer: 21 }, ...fields });
const fingerprint = fields => record("fingerprint", { kind: "fingerprint", candy: undefined, prompt: undefined, api: "chat_completions", strict: true,
  serviceTier: "default", account: "", bank: { sha256: "a".repeat(64), sdkVersion: "0.2.0" },
  challenges: [1, 2, 3].map(index => ({ id: `probe-${index}`, prompt: `私有原题 ${index}`, expected_count: 280 })),
  samples: [1, 2, 3].map(() => ({ state: "complete", count: 280, expected_count: 280, raw_text: "数字回答" })),
  analysis: { decision: "scored", results: [{ display_name: "候选 A" }] }, ...fields });

test("diagnosis distinguishes upstream limits, timeout and local storage from generic request failure", () => {
  assert.equal(typeof diagnostics.failureInfo, "function", "Specific failure explanations are missing");
  for (const [error, code] of [["生成失败（HTTP 429）：Too many requests", "rate-limit"], ["生成超时，已终止上游请求", "timeout"],
    ["生成失败（HTTP 401）：Unauthorized", "authentication"], ["结果保存失败：EACCES", "storage"],
    ["响应在结束标志之前断开，保留了已收到的输出", "connection"], ["未知上游错误", "request"]]) {
    const info = diagnostics.failureInfo(record("failed", { status: "error", error }));
    assert.equal(info.code, code); assert.equal(info.tone, "error"); assert.ok(info.advice.length > 5);
  }
  assert.equal(diagnostics.failureInfo(record("success")), null);
  assert.equal(diagnostics.failureInfo(record("active", { status: "running", error: "旧错误" })), null);
});

test("fingerprint diagnosis uses sample errors even when the run has a generic aggregate error", () => {
  assert.equal(typeof diagnostics.failureInfo, "function", "Fingerprint sample causes are missing");
  const run = fingerprint({ status: "error", error: "没有有效采样，原始回答和错误已保留",
    samples: [{ state: "failed", error: "采样失败（HTTP 429）：rate limit" }, { state: "failed", error: "rate limit" }, { state: "failed" }] });
  assert.equal(diagnostics.failureInfo(run).code, "rate-limit");
  assert.equal(summary(run).diagnostic.code, "rate-limit", "The compact list must retain the actual sample cause");
  assert.equal(Object.hasOwn(summary(run), "samples"), false);
});

test("diagnosis keeps output, answer and current preview problems distinct from request failures", () => {
  assert.equal(typeof diagnostics.failureInfo, "function", "Output and preview explanations are missing");
  assert.equal(diagnostics.failureInfo(record("cut", { status: "truncated" })).code, "truncated");
  const wrong = record("wrong", { candy: { verdict: "mismatch", answer: 20 } });
  assert.equal(diagnostics.failureInfo(wrong).code, "mismatch"); assert.equal(abnormalRetest(wrong), true);
  assert.equal(diagnostics.failureInfo(record("review", { candy: { verdict: "review" } })).code, "review");
  const cancelled = diagnostics.failureInfo(record("cancelled", { status: "cancelled" }));
  assert.equal(cancelled.code, "cancelled"); assert.equal(cancelled.abnormal, false); assert.equal(abnormalRetest(record("cancelled", { status: "cancelled" })), false);
  const goodAnimation = record("animation", { kind: "pelican" });
  assert.equal(diagnostics.failureInfo(goodAnimation, { previewError: "预览运行错误：ReferenceError" }).code, "preview");
  assert.equal(diagnostics.failureInfo(goodAnimation, { loadError: "读取失败" }).code, "load");
  assert.equal(goodAnimation.status, "completed", "Preview diagnosis must not rewrite the saved generation state");
});

test("recent trends retain the saved conditions and exclude different or incomplete originals", () => {
  const first = summary(record("one")), second = summary(record("two", { prompt: "原题面 B", maxTokens: 0, effort: "high" }));
  assert.notEqual(first.conditions.question, second.conditions.question);
  assert.notEqual(first.conditions.effort, second.conditions.effort);
  assert.notEqual(first.conditions.maxTokens, second.conditions.maxTokens);
  const legacy = summary({ id: "old", model: "fixture/one", status: "completed", kind: "candy", createdAt: first.createdAt });
  assert.equal(comparison.recentTrend(first, [first, second, legacy]).attempts, 1);
  assert.equal(comparison.recentTrend(legacy, [legacy]).available, false, "Missing conditions cannot be treated as a matching profile");
});

test("fingerprint trend matching hashes original challenges without leaking them or conflating different banks", () => {
  const first = summary(fingerprint()), second = summary(fingerprint({ id: "other", bank: { sha256: "b".repeat(64), sdkVersion: "0.2.0" } }));
  assert.match(first.conditions.question, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(first.conditions).includes("私有原题"), false);
  assert.notEqual(first.conditions.bank, second.conditions.bank);
  const changed = summary(fingerprint({ id: "changed", challenges: [1, 2, 3].map(index => ({ prompt: `其他题 ${index}`, expected_count: 280 })) }));
  assert.notEqual(first.conditions.question, changed.conditions.question);
  assert.equal(comparison.recentTrend(first, [first, second, changed]).attempts, 1);
});

test("same-model trend excludes other conditions and counts failed attempts without distorting valid metrics", () => {
  assert.equal(typeof comparison.recentTrend, "function", "Condition-matched recent trends are missing");
  const first = summary(record("one", { elapsedMs: 1000, usage: { total_tokens: 100 } }));
  const wrong = summary(record("two", { elapsedMs: 3000, tokens: { total: 200, partial: ["total"] },
    candy: { version: "shape-choice-v1", expected: 21, verdict: "mismatch", answer: 20 } }));
  wrong.tokens = { total: 200, partial: ["total"] };
  const failed = summary(record("three", { status: "error", error: "生成超时", elapsedMs: 5000, usage: { total_tokens: 50 } }));
  const inputs = [first, wrong, failed, summary(record("cancelled", { status: "cancelled" })), summary(record("active", { status: "running" })),
    summary(record("different", { maxTokens: 0 })), summary(record("other", { model: "fixture/two" }))];
  const trend = comparison.recentTrend(first, inputs);
  assert.equal(trend.attempts, 3); assert.equal(trend.valid, 2); assert.equal(trend.successes, 1); assert.equal(trend.rate, 50);
  assert.equal(trend.elapsedMedian, 2000); assert.equal(trend.elapsedCount, 2);
  assert.equal(trend.tokenMedian, 100); assert.equal(trend.tokenCount, 1);
  assert.deepEqual(trend.points.map(point => point.id).sort(), ["one", "three", "two"]);
});

test("recent trends keep the newest twenty records and report small samples and unavailable metrics honestly", () => {
  assert.equal(typeof comparison.recentTrend, "function", "Bounded and truthful trend summaries are missing");
  const entries = Array.from({ length: 24 }, (_, index) => summary(record(`run-${index}`, { createdAt: `2026-11-20T01:${String(index).padStart(2, "0")}:00Z` })));
  const trend = comparison.recentTrend(entries[0], entries);
  assert.equal(trend.attempts, 20); assert.equal(trend.points[0].id, "run-4"); assert.equal(trend.points.at(-1).id, "run-23");
  assert.equal(trend.elapsedMedian, null); assert.equal(trend.tokenMedian, null);
  const small = comparison.recentTrend(entries[0], entries.slice(0, 2));
  assert.equal(small.insufficient, true); assert.equal(small.attempts, 2);
  const empty = comparison.recentTrend(entries[0], []); assert.equal(empty.rate, null);
});

test("fingerprint trends describe scored results and candidate consistency without inventing identity accuracy", () => {
  assert.equal(typeof comparison.recentTrend, "function", "Fingerprint stability evidence is missing");
  const entries = [summary(fingerprint()), summary(fingerprint({ id: "same" })),
    summary(fingerprint({ id: "other", analysis: { decision: "scored", results: [{ display_name: "候选 B" }] } })),
    summary(fingerprint({ id: "failed", status: "error", error: "没有有效采样", analysis: null }))];
  const trend = comparison.recentTrend(entries[0], entries);
  assert.equal(trend.rate, 75); assert.equal(trend.valid, 3);
  assert.deepEqual(trend.candidates, [{ name: "候选 A", count: 2 }, { name: "候选 B", count: 1 }]);
});
