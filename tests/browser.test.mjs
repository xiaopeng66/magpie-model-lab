import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { temporary } from "./helpers.mjs";

const browser = await import("../lib/browser.mjs").catch(() => ({}));
const url = "http://127.0.0.1:12345/preview/abc8aefd-2b61-4c51-b742-f768d9158f5b?key=" + "a".repeat(64);

test("the default browser launcher passes a local preview URL without shell interpolation", async () => {
  assert.equal(typeof browser.openBrowser, "function", "The plugin needs a browser launcher");
  const calls = [];
  const launch = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter(); queueMicrotask(() => child.emit("close", 0)); return child;
  };
  await browser.openBrowser(url, { platform: "win32", launch });
  assert.equal(calls[0].command, "powershell.exe");
  assert.deepEqual(calls[0].args, ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", "Start-Process -FilePath $env:MAGPIE_PELICAN_PREVIEW_URL"]);
  assert.equal(calls[0].options.env.MAGPIE_PELICAN_PREVIEW_URL, url);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.shell, undefined);
  await browser.openBrowser(url, { platform: "darwin", launch });
  assert.equal(calls[1].command, "open");
  assert.deepEqual(calls[1].args, [url]);
  await browser.openBrowser(url, { platform: "linux", launch });
  assert.equal(calls[2].command, "xdg-open");
  assert.deepEqual(calls[2].args, [url]);
});

test("browser launcher refuses other targets and reports OS launch failures", async () => {
  assert.equal(typeof browser.openBrowser, "function", "The plugin needs a browser launcher");
  const launches = [];
  const launch = (...args) => { launches.push(args); const child = new EventEmitter(); queueMicrotask(() => child.emit("close", 1)); return child; };
  for (const target of ["https://example.invalid/", "file:///C:/Windows/", "http://127.0.0.1:12345/api/runs", url + "&other=1", url.replace("127.0.0.1", "evil.example")]) {
    await assert.rejects(() => browser.openBrowser(target, { launch }), /预览/);
  }
  assert.equal(launches.length, 0);
  await assert.rejects(() => browser.openBrowser(url, { launch }), /浏览器/);
});

test("folder opening passes an existing directory separately from the fixed launch command", async (t) => {
  assert.equal(typeof browser.openDirectory, "function", "Saved output needs a folder opener");
  const dir = join(await temporary(t), "saved runs & ' $literal"); await mkdir(dir);
  const calls = [];
  const launch = (command, args, options) => {
    calls.push({ command, args, options }); const child = new EventEmitter();
    queueMicrotask(() => child.emit("close", 0)); return child;
  };
  await browser.openDirectory(dir, { platform: "win32", launch });
  assert.equal(calls[0].command, "powershell.exe");
  assert.deepEqual(calls[0].args, ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", "Start-Process -FilePath $env:MAGPIE_PELICAN_DATA_DIR"]);
  assert.equal(calls[0].options.env.MAGPIE_PELICAN_DATA_DIR, dir);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.shell, undefined);
  for (const [platform, command] of [["darwin", "open"], ["linux", "xdg-open"]]) {
    await browser.openDirectory(dir, { platform, launch });
    assert.equal(calls.at(-1).command, command); assert.deepEqual(calls.at(-1).args, [dir]);
  }
});

test("folder opening refuses files, missing or linked directories and reports OS failure", async (t) => {
  assert.equal(typeof browser.openDirectory, "function", "Saved output needs a folder opener");
  const dir = await temporary(t), file = join(dir, "file.txt"), link = join(dir, "linked");
  await writeFile(file, "keep"); await symlink(await temporary(t), link, process.platform === "win32" ? "junction" : "dir");
  let launches = 0;
  const launch = () => { launches++; const child = new EventEmitter(); queueMicrotask(() => child.emit("close", 1)); return child; };
  for (const target of [file, link, join(dir, "missing"), "relative/path", "https://example.invalid/", "\\\\example.invalid\\share"]) {
    await assert.rejects(() => browser.openDirectory(target, { platform: "win32", launch }), /目录|文件夹/);
  }
  assert.equal(launches, 0);
  await assert.rejects(() => browser.openDirectory(dir, { launch }), /文件夹/);
});
