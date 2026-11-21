import { readFile, writeFile, mkdir, readdir, access } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

assert.ok(globalThis.Bun, "Run this check with: bun tools/check-static.mjs");
const root = resolve(import.meta.dirname, "..");
const output = join(root, ".test-data", "static");
const excluded = new Set([".test-data", ".local-data", "dist", "node_modules", ".git"]);
async function filesIn(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesIn(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}
const files = await filesIn(root);
const javascript = files.filter(file => /\.(?:js|mjs)$/.test(file));
for (const file of javascript) execFileSync("node", ["--check", file], { stdio: "pipe", windowsHide: true });
const html = await readFile(join(root, "ui/index.html"), "utf8");
const css = await readFile(join(root, "ui/style.css"), "utf8");
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
assert.equal(new Set(ids).size, ids.length, "Duplicate HTML IDs");
const uses = [...html.matchAll(/<use\s+href="#([^"]+)"/g)].map(match => match[1]);
for (const id of uses) assert.ok(ids.includes(id), "Missing SVG symbol: " + id);
for (const match of html.matchAll(/\b(?:for|aria-controls|aria-describedby|aria-labelledby)="([^"]+)"/g)) {
  for (const id of match[1].split(/\s+/)) assert.ok(ids.includes(id), "Missing control reference: " + id);
}
const declared = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map(match => match[1]));
for (const match of css.matchAll(/var\((--[\w-]+)/g)) assert.ok(declared.has(match[1]), "Missing CSS variable: " + match[1]);
for (const tag of html.matchAll(/<button\b[^>]*>/g)) assert.ok(/\btype="button"/.test(tag[0]), "Implicit form submission");
for (const id of ["max-tokens", "concurrency"]) {
  const field = [...html.matchAll(/<input\b[^>]*>/g)].find(match => match[0].includes(`id="${id}"`))?.[0];
  assert.ok(field, "Missing numeric field: " + id);
  assert.ok(!/\bmax=/.test(field), "No artificial numeric ceiling: " + id);
}
const metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
await access(join(root, metadata.magpie.page.file));
await access(join(root, metadata.magpie.page.icon));
await access(join(root, 'vendor/json-save/SaveJson.exe'));
const boot = await readFile(join(root, "page/index.html"), "utf8");
const bootCSS = boot.match(/<style>([\s\S]*?)<\/style>/)?.[1];
assert.ok(bootCSS, "Missing entry page styles");
await mkdir(output, { recursive: true });
await writeFile(join(output, "boot.css"), bootCSS);
const styleBuild = await Bun.build({ entrypoints: [join(root, "ui/style.css"), join(root, "ui/polish.css"), join(root, "ui/enhancements.css"), join(output, "boot.css")], target: "browser", write: false });
assert.equal(styleBuild.success, true, JSON.stringify(styleBuild.logs));
assert.equal(styleBuild.logs.length, 0);
const theme = block => Object.fromEntries([...block.matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-f]{6})\s*;/gi)].map(match => [match[1], match[2]]));
const light = theme(css.match(/:root\s*\{([\s\S]*?)\}/)[1]);
const dark = { ...light, ...theme(css.match(/:root\[data-theme="dark"\]\s*\{([\s\S]*?)\}/)[1]) };
const luminance = color => {
  assert.match(color || "", /^#[0-9a-f]{6}$/i, "Missing contrast color");
  const channels = color.slice(1).match(/../g).map(part => parseInt(part, 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
};
const ratio = (foreground, background) => {
  const values = [luminance(foreground), luminance(background)].sort((first, second) => second - first);
  return (values[0] + .05) / (values[1] + .05);
};
const pairs = [["--fg", "--bg"], ["--fg", "--surface"], ["--fg", "--surface-soft"], ["--muted", "--bg"], ["--muted", "--surface"], ["--muted", "--surface-soft"], ["--accent", "--surface"], ["--accent", "--accent-soft"], ["--accent-text", "--accent"], ["--success", "--success-bg"], ["--error", "--error-bg"], ["--error", "--surface"], ["--warning", "--warning-bg"], ["--muted", "--accent-soft"]];
const contrast = {};
for (const [name, colors] of Object.entries({ light, dark })) {
  const texts = pairs.map(([foreground, background]) => ({ foreground, background, ratio: ratio(colors[foreground], colors[background]) }));
  for (const pair of texts) assert.ok(pair.ratio >= 4.5, `${name} ${pair.foreground}/${pair.background}: ${pair.ratio}`);
  const boundaries = ["--surface", "--surface-soft", "--bg"].map(background => ({ background, ratio: ratio(colors["--control-line"], colors[background]) }));
  for (const pair of boundaries) assert.ok(pair.ratio >= 3, `${name} control/${pair.background}: ${pair.ratio}`);
  contrast[name] = { minimumText: Math.min(...texts.map(pair => pair.ratio)), minimumControl: Math.min(...boundaries.map(pair => pair.ratio)) };
}
let links = 0;
const documents = [join(root, "README.md"), join(root, "THIRD_PARTY_NOTICES.md"), ...files.filter(file => file.startsWith(join(root, "docs") + "/") || file.startsWith(join(root, "docs") + "\\")).filter(file => file.endsWith(".md"))];
for (const file of documents) {
  const content = await readFile(file, "utf8");
  for (const match of content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    if (/^(?:https?:|#)/.test(match[1])) continue;
    await access(resolve(dirname(file), match[1].split("#")[0]));
    links++;
  }
}
const report = { at: new Date().toISOString(), version: metadata.version, javascriptFiles: javascript.length, htmlIDs: ids.length, svgUses: uses.length, cssVariables: declared.size, cssBuild: { success: styleBuild.success, logs: styleBuild.logs.length }, contrast, localDocLinks: links };
await writeFile(join(root, ".test-data", `audit-${metadata.version}-static.json`), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
