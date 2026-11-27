import { join, resolve } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { parseArgs } from "node:util";
import { Gateway, DEFAULT_PROMPT } from "../lib/gateway.mjs";
import { RunStore } from "../lib/store.mjs";
import { Runner } from "../lib/runner.mjs";
import { pruneSmokeRuns } from "./smoke-retention.mjs";

const { values } = parseArgs({ options: { "data-dir": { type: "string" }, models: { type: "string", default: "deepseek/deepseek-flash,rua/gpt-6-astra" } } });
const dataDir = values["data-dir"] || resolve(".test-data", "smoke", "runs");
const store = new RunStore(dataDir);
await store.init();
const addr = process.env.MAGPIE_ADDR || "127.0.0.1:3425";
const runner = new Runner({ store, gateway: new Gateway({ url: /^https?:/.test(addr) ? addr : `http://${addr}`, key: process.env.MAGPIE_GATEWAY_KEY || "magpie" }) });
const catalog = await runner.models();
const picks = values.models.split(",").map((id) => {
  const model = catalog.find((m) => m.id === id);
  if (!model) throw new Error(`Model unavailable: ${id}`);
  return { id, effort: model.efforts.includes("low") ? "low" : "" };
});
const batch = await runner.submit({ prompt: DEFAULT_PROMPT, maxTokens: 8192, models: picks });
console.log(JSON.stringify({ batch: batch[0].batchId, models: picks.map((p) => p.id), dataDir }));
try {
  while (batch.some((r) => ["queued", "running"].includes(runner.get(r.id).status))) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    console.log(JSON.stringify(batch.map((r) => {
      const run = runner.get(r.id); return { id: run.id, model: run.model, status: run.status, chars: run.content.length, reasoningChars: run.reasoning.length };
    })));
  }
  const results = batch.map((r) => runner.get(r.id));
  for (const run of results) if (run.files?.html) {
    if (await readFile(run.files.html, "utf8") !== run.html) throw new Error("Saved HTML differs from original result");
  }
  const report = results.map(({ id, model, status, promptHash, effort, maxTokens, usage, elapsedMs, firstContentMs, files, error }) => ({ id, model, status, promptHash, effort, maxTokens, usage, elapsedMs, firstContentMs, files, error }));
  if (!values["data-dir"]) await pruneSmokeRuns(store, runner);
  await mkdir("docs", { recursive: true });
  await writeFile("docs/smoke-results.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (results.some((r) => r.status !== "completed")) process.exitCode = 1;
} finally { await runner.close(); }
