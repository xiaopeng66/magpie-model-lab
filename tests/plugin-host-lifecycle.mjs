// RYP: run the installed Windows Magpie host against an isolated, credential-free configuration.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, access, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { magpie: { type: "string" }, bun: { type: "string" }, output: { type: "string" }, seed: { type: "string" } } });
assert.equal(process.platform, "win32", "This acceptance checks Windows job-object teardown");
assert.ok(values.magpie && values.bun && values.output, "Pass --magpie, --bun and an existing --output directory");
const root = await mkdtemp(join(tmpdir(), "model-lab-real-host-"));
const configHome = join(root, "config"), cacheHome = join(root, "cache"), config = join(configHome, "magpie");
const source = fileURLToPath(new URL("../", import.meta.url)).replace(/[\\/]$/, "");
const fixture = join(root, "plugin");
const data = join(config, "magpie-pelican-bench", "runs"), output = resolve(values.output);
await mkdir(config, { recursive: true }); await mkdir(cacheHome);
const env = { ...process.env, XDG_CONFIG_HOME: configHome, XDG_CACHE_HOME: cacheHome, MAGPIE_BUN: resolve(values.bun), MAGPIE_PELICAN_BANK_SOURCE: "" };
const report = { at: new Date().toISOString(), magpie: resolve(values.magpie), root, data, drainDelayMs: 300, cases: [], paidGenerationRequests: 0 };
const exists = path => access(path).then(() => true, () => false);
let command = 0;

async function run(args) {
  const child = spawn(values.magpie, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.on("data", bytes => { out += bytes; }); child.stderr.on("data", bytes => { err += bytes; });
  const timer = setTimeout(() => child.kill(), 45000);
  const code = await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); }).finally(() => clearTimeout(timer));
  await writeFile(join(output, "real-host-" + (++command) + "-" + args[0] + "-" + (args[1] || "paths") + ".log"), out + err);
  assert.equal(code, 0, "Isolated Magpie command failed: " + args.slice(0, 2).join(" "));
  return out;
}

try {
  const paths = await run(["data"]);
  assert.ok(paths.replaceAll("/", "\\").toLowerCase().includes(config.toLowerCase()), "Magpie did not honor isolated XDG_CONFIG_HOME; do not run plugin commands");
  await mkdir(fixture);
  await cp(join(source, "index.mjs"), join(fixture, "index.mjs"));
  await cp(join(source, "package.json"), join(fixture, "package.json"));
  // Keep the real server and stores; delay its close to expose the host's job-object race deterministically.
  await writeFile(join(fixture, "serve.mjs"), `
    import { parseArgs } from "node:util";
    import { startServer } from ${JSON.stringify(pathToFileURL(join(source, "lib", "server.mjs")).href)};
    const { values } = parseArgs({ options: {
      port: { type: "string" }, "data-dir": { type: "string" }, "bank-source": { type: "string" }, "parent-stdin": { type: "boolean" }
    } });
    const pending = startServer({ port: Number(values.port), dataDir: values["data-dir"], bankSource: values["bank-source"] });
    let closing;
    const close = () => closing ||= (async () => {
      await new Promise(resolve => setTimeout(resolve, 300));
      await (await pending).close(); process.exit(0);
    })().catch(error => { console.error(error.message); process.exit(1); });
    process.stdin.once("end", close); process.stdin.resume();
    const server = await pending, port = await server.ready;
    console.log("Model Lab http://127.0.0.1:" + port + "/");
  `);
  if (values.seed) {
    const seed = resolve(values.seed), oldOwner = join(seed, ".data-owner");
    await cp(seed, data, { recursive: true, filter: path => path !== oldOwner });
    const favoritePath = join(data, ".favorites", "state.json");
    const favorites = JSON.parse(await readFile(favoritePath, "utf8"));
    favorites.enabled = false; for (const plan of favorites.plans) plan.enabled = false;
    await writeFile(favoritePath, JSON.stringify(favorites));
    report.seed = seed; report.isolatedAutomaticPlansDisabled = true;
  }
  await writeFile(join(config, "plugins.json"), JSON.stringify({ plugins: [{ spec: fixture, off: true }] }));
  for (let cycle = 1; cycle <= 2; cycle++) {
    await run(["plugin", "on", fixture]);
    await run(["plugin", "list", "--json"]);
    const favorites = JSON.parse(await readFile(join(data, ".favorites", "state.json"), "utf8"));
    assert.equal(favorites.schema, 3, "The real host did not initialize the candidate plugin");
    const markerExists = await exists(join(data, ".data-owner"));
    report.cases.push({ cycle, initialized: true, markerExists, cleanAfterCliExit: !markerExists });
    assert.equal(markerExists, false, "Magpie CLI ended its Windows process tree before the plugin released ownership");
    await run(["plugin", "off", fixture]);
    assert.equal(await exists(join(data, ".data-owner")), false);
  }
  console.log("PASS two real Windows Magpie CLI host exits; service initialized, ownership released, isolated config only");
} catch (error) {
  report.error = error.message; process.exitCode = 1; console.error(error.message);
} finally {
  await writeFile(join(output, "real-host-lifecycle.json"), JSON.stringify(report, null, 2));
}
