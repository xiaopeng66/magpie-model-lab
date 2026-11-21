import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer as startPluginServer } from "../lib/server.mjs";

export const FIXTURE_HTML = '<!doctype html><html><head><title>鹈鹕</title><style>@keyframes ride {to {transform:translateX(80px)}} #bird{animation:ride 1s linear infinite alternate}</style></head><body><svg width="300" height="160"><circle id="bird" cx="40" cy="70" r="20" fill="#f80"/></svg><script>document.body.dataset.playing="true";</script></body></html>';

export async function temporary(t) {
  const dir = await mkdtemp(join(tmpdir(), "pelican-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

export async function startTestServer(options = {}) {
  for (let attempt = 0; attempt < 16; attempt++) {
    const service = await startPluginServer(options);
    if (options.port !== 0) return service;
    try {
      // Windows can choose an ephemeral port blocked by Fetch; rebind only that case.
      await (await fetch(service.url)).arrayBuffer();
      return service;
    } catch (error) {
      await service.close();
      if (error.cause?.message !== "bad port" || attempt === 15) throw error;
    }
  }
}

export async function waitFor(check, timeout = 4000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Expected state was not reached");
}

export async function fakeGateway(t, handler, { modelIds = ["one", "two", "three", "four"] } = {}) {
  const seen = { requests: [], active: 0, peak: 0, aborted: 0 };
  const server = createServer(async (req, res) => {
    if (req.url === "/v1/models") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ object: "list", data: modelIds.map((id) => ({
        id: "fixture/" + id, display_name: id, reasoning: true, reasoning_levels: ["low", "high"], max_output_tokens: 32768,
        modalities: { input: ["text"], output: ["text"] }, native_endpoints: ["/v1/chat/completions"],
      })) }));
      return;
    }
    if (req.url !== "/v1/chat/completions") { res.writeHead(404); res.end(); return; }
    let body = "";
    for await (const bytes of req) body += bytes;
    const payload = JSON.parse(body);
    seen.requests.push(payload); seen.active++; seen.peak = Math.max(seen.peak, seen.active);
    let finished = false;
    res.on("close", () => { seen.active--; if (!finished) seen.aborted++; });
    const chunk = (data) => res.write("data: " + JSON.stringify(data) + "\n\n");
    const complete = (content = FIXTURE_HTML, reason = "stop") => {
      if (!res.headersSent) res.writeHead(200, { "content-type": "text/event-stream", "x-request-id": "fixture-request" });
      chunk({ choices: [{ index: 0, delta: { reasoning_content: "先构建骑行场景" } }] });
      chunk({ choices: [{ index: 0, delta: { content } }] });
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: reason }], usage: { prompt_tokens: 40, completion_tokens: 120, total_tokens: 160 } });
      finished = true;
      res.end("data: [DONE]\n\n");
    };
    try { if (handler) await handler({ req, res, payload, chunk, complete, seen }); else complete(); }
    catch { if (!res.destroyed) res.destroy(); }
  });
  let url;
  for (let attempt = 0; attempt < 16; attempt++) {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${server.address().port}`;
    try {
      // Windows can allocate an ephemeral port blocked by Fetch's standard bad-port list.
      await (await fetch(url + "/v1/models")).arrayBuffer();
      break;
    } catch (error) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      if (error.cause?.message !== "bad port" || attempt === 15) throw error;
    }
  }
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  return { url, seen, server };
}
