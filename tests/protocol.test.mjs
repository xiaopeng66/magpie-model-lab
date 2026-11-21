import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { createServer } from "node:http";

const protocol = await import("../lib/gateway.mjs").catch(() => ({}));
const result = await import("../lib/result.mjs").catch(() => ({}));
const html = '<!doctype html><html lang="zh"><head><title>鹈鹕</title></head><body>骑行</body></html>';

test("catalog keeps exact provider ids and exposes only text model candidates", () => {
  assert.equal(typeof protocol.normalizeModels, "function", "Model catalog normalization is missing");
  const models = protocol.normalizeModels({ data: [
    { id: "demo/coder", display_name: "Coder", magpie_label: "Coder · Demo", reasoning: true, reasoning_levels: ["low", "high"], max_output_tokens: 4096, native_endpoints: ["/v1/responses"], modalities: { output: ["text"] } },
    { id: "group/auto", display_name: "Automatic" },
    { id: "demo/image", modalities: { output: ["image"] } },
    { id: "demo/decision", type: "decision" },
    { id: "demo/coder" },
  ] });
  assert.equal(models.length, 1);
  assert.equal(models[0].id, "demo/coder");
  assert.equal(models[0].name, "Coder · Demo");
  assert.equal(models[0].provider, "demo");
  assert.equal(models[0].providerName, "Demo");
  assert.deepEqual(models[0].efforts, ["low", "high"]);
  assert.equal(models[0].maxOutputTokens, 4096);
});

test("catalog normalizes malformed optional model labels without breaking model selection", () => {
  const models = protocol.normalizeModels({ data: [{ id: "fixture/one", magpie_label: { value: "wrong" }, display_name: "One", reasoning_levels: ["low", null, "low"] },
    { id: "fixture/two", display_name: ["Two"] }, { id: "fixture/three", magpie_label: "", name: "Three" }] });
  assert.equal(models[0].name, "One"); assert.deepEqual(models[0].efforts, ["low"]);
  assert.equal(models[1].name, "fixture/two"); assert.equal(models[2].name, "Three");
});

test("requests have fresh context and reject unsupported effort or invalid output values", () => {
  assert.equal(typeof protocol.buildPayload, "function", "Request validation is missing");
  const model = { id: "demo/coder", efforts: ["low", "high"], maxOutputTokens: 4096 };
  const payload = protocol.buildPayload(model, { prompt: "生成鹈鹕", maxTokens: 1024, effort: "low" });
  assert.deepEqual(payload.messages, [{ role: "user", content: "生成鹈鹕" }]);
  assert.equal(payload.model, "demo/coder");
  assert.equal(payload.max_tokens, 1024);
  assert.equal(payload.reasoning_effort, "low");
  assert.equal(payload.temperature, undefined);
  assert.equal(protocol.buildPayload(model, { prompt: "test", maxTokens: 1024, effort: "" }).reasoning_effort, undefined);
  assert.throws(() => protocol.buildPayload(model, { prompt: "test", maxTokens: 1024, effort: "ultra" }), /思考/);
  assert.throws(() => protocol.buildPayload(model, { prompt: " ", maxTokens: 1024 }), /提示词/);
  assert.throws(() => protocol.buildPayload(model, { prompt: "test", maxTokens: 1024.5 }), /整数/);
});

test("output defaults to 64000, omits the cap at zero and accepts larger requests", () => {
  const model = { id: "demo/coder", efforts: [], maxOutputTokens: 4096 };
  assert.equal(protocol.buildPayload(model, { prompt: "test" }).max_tokens, 64000);
  assert.equal(Object.hasOwn(protocol.buildPayload(model, { prompt: "test", maxTokens: 0 }), "max_tokens"), false);
  assert.equal(protocol.buildPayload(model, { prompt: "test", maxTokens: 131072 }).max_tokens, 131072);
  for (const maxTokens of [-1, 1.5, NaN, Infinity]) assert.throws(() => protocol.buildPayload(model, { prompt: "test", maxTokens }), /整数/);
});

test("SSE decoding preserves Chinese split between UTF-8 bytes and final unterminated event", async () => {
  assert.equal(typeof protocol.parseSSE, "function", "SSE streaming parser is missing");
  const wire = new TextEncoder().encode(': heartbeat\r\nevent: chunk\r\ndata: {"text":"鹈鹕"}\r\n\r\ndata: [DONE]');
  const stream = new ReadableStream({ start(controller) {
    for (let i = 0; i < wire.length; i += 2) controller.enqueue(wire.slice(i, i + 2));
    controller.close();
  } });
  const events = [];
  for await (const item of protocol.parseSSE(stream)) events.push(item);
  assert.deepEqual(events, [{ event: "chunk", data: '{"text":"鹈鹕"}' }, { event: "message", data: "[DONE]" }]);
});

test("SSE retains multi-line data rather than splitting one JSON event", async () => {
  assert.equal(typeof protocol.parseSSE, "function", "SSE streaming parser is missing");
  const stream = new Response('data: {\ndata: "ok": true\ndata: }\n\n').body;
  const events = [];
  for await (const item of protocol.parseSSE(stream)) events.push(item);
  assert.deepEqual(events, [{ event: "message", data: '{\n"ok": true\n}' }]);
});

test("SSE bounds the combined UTF-8 bytes of a multiline event and cancels an oversized stream", async () => {
  let pulls = 0, cancelled = false;
  const part = new TextEncoder().encode("data: " + "鹈".repeat(1024) + "\n");
  const stream = new ReadableStream({ pull(controller) {
    pulls++; if (pulls <= 1500) controller.enqueue(part); else { controller.enqueue(new TextEncoder().encode("\n")); controller.close(); }
  }, cancel() { cancelled = true; } });
  await assert.rejects(async () => { for await (const _event of protocol.parseSSE(stream)) {} }, /事件过大/);
  assert.equal(cancelled, true); assert.ok(pulls < 1500, "Stop reading as soon as the event reaches its byte limit");
  const small = [];
  for await (const item of protocol.parseSSE(new Response("data: " + "x".repeat(2048) + "\n\n" + "data: ok\n\n").body)) small.push(item);
  assert.equal(small.length, 2, "An event boundary resets the byte count");
});

test("model catalogs stop reading at their byte limit instead of buffering an arbitrary response", async (t) => {
  let released;
  const response = new Promise(resolve => { released = resolve; });
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.on("close", () => released(true));
    // This fits the old character limit but exceeds 4 MiB of UTF-8 bytes.
    res.end(JSON.stringify({ data: [{ id: "fixture/one", name: "鹈".repeat(1500000) }] }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const gateway = new protocol.Gateway({ url: `http://127.0.0.1:${server.address().port}` });
  await assert.rejects(() => gateway.models(), /目录过大/);
  await response;
});

test("HTML extraction preserves complete documents in raw or fenced responses", () => {
  assert.equal(typeof result.extractHTML, "function", "HTML extraction is missing");
  assert.equal(result.extractHTML(html), html);
  assert.equal(result.extractHTML(`说明\n\`\`\`html\n${html}\n\`\`\`\n完成`), html);
  assert.equal(result.extractHTML("<html><body>unfinished"), "");
  assert.equal(result.extractHTML("Here is an SVG: <svg></svg>"), "");
});

test("HTML extraction does not cut off a document at a closing tag inside JavaScript text", () => {
  const document = '<!doctype html><html><head><script>const text="</html>";</script></head><body>鹈鹕</body></html>';
  assert.equal(result.extractHTML(document), document);
});

test("truncated responses never become completed even if they contain closing html", () => {
  assert.equal(typeof result.classifyResult, "function", "Result classification is missing");
  assert.equal(result.classifyResult(html, "stop").status, "completed");
  assert.equal(result.classifyResult(html, "length").status, "truncated");
  assert.equal(result.classifyResult("I cannot do that", "stop").status, "invalid");
  assert.equal(result.classifyResult(html, "content_filter").status, "error");
});

test("preview diagnostics are injected without changing the saved original", () => {
  assert.equal(typeof result.previewDocument, "function", "Isolated preview document is missing");
  const run = { id: "54f7571f-b51f-48ad-8cdf-d9ae51d7ebc6", html };
  const preview = result.previewDocument(run);
  assert.ok(preview.includes("pelican-preview"));
  assert.ok(preview.includes(run.id));
  assert.ok(preview.indexOf("pelican-preview") < preview.indexOf("<title>"));
  assert.equal(run.html, html);
  assert.ok(!preview.includes("x-pelican-token"));
});

test("preview reports overflowing content dimensions so a thumbnail can show the full scene", () => {
  const id = "54f7571f-b51f-48ad-8cdf-d9ae51d7ebc6", messages = [], handlers = {};
  const preview = result.previewDocument({ id, html });
  const script = preview.match(/<script>([\s\S]*?)<\/script>/)[1];
  runInNewContext(script, { innerWidth: 960, innerHeight: 600,
    document: { documentElement: { scrollWidth: 1400, scrollHeight: 900 }, body: { scrollWidth: 1400, scrollHeight: 900 } },
    parent: { postMessage: message => messages.push(message) }, addEventListener: (name, handler) => { handlers[name] = handler; },
    requestAnimationFrame: handler => handler(), console,
  });
  handlers.load();
  const dimensions = messages.find(message => message.kind === "size");
  assert.ok(dimensions, "The parent needs dimensions from the generated document");
  assert.equal(dimensions.id, id);
  assert.equal(dimensions.width, 1400);
  assert.equal(dimensions.height, 900);
  assert.ok(messages.some(message => message.kind === "ready"));
});
