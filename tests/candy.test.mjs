import test from "node:test";
import assert from "node:assert/strict";
import { Gateway } from "../lib/gateway.mjs";
import { RunStore } from "../lib/store.mjs";
import { Runner } from "../lib/runner.mjs";
import { temporary, fakeGateway, waitFor } from "./helpers.mjs";

const candy = await import("../lib/candy.mjs").catch(() => ({}));

test("candy grades only an explicit unambiguous final answer, never a number in reasoning", () => {
  assert.equal(typeof candy.classifyCandy, "function", "Missing candy classifier");
  for (const [reply, verdict, answer] of [
    ["需要保证策略。\n最终答案：21", "match", 21],
    ["21 并不够。\n最终答案：29", "mismatch", 29],
    ["最终答案：不是21", "review", null],
    ["最终答案：21或29", "review", null],
    ["最终答案：21\n最终答案：29", "review", null],
    ["推导中可能会提到21", "review", null],
    ["**最终答案：21颗。**", "match", 21],
    ["最终答案：二十一", "review", null],
    ["最终答案：21.5", "mismatch", 21.5],
  ]) {
    const result = candy.classifyCandy(reply, "stop");
    assert.equal(result.candy.verdict, verdict, reply); assert.equal(result.candy.answer, answer, reply);
  }
  assert.equal(candy.classifyCandy("最终答案：21", "length").candy.verdict, "incomplete");
  assert.equal(candy.classifyCandy("最终答案：21", "").status, "error");
});

test("candy keeps rounded or conflicting decimal conclusions under review", () => {
  for (const reply of [
    "最终答案：21.00000000000000000001",
    "最终答案：20.99999999999999999999",
    "最终答案：21\n最终答案：21.00000000000000000001",
    "最终答案：9007199254740993",
  ]) {
    const result = candy.classifyCandy(reply, "stop");
    assert.equal(result.candy.verdict, "review", reply);
    assert.equal(result.candy.answer, null, reply);
  }
  for (const [reply, verdict, answer] of [
    ["最终答案：+00021.000\n最终答案：21", "match", 21],
    ["最终答案：21.50", "mismatch", 21.5],
    ["最终答案：-0.00\n最终答案：+000.000", "mismatch", 0],
  ]) {
    const result = candy.classifyCandy(reply, "stop");
    assert.equal(result.candy.verdict, verdict, reply);
    assert.equal(result.candy.answer, answer, reply);
  }
});

test("candy runner sends a fixed independent question and restores evidence without HTML previews", async t => {
  const dir = await temporary(t), upstream = await fakeGateway(t, ({ complete }) => complete("策略与下界。\n最终答案：21"));
  const store = new RunStore(dir); await store.init();
  const runner = new Runner({ store, gateway: new Gateway({ url: upstream.url }) }); t.after(() => runner.close());
  const [created] = await runner.submit({ kind: "candy", models: [{ id: "fixture/one" }] });
  const done = await waitFor(() => runner.get(created.id)?.status === "completed" && runner.get(created.id));
  assert.equal(done.candy.answer, 21); assert.equal(done.candy.verdict, "match"); assert.equal(done.html, "");
  assert.equal(done.concurrency, 3); assert.equal(upstream.seen.requests[0].max_tokens, 64000);
  assert.match(upstream.seen.requests[0].messages[0].content, /不放回/);
  assert.equal(done.promptHash.length, 64); assert.equal(done.previewKey, undefined);
  const recovered = new RunStore(dir); await recovered.init();
  assert.equal(recovered.records.get(done.id).candy.verdict, "match");
  assert.equal(recovered.list()[0].candy.answer, 21);
});
