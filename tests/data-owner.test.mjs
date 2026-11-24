import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, rm, symlink, access } from "node:fs/promises";
import { join } from "node:path";
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
