import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { RunStore } from "../lib/store.mjs";
import { failureInfo } from "../lib/diagnostics.mjs";
import { temporary, fakeGateway, startTestServer } from "./helpers.mjs";

test("A100-002: malformed optional samples are isolated without breaking healthy list, bootstrap or detail", async t => {
  const dir = await temporary(t), healthy = { id: randomUUID(), status: "completed", createdAt: new Date().toISOString(), kind: "candy", content: "最终答案：21" };
  const records = [healthy, ...[{ damaged: true }, [null], ["bad"], [{ error: {} }]].map(samples => ({ ...healthy, id: randomUUID(), samples }))];
  for (const run of records) { await mkdir(join(dir, run.id)); await writeFile(join(dir, run.id, "run.json"), JSON.stringify(run)); }
  const store = new RunStore(dir), recovery = await store.init();
  assert.equal(recovery.unreadable, 4);
  assert.deepEqual(store.list().map(run => run.id), [healthy.id]);
  for (const run of records) assert.deepEqual(JSON.parse(await readFile(join(dir, run.id, "run.json"), "utf8")), run);
  const upstream = await fakeGateway(t), service = await startTestServer({ port: 0, dataDir: dir, gatewayUrl: upstream.url }); t.after(() => service.close());
  const token = (await (await fetch(service.url)).text()).match(/name="pelican-token" content="([a-f0-9]+)"/)[1];
  for (const path of ["api/runs", "api/bootstrap", "api/runs/" + healthy.id]) {
    const response = await fetch(service.url + path, { headers: { "x-pelican-token": token } });
    assert.equal(response.status, 200, path);
    const data = await response.json();
    if (data.runs) assert.deepEqual(data.runs.map(run => run.id), [healthy.id]);
    else assert.equal(data.id, healthy.id);
  }
  assert.equal(upstream.seen.requests.length, 0);
});

test("A100-002: diagnostics tolerate damaged samples and retain errors from valid samples", () => {
  for (const samples of [{ damaged: true }, [null], ["bad"]]) assert.equal(failureInfo({ status: "error", error: "HTTP 429", samples }).code, "rate-limit");
  assert.equal(failureInfo({ status: "error", samples: [null, { error: "ECONNRESET" }] }).code, "connection");
});
