import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunStore } from '../lib/store.mjs';
import { Runner } from '../lib/runner.mjs';
import { Gateway } from '../lib/gateway.mjs';
import { Settings } from '../lib/settings.mjs';
import { Annotations } from '../lib/annotations.mjs';
import { Favorites } from '../lib/favorites.mjs';
import { UsageLedger } from '../lib/usage-ledger.mjs';
import { QueuePolicy, DEFAULT_QUEUE } from '../lib/queue-policy.mjs';
import { FIXTURE_HTML } from './helpers.mjs';

export async function enhancementSetup(t, { handler, accounts, runnerOptions = {}, settings: settingsPatch } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'model-lab-bd-')), seen = [];
  const candidates = accounts || [{ provider: 'fixture', id: 'a', name: 'A', enabled: true }, { provider: 'fixture', id: 'b', name: 'B', enabled: true }];
  const routes = new Map();
  const upstream = createServer(async (req, res) => {
    if (req.url === '/') return res.end(JSON.stringify({ name: 'magpie', version: '0.1.4530' }));
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: ['one', 'two'].map(id => ({ id: 'fixture/' + id, name: id, reasoning_levels: ['high'], modalities: { output: ['text'] } })) }));
    if (req.url === '/v1/magpie/quotas?kept=1') return res.end(JSON.stringify({ data: candidates.map(account => ({ provider: account.provider, user: account.id, alias: account.name, on: account.enabled, available: account.available, kind: 'subscription' })) }));
    if (req.url.startsWith('/v1/magpie/route?')) return res.end(JSON.stringify(routes.get(new URL(req.url, 'http://fixture').searchParams.get('session')) || {}));
    if (req.url !== '/v1/chat/completions') { res.writeHead(404); return res.end(); }
    let raw = ''; for await (const part of req) raw += part;
    const payload = JSON.parse(raw), account = req.headers['x-magpie-account'] || '', session = req.headers['x-magpie-session'];
    seen.push({ payload, account, session });
    routes.set(session, { provider: 'fixture', model: payload.model, ...(account ? { accountId: decodeURIComponent(account) } : {}) });
    const complete = (text = FIXTURE_HTML, route = null) => {
      if (route) routes.set(session, route);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'same-upstream-id' });
      res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } }) + '\n\ndata: [DONE]\n\n');
    };
    try { if (handler) await handler({ req, res, payload, account, session, complete }); else complete(); } catch { res.destroy(); }
  });
  for (let attempt = 0; attempt < 16; attempt++) {
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    try { await (await fetch(`http://127.0.0.1:${upstream.address().port}/`)).arrayBuffer(); break; }
    catch (error) { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); if (error.cause?.message !== 'bad port' || attempt === 15) throw error; }
  }
  const store = new RunStore(dir); await store.init();
  const settings = new Settings(dir, { capabilities: { presets: true, retention: true, progressNotice: true, queue: true, usage: true } }); await settings.init();
  if (settingsPatch) await settings.save({ expectedRevision: settings.snapshot().revision, patch: settingsPatch });
  const annotations = new Annotations(dir); await annotations.init();
  const gateway = new Gateway({ url: `http://127.0.0.1:${upstream.address().port}` });
  const usage = new UsageLedger(dir); await usage.init();
  const queuePolicy = new QueuePolicy(() => settings.snapshot().queue || DEFAULT_QUEUE, { dir }); await queuePolicy.init();
  const runner = new Runner({ store, gateway, settings, annotations, usage, queuePolicy, ...runnerOptions });
  const favorites = new Favorites({ dir, runner }); await favorites.init();
  t.after(async () => { await runner.close(); await favorites.close(); await settings.close(); await annotations.close(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  return { dir, store, settings, annotations, gateway, runner, favorites, seen, candidates };
}
