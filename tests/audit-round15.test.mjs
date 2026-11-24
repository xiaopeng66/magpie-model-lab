import test from 'node:test';
import assert from 'node:assert/strict';
import { Settings } from '../lib/settings.mjs';
import { QueuePolicy, DEFAULT_QUEUE } from '../lib/queue-policy.mjs';
import { createLabTools } from '../ui/lab-tools.mjs';
import { temporary, waitFor } from './helpers.mjs';
import { uiHarness } from './ui-harness.mjs';
import { enhancementSetup } from './enhancement-helpers.mjs';
import { ConfigTransfer, configDigest } from '../lib/config-transfer.mjs';

const specialProviders = ['constructor', 'toString', '__proto__'];
const target = provider => ({ provider, model: `${provider}/one`, accountTarget: { mode: 'auto' } });

test('default provider concurrency also applies when a provider name matches an inherited object property', () => {
  const queue = new QueuePolicy(() => ({ ...DEFAULT_QUEUE, providerConcurrency: 1 }));
  for (const provider of specialProviders) {
    const run = target(provider);
    assert.deepEqual(queue.check(run, [{ run }]), { allowed: false, reason: 'provider_limit' }, provider);
  }
});

test('default intervals and HTTP 429 cooldowns remain effective for inherited-property provider names', () => {
  let now = 1000;
  const queue = new QueuePolicy(() => ({ ...DEFAULT_QUEUE, minIntervalMs: 2000 }), { now: () => now });
  for (const provider of specialProviders) {
    const run = target(provider);
    queue.started(run);
    assert.deepEqual(queue.check(run, []), { allowed: false, reason: 'cooldown', until: 3000 }, provider);
  }
  now = 3000;
  for (const provider of specialProviders) {
    const run = target(provider);
    assert.deepEqual(queue.check(run, []), { allowed: true }, provider);
    queue.noteFailure(run, { upstreamStatus: 429, retryAfterMs: 10000 });
    assert.deepEqual(queue.check(run, []), { allowed: false, reason: 'cooldown', until: 13000 }, provider);
  }
});

test('a server-provided HTTP 429 cooldown blocks a special provider even when no startup interval is configured', () => {
  const queue = new QueuePolicy(() => DEFAULT_QUEUE, { now: () => 1000 });
  for (const provider of specialProviders) {
    const run = target(provider);
    queue.noteFailure(run, { upstreamStatus: 429, retryAfterMs: 10000 });
    assert.deepEqual(queue.check(run, []), { allowed: false, reason: 'cooldown', until: 11000 }, provider);
  }
});

for (const provider of specialProviders) test(`request-control rule ${provider} can be added, edited and deleted without changing the dictionary prototype`, async t => {
  const dir = await temporary(t), settings = new Settings(dir, { capabilities: { queue: true } });
  await settings.init(); t.after(() => settings.close());
  await settings.save({ expectedRevision: 0, patch: { queue: { ...structuredClone(DEFAULT_QUEUE), providerConcurrency: 1 } } });
  const ui = await uiHarness({ bootstrap: { models: [], runs: [], defaultPrompt: 'test' } });
  await waitFor(() => !ui.elements.get('generate').disabled); t.after(() => ui.closeStream());
  const body = ui.elements.get('drawer-content');
  ui.elements.get('favorite-drawer').hidden = false;
  const tools = createLabTools({ document: ui.document, $: id => ui.elements.get(id), api: async () => ({ queued: [], cooldowns: [] }),
    settingsUI: { snapshot: () => ({ ...settings.snapshot(), capabilities: settings.capabilities }), refresh: async () => {}, savePatch: async patch => {
      await settings.save({ expectedRevision: settings.snapshot().revision, patch }); return { state: 'saved' };
    } }, models: () => [{ provider, id: `${provider}/one` }], records: () => [], confirmAction: async () => true });
  tools.load({ queueAvailable: true }); tools.appendLocal(body);
  const find = label => ui.descendants(body, 'button').find(control => control.textContent === label && control.getClientRects().length);
  const input = label => ui.descendants(body, 'input').find(control => control.getAttribute('aria-label') === label);
  await find('新增供应商规则').fire('click'); input('单独并行数').value = '2';
  await find('保存规则').fire('click');
  assert.equal(Object.hasOwn(settings.snapshot().queue.providers, provider), true, 'The added rule must actually be persisted');
  assert.deepEqual(settings.snapshot().queue.providers[provider], { concurrency: 2, intervalMs: 0 });
  assert.equal(Object.getPrototypeOf(settings.snapshot().queue.providers), Object.prototype);
  const policy = new QueuePolicy(() => settings.snapshot().queue), run = target(provider);
  assert.deepEqual(policy.check(run, [{ run }]), { allowed: true });
  assert.deepEqual(policy.check(run, [{ run }, { run }]), { allowed: false, reason: 'provider_limit' });
  await find('编辑规则').fire('click'); input('单独并行数').value = '0';
  await find('保存规则').fire('click');
  assert.deepEqual(policy.check(run, [{ run }, { run }]), { allowed: true }, 'An explicit zero rule must still override defaults');
  await find('删除规则').fire('click');
  assert.equal(Object.hasOwn(settings.snapshot().queue.providers, provider), false);
  assert.deepEqual(policy.check(run, [{ run }]), { allowed: false, reason: 'provider_limit' }, 'Deletion must restore the default limit');
});

for (const scope of ['provider', 'account']) test(`parallel requests enforce the ${scope} startup interval at the actual fetch boundary`, async t => {
  const arrivals = [];
  const { runner, settings, seen } = await enhancementSetup(t, { handler({ complete }) { arrivals.push(performance.now()); complete('最终答案：21'); } });
  const queue = { ...structuredClone(DEFAULT_QUEUE), ...(scope === 'provider'
    ? { minIntervalMs: 250 }
    : { accounts: { '["fixture","a"]': { concurrency: 0, intervalMs: 250 } } }) };
  await settings.save({ expectedRevision: settings.snapshot().revision, patch: { queue } });
  const runs = await runner.submit({ kind: 'candy', concurrency: 2, targets: ['one', 'two'].map(id => ({ modelId: `fixture/${id}`, account: { mode: 'pinned', id: 'a' } })) });
  await waitFor(() => runs.every(run => runner.get(run.id)?.status === 'completed'));
  assert.equal(seen.length, 2, 'Requeueing must not create duplicate upstream requests');
  assert.ok(arrivals[1] - arrivals[0] >= 220, `Configured 250 ms; the upstream received requests only ${(arrivals[1] - arrivals[0]).toFixed(1)} ms apart`);
  assert.equal(runner.usage.summary().knownRequests, 2, 'Only the two issued requests may count toward usage');
});

test('a requeued request waits for its existing control to close before being admitted again', async t => {
  const { runner, gateway, settings } = await enhancementSetup(t);
  let release, readmitPaused = false, changed = false;
  const gate = new Promise(resolve => { release = resolve; }), generate = gateway.generate.bind(gateway), readmit = runner.readmit.bind(runner);
  gateway.generate = async (payload, options) => {
    if (!changed) {
      changed = true;
      await settings.save({ expectedRevision: settings.snapshot().revision, patch: { queue: { ...structuredClone(DEFAULT_QUEUE), providerConcurrency: 3 } } });
    }
    return generate(payload, options);
  };
  runner.readmit = async (...args) => { await readmit(...args); readmitPaused = true; await gate; };
  const [run] = await runner.submit({ kind: 'candy', concurrency: 2, targets: [{ modelId: 'fixture/one' }] });
  try {
    await waitFor(() => readmitPaused);
    const existing = runner.active.get(run.id);
    assert.ok(existing, 'The first control remains active until readmission cleanup completes');
    runner.pump(); await waitFor(() => !runner.pumping);
    assert.equal(runner.active.get(run.id), existing, 'A settings refresh must not replace the still-active control with another request');
  } finally { release(); }
  await waitFor(() => runner.get(run.id)?.status === 'completed');
  assert.equal(runner.usage.summary().knownRequests, 1);
});

test('waiting status changes from a supplier limit to the batch concurrency limit when rules are relaxed', async t => {
  const completions = [];
  const { runner, settings, seen } = await enhancementSetup(t, { handler({ complete }) { completions.push(complete); } });
  const queue = { ...structuredClone(DEFAULT_QUEUE), providerConcurrency: 1 };
  await settings.save({ expectedRevision: settings.snapshot().revision, patch: { queue } });
  const runs = await runner.submit({ kind: 'candy', concurrency: 2, targets: [
    { modelId: 'fixture/one', account: { mode: 'pinned', id: 'a' } },
    { modelId: 'fixture/two', account: { mode: 'pinned', id: 'a' } },
    { modelId: 'fixture/one', account: { mode: 'pinned', id: 'b' } },
  ] });
  try {
    await waitFor(() => seen.length === 1 && runner.queueStatus().queued.some(item => item.runId === runs[2].id && item.reason === 'provider_limit'));
    await settings.save({ expectedRevision: settings.snapshot().revision, patch: { queue: { ...queue, providerConcurrency: 2 } } });
    runner.pump(); await waitFor(() => seen.length === 2 && !runner.pumping);
    assert.equal(runner.queueStatus().queued.find(item => item.runId === runs[2].id)?.reason, 'concurrency');
    assert.equal(runner.queueStatus().queued.find(item => item.runId === runs[2].id)?.until, null);
  } finally { for (const complete of completions) complete('最终答案：21'); }
});

test('configuration imports reject an explicitly invalid queue value instead of silently removing request limits', async t => {
  const { runner, settings, favorites } = await enhancementSetup(t);
  const transfer = new ConfigTransfer({ runner, settings, favorites });
  for (const queue of [null, false, 0, '']) {
    const document = transfer.export(); document.payload.settings.queue = queue; document.digest = configDigest(document.payload);
    await assert.rejects(transfer.preview({ document, choices: { settings: { queue: 'overwrite' } } }), /队列/);
  }
  assert.equal(transfer.tokens.size, 0, 'Invalid rules cannot produce an applicable import preview');
});

test('a parallel HTTP 429 response cools a request that has not reached fetch yet', async t => {
  const { runner, gateway, seen } = await enhancementSetup(t, { handler({ res }) {
    res.writeHead(429); res.end('{"error":{"message":"Quota reached"}}');
  } });
  let release, waiting = false;
  const gate = new Promise(resolve => { release = resolve; }), generate = gateway.generate.bind(gateway);
  gateway.generate = async (payload, options) => {
    if (payload.model === 'fixture/one') { waiting = true; await gate; }
    return generate(payload, options);
  };
  const runs = await runner.submit({ kind: 'candy', concurrency: 2, models: [{ id: 'fixture/one' }, { id: 'fixture/two' }] });
  try {
    await waitFor(() => waiting && runner.get(runs[1].id)?.status === 'error');
    release();
    await waitFor(() => runner.queueStatus().queued.some(item => item.runId === runs[0].id && item.reason === 'cooldown'));
    t.diagnostic(JSON.stringify({ arrivalOrder: seen.map(item => item.payload.model), statuses: runs.map(run => runner.get(run.id).status), waitingReason: runner.get(runs[0].id).queueReason }));
    assert.equal(runner.get(runs[0].id).status, 'queued');
    assert.equal(runner.get(runs[1].id).upstreamStatus, 429);
    assert.equal(seen.length, 1, 'The pending request must respect the new cooldown before it is sent');
    assert.equal(runner.usage.summary().knownRequests, 1);
  } finally { release(); await runner.cancel(runs[0].id); }
});

test('repeated result groups expose distinct account names to assistive navigation', async t => {
  const records = [0, 1].flatMap(round => ['a', 'b'].map((account, index) => ({
    id: `repeat-${account}-${round}`, batchId: 'account-repetitions', kind: 'candy', model: 'fixture/one', modelName: 'one',
    provider: 'fixture', providerName: '合成供应商', accountTarget: { mode: 'pinned', id: account, name: `账号 ${account.toUpperCase()}` },
    experiment: { repeatCount: 2 }, repetitionIndex: round, executionIndex: round * 2 + index,
    createdAt: '2026-11-24T00:00:00Z', status: 'completed', content: '最终答案：21',
  })));
  const ui = await uiHarness({ bootstrap: { models: [], runs: records, candyAvailable: true, defaultPrompt: 'test' }, search: '?view=candy' });
  t.after(() => ui.closeStream());
  await waitFor(() => ui.descendants(ui.elements.get('candy-results'), 'article').length === 4);
  const names = ui.elements.get('candy-results').children.filter(element => element.className === 'repeat-model-row').map(element => element.getAttribute('aria-label'));
  assert.equal(names.length, 2);
  assert.equal(new Set(names).size, 2, 'Same-model groups must be distinguishable by their selected accounts');
  assert.ok(names[0].includes('账号 A'));
  assert.ok(names[1].includes('账号 B'));
});

test('retest selection identifies an exact account and original round without expanding repetitions again', async t => {
  const records = [0, 1].flatMap(round => ['a', 'b'].map((account, index) => ({
    id: `source-${account}-${round}`, batchId: 'original-repetitions', kind: 'candy', model: 'fixture/one', modelName: 'one',
    provider: 'fixture', providerName: '合成供应商', accountTarget: { mode: 'pinned', id: account, name: `账号 ${account.toUpperCase()}` },
    experiment: { repeatCount: 2 }, repetitionIndex: round, executionIndex: round * 2 + index,
    createdAt: '2026-11-24T00:00:00Z', status: 'completed', content: '最终答案：21',
    candy: { verdict: 'match', answer: 21, expected: 21 },
  })));
  let submitted;
  const ui = await uiHarness({ bootstrap: { models: [], runs: records, candyAvailable: true, retestAvailable: true, defaultPrompt: 'test' }, search: '?view=candy',
    retests: (path, body) => {
      if (path.endsWith('preview')) return { items: records.map(run => ({ id: run.id, run, kind: 'candy', available: true,
        conditions: { prompt: 'original candy prompt', maxTokens: 1024, timeoutMs: 10000, concurrency: 3 } })) };
      submitted = body;
      return { batchId: 'new-retest', runs: [{ ...records[2], id: 'new-result', batchId: 'new-retest', status: 'queued' }] };
    } });
  t.after(() => ui.closeStream());
  const action = (id, label) => ui.descendants(ui.elements.get(id), 'button').find(element => element.textContent === label);
  await waitFor(() => action('candy-batch-actions', '原条件复测'));
  await action('candy-batch-actions', '原条件复测').fire('click');
  const choices = ui.descendants(ui.elements.get('drawer-content'), 'input').filter(element => element.type === 'checkbox');
  const names = choices.map(element => element.getAttribute('aria-label'));
  assert.equal(new Set(names).size, 4, 'Each account and original round must be separately identifiable');
  assert.ok(ui.descendants(ui.elements.get('drawer-content')).some(element => element.textContent === '第 2/2 轮'), 'The round must be visible, not only in an accessibility label');
  await action('drawer-content', '清空').fire('click');
  const chosen = choices.find(element => element.getAttribute('aria-label').includes('账号 A') && element.getAttribute('aria-label').includes('第 2/2 轮'));
  assert.ok(chosen); chosen.checked = true; await chosen.fire('change');
  await action('drawer-footer', '开始复测（1 条）').fire('click');
  assert.deepEqual(submitted.runIds, ['source-a-1']);
  assert.equal(submitted.repeat, undefined, 'An original round is retested once');
});
