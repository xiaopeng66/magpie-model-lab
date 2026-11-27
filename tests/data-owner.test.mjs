import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, rm, symlink, access, readdir, unlink, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { acquireDataOwner } from "../lib/data-owner.mjs";
import { startServer } from "../lib/server.mjs";
import { temporary, fakeGateway, startTestServer, waitFor } from "./helpers.mjs";

test("a second owner is refused until normal release; release is idempotent", async t => {
  const dir = await temporary(t), first = await acquireDataOwner(dir);
  await assert.rejects(() => acquireDataOwner(dir), e => e.status === 503);
  await first.release(); await first.release();
  await (await acquireDataOwner(dir)).release();
});
test("a changed token or abandoned marker is preserved and never taken over", async t => {
  const dir = await temporary(t), first = await acquireDataOwner(dir), path = join(dir, ".data-owner", "owner.json");
  const original = await readFile(path, "utf8");
  await writeFile(path, JSON.stringify({ token: "someone-else", pid: 0 }));
  await assert.rejects(() => first.release(), e => e.status === 503);
  await assert.rejects(() => acquireDataOwner(dir), e => e.status === 503);
  await writeFile(path, original); await first.release();
  await mkdir(join(dir, ".data-owner"));
  await assert.rejects(() => acquireDataOwner(dir), e => e.status === 503);
});
test("a second HTTP port cannot recover or interrupt the first writer's live run", async t => {
  const dir = await temporary(t), upstream = await fakeGateway(t, async ({ res }) => new Promise(resolve => res.once("close", resolve)));
  const first = await startTestServer({ port: 0, dataDir: dir, gatewayUrl: upstream.url }); t.after(() => first.close());
  const html = await (await fetch(first.url)).text(), token = html.match(/name="pelican-token" content="([^"]+)"/)[1];
  const response = await fetch(first.url + "api/runs", { method: "POST", headers: { "x-pelican-token": token, "content-type": "application/json" }, body: JSON.stringify({ prompt: "hold", models: [{ id: "fixture/one" }], timeoutMs: 0 }) });
  const { runs } = await response.json();
  const path = join(dir, runs[0].id, "run.json"); await waitFor(async () => JSON.parse(await readFile(path, "utf8")).status === "running");
  const before = await readFile(path, "utf8"), second = await startServer({ port: 0, dataDir: dir, gatewayUrl: upstream.url });
  await assert.rejects(second.ready, e => e.status === 503); await second.close();
  assert.equal(await readFile(path, "utf8"), before);
  await first.close();
  const third = await startTestServer({ port: 0, dataDir: dir, gatewayUrl: upstream.url }); await third.ready; await third.close();
});
test("initialization failure after acquisition releases its marker", async t => {
  const dir = await temporary(t); await writeFile(join(dir, ".fingerprint-bank"), "not a directory");
  const service = await startServer({ port: 0, dataDir: dir }); await assert.rejects(service.ready); await service.close();
  await (await acquireDataOwner(dir)).release();
});
test("a missing data directory below a linked ancestor is refused before creating directories in its destination", async t => {
  const dir = await temporary(t), external = await temporary(t), link = join(dir, "linked-parent");
  await symlink(external, link, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(() => acquireDataOwner(join(link, "must-not-exist")), error => error.status === 503);
  await assert.rejects(() => access(join(external, "must-not-exist")), error => error.code === "ENOENT");
});

async function abandonedOwner(dir, { legacy = false } = {}) {
  const moduleURL = new URL("../lib/data-owner.mjs", import.meta.url).href;
  const script = legacy ? `
    import {mkdir,writeFile} from "node:fs/promises"; import {join} from "node:path"; import {randomUUID} from "node:crypto";
    const dir=join(process.argv[1],".data-owner"); await mkdir(dir);
    await writeFile(join(dir,"owner.json"),JSON.stringify({token:randomUUID(),pid:process.pid,startedAt:new Date().toISOString()}));
  ` : `import {acquireDataOwner} from ${JSON.stringify(moduleURL)}; await acquireDataOwner(process.argv[1]);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script + "process.exit(9);", dir], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  let errors = ""; child.stderr.on("data", bytes => { errors += bytes; });
  assert.equal(await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); }), 9, errors);
  return readFile(join(dir, ".data-owner", "owner.json"), "utf8");
}

test("Windows reclaims a crashed owner and archives its exact marker without changing saved data", { skip: process.platform !== "win32" }, async t => {
  const dir = await temporary(t), saved = '{"status":"completed","content":"keep this result"}';
  await writeFile(join(dir, "saved.json"), saved);
  const before = await abandonedOwner(dir);
  const recovered = await acquireDataOwner(dir); t.after(() => recovered.release());
  assert.notEqual(JSON.parse(await readFile(join(dir, ".data-owner", "owner.json"), "utf8")).token, JSON.parse(before).token);
  const archives = (await readdir(dir)).filter(name => name.startsWith(".data-owner.stale-"));
  assert.equal(archives.length, 1);
  assert.equal(await readFile(join(dir, archives[0], "owner.json"), "utf8"), before);
  assert.equal(await readFile(join(dir, "saved.json"), "utf8"), saved);
});

test("Windows migrates a dead legacy owner but refuses a live legacy writer", { skip: process.platform !== "win32" }, async t => {
  const dir = await temporary(t), before = await abandonedOwner(dir, { legacy: true });
  await (await acquireDataOwner(dir)).release();
  const archives = (await readdir(dir)).filter(name => name.startsWith(".data-owner.stale-"));
  assert.equal(archives.length, 1);
  assert.equal(await readFile(join(dir, archives[0], "owner.json"), "utf8"), before);
  await mkdir(join(dir, ".data-owner"));
  const live = JSON.stringify({ token: randomUUID(), pid: process.pid, startedAt: "2020-01-01T00:00:00.000Z" });
  await writeFile(join(dir, ".data-owner", "owner.json"), live);
  await assert.rejects(() => acquireDataOwner(dir), error => error.status === 503);
  assert.equal(await readFile(join(dir, ".data-owner", "owner.json"), "utf8"), live);
});

test("Windows uses the kernel lease rather than a reused PID for its own crashed markers", { skip: process.platform !== "win32" }, async t => {
  const dir = await temporary(t); await abandonedOwner(dir);
  const path = join(dir, ".data-owner", "owner.json"), marker = JSON.parse(await readFile(path, "utf8"));
  marker.pid = process.pid; await writeFile(path, JSON.stringify(marker));
  await (await acquireDataOwner(dir)).release();
});

test("Windows keeps a live lease exclusive even when its disk marker is temporarily missing", { skip: process.platform !== "win32" }, async t => {
  const dir = await temporary(t), first = await acquireDataOwner(dir), path = join(dir, ".data-owner", "owner.json");
  t.after(() => first.release());
  const before = await readFile(path, "utf8");
  await unlink(path); await rmdir(join(dir, ".data-owner"));
  let unexpected;
  try { await assert.rejects(async () => { unexpected = await acquireDataOwner(dir.toUpperCase()); }, error => error.status === 503); }
  finally { await unexpected?.release(); await mkdir(join(dir, ".data-owner")); await writeFile(path, before); }
});

test("Windows preserves malformed, ambiguous and linked old markers instead of guessing", { skip: process.platform !== "win32" }, async t => {
  const dir = await temporary(t), marker = join(dir, ".data-owner"), path = join(marker, "owner.json");
  for (const bytes of ["{broken", JSON.stringify({ token: randomUUID(), pid: 0 }), JSON.stringify({ token: randomUUID(), pid: process.pid, startedAt: "bad date" }), JSON.stringify({ token: [randomUUID()], pid: process.pid, startedAt: "2020-01-01T00:00:00.000Z", lease: "win32-pipe-v1" }), JSON.stringify({ token: randomUUID(), pid: process.pid, startedAt: "2020-01-01T00:00:00.000Z", lease: "future-version" })]) {
    await mkdir(marker); await writeFile(path, bytes);
    let unexpected;
    try { await assert.rejects(async () => { unexpected = await acquireDataOwner(dir); }, error => error.status === 503); }
    finally { await unexpected?.release(); }
    assert.equal(await readFile(path, "utf8"), bytes);
    await unlink(path); await rmdir(marker);
  }
  const outside = await temporary(t); await symlink(outside, marker, "junction");
  await assert.rejects(() => acquireDataOwner(dir), error => error.status === 503);
  assert.deepEqual(await readdir(outside), []);
});
