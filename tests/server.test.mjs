import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { createServer } from "node:net";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startTestServer, fakeGateway, temporary, waitFor, FIXTURE_HTML } from "./helpers.mjs";

const httpService = await import("../lib/server.mjs").catch(() => ({}));

async function setup(t, handler) {
  assert.equal(typeof httpService.startServer, "function", "Authenticated plugin service is missing");
  const dir = await temporary(t);
  const upstream = await fakeGateway(t, handler);
  const service = await startTestServer({ port: 0, dataDir: dir, gatewayUrl: upstream.url });
  t.after(() => service.close());
  const html = await (await fetch(service.url)).text();
  const token = html.match(/name="pelican-token" content="([a-f0-9]+)"/)?.[1];
  assert.ok(token, "Only the plugin UI receives its service token");
  const headers = { "x-pelican-token": token, "content-type": "application/json" };
  return { service, headers, upstream, dir, html };
}

const submit = (service, headers) => fetch(service.url + "api/runs", { method: "POST", headers,
  body: JSON.stringify({ prompt: "生成鹈鹕", maxTokens: 1024, models: [{ id: "fixture/one", effort: "low" }] }) });

test("mutation APIs reject non-object JSON without changing data or invoking the model", async t => {
  const { service, headers, upstream } = await setup(t);
  for (const path of ["runs", "runs/cleanup", "favorites/save", "favorites/remove", "schedules/save", "schedules/remove", "schedules/settings"]) {
    for (const body of ["null", "[]", "1", '"text"']) {
      const response = await fetch(service.url + "api/" + path, { method: "POST", headers, body });
      assert.equal(response.status, 400, path + ": " + body);
      assert.match((await response.json()).error, /JSON.*对象/);
    }
  }
  assert.equal(upstream.seen.requests.length, 0);
  const snapshot = await (await fetch(service.url + "api/favorites", { headers })).json();
  assert.equal(snapshot.favorites.length, 0); assert.equal(snapshot.plans.length, 0); assert.equal(snapshot.concurrency, 3);
});

test("the Model Lab logo is served as the packaged PNG with a matching entry-page asset", async t => {
  const { service, html } = await setup(t);
  const response = await fetch(service.url + "icon.png");
  assert.equal(response.status, 200); assert.equal(response.headers.get("content-type"), "image/png");
  const image = Buffer.from(await response.arrayBuffer());
  assert.equal(image.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.deepEqual(image, await readFile(new URL("../page/icon.png", import.meta.url)));
  assert.match(html, /src="icon\.png"/); assert.match(html, /模型实验室/);
});

test('all browser entry modules and their imports are available as public JavaScript', async t => {
  const { service, html, upstream } = await setup(t);
  const pending = [...html.matchAll(/<script\b[^>]*src="([^"]+)"/g)].map(match => new URL(match[1], service.url));
  const visited = new Set();
  while (pending.length) {
    const url = pending.shift(); if (visited.has(url.href)) continue; visited.add(url.href);
    const response = await fetch(url);
    assert.equal(response.status, 200, 'Browser module is unavailable: ' + url.pathname);
    assert.match(response.headers.get('content-type'), /javascript/);
    const source = await response.text();
    for (const match of source.matchAll(/^import\s+.*?\s+from\s+['"]([^'"]+)['"]/gm)) pending.push(new URL(match[1], url));
  }
  assert.ok(visited.size > 10);
  assert.equal(upstream.seen.requests.length, 0);
});

test("private APIs reject anonymous, wrong-token and foreign-origin requests", async (t) => {
  const { service, headers } = await setup(t);
  assert.equal((await fetch(service.url + "api/bootstrap")).status, 403);
  assert.equal((await fetch(service.url + "api/bootstrap", { headers: { "x-pelican-token": "wrong" } })).status, 403);
  assert.equal((await fetch(service.url + "api/bootstrap", { headers: { ...headers, origin: "https://evil.example" } })).status, 403);
  const ok = await fetch(service.url + "api/bootstrap", { headers: { ...headers, origin: "null" } });
  assert.equal(ok.status, 200);
  const boot = await ok.json();
  assert.equal(boot.models.length, 4);
  assert.ok(boot.defaultPrompt.includes("鹈鹕"));
  assert.equal(boot.dataDir, service.dataDir);
});

test("DNS-rebound Host is rejected even for the UI that contains its token", async (t) => {
  const { service } = await setup(t);
  const code = await new Promise((resolve, reject) => {
    const req = request(service.url, { headers: { host: "evil.example" } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject); req.end();
  });
  assert.equal(code, 403);
});

test("HTML result is persisted and preview has a separate capability and no network", async (t) => {
  const { service, headers } = await setup(t);
  const created = await submit(service, headers);
  assert.equal(created.status, 201);
  const { runs } = await created.json();
  const detail = await waitFor(async () => {
    const run = await (await fetch(service.url + "api/runs/" + runs[0].id, { headers })).json();
    return run.status === "completed" && run;
  });
  assert.equal(detail.html, FIXTURE_HTML);
  assert.ok(detail.files.html.endsWith("result.html"));
  assert.ok(detail.previewUrl.startsWith("preview/"));
  assert.equal(detail.previewKey, undefined, "Only the protected preview URL is sent to the UI");
  assert.equal((await fetch(service.url + "preview/" + detail.id)).status, 403);
  assert.equal((await fetch(service.url + "preview/" + detail.id + "?key=wrong")).status, 403);
  const response = await fetch(service.url + detail.previewUrl);
  assert.equal(response.status, 200);
  assert.ok(response.headers.get("content-security-policy").includes("connect-src 'none'"));
  assert.ok(response.headers.get("content-security-policy").includes("sandbox allow-scripts"));
  const preview = await response.text();
  assert.ok(preview.includes("pelican-preview"));
  assert.ok(!preview.includes(headers["x-pelican-token"]));
  const previewKey = new URL(service.url + detail.previewUrl).searchParams.get("key");
  assert.equal((await fetch(service.url + "api/runs", { headers: { "x-pelican-token": previewKey } })).status, 403);
});

test("browser-open uses the authenticated saved result and cannot choose an external URL", async (t) => {
  const dir = await temporary(t), upstream = await fakeGateway(t), opened = [];
  const service = await startTestServer({ port: 0, dataDir: dir, gatewayUrl: upstream.url, openPreview: async (url) => opened.push(url) });
  t.after(() => service.close());
  const page = await (await fetch(service.url)).text();
  const token = page.match(/name="pelican-token" content="([a-f0-9]+)"/)[1];
  const headers = { "x-pelican-token": token, "content-type": "application/json", origin: "null" };
  const { runs } = await (await submit(service, headers)).json();
  const detail = await waitFor(async () => {
    const run = await (await fetch(service.url + "api/runs/" + runs[0].id, { headers })).json();
    return run.status === "completed" && run;
  });
  const path = service.url + "api/runs/" + detail.id + "/open";
  assert.equal((await fetch(path, { method: "POST" })).status, 403);
  assert.equal(opened.length, 0);
  const response = await fetch(path, { method: "POST", headers, body: '{"url":"https://example.invalid/"}' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { opened: true });
  assert.deepEqual(opened, [service.url + detail.previewUrl], "The server constructs the saved preview URL rather than trusting a submitted URL");
  assert.equal((await fetch(opened[0])).status, 200);
  assert.equal(upstream.seen.requests.length, 1, "Browser-open must not generate again");
});

test("folder-open authenticates the request and opens only the configured output root", async (t) => {
  const dir = await temporary(t), upstream = await fakeGateway(t), opened = [];
  let failure = true;
  const service = await startTestServer({ port: 0, dataDir: dir, gatewayUrl: upstream.url, openStorage: async path => {
    if (failure) { failure = false; throw Object.assign(new Error("Folder launch failed"), { status: 502 }); }
    opened.push(path);
  } }); t.after(() => service.close());
  const token = (await (await fetch(service.url)).text()).match(/name="pelican-token" content="([a-f0-9]+)"/)[1];
  const headers = { "x-pelican-token": token, "content-type": "application/json", origin: "null" };
  const endpoint = service.url + "api/storage/open";
  assert.equal((await (await fetch(service.url + "api/bootstrap", { headers })).json()).openDataDir, true);
  assert.equal((await fetch(endpoint, { method: "POST" })).status, 403);
  assert.equal((await fetch(endpoint, { method: "POST", headers: { ...headers, origin: "https://other.example" } })).status, 403);
  assert.equal((await fetch(endpoint, { headers })).status, 404);
  assert.deepEqual(opened, []);
  assert.equal((await fetch(endpoint, { method: "POST", headers })).status, 502);
  const response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ path: "C:/Windows", url: "https://example.invalid" }) });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { opened: true });
  assert.deepEqual(opened, [service.dataDir], "Webpage input cannot redirect a folder launch");
  assert.equal(upstream.seen.requests.length, 0);
});

test("HTTP JSON preserves Chinese split inside a UTF-8 character and counts raw request bytes", async (t) => {
  const { service, headers, upstream } = await setup(t);
  const prompt = "鹈鹕骑车 · 分块中文";
  const body = Buffer.from(JSON.stringify({ prompt, models: [{ id: "fixture/one" }] }));
  const split = body.indexOf(Buffer.from("鹈")) + 1;
  const result = await new Promise((resolve, reject) => {
    const req = request(service.url + "api/runs", { method: "POST", headers: { ...headers, "content-length": body.length } }, res => {
      let text = ""; res.on("data", bytes => { text += bytes; }); res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on("error", reject); req.write(body.subarray(0, split)); setTimeout(() => req.end(body.subarray(split)), 25);
  });
  assert.equal(result.status, 201); assert.equal(result.body.runs[0].prompt, prompt);
  await waitFor(() => upstream.seen.requests.length === 1);
  assert.equal(upstream.seen.requests[0].messages[0].content, prompt);
  const oversize = await fetch(service.url + "api/runs", { method: "POST", headers, body: JSON.stringify({ prompt: "鹈".repeat(24000), models: [{ id: "fixture/one" }] }) });
  assert.equal(oversize.status, 413);
  const malformed = Buffer.concat([Buffer.from('{"prompt":"'), Buffer.from([0xff]), Buffer.from('","models":[{"id":"fixture/one"}]}')]);
  assert.equal((await fetch(service.url + "api/runs", { method: "POST", headers, body: malformed })).status, 400);
  assert.equal(upstream.seen.requests.length, 1, "Rejected requests must not consume a model call");
  await service.close(); // Drain the accepted generation before shared temporary-directory cleanup.
});

test("a saved result keeps its preview link across a host restart without generating again", async (t) => {
  const { service, headers, upstream, dir } = await setup(t);
  const { runs } = await (await submit(service, headers)).json();
  const detail = await waitFor(async () => {
    const value = await (await fetch(service.url + "api/runs/" + runs[0].id, { headers })).json();
    return value.status === "completed" && value;
  });
  const url = service.url + detail.previewUrl;
  assert.equal((await fetch(url)).status, 200);
  const original = await readFile(detail.files.html, "utf8");
  await service.close();
  const replacement = await httpService.startServer({ port: service.port, dataDir: dir, gatewayUrl: upstream.url });
  t.after(() => replacement.close());
  await replacement.ready;
  const replay = await fetch(url);
  assert.equal(replay.status, 200, "Restarting the host must not revoke the preview of a saved result");
  assert.ok((await replay.text()).includes("鹈鹕"));
  assert.equal(await readFile(detail.files.html, "utf8"), original);
  assert.equal(upstream.seen.requests.length, 1, "Replay must not call the model again");
  assert.equal((await fetch(replacement.url + "api/runs", { headers })).status, 403, "The old API session must still expire");
});

test("legacy results gain a persistent preview without rewriting their output files", async (t) => {
  const dir = await temporary(t), id = "8767bb63-c10d-4c95-b267-6c3940cf31e2", runDir = join(dir, id);
  await mkdir(runDir);
  const files = { metadata: join(runDir, "run.json"), html: join(runDir, "result.html"), response: join(runDir, "response.txt") };
  await writeFile(files.metadata, JSON.stringify({ id, batchId: id, createdAt: new Date().toISOString(), status: "completed", html: FIXTURE_HTML, content: FIXTURE_HTML, files }));
  await writeFile(files.html, FIXTURE_HTML);
  await writeFile(files.response, "An existing file edited independently of the saved record");
  const upstream = await fakeGateway(t);
  const service = await startTestServer({ port: 0, dataDir: dir, gatewayUrl: upstream.url });
  t.after(() => service.close());
  const page = await (await fetch(service.url)).text();
  const token = page.match(/name="pelican-token" content="([a-f0-9]+)"/)[1];
  const detail = await (await fetch(service.url + "api/runs/" + id, { headers: { "x-pelican-token": token } })).json();
  assert.equal((await fetch(service.url + detail.previewUrl)).status, 200);
  assert.equal(await readFile(files.html, "utf8"), FIXTURE_HTML);
  assert.equal(await readFile(files.response, "utf8"), "An existing file edited independently of the saved record", "A preview migration must touch metadata only");
  const saved = JSON.parse(await readFile(files.metadata, "utf8"));
  assert.equal(new URL(service.url + detail.previewUrl).searchParams.get("key"), saved.previewKey);
  assert.equal(upstream.seen.requests.length, 0);
});

test("cancel API preserves partial reply and stops server-side generation", async (t) => {
  const { service, headers, upstream } = await setup(t, ({ res, chunk }) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    chunk({ choices: [{ delta: { content: "<html>partial" } }] });
  });
  const { runs } = await (await submit(service, headers)).json();
  await waitFor(() => upstream.seen.requests.length === 1);
  const response = await fetch(service.url + "api/runs/" + runs[0].id + "/cancel", { method: "POST", headers });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "cancelled");
  await waitFor(() => upstream.seen.aborted === 1);
});

test("malformed JSON and path traversal return bounded errors without exposing files", async (t) => {
  const { service, headers } = await setup(t);
  assert.equal((await fetch(service.url + "api/runs", { method: "POST", headers, body: "{" })).status, 400);
  assert.equal((await fetch(service.url + "api/runs/not-an-id", { headers })).status, 400);
  assert.equal((await fetch(service.url + "lib/server.mjs")).status, 404);
  assert.equal((await fetch(service.url + "ui/%2e%2e%2fpackage.json")).status, 404);
});

test("events send a ready snapshot before generation and support authenticated opaque-origin streaming", async (t) => {
  const { service, headers } = await setup(t);
  const abort = new AbortController();
  const response = await fetch(service.url + "api/events", { headers: { ...headers, origin: "null" }, signal: abort.signal });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "null");
  const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.ok(first.includes("event: hello"));
  abort.abort();
  await reader.cancel().catch(() => {});
});

test("occupied service port waits in background and binds after the old host releases it", async (t) => {
  assert.equal(typeof httpService.startServer, "function", "Authenticated plugin service is missing");
  const occupying = createServer();
  await new Promise((resolve) => occupying.listen(0, "127.0.0.1", resolve));
  const port = occupying.address().port;
  const dir = await temporary(t);
  const service = await httpService.startServer({ port, dataDir: dir });
  t.after(() => service.close());
  assert.equal(service.listening, false);
  await new Promise((resolve) => occupying.close(resolve));
  assert.equal(await service.ready, port);
  assert.equal((await fetch(service.url)).status, 200);
});

test("waiting host does not interrupt the old host's runs and restores its final result after binding", async (t) => {
  const occupying = createServer();
  await new Promise((resolve) => occupying.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => occupying.listening ? occupying.close(resolve) : resolve()));
  const dir = await temporary(t);
  const id = "9cb49ba0-e408-4652-822f-0164b0e74ea0";
  await mkdir(join(dir, id));
  const path = join(dir, id, "run.json");
  const run = { id, batchId: id, status: "running", createdAt: new Date().toISOString(), content: "partial", reasoning: "", html: "" };
  await writeFile(path, JSON.stringify(run));
  const service = await httpService.startServer({ port: occupying.address().port, dataDir: dir });
  t.after(() => service.close());
  assert.equal(JSON.parse(await readFile(path, "utf8")).status, "running", "A waiting replacement must leave old host state alone");
  await writeFile(path, JSON.stringify({ ...run, status: "completed", content: FIXTURE_HTML, html: FIXTURE_HTML }));
  await new Promise((resolve) => occupying.close(resolve));
  await service.ready;
  const html = await (await fetch(service.url)).text();
  const token = html.match(/name="pelican-token" content="([a-f0-9]+)"/)[1];
  const boot = await (await fetch(service.url + "api/bootstrap", { headers: { "x-pelican-token": token } })).json();
  assert.equal(boot.runs[0].status, "completed");
});
