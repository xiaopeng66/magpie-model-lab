// RYP: exercise the real host with synthetic credentials and an isolated local upstream.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Gateway } from '../lib/gateway.mjs';

const primary = 'synthetic-primary-key', spare = 'synthetic-spare-key', replacement = 'synthetic-replacement-key';
const target = key => ({ mode: 'pinned', id: 'key:' + createHash('sha256').update(key).digest('hex') });
const short = key => target(key).id.slice(4, 14);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
async function stopChild(child, exit) {
  child.kill(); let timer;
  try { await Promise.race([exit, new Promise(resolve => { timer = setTimeout(resolve, 5000); })]); }
  finally { clearTimeout(timer); }
  assert.notEqual(child.exitCode ?? child.signalCode, null, 'The isolated host must stop');
}

export async function verifyMultiKeyHost({ magpie, output } = {}) {
  assert.ok(magpie, 'Pass --magpie with the absolute path to the Magpie executable');
  const executable = resolve(magpie);
  if (process.platform === 'win32') assert.equal(basename(executable).toLowerCase(), 'magpie.exe', 'Use magpie.exe directly so the probe owns and stops its host process');
  const temporaryBase = resolve(tmpdir()), root = await mkdtemp(join(temporaryBase, 'magpie-multi-key-host-'));
  const configHome = join(root, 'config'), cacheHome = join(root, 'cache'), configDir = join(configHome, 'magpie');
  const seen = [], proofs = []; let child, childExit, failure, denyNext = false, stopped = false;
  const upstream = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: ['one', 'two'].map(id => ({ id })) })); return;
      }
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return; }
      let text = ''; for await (const bytes of req) { text += bytes; assert.ok(text.length < 65536, 'Synthetic request exceeded its limit'); }
      const body = JSON.parse(text), secret = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const identity = secret === primary ? 'primary' : secret === spare ? 'spare' : secret === replacement ? 'replacement' : 'unknown';
      seen.push({ identity, model: body.model, pinReachedUpstream: Boolean(req.headers['x-magpie-account']) });
      if (denyNext) { denyNext = false; res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Synthetic credential refused' } })); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ model: body.model, choices: [{ index: 0, delta: { content: '最终答案：21' } }] }) + '\n\n');
      res.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 } }) + '\n\ndata: [DONE]\n\n');
    } catch { res.destroy(); }
  });
  try {
    await Promise.all([mkdir(configDir, { recursive: true }), mkdir(join(cacheHome, 'magpie'), { recursive: true })]);
    const upstreamURL = await listen(upstream), reservation = createServer();
    const hostURL = await listen(reservation); await close(reservation);
    const base = { id: 'fixture', name: 'Synthetic', chat: upstreamURL + '/v1', baseAPI: 'chat', models: ['one', 'two'] };
    const save = async provider => {
      const file = join(configDir, 'providers.json'), staging = file + '.tmp';
      await writeFile(staging, JSON.stringify({ providers: [{ ...base, ...provider }], noAutoGroups: true })); await rename(staging, file);
    };
    const original = { key: primary, keyName: '同名分组', keys: [{ key: spare, name: '同名分组' }], accountModels: { [short(spare)]: ['one'] } };
    await save(original);
    await writeFile(join(configDir, 'plugins.yml'), '[]\n');
    await writeFile(join(cacheHome, 'magpie', 'models.json'), '{}');
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/KEY|TOKEN|SECRET|PASSWORD/i.test(name) && !name.startsWith('MAGPIE_') && !name.startsWith('XDG_')));
    Object.assign(env, { XDG_CONFIG_HOME: configHome, XDG_CACHE_HOME: cacheHome, MAGPIE_ADDR: new URL(hostURL).host });
    child = spawn(executable, ['serve'], { env, cwd: root, stdio: 'ignore', windowsHide: true });
    child.on('error', error => { failure = error; }); childExit = new Promise(resolve => child.once('exit', resolve));
    let descriptor;
    const started = Date.now();
    while (Date.now() - started < 20000) {
      if (failure) throw failure;
      assert.equal(child.exitCode, null, 'Isolated Magpie stopped before readiness');
      try {
        descriptor = JSON.parse(await readFile(join(configDir, 'gateway.json'), 'utf8'));
        const reply = await fetch(hostURL + '/', { signal: AbortSignal.timeout(500), redirect: 'error' });
        if (reply.ok && (await reply.json()).name === 'magpie') break;
      } catch { /* the owned host is still starting */ }
      await pause(100);
    }
    assert.equal(descriptor?.pid, child.pid, 'The isolated descriptor must belong to the directly spawned host');
    const gateway = new Gateway({ url: hostURL, configDir }), models = await gateway.models();
    assert.ok(models.some(model => model.id === 'fixture/one'), 'The isolated synthetic model must be available');
    const payload = model => ({ model: 'fixture/' + model, stream: true, messages: [{ role: 'user', content: 'Synthetic local probe' }] });
    const signal = () => AbortSignal.timeout(10000);
    for (const [key, identity] of [[primary, 'primary'], [spare, 'spare']]) {
      const result = await gateway.generate(payload('one'), { account: target(key), signal: signal() });
      assert.equal(seen.at(-1).identity, identity); assert.equal(seen.at(-1).pinReachedUpstream, false);
      assert.equal(result.routing.verification, 'unavailable', 'This host provides model evidence without an ordinary Key ID');
      proofs.push({ case: 'pin-' + identity, passed: true, reportedAccount: result.routing.verification });
    }
    const beforeRestriction = seen.length;
    await assert.rejects(gateway.generate(payload('two'), { account: target(spare), signal: signal() }), /模型/);
    const refused = await fetch(hostURL + '/v1/chat/completions', { method: 'POST', signal: signal(), redirect: 'error', headers: { ...gateway.headers, 'x-magpie-account': 'fixture#' + short(spare) }, body: JSON.stringify(payload('two')) });
    assert.equal(refused.status, 400); await refused.body?.cancel(); assert.equal(seen.length, beforeRestriction);
    proofs.push({ case: 'restricted-model-no-fallback', passed: true, status: refused.status });
    await save({ key: spare, keyName: '已重命名', keys: [{ key: primary, off: true }], accountModels: { [short(spare)]: ['one'] } });
    // A file edit outside the host can overlap its one-second held catalog.
    await pause(1100);
    const binding = await gateway.resolveAccount('fixture/one', target(spare)); assert.equal(binding.header, 'fixture');
    await gateway.generate(payload('one'), { account: target(spare), signal: signal() }); assert.equal(seen.at(-1).identity, 'spare');
    proofs.push({ case: 'single-enabled-key-stable-identity', passed: true });
    await save({ key: primary, keys: [{ key: replacement, name: '同名分组' }] });
    await pause(1100);
    const beforeReplacement = seen.length;
    await assert.rejects(gateway.generate(payload('one'), { account: target(spare), signal: signal() }), /账号/); assert.equal(seen.length, beforeReplacement);
    await gateway.generate(payload('one'), { account: target(replacement), signal: signal() }); assert.equal(seen.at(-1).identity, 'replacement');
    proofs.push({ case: 'replaced-key-old-identity-rejected', passed: true });
    denyNext = true; const beforeFailure = seen.length;
    await assert.rejects(gateway.generate(payload('one'), { account: target(replacement), signal: signal() }), /失败/);
    assert.equal(seen.length, beforeFailure + 1); assert.equal(seen.at(-1).identity, 'replacement');
    proofs.push({ case: 'failed-pin-does-not-switch-key', passed: true });
    assert.ok(seen.every(request => request.identity !== 'unknown' && !request.pinReachedUpstream));
    const report = { hostVersion: descriptor.version, proofs, upstreamRequests: seen.length, realCredentialsUsed: false, hostStopped: false };
    // Do not declare cleanup successful until the directly owned process exits.
    await stopChild(child, childExit); stopped = true;
    report.hostStopped = true;
    if (output) { const file = resolve(output); await mkdir(resolve(file, '..'), { recursive: true }); await writeFile(file, JSON.stringify(report, null, 2) + '\n'); }
    return report;
  } finally {
    if (child && !stopped && child.exitCode === null && child.signalCode === null) await stopChild(child, childExit);
    await close(upstream);
    assert.ok(root.startsWith(temporaryBase + sep) && basename(root).startsWith('magpie-multi-key-host-'), 'Unsafe probe cleanup path');
    await rm(root, { recursive: true, force: true, maxRetries:8, retryDelay:100 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), magpie = args[args.indexOf('--magpie') + 1], output = args.includes('--output') ? args[args.indexOf('--output') + 1] : undefined;
  if (!args.includes('--magpie')) throw Error('Usage: node tools/verify-multi-key-host.mjs --magpie <absolute executable path> [--output <report.json>]');
  console.log(JSON.stringify(await verifyMultiKeyHost({ magpie, output }), null, 2));
}
