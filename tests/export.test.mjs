import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporary } from './helpers.mjs';

const exports = await import('../lib/export.mjs').catch(() => ({}));
const data = { schema: 'pelican-batch-v1', runs: [{ content: '答案 21 · "quote" · $literal' }] };
const filename = 'magpie-model-lab-2026-11-19-candy-12345678.json';

function launcher(result = { code: 0, output: '' }) {
  const calls = [];
  const launch = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    queueMicrotask(() => { child.stdout.end(result.output); child.emit('close', result.code); }); return child;
  };
  return { launch, calls };
}

test('saving JSON waits for a native picker and returns the path only after writing complete Unicode JSON', async t => {
  const dir = await temporary(t), path = join(dir, "saved & ' $literal.json");
  assert.equal(typeof exports.saveJSON, 'function', 'JSON export needs a confirmed local save');
  const { launch, calls } = launcher({ code: 0, output: path });
  const result = await exports.saveJSON(data, filename, { platform: 'win32', launch });
  assert.deepEqual(result, { path }); assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), data);
  assert.equal(calls.length, 1); assert.match(calls[0].command, /[/\\]vendor[/\\]json-save[/\\]SaveJson\.exe$/);
  assert.equal(calls[0].options.shell, undefined); assert.equal(calls[0].options.windowsHide, false);
  assert.deepEqual(calls[0].args, [filename, String(process.ppid)]);
  assert.ok(!calls[0].args.some(argument => argument.includes(path) || argument.includes(data.runs[0].content)));
});

test('cancelling the native picker creates no file and does not report a completed download', async t => {
  const dir = await temporary(t); assert.equal(typeof exports.saveJSON, 'function');
  const { launch } = launcher();
  assert.deepEqual(await exports.saveJSON(data, filename, { platform: 'win32', launch }), { cancelled: true });
  assert.deepEqual(await readdir(dir), []);
});

test('saving rejects invalid picker targets and preserves an existing file on invalid or failed exports', async t => {
  const dir = await temporary(t), path = join(dir, 'existing.json'); await writeFile(path, 'keep original');
  assert.equal(typeof exports.saveJSON, 'function');
  for (const target of ['relative.json', '\\\\example.invalid\\share\\file.json', join(dir, 'wrong.txt'), dir]) {
    const { launch } = launcher({ code: 0, output: target }); await assert.rejects(() => exports.saveJSON(data, filename, { platform: 'win32', launch }));
  }
  const { launch } = launcher({ code: 1, output: '' }); await assert.rejects(() => exports.saveJSON(data, filename, { platform: 'win32', launch }), /保存/);
  const cyclic = {}; cyclic.self = cyclic;
  await assert.rejects(() => exports.saveJSON(cyclic, filename, { platform: 'win32', launch: launcher({ code: 0, output: path }).launch }));
  assert.equal(await readFile(path, 'utf8'), 'keep original');
  assert.deepEqual(await readdir(dir), ['existing.json']);
});

test('a confirmed overwrite replaces the JSON atomically without leaving temporary files', async t => {
  const dir = await temporary(t), path = join(dir, 'existing.json'); await writeFile(path, 'previous content');
  assert.equal(typeof exports.saveJSON, 'function');
  await exports.saveJSON(data, filename, { platform: 'win32', launch: launcher({ code: 0, output: path }).launch });
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), data); assert.deepEqual(await readdir(dir), ['existing.json']);
  const folder = join(dir, 'folder.json'); await mkdir(folder);
  await assert.rejects(() => exports.saveJSON(data, filename, { platform: 'win32', launch: launcher({ code: 0, output: folder }).launch }));
  assert.deepEqual(await readdir(folder), []);
});
