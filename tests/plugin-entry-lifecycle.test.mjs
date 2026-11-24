import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { acquireDataOwner } from "../lib/data-owner.mjs";
import { fakeGateway, temporary, waitFor } from "./helpers.mjs";

async function availablePort() {
  for (let attempt = 0; attempt < 16; attempt++) {
    const probe = createServer((_req, res) => res.end("fixture"));
    await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
    const port = probe.address().port;
    try { await (await fetch(`http://127.0.0.1:${port}/`)).text(); return port; }
    catch (error) { if (error.cause?.message !== "bad port") throw error; }
    finally { probe.closeAllConnections(); await new Promise(resolve => probe.close(resolve)); }
  }
  throw new Error("No browser-compatible fixture port");
}

for (const hostPendingMs of [0, 2500]) test(hostPendingMs
  ? "Magpie-style busy parent EOF drains and releases ownership before the host's other calls end"
  : "Magpie-style parent EOF drains the plugin service, interrupts generation and releases directory ownership", { timeout: 20000 }, async t => {
  const dir = await temporary(t), port = await availablePort(), url = `http://127.0.0.1:${port}/`;
  const upstream = await fakeGateway(t, ({ res, chunk }) => { res.writeHead(200, { "content-type": "text/event-stream" }); chunk({ choices: [{ delta: { content: "partial fixture reply" } }] }); });
  const entry = new URL("../index.mjs", import.meta.url).href;
  // The installed Magpie host exits directly when readline closes; no plugin disposal hook is called.
  const parent = spawn(process.execPath, ["--input-type=module", "-e", `
    import readline from "node:readline";
    const rl = readline.createInterface({input:process.stdin,terminal:false});
    rl.on("close",()=>${hostPendingMs ? `setTimeout(()=>process.exit(0),${hostPendingMs})` : "process.exit(0)"});
    const plugin = (await import(${JSON.stringify(entry)})).default;
    await plugin.server({directory:process.argv[1]},{port:Number(process.argv[2])});
    console.log("fixture parent ready");
  `, dir, String(port)], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    env: { ...process.env, MAGPIE_ADDR: upstream.url, MAGPIE_GATEWAY_KEY: "fixture-gateway", MAGPIE_PELICAN_BANK_SOURCE: "" } });
  let output = "", errors = ""; parent.stdout.on("data", bytes => { output += bytes; }); parent.stderr.on("data", bytes => { errors += bytes; });
  const exited = new Promise((resolve, reject) => { parent.once("exit", resolve); parent.once("error", reject); });
  t.after(async () => { parent.stdin.end(); if (parent.exitCode === null) await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 2000))]); if (parent.exitCode === null) parent.kill(); });
  await waitFor(() => output.includes("fixture parent ready"), 15000);
  const page = await (await fetch(url, { signal: AbortSignal.timeout(2000) })).text();
  const token = page.match(/name="pelican-token" content="([^"]+)"/)[1], headers = { "content-type": "application/json", "x-pelican-token": token };
  const post = async (path, body) => { const response = await fetch(url + path, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(2000) }); assert.ok(response.ok); return response.json(); };
  const settings = (await (await fetch(url + "api/settings", { headers })).json()).settings;
  await post("api/settings/save", { expectedRevision: settings.revision, patch: { manual: { pelican: { ...settings.manual.pelican, timeoutMs: 1800000 } } } });
  const { runs } = await post("api/runs", { kind: "candy", models: [{ id: "fixture/one" }], timeoutMs: 0 });
  await waitFor(async () => (await (await fetch(url + "api/runs/" + runs[0].id, { headers })).json()).content === "partial fixture reply");
  const dataDir = join(dir, "magpie-pelican-bench", "runs");
  parent.stdin.end();
  if (hostPendingMs) {
    await waitFor(() => access(join(dataDir, ".data-owner")).then(() => false, error => { if (error.code === "ENOENT") return true; throw error; }), 1000);
    assert.equal(parent.exitCode, null, "The plugin must finish independently of the host's pending calls");
  }
  assert.equal(await exited, 0, errors);
  await waitFor(async () => { try { await fetch(url, { signal: AbortSignal.timeout(300) }); return false; } catch { return true; } });
  const owner = await acquireDataOwner(dataDir); await owner.release();
  const saved = JSON.parse(await readFile(join(dataDir, runs[0].id, "run.json"), "utf8"));
  assert.equal(saved.status, "interrupted"); assert.equal(saved.content, "partial fixture reply"); assert.equal(saved.progress.phase, "ended");
  const restored = JSON.parse(await readFile(join(dataDir, ".settings", "state.json"), "utf8"));
  assert.equal(restored.manual.pelican.timeoutMs, 1800000); assert.equal(upstream.seen.requests.length, 1);
});
