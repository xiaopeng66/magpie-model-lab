import { createServer } from "node:http";
import { createHash } from "node:crypto";

export const numberReply = (count = 320) => Array.from({ length: count }, (_, index) => index % 2 ? 340 - index % 13 : 12 + index % 17).join(", ");

export function referenceFixture(builtAt = "test-snapshot", ranked = false) {
  const zeros = n => Array(n).fill(0), params = n => ({ mean: zeros(n), scale: Array(n).fill(1) });
  const modelIds = ranked ? ["reference/a", "reference/b"] : [];
  const detectorJSON = Buffer.from(JSON.stringify({ schema: "shared-detector-v2", bank_built_at: builtAt,
    model_ids: modelIds, response_counts: modelIds.map(() => 10), base_sha256: "test-base", source_reference_sha256: "test-reference",
    ...(ranked ? { ranker: {
      full_params: [params(355), params(74)], head_params: [params(355), params(74)],
      lda_weights: [zeros(429), zeros(429)], lda_bias: [1, -1], references: [[zeros(429)], [zeros(429)]],
      bank: { hellinger: { feature_mean: zeros(355), feature_scale: Array(355).fill(1), nuisance_basis: [], centroids: [zeros(355), zeros(355)] },
        ordered_blocks: { feature_mean: zeros(74), feature_scale: Array(74).fill(1), nuisance_basis: [], centroids: [zeros(74), zeros(74)], environment_centroids: [[zeros(74), zeros(74)]] } },
      positional: { params: [355, 74, 102, 220].map(params), weights: [zeros(751), zeros(751)], bias: [1, -1] }, blend: { frequency: .5, positional: .5 },
    }, calibration: { schema: "shared-confidence-v2", method: "ranking-temperature", tau: 1, calibration_run: "test-calibration",
      binding: { base_sha256: "test-base", reference_sha256: "test-reference", model_ids: modelIds } } } : {}) }));
  const detector = Buffer.alloc(Math.ceil((4 + detectorJSON.length) / 4) * 4);
  detector.writeUInt32LE(detectorJSON.length); detectorJSON.copy(detector, 4);
  const zstd = detector.length < 256 ? Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, detector.length, 0, 0, 0]) : Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0xa0, 0, 0, 0, 0, 0, 0, 0]);
  if (detector.length >= 256) zstd.writeUInt32LE(detector.length, 5);
  zstd.writeUIntLE((detector.length << 3) | 1, zstd.length - 3, 3);
  const bundle = Buffer.from(JSON.stringify({ schema: "lmfpd-data-v1", detector_schema: "shared-detector-v2", built_at: builtAt,
    models: modelIds.map((id, index) => ({ id, display_name: index ? "Reference B" : "Reference A", family: "fixture", family_name: "Fixture", response_count: 10 })),
    files: { "shared_detector.bin": { sha256: createHash("sha256").update(detector).digest("hex"), bytes: detector.length + zstd.length, parts: ["fixture.zst"] } } }));
  const length = Buffer.alloc(4); length.writeUInt32LE(bundle.length);
  return { bundle, detector, compressed: Buffer.concat([zstd, detector]), cache: Buffer.concat([length, bundle, detector]) };
}

export async function fingerprintGateway(t, { handler, models = ["responses", "chat", "messages"], route, bank } = {}) {
  const seen = { requests: [], downloads: [], reads: [], active: 0, peak: 0, aborted: 0 };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/data/")) {
      seen.downloads.push({ path: url.pathname, headers: req.headers });
      if (!bank) { res.writeHead(503); res.end("Unavailable"); return; }
      res.end(url.pathname.endsWith("bundle.json") ? bank.bundle : bank.compressed); return;
    }
    if (req.method === "GET") {
      seen.reads.push(req.url); res.setHeader("content-type", "application/json");
      if (url.pathname === "/v1/models") res.end(JSON.stringify({ data: models.map(name => ({ id: "fixture/" + name, display_name: name,
        reasoning_levels: ["low", "high"], native_endpoints: [name === "messages" ? "/v1/messages" : name === "responses" ? "/v1/responses" : "/v1/chat/completions"] })) }));
      else if (url.pathname === "/v1/magpie/quotas") res.end(JSON.stringify({ data: [{ provider: "fixture", user: "北冥", alias: "主账号", kind: "subscription", token: "never-send", balance: 99 }] }));
      else if (url.pathname === "/v1/magpie/route" && route) res.end(JSON.stringify(route(url.searchParams.get("session"))));
      else { res.writeHead(404); res.end("{}"); }
      return;
    }
    let text = ""; for await (const bytes of req) text += bytes;
    const payload = JSON.parse(text); seen.requests.push({ path: url.pathname, payload, headers: req.headers });
    seen.active++; seen.peak = Math.max(seen.peak, seen.active);
    let finished = false;
    res.on("close", () => { seen.active--; if (!finished) seen.aborted++; });
    const chunk = value => res.write(`data: ${JSON.stringify(value)}\n\n`);
    const complete = (reply = numberReply(), finish = "stop", json = false) => {
      const body = url.pathname === "/v1/responses" ? { id: "r-test", model: payload.model, status: finish === "stop" ? "completed" : "incomplete",
        output: [{ type: "message", content: [{ type: "output_text", text: reply }] }], usage: { input_tokens: 20, output_tokens: 400, total_tokens: 420 } }
        : url.pathname === "/v1/messages" ? { id: "r-test", model: payload.model, content: [{ type: "text", text: reply }], stop_reason: finish === "stop" ? "end_turn" : finish, usage: { input_tokens: 20, output_tokens: 400 } }
        : { id: "r-test", model: payload.model, choices: [{ index: 0, message: { content: reply }, finish_reason: finish }], usage: { prompt_tokens: 20, completion_tokens: 400, total_tokens: 420 } };
      if (!res.headersSent) res.writeHead(200, { "content-type": json ? "application/json" : "text/event-stream", "x-request-id": "fixture-request" });
      if (json) { finished = true; res.end(JSON.stringify(body)); return; }
      if (url.pathname === "/v1/responses") {
        chunk({ type: "response.output_text.delta", delta: reply }); chunk({ type: "response.completed", response: body });
      } else if (url.pathname === "/v1/messages") {
        chunk({ type: "message_start", message: { id: body.id, model: body.model, usage: { input_tokens: 20 } } });
        chunk({ type: "content_block_delta", delta: { type: "text_delta", text: reply } });
        chunk({ type: "message_delta", delta: { stop_reason: body.stop_reason }, usage: { output_tokens: 400 } }); chunk({ type: "message_stop" });
      } else {
        chunk({ id: body.id, model: body.model, choices: [{ index: 0, delta: { content: reply } }] });
        chunk({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: body.usage });
      }
      finished = true; res.end("data: [DONE]\n\n");
    };
    try { if (handler) await handler({ req, res, payload, chunk, complete, seen }); else complete(); }
    catch { res.destroy(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { url: `http://127.0.0.1:${server.address().port}`, seen, server };
}
