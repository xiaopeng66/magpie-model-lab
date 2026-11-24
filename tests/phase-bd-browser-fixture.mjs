import { pathToFileURL } from 'node:url';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RunStore } from '../lib/store.mjs';
import { normalizeTarget } from '../lib/targets.mjs';
import { legacyReasoningTask } from './legacy-task-fixtures.mjs';
import { phaseABoot, PHASE_HTML } from './phase-a-fixtures.mjs';
import { fingerprintGateway, referenceFixture, numberReply } from './fingerprint-helpers.mjs';
import { startTestServer } from './helpers.mjs';

// RYP: browser acceptance uses synthetic accounts, records and a local gateway.
export async function startPhaseBDFixture({ dataDir, proofDir, port = 0, seed = true, handler } = {}) {
  const owned = !dataDir, dir = dataDir || await mkdtemp(join(tmpdir(), 'phase-bd-browser-')), cleanups = [], routes = new Map();
  const accounts = Array.from({ length: 50 }, (_, i) => ({ provider: 'fixture', user: 'account-' + (i + 1), alias: i === 48 ? '合成账号 49 · ' + 'LongAccountName'.repeat(16) : '合成账号 ' + (i + 1), on: i !== 49, kind: 'subscription' }));
  const upstream = await fingerprintGateway({ after: fn => cleanups.push(fn) }, { bank: referenceFixture('browser-bd', true), models: Array.from({ length: 50 }, (_, i) => 'model-' + (i + 1)), accounts, route: session => ({ route: routes.get(session) || {} }),
    handler: ({ req, res, payload, complete }) => {
      routes.set(req.headers['x-magpie-session'], { model: payload.model, provider: 'fixture', accountId: req.headers['x-magpie-account'] || '' });
      if (handler) return handler({ req, res, payload, complete });
      const prompt = (payload.input || payload.messages)?.[0]?.content || '';
      complete(prompt.includes('糖果') ? '最终答案：21' : prompt.includes('355') || prompt.includes('numbers') || prompt.includes('random') ? numberReply(400) : PHASE_HTML);
    } });
  const store = new RunStore(dir); await store.init(); const runs = seed ? phaseABoot({ count: 100 }).runs : [];
  for (const [i, run] of runs.entries()) {
    const target = normalizeTarget({ modelId: 'fixture/model-' + (i % 50 + 1), account: { mode: 'pinned', id: accounts[i % 49].user, name: accounts[i % 49].alias } });
    Object.assign(run, { model: target.modelId, modelName: '合成模型 ' + (i % 50 + 1), ...{ targetKey: target.targetKey, accountTarget: target.account }, routing: { requestedAccountId: target.account.id, reportedAccountId: target.account.id, verification: 'verified' }, physicalRequests: [{ state: 'started', admissionPolicyHash: 'browser-rules' }] });
    if (run.kind === 'fingerprint') run.account = target.account.id;
    if (run.kind === 'candy' && i >= 80) { run.task = legacyReasoningTask(i % 2 ? 'arithmetic' : 'deduction'); run.prompt = run.task.prompt; run.grade = { expected: run.task.expected, answer: run.task.expected, verdict: 'match' }; run.content = '最终答案：' + run.task.expected; delete run.candy; run.experimentId = run.batchId; run.executionIndex = 0; run.repetitionIndex = 0; run.experiment = { repeatCount: 2, plannedRequests: 6, plannedRunCount: 6 }; }
    await store.save(run);
  }
  const save = async (value, filename) => {
    if (!proofDir) return { cancelled: true }; await mkdir(proofDir, { recursive: true }); const path = join(proofDir, filename);
    await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2)); return { path };
  };
  const service = await startTestServer({ port, dataDir: dir, gatewayUrl: upstream.url, bankSource: upstream.url + '/data/', saveExport: save });
  await service.ready;
  const html = await (await fetch(service.url)).text(), headers = { 'content-type': 'application/json', 'x-pelican-token': html.match(/name="pelican-token" content="([^"]+)"/)[1] };
  const call = async (path, input) => { const response = await fetch(service.url + path, { method: 'POST', headers, body: JSON.stringify(input) }); if (!response.ok) throw Error(await response.text()); return response.json(); };
  if (seed) {
    for (const account of accounts.slice(0, 2)) { const { favorite } = await call('api/favorites/save', { modelId: 'fixture/model-1', account: { mode: 'pinned', id: account.user }, maxTokens: 1200, timeoutMs: 600000 }); await call('api/schedules/save', { favoriteIds: [favorite.id], kinds: ['candy'], mode: 'times', times: ['09:00', '18:00'], days: [1, 2, 3, 4, 5], timeZone: 'Asia/Shanghai', enabled: false }); }
    await call('api/runs/annotations', { runId: runs.at(-1).id, expectedRunRevision: 0, note: '合成复核备注 · 多账号与多题验证', tags: ['实验', '待复核'] });
  }
  return { url: service.url, dataDir: dir, headers, seen: upstream.seen, service, async close() { await service.close(); for (const cleanup of cleanups.reverse()) await cleanup(); if (owned) await rm(dir, { recursive: true, force: true }); } };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const fixture = await startPhaseBDFixture({ proofDir: process.argv[2] }); console.log(JSON.stringify({ url: fixture.url, dataDir: fixture.dataDir, records: 100, targets: 50, realModelRequests: 0 }));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await fixture.close(); process.exit(0); });
}
