import test from "node:test";
import assert from "node:assert/strict";
import { Gateway } from "../lib/gateway.mjs";
import { Runner } from "../lib/runner.mjs";
import { RunStore } from "../lib/store.mjs";
import { sampleFingerprint } from "../lib/fingerprint-sample.mjs";
import { FingerprintBank } from "../lib/fingerprint-bank.mjs";
import { temporary, waitFor, FIXTURE_HTML } from "./helpers.mjs";
import { fingerprintGateway, referenceFixture, numberReply } from "./fingerprint-helpers.mjs";

test("all test modes preserve zero and send no cap; Messages uses the compatible Chat endpoint", async t => {
  const upstream = await fingerprintGateway(t, { bank: referenceFixture("limits", true), handler: ({ payload, complete }) => {
    const prompt = payload.messages?.[0]?.content || ""; complete(prompt.includes("糖果") ? "最终答案：21" : prompt === "animate" ? FIXTURE_HTML : numberReply());
  } });
  const dir = await temporary(t), store = new RunStore(dir); await store.init();
  const bank = new FingerprintBank({ dir: dir + "/bank", source: upstream.url + "/data/" }); await bank.init(); t.after(() => bank.close());
  const runner = new Runner({ store, bank, gateway: new Gateway({ url: upstream.url }) }); t.after(() => runner.close());
  for (const kind of ["candy", "pelican", "fingerprint"]) {
    const [run] = await runner.submit({ kind, maxTokens: 0, prompt: "animate", models: [{ id: "fixture/messages" }] });
    await waitFor(() => !["queued", "running"].includes(runner.get(run.id).status));
    assert.equal(runner.get(run.id).status, "completed"); assert.equal(run.maxTokens, 0);
    if (kind === "fingerprint") { assert.equal(run.api, "chat_completions"); assert.equal(run.requestedApi, "auto"); }
  }
  assert.equal(upstream.seen.requests.length, 5);
  for (const { payload, path } of upstream.seen.requests) {
    assert.equal(path, "/v1/chat/completions");
    assert.equal(Object.hasOwn(payload, "max_tokens"), false); assert.equal(Object.hasOwn(payload, "max_output_tokens"), false);
  }
});

test("Responses zero cap is omitted and explicit positive Messages cap is retained", async t => {
  const upstream = await fingerprintGateway(t), gateway = new Gateway({ url: upstream.url });
  for (const [api, maxTokens] of [["responses", 0], ["messages", 64000]]) {
    const sample = await sampleFingerprint(gateway, { model: "fixture/" + api, api, maxTokens, strict: true }, { prompt: "numbers", expected_count: 300 });
    assert.equal(sample.error, null);
  }
  assert.equal(Object.hasOwn(upstream.seen.requests[0].payload, "max_output_tokens"), false);
  assert.equal(upstream.seen.requests[1].payload.max_tokens, 64000);
});
