import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const source = await readFile(new URL("../page/boot.js", import.meta.url), "utf8");
async function entry(magpie) {
  const added = [], timers = new Map(), status = { textContent: "", after(control) { added.push(control); } };
  let reloads = 0, navigation = "";
  const root = { dataset: {} };
  runInNewContext(source, { window: { magpie }, URL, document: { documentElement: root, getElementById: () => status, createElement: () => ({}) },
    location: { href: "http://plugin.local/page/index.html", reload() { reloads++; }, replace(value) { navigation = value; } },
    setTimeout(callback) { timers.set(1, callback); return 1; }, clearTimeout(id) { timers.delete(id); } });
  await new Promise(resolve => setImmediate(resolve));
  return { status, added, timers, root, reloads: () => reloads, navigation: () => navigation };
}

test("entry failure exposes one retry and stalled bridge initialization has a recovery button", async () => {
  for (const bridge of [undefined, { ready: new Promise(() => {}) }, { ready: Promise.resolve({}), options: { get: async () => { throw new Error("无法读取选项"); } } }]) {
    const page = await entry(bridge); for (const callback of page.timers.values()) callback();
    assert.equal(page.added.length, 1); assert.equal(page.added[0].textContent, "重试"); page.added[0].onclick(); assert.equal(page.reloads(), 1);
  }
});

test("entry navigation retains host theme and provider context", async () => {
  const page = await entry({ ready: Promise.resolve({ dark: true, tokens: { fg: "#ffffff" } }), options: { get: async () => ({ port: 3489 }) }, context: { provider: { id: "fixture" } } });
  const url = new URL(page.navigation());
  assert.equal(page.root.dataset.theme, "dark", "The loading screen must use the same mode as the destination");
  assert.equal(url.hostname, "127.0.0.1"); assert.equal(url.searchParams.get("theme"), "dark"); assert.equal(url.searchParams.get("provider"), "fixture"); assert.equal(url.searchParams.get("view"), "fingerprint");
});
