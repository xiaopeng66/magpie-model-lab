import { randomUUID, createHash } from "node:crypto";
import { buildPayload, DEFAULT_MAX_TOKENS, DEFAULT_TIMEOUT_MS, generationTimeout, invalid, safeError } from "./gateway.mjs";
import { classifyResult, summary, SAVED_SUMMARY } from "./result.mjs";
import { ACTIVE, UUID } from "./store.mjs";
import { generateChallenges } from "../vendor/lmfpd-sdk/index.js";
import { sampleFingerprint, fingerprintApi, buildFingerprintRequest } from "./fingerprint-sample.mjs";
import { CANDY_VERSION, classifyCandy } from "./candy.mjs";
import { sumUsage, tokenUsage } from "./usage.mjs";
import { automaticResultKey, indexAutomaticResults } from "./automatic-results.mjs";
import { batchKey, historyBatches } from "./history-groups.mjs";
import { retestSources, originalConditions, abnormalRetest } from "./retest.mjs";
import { retentionCandidates, RetentionPreviews, measureRunFiles } from "./retention.mjs";
import { newProgress, advanceProgress, readRuntimeTiming, hasModelUsage } from "./progress.mjs";
import { normalizeTarget, readRunTarget, routingEvidence } from "./targets.mjs";
import { QueuePolicy, DEFAULT_QUEUE } from './queue-policy.mjs';
import { repetitionCount } from './experiments.mjs';
import { selectTasks, gradeTask } from './suites.mjs';

export const RETENTION_DAYS = 7;
export const HISTORY_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

const freshRun = fields => ({ ...fields, status: "queued", startedAt: null, finishedAt: null, firstContentMs: null, elapsedMs: null,
  finishReason: "", usage: null, requestId: "", content: "", reasoning: "", html: "", error: "", progress: newProgress() });
const fingerprintFields = (conditions, loadedBank) => ({ api: conditions.api, requestedApi: conditions.requestedApi, strict: conditions.strict,
  serviceTier: conditions.serviceTier, account: conditions.account, challenges: conditions.challenges,
  samples: conditions.challenges.map(challenge => ({ state: "queued", text: "", raw_text: "", count: 0, expected_count: challenge.expected_count,
    first_byte_ms: null, response_model: null, response_id: null, error: null, startedAt: null, finishedAt: null, progress: newProgress() })), analysis: null, bank: loadedBank.meta, revision: 0 });

export class Runner {
  constructor({ store, gateway, bank, annotations, settings, usage, queuePolicy, retentionNow = Date.now, timeoutMs = DEFAULT_TIMEOUT_MS, monoNow = () => performance.now(), progressNow = () => new Date().toISOString() }) {
    this.store = store; this.gateway = gateway; this.timeoutMs = generationTimeout(timeoutMs);
    this.bank = bank; this.schedulingPaused = 0; this.pendingFinishes = new Map();
    this.runs = new Map(store.records);
    this.queue = []; this.active = new Map(); this.listeners = new Set(); this.payloads = new Map();
    this.catalog = []; this.catalogAt = 0; this.submissions = Promise.resolve(); this.closed = false;
    this.annotations = annotations; this.settings = settings; this.retentionNow = retentionNow; this.retentionPreviews = new RetentionPreviews({ now: retentionNow });
    this.monoNow = monoNow; this.progressNow = progressNow;
    this.usage = usage; this.queuePolicy = queuePolicy || new QueuePolicy(() => this.settings?.snapshot().queue || DEFAULT_QUEUE);
    this.pumping = null; this.pumpAgain = false; this.queueTimer = null;
  }

  get(id) { const run = this.runs.get(id); return run?.[SAVED_SUMMARY] ? this.store.getSync(id) : run || null; }
  async read(id) { const run = this.runs.get(id); return run?.[SAVED_SUMMARY] ? this.store.get(id) : run || null; }
  busy(id) { return this.pendingFinishes.has(id) || [...this.active.entries()].some(([key, control]) => (control.id || key) === id); }
  queuedId(key) { return key.split(":")[0]; }
  runtimeTiming(run, monoNow = this.monoNow()) {
    if (!ACTIVE.has(run.status)) return undefined;
    const read = (control, progress) => control && Number.isFinite(control.startedMonoMs) && progress?.phase !== "ended" ? readRuntimeTiming({ ...control, progressRevision: progress?.revision ?? 0 }, { monoNow }) : null;
    if (run.kind === "fingerprint") return run.samples.map((sample, index) => read(this.active.get(`${run.id}:${index}`), sample.progress));
    return read(this.active.get(run.id), run.progress) || undefined;
  }
  publicRun(run) { const timing = this.runtimeTiming(run); return { ...summary(run), ...(timing ? { runtimeTiming: timing } : {}) }; }
  detailRun(run) { const timing = this.runtimeTiming(run); return { ...run, ...(timing ? { runtimeTiming: timing } : {}) }; }
  list() { return [...this.runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(run => this.publicRun(run)); }
  aggregateProgress(run) {
    const samples = run.samples.map(sample => sample.progress), moving = samples.filter(p => !["queued", "ended"].includes(p.phase));
    const phase = ["output", "reasoning", "waiting_response"].find(phase => moving.some(p => p.phase === phase)) ||
      (moving.length ? "waiting_response" : samples.some(p => p.phase === "queued") ? "queued" : "saving");
    if (run.progress.phase !== "ended" && run.progress.phase !== phase) run.progress = { ...run.progress, phase, revision: run.progress.revision + 1 };
  }
  stopProgress(control) { control.finishing = true; clearTimeout(control.progressTimer); control.progressTimer = null; control.stopEmission?.(); }
  recordProgress(run, control, event, sampleIndex = null) {
    if (control.finishing || !ACTIVE.has(run.status) || !(event.modelEvent || event.content || event.reasoning || hasModelUsage(event.usage))) return;
    const target = sampleIndex === null ? run : run.samples[sampleIndex], before = target.progress, at = this.progressNow();
    let next = before;
    if (event.reasoning) next = advanceProgress(next, "reasoning", { at });
    if (event.content) next = advanceProgress(next, "output", { at });
    if (!event.reasoning && !event.content) next = advanceProgress(next, "model_event", { at });
    target.progress = next; control.lastDataMonoMs = this.monoNow();
    if (sampleIndex !== null) {
      if (event.reasoning) run.progress = advanceProgress(run.progress, "reasoning", { at });
      if (event.content) run.progress = advanceProgress(run.progress, "output", { at });
      if (!event.reasoning && !event.content) run.progress = advanceProgress(run.progress, "model_event", { at });
      this.aggregateProgress(run); run.revision++;
    }
    const force = ["phase", "firstEventAt", "firstReasoningAt", "firstOutputAt"].some(key => next[key] !== before[key]);
    const publish = () => {
      clearTimeout(control.progressTimer); control.progressTimer = null;
      if (control.finishing || !ACTIVE.has(run.status)) return;
      control.progressPublishedMonoMs = this.monoNow();
      if (sampleIndex === null) this.emit("delta", { id: run.id, progress: run.progress, runtimeTiming: this.runtimeTiming(run) });
      else control.publishProgress?.();
    };
    const elapsed = this.monoNow() - (control.progressPublishedMonoMs ?? -Infinity);
    if (force || elapsed >= 1000) publish(); else control.progressTimer ||= setTimeout(publish, Math.max(1, 1000 - elapsed));
  }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(type, value) {
    for (const fn of this.listeners) { try { fn({ type, ...value }); } catch { /* a disconnected UI cannot stop generation */ } }
  }

  async models(refresh = false) {
    if (!refresh && this.catalog.length && Date.now() - this.catalogAt < 30000) return this.catalog;
    if (!this.catalogLoad) this.catalogLoad = this.gateway.models().then((models) => {
      this.catalog = models; this.catalogAt = Date.now(); return models;
    }).finally(() => { this.catalogLoad = null; });
    return this.catalogLoad;
  }

  submit(request, context = {}) {
    const snapshot = structuredClone(request); return this.mutate(() => this.create(snapshot, context));
  }
  mutate(task) { if (this.closed) return Promise.reject(invalid("服务正在关闭", 503)); if (this.maintenance) return Promise.reject(invalid('配置维护期间请稍后重试', 409)); const pending = this.submissions.catch(() => {}).then(task); this.submissions = pending; return pending; }

  async previewRetest(request) {
    const { items } = await this.checkRetest(request);
    return { items };
  }

  async checkRetest(request) {
    if (this.closed) throw invalid("服务正在关闭", 503);
    const sources = retestSources(this.runs, request?.runIds), catalog = new Map((await this.models(true)).map(model => [model.id, model]));
    const checkedBanks = new Map(), items = [];
    for (const source of sources) {
      let conditions = null, reason = "";
      try {
        if (ACTIVE.has(source.status) || this.busy(source.id)) throw invalid("原测试尚未结束，请结束后再复测");
        conditions = originalConditions(source, catalog.get(source.model));
        if (conditions.accountTarget?.mode === 'pinned') await this.gateway.assertAccount(source.provider, conditions.accountTarget, source.model);
        if (conditions.kind === "fingerprint") {
          if (!this.bank) throw invalid("当前后端不支持指纹检测");
          const sha = conditions.bank.sha256;
          if (!checkedBanks.has(sha)) checkedBanks.set(sha, this.bank.snapshotBytes(sha));
          await checkedBanks.get(sha);
        }
      } catch (error) { reason = safeError(error); }
      items.push({ id: source.id, kind: source.kind || "pelican", run: summary(source), conditions, available: !reason, reason, abnormal: abnormalRetest(source) });
    }
    return { items, catalog };
  }

  retest(request) {
    const snapshot = structuredClone(request); return this.mutate(() => this.createRetest(snapshot));
  }

  async createRetest(request) {
    if (this.closed) throw invalid("服务正在关闭", 503);
    if (typeof request?.operationId !== "string" || !UUID.test(request.operationId)) throw invalid("复测操作标识无效");
    if (!Array.isArray(request.runIds) || !request.runIds.length || request.runIds.some(id => typeof id !== "string" || !UUID.test(id)) || new Set(request.runIds).size !== request.runIds.length) throw invalid("复测源记录无效或重复");
    const selectionHash = createHash("sha256").update([...request.runIds].sort().join("\n")).digest("hex");
    const prior = [...this.runs.values()].filter(run => run.retest?.operationId === request.operationId);
    if (prior.length) {
      if (prior.length !== request.runIds.length || prior.some(run => run.retest.selectionHash !== selectionHash)) throw invalid("复测操作已使用或部分记录已清理，请重新打开复测", 409);
      return { batchId: batchKey(prior[0]), runs: prior.map(run => this.publicRun(run)) };
    }
    const { items, catalog } = await this.checkRetest(request);
    if (new Set(items.map(item => item.kind)).size !== 1) throw invalid("一次复测只能运行一种测试类型");
    const unavailable = items.find(item => !item.available);
    if (unavailable) throw invalid(unavailable.reason, 409);
    const roundId = randomUUID(), createdAt = new Date().toISOString(), batches = new Map(), snapshots = new Map(), entries = [];
    for (const item of items) {
      const source = this.runs.get(item.id), conditions = item.conditions;
      if (!source || ACTIVE.has(source.status) || this.busy(source.id)) throw invalid("原记录已变化，请重新打开复测", 409);
      const model = catalog.get(source.model), key = source.batchId || source.id;
      if (!batches.has(key)) batches.set(key, randomUUID());
      let loadedBank = null;
      if (conditions.kind === "fingerprint") {
        const sha = conditions.bank.sha256;
        if (!snapshots.has(sha)) snapshots.set(sha, this.bank.loadSnapshot(sha));
        loadedBank = await snapshots.get(sha);
      }
      const run = freshRun({ id: randomUUID(), batchId: batches.get(key), roundId, source: "manual", createdAt, kind: conditions.kind,
        model: source.model, modelName: model.name, provider: model.provider, providerName: model.providerName,
        effort: conditions.effort, maxTokens: conditions.maxTokens, concurrency: conditions.concurrency, timeoutMs: conditions.timeoutMs,
        targetKey: readRunTarget(source).targetKey, accountTarget: conditions.accountTarget, routing: routingEvidence(conditions.accountTarget),
        ...(loadedBank ? fingerprintFields(conditions, loadedBank) : { prompt: conditions.prompt,
          promptHash: createHash("sha256").update(conditions.prompt).digest("hex"),
          ...(conditions.kind === "candy" ? conditions.task ? { task: structuredClone(conditions.task), grade: { expected: conditions.task.expected, answer: null, verdict: 'incomplete' }, candy: { version: CANDY_VERSION, expected: 21, answer: null, verdict: 'incomplete' } } : { candy: { version: conditions.candyVersion, expected: 21, answer: null, verdict: "incomplete" } } : {}) }),
        retest: { sourceRunId: source.id, sourceBatchId: batchKey(source), sourceTime: conditions.sourceTime,
          sourceMode: source.source === "automatic" ? "automatic" : "manual", operationId: request.operationId, selectionHash } });
      entries.push({ run, payload: loadedBank ? { detector: loadedBank.detector, finishing: false, cancelReason: "" } : buildPayload(model, conditions) });
    }
    const created = await this.persistPrepared(entries);
    return { batchId: roundId, runs: created.map(run => this.publicRun(run)) };
  }

  cleanup(request) {
    const snapshot = structuredClone(request); return this.mutate(() => this.prune(snapshot));
  }
  assertCleanupHealth() {
    const error = this.settings?.recoveryError || this.annotations?.recoveryError;
    if (error) throw invalid(error, 503);
  }
  annotate(request) {
    const input = structuredClone(request);
    return this.mutate(async () => {
      if (!this.annotations) throw invalid("当前后端未开放记录保护", 503);
      if (!UUID.test(input?.runId || "")) throw invalid("运行 ID 无效");
      if (!this.runs.has(input.runId)) throw invalid("没有找到这个运行结果", 404);
      const result = await this.annotations.save(input); this.emit("annotation", result); return result;
    });
  }
  retentionContext(days, previewAt = this.retentionNow()) {
    this.assertCleanupHealth();
    const candidates = retentionCandidates(this.runs.values(), { days, now: previewAt, isBusy: id => this.busy(id), isProtected: id => this.annotations?.isProtected(id) });
    return { days, previewAt, settingsRevision: this.settings?.snapshot().revision || 0, annotationsRevision: this.annotations?.revision || 0, ...candidates };
  }
  async previewRetention({ days } = {}) {
    if (!this.settings?.capabilities.retention) throw invalid("当前后端未开放保留策略", 409);
    const context = await this.mutate(() => this.retentionContext(days));
    const estimatedMetadataBytes = context.candidateIds.reduce((sum, id) => sum + (this.store.sizes.get(id) || 0), 0);
    const measured = await measureRunFiles(this.store, context.candidateIds);
    return this.mutate(() => {
      const checked = this.retentionContext(days, context.previewAt);
      if (checked.settingsRevision !== context.settingsRevision || checked.annotationsRevision !== context.annotationsRevision || JSON.stringify([...checked.candidateIds].sort()) !== JSON.stringify([...context.candidateIds].sort())) throw invalid("预览期间记录或保护已变化，请重新预览", 409);
      return { days, previewAt: new Date(context.previewAt).toISOString(), candidateCount: context.candidateIds.length, estimatedMetadataBytes, ...measured,
        skippedActive: context.skippedActive, skippedProtected: context.skippedProtected, ...this.retentionPreviews.issue(context) };
    });
  }
  saveSettings(request) {
    const input = structuredClone(request);
    return this.mutate(async () => {
      this.assertCleanupHealth(); let consumed = false;
      const result = await this.settings.save({ expectedRevision: input.expectedRevision, patch: input.patch }, { authorizeRetentionChange: ({ before, after }) => {
        this.assertCleanupHealth();
        const shorter = after.retention.days !== null && (before.retention.days === null || after.retention.days < before.retention.days);
        if (shorter) {
          const old = this.retentionPreviews.context(input.previewToken), current = this.retentionContext(after.retention.days, old.previewAt);
          this.retentionPreviews.verify(input.previewToken, current); consumed = true;
        }
      } });
      if (consumed) this.retentionPreviews.consume(input.previewToken); return result;
    });
  }
  expireRetention() {
    return this.mutate(async () => {
      if (this.settings?.recoveryError || this.annotations?.recoveryError || this.settings && !this.settings.capabilities.retention) return { removed: [], errors: [], paused: true };
      const context = this.retentionContext(this.settings ? this.settings.snapshot().retention.days : RETENTION_DAYS);
      const ids = new Set(context.candidateIds), result = await this.prune({ mode: "all" }, [...this.runs.values()].filter(run => ids.has(run.id)));
      return { ...result, skippedActive: result.skippedActive + context.skippedActive, skippedProtected: result.skippedProtected + context.skippedProtected, invalidTimes: context.invalidTimes };
    });
  }

  dailyGroup(runIds) {
    if (!Array.isArray(runIds) || !runIds.length || runIds.some(id => typeof id !== "string" || !UUID.test(id))) throw invalid("每日批次记录 ID 无效");
    const expected = new Set(runIds);
    if (expected.size !== runIds.length) throw invalid("每日批次有重复的记录 ID");
    // Recompute under the submission lock for deletion: a scheduled run may have joined the group since it was displayed.
    const group = historyBatches(this.runs.values(), HISTORY_TIME_ZONE).find(item => item.source === "automatic" && item.runs.some(run => run.id === runIds[0]));
    if (!group || group.runs.length !== expected.size || !group.runs.every(run => expected.has(run.id))) throw invalid("每日批次已变化，请重新选择后再操作", 409);
    return group;
  }

  async prune(request, selectedCandidates = null) {
    if (this.closed) throw invalid("服务正在关闭", 503);
    this.assertCleanupHealth();
    if (!request || !["all", "before", "batch", "daily"].includes(request.mode)) throw invalid("请选择有效的清理方式");
    let candidates = selectedCandidates || [...this.runs.values()];
    if (request.mode === "batch") {
      if (typeof request.batchId !== "string" || !UUID.test(request.batchId)) throw invalid("批次 ID 无效");
      candidates = candidates.filter(run => batchKey(run) === request.batchId);
      if (!candidates.length) throw invalid("没有找到这个批次", 404);
    }
    if (request.mode === "daily") candidates = this.dailyGroup(request.runIds).runs;
    if (["batch", "daily"].includes(request.mode) && candidates.some(run => ACTIVE.has(run.status) || this.busy(run.id))) throw invalid("本批仍有任务未完成，请结束后再删除", 409);
    let cutoff = Infinity;
    if (request.mode === "before") {
      if (typeof request.before !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(request.before)) throw invalid("清理时间需为有效 UTC 时间");
      cutoff = Date.parse(request.before);
      if (!Number.isFinite(cutoff) || new Date(cutoff).toISOString().slice(0, 19) !== request.before.slice(0, 19)) throw invalid("清理时间无效");
    }
    const outcome = { removed: [], skippedActive: 0, skippedProtected: 0, errors: [] };
    for (const run of candidates) {
      if (ACTIVE.has(run.status) || this.busy(run.id)) { outcome.skippedActive++; continue; }
      if (this.annotations?.isProtected(run.id)) { outcome.skippedProtected++; continue; }
      const finished = Date.parse(run.finishedAt), retainedAt = Number.isFinite(finished) ? finished : Date.parse(run.createdAt);
      if (request.mode === "before" && !(retainedAt < cutoff)) continue;
      try { await this.store.remove(run.id); this.runs.delete(run.id); outcome.removed.push(run.id); }
      catch (error) { outcome.errors.push({ id: run.id, error: safeError(error) }); }
    }
    if (outcome.removed.length && this.annotations) {
      try { await this.annotations.removeOrphans(outcome.removed); }
      catch (error) { outcome.annotationErrors = [safeError(error)]; }
    }
    if (outcome.removed.length) this.emit("removed", { ids: outcome.removed });
    return outcome;
  }

  async create(request, context = {}) {
    if (this.closed) throw invalid("服务正在关闭", 503);
    const repeat = repetitionCount(request?.repeat);
    if (!request || request.models && request.targets) throw invalid('只能选择 models 或 targets 其中一种目标协议');
    const picks = request.targets ?? request.models;
    if (!Array.isArray(picks) || picks.length < 1) throw invalid("请选择至少一个模型");
    const kind = request.kind || "pelican";
    if (!["pelican", "fingerprint", "candy"].includes(kind)) throw invalid("测试模式无效");
    if (kind !== 'candy' && request.suite != null) throw invalid('题集仅用于糖果测试');
    if (context.source === 'automatic' && (repeat !== 1 || request.suite != null)) throw invalid('自动计划仅运行一次原题');
    const tasks = kind === 'candy' ? selectTasks(request.suite) : [null], expanded = repeat > 1 || request.suite != null;
    const prompt = kind === "candy" ? tasks[0].prompt : request.prompt;
    const concurrency = request.concurrency ?? (kind === "pelican" ? 2 : 3), maxTokens = request.maxTokens ?? DEFAULT_MAX_TOKENS;
    const timeoutMs = generationTimeout(request.timeoutMs ?? this.timeoutMs);
    if (!Number.isSafeInteger(concurrency) || concurrency < 0) throw invalid("并行数需为非负整数，0 表示不设上限");
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 0) throw invalid("输出上限需为非负整数，0 表示不设上限");
    if (kind === "fingerprint") {
      if (request.strict != null && typeof request.strict !== "boolean") throw invalid("严格模式参数无效");
      if (!["auto", "responses", "chat_completions", "messages"].includes(request.api || "auto")) throw invalid("指纹请求接口无效");
      if (!["default", "flex", "fast", "ultrafast"].includes(request.serviceTier || "default")) throw invalid("服务档位无效");
      if (!this.bank) throw invalid("当前后端不支持指纹检测，请重新开启插件", 503);
    }
    const catalog = await this.models();
    const byId = new Map(catalog.map(model => [model.id, model]));
    const selected = picks.map((pick) => {
      const model = byId.get(request.targets ? pick?.modelId : pick?.id);
      if (!model) throw invalid("所选模型不在当前目录中，请刷新模型列表");
      const effort = pick.effort || "";
      const payload = buildPayload(model, { ...request, prompt: kind === "fingerprint" ? "数字指纹采样" : prompt, maxTokens, effort });
      if (!request.targets && kind !== 'fingerprint' && pick.account) throw invalid('旧 models.account 仅用于指纹；普通测试请迁移为 targets 账号目标');
      const target = normalizeTarget({ modelId: model.id, account: request.targets ? pick.account : kind === 'fingerprint' && pick.account ? { mode: 'pinned', id: pick.account } : { mode: 'auto' } });
      return { model, effort, account: target.account.mode === 'pinned' ? target.account.id : '', target, payload };
    });
    if (new Set(selected.map(item => item.target.targetKey)).size !== selected.length) throw invalid('同一批次不能重复选择相同模型账号目标');
    for (const item of selected) if (item.target.account.mode === 'pinned') item.target.account = await this.gateway.assertAccount(item.model.provider, item.target.account, item.model.id);
    const loadedBank = kind === "fingerprint" ? await this.bank.load() : null;
    const challenges = kind === "fingerprint" ? generateChallenges(3) : null;
    if (this.closed) throw invalid("服务正在关闭", 503);
    const batchId = randomUUID(), createdAt = new Date().toISOString();
    const entries = [], linked = [];
    const experiment = expanded ? { repeatCount: repeat, targetCount: selected.length, questionIds: tasks.filter(Boolean).map(task => task.questionId),
      plannedRunCount: repeat * selected.length * tasks.length, plannedRequests: repeat * selected.length * tasks.length * (kind === 'fingerprint' ? 3 : 1), preparedBytes: 0 } : null;
    if (experiment && !Number.isSafeInteger(experiment.plannedRequests)) throw invalid('实验请求规模超出安全范围', 413);
    const preparedSize = entry => Buffer.byteLength(JSON.stringify(entry.run)) + Buffer.byteLength(JSON.stringify(kind === 'fingerprint'
      ? entry.run.challenges.map(challenge => buildFingerprintRequest(entry.run, challenge).body) : entry.payload));
    const checkPreparation = total => {
      if (!Number.isSafeInteger(total) || total > 8 * 1024 * 1024) throw invalid('实验展开的元数据与请求体超过 8 MiB，请减少目标或重复次数', 413);
    };
    let preparedBytes = 0;
    const automaticResults = context.source === "automatic" ? indexAutomaticResults(this.runs.values()) : null;
    for (let repetitionIndex = 0; repetitionIndex < repeat; repetitionIndex++) for (const task of tasks) {
      for (const { model, effort, account, target, payload } of selected) {
        const member = context.members?.[target.targetKey] || context.members?.[model.id];
        if (member) {
          const triggerKeys = new Set((context.plans || []).map(ref => ref.triggerKey).filter(Boolean));
          const prior = automaticResults?.get(automaticResultKey(member.favoriteId, model.id, kind, context.scheduledAt, target)) || [...this.runs.values()].find(run => run.favoriteId === member.favoriteId && readRunTarget(run).targetKey === target.targetKey && run.kind === kind &&
            (context.source === "automatic"
              ? run.source === "automatic" && run.plans?.some(ref => triggerKeys.has(ref.triggerKey))
              : run.compareKey === member.compareKey && ACTIVE.has(run.status)));
          if (prior) { linked.push({ ...summary(prior), linked: true }); continue; }
        }
        const run = freshRun({ id: randomUUID(), batchId, kind, model: model.id, modelName: model.name, provider: model.provider, providerName: model.providerName, effort,
          ...(expanded ? { experimentId: batchId, repetitionIndex, executionIndex: entries.length, experiment } : {}),
          targetKey: target.targetKey, accountTarget: target.account, routing: routingEvidence(target.account),
          ...(member ? { ...member, roundId: context.roundId, source: context.source, plans: context.plans || [], expiresAt: context.expiresAt, scheduledAt: context.scheduledAt } : {}),
          ...(kind === "fingerprint" ? fingerprintFields({ api: maxTokens === 0 && fingerprintApi(request.api, model) === "messages" ? "chat_completions" : fingerprintApi(request.api, model), requestedApi: request.api || "auto", strict: request.strict || false, serviceTier: request.serviceTier || "default", account, challenges }, loadedBank)
            : { prompt: task?.prompt || prompt, promptHash: createHash("sha256").update(task?.prompt || prompt).digest("hex"), ...(kind === "candy" ? expanded ? { task, grade: { expected: task.expected, answer: null, verdict: 'incomplete' }, candy: { version: CANDY_VERSION, expected: 21, answer: null, verdict: 'incomplete' } } : { candy: { version: CANDY_VERSION, expected: 21, answer: null, verdict: "incomplete" } } : {}) }), maxTokens, concurrency, timeoutMs,
          createdAt });
        const entry = { run, payload: kind === "fingerprint" ? { detector: loadedBank.detector, finishing: false, cancelReason: "" } : task && expanded ? buildPayload(model, { prompt: task.prompt, effort, maxTokens }) : payload };
        if (expanded) { preparedBytes += preparedSize(entry); checkPreparation(preparedBytes); }
        entries.push(entry);
      }
    }
    if (expanded) {
      let last = -1, total = 0;
      for (let pass = 0; pass < 6 && total !== last; pass++) {
        last = total; experiment.preparedBytes = total;
        total = entries.reduce((sum, entry) => sum + preparedSize(entry), 0);
        checkPreparation(total);
      }
      experiment.preparedBytes = total;
    }
    const created = await this.persistPrepared(entries);
    return [...created.map(run => this.publicRun(run)), ...linked];
  }

  async persistPrepared(entries) {
    const created = [], attempted = [];
    try {
      for (const { run, payload } of entries) {
        attempted.push(run.id);
        const saved = await this.store.save(run);
        created.push(saved); this.payloads.set(saved.id, payload);
      }
      if (this.closed) throw invalid("服务正在关闭", 503);
    } catch (error) {
      const failures = [];
      for (const id of attempted) {
        this.payloads.delete(id);
        try { await this.store.remove(id); }
        catch (rollbackError) {
          failures.push(safeError(rollbackError));
          const run = created.find(run => run.id === id) || this.store.records.get(id);
          if (run) { this.runs.set(id, run); await this.finish(run, { status: "error", error: `批次未创建：${safeError(error)}` }); }
        }
      }
      if (failures.length) throw invalid(`${safeError(error)}；部分文件清理失败：${failures[0]}`, 500);
      throw error;
    }
    for (const run of created) this.runs.set(run.id, run);
    for (const run of created) { this.queue.push(...(run.kind === "fingerprint" ? run.challenges.map((_, index) => `${run.id}:${index}`) : [run.id])); this.emit("run", { run: this.publicRun(run) }); }
    this.pump();
    return created;
  }

  pump() {
    if (this.closed || this.schedulingPaused) return;
    if (this.pumping) { this.pumpAgain = true; return; }
    this.pumping = this.scanQueue().catch(error => this.emit('queue-error', { error: safeError(error) })).finally(() => {
      this.pumping = null; if (this.pumpAgain) { this.pumpAgain = false; this.pump(); }
    });
  }
  admissionHash() { return this.queuePolicy.hash(); }
  queueStatus() { return { queued: this.queue.map(key => { const run=this.runs.get(this.queuedId(key)); return {key,runId:run?.id,reason:run?.queueReason||'concurrency',until:run?.queueUntil||null}; }), ...this.queuePolicy.status() }; }
  queueWake(until) { if (!Number.isFinite(until)) return; this.nextQueueWake=Math.min(this.nextQueueWake||Infinity,until); }
  async scanQueue() {
    clearTimeout(this.queueTimer); this.nextQueueWake=Infinity;
    const counts = new Map(); let automaticCount = 0;
    for (const [key, control] of this.active) {
      if (!control.admitted) continue;
      const batchId = this.runs.get(control.id || key)?.batchId;
      if (this.runs.get(control.id || key)?.source === "automatic") automaticCount++;
      counts.set(batchId, (counts.get(batchId) || 0) + 1);
    }
    for (let index = 0; index < this.queue.length && !this.closed && !this.schedulingPaused;) {
      const key = this.queue[index], id = this.queuedId(key), sampleIndex = key.includes(":") ? Number(key.split(":")[1]) : null;
      const run = this.runs.get(id);
      if (this.active.has(key)) { index++; continue; }
      const eligible = run?.kind === "fingerprint" ? ACTIVE.has(run.status) && run.samples[sampleIndex]?.state === "queued" : run?.status === "queued";
      if (!eligible) { if (run?.kind !== "fingerprint") this.payloads.delete(id); this.queue.splice(index, 1); continue; }
      if (run.source === "automatic" && !this.automaticEligible?.(run)) {
        this.queue = this.queue.filter(queued => this.queuedId(queued) !== id);
        if (run.kind === "fingerprint") {
          const config = this.payloads.get(id); if (config) config.cancelReason = "cancelled";
          for (const sample of run.samples) if (sample.state === "queued") this.endQueuedSample(sample, "计划已暂停、修改或超出时间窗");
          if (!this.busy(id) && config) this.saveSkipped(id, this.finishFingerprint(run, config));
        } else this.saveSkipped(id, this.finish(run, { status: "cancelled", error: "计划已暂停、修改或超出时间窗" }));
        continue;
      }
      const count = counts.get(run.batchId) || 0;
      const batchLimit = run.concurrency ?? 2, automaticLimit = this.automaticConcurrency ?? 3;
      if ((batchLimit > 0 && count >= batchLimit) || (run.source === "automatic" && automaticLimit > 0 && automaticCount >= automaticLimit)) { run.queueReason = 'concurrency'; run.queueUntil = null; index++; continue; }
      const active=[...this.active.values()].filter(c=>c.admitted).map(c=>({run:this.runs.get(c.id)}));
      let decision;
      try { decision = this.queuePolicy.check(run, active); }
      catch (error) { run.queueReason = 'queue_storage'; run.queueUntil = null; this.emit('queue-error', { error: safeError(error) }); index++; continue; }
      if (!decision.allowed) { run.queueReason=decision.reason;run.queueUntil=decision.until||null;this.queueWake(decision.until);index++;continue; }
      this.queue.splice(index,1);delete run.queueReason;delete run.queueUntil;
      const control = { id, sampleIndex, abort: new AbortController(), reason: "", promise: null, admitted:false, fetchCalled:false, physicalRequestId:randomUUID(), policyHash:this.admissionHash() };
      this.active.set(key, control);
      let admitResolve; const admitted=new Promise(resolve=>{admitResolve=resolve;});
      control.promise = this.admitAndExecute(run,control,key,admitResolve).finally(() => {
        admitResolve(false);
        this.active.delete(key);
        if (!this.busy(id) && !this.queue.some(key => this.queuedId(key) === id)) this.payloads.delete(id);
        this.pump();
      });
      if (await admitted) {counts.set(run.batchId,count+1);if(run.source==='automatic')automaticCount++;}
    }
    if (this.queue.length) {
      for (const key of this.queue) {const run=this.runs.get(this.queuedId(key));if(run?.source==='automatic')this.queueWake(Date.parse(run.expiresAt));}
      if (Number.isFinite(this.nextQueueWake)) {this.queueTimer=setTimeout(()=>this.pump(),this.queuePolicy.nextDelay(this.nextQueueWake));this.queueTimer.unref?.();}
    }
  }
  stoppedAdmission(run,control) { if(this.closed&&!control.reason)control.reason='shutdown';if(run.source==='automatic'&&!this.automaticEligible?.(run)&&!control.reason)control.reason='cancelled';return Boolean(control.reason||control.abort.signal.aborted); }
  async admitAndExecute(run,control,key,resolve) {
    try {
      const choice=this.usage?await this.usage.reserve({physicalRequestId:control.physicalRequestId,runId:run.id,provider:run.provider,accountId:readRunTarget(run).account.id||'',admissionPolicyHash:control.policyHash}):{};
      control.reservation=choice.reservation;
      if(this.stoppedAdmission(run,control)) {if(control.reservation)await this.usage.release(control.physicalRequestId);resolve(false);if(run.kind==='fingerprint'){this.endQueuedSample(run.samples[control.sampleIndex],'采样未开始，已取消');const config=this.payloads.get(run.id);if(config&&run.samples.every(s=>s.progress.phase==='ended'))await this.finishFingerprint(run,config);}else await this.finish(run,{status:control.reason==='shutdown'?'interrupted':'cancelled',error:'任务未发出，已取消'});return;}
      if(control.policyHash!==this.admissionHash()){if(control.reservation)await this.usage.release(control.physicalRequestId);this.queue.unshift(key);this.pumpAgain=true;resolve(false);return;}
      control.admitted=true;
      const physical={physicalRequestId:control.physicalRequestId,admissionPolicyHash:control.policyHash,state:'reserved',sampleIndex:control.sampleIndex};
      (run.physicalRequests ||= []).push(physical);control.physical=physical;resolve(true);
      await (run.kind==='fingerprint'?this.executeSample(run,control.sampleIndex,control):this.execute(run,control));
    } catch(error) {
      resolve(false);
      if (run.kind === 'fingerprint') {
        const sample = run.samples[control.sampleIndex], at = this.progressNow();
        run.samples[control.sampleIndex] = { ...sample, state: 'failed', failureKind: 'usage_storage', error: safeError(error), finishedAt: at,
          progress: advanceProgress(sample.progress || newProgress(), 'end', { at }) };
        run.revision++; this.aggregateProgress(run); this.emit('run', { run: this.publicRun(run) });
        const config = this.payloads.get(run.id);
        if (config && run.samples.every(sample => sample.progress.phase === 'ended')) await this.finishFingerprint(run, config);
      } else await this.finish(run,{status:'error',failureKind:'usage_storage',error:safeError(error)});
    }
    finally {if(control.reservation&&!control.fetchCalled){try{await this.usage.release(control.physicalRequestId);}catch(error){this.emit('queue-error',{error:safeError(error)});}if(control.physical)control.physical.state='released';}}
  }
  checkFetch(run, control) {
    if (this.stoppedAdmission(run, control)) { control.abort.abort(); throw invalid('请求已取消'); }
    if (control.policyHash !== this.admissionHash()) throw Object.assign(invalid('请求控制已变化，重新排队', 409), { readmit: true });
    const active = [...this.active.values()].filter(item => item !== control && item.admitted).map(item => ({ run: this.runs.get(item.id) }));
    if (!this.queuePolicy.check(run, active).allowed) throw Object.assign(invalid('请求限制或冷却已变化，重新排队', 409), { readmit: true });
  }
  async prepareFetch(run, control) {
    this.checkFetch(run, control);
    if (control.reservation) try { await this.usage.start(control.physicalRequestId); } catch (error) { if (error.status === 409) error.readmit = true; else error.usageStorage = true; throw error; }
    this.checkFetch(run, control);
  }
  physicalFor(run, control) { return run.physicalRequests?.find(item => item.physicalRequestId === control.physicalRequestId) || control.physical; }
  fetched(run,control) {this.checkFetch(run,control);control.fetchCalled=true;control.physical=this.physicalFor(run,control);control.physical.state='started';const at=this.usage?.now()??Date.now();control.physical.startedAt=new Date(at).toISOString();this.queuePolicy.started(run);if(control.reservation)this.usage.markStarted(control.physicalRequestId,at).catch(error=>this.emit('queue-error',{error:safeError(error)}));}
  observeUsage(control,usage,revision) {if(control.reservation&&usage)this.usage.observe(control.physicalRequestId,usage,revision).catch(error=>this.emit('queue-error',{error:safeError(error)}));}
  async readmit(run,control) {if(control.reservation)await this.usage.release(control.physicalRequestId);this.physicalFor(run,control).state='released';const key=control.sampleIndex===null?run.id:`${run.id}:${control.sampleIndex}`;if(control.sampleIndex===null){run.status='queued';run.startedAt=null;run.progress=newProgress();}else{const sample=run.samples[control.sampleIndex];sample.state='queued';sample.startedAt=null;sample.progress=newProgress();}await this.store.save(run);this.queue.unshift(key);this.pumpAgain=true;}

  async finish(run, patch) {
    for (const [key, control] of this.active) if ((control.id || key) === run.id) this.stopProgress(control);
    for (const control of this.active.values()) if (control.id === run.id && control.fetchCalled && control.reservation) await this.usage.complete(control.physicalRequestId).catch(error => this.emit('queue-error', { error: safeError(error) }));
    for (const control of this.active.values()) if (control.id === run.id && !control.fetchCalled && control.physical) {
      if (control.reservation) await this.usage.release(control.physicalRequestId).catch(error => this.emit('queue-error', { error: safeError(error) }));
      this.physicalFor(run, control).state = 'released';
    }
    run.progress = advanceProgress(run.progress || newProgress(), "saving", { at: this.progressNow() });
    this.emit("run", { run: this.publicRun(run) });
    const done = { ...run, ...patch, finishedAt: new Date().toISOString(),
      elapsedMs: run.startedAt ? Date.now() - Date.parse(run.startedAt) : 0,
      progress: advanceProgress(run.progress, "end", { at: this.progressNow() }) };
    let saved = false;
    try { Object.assign(run, await this.store.save(done)); saved = true; }
    catch (error) { Object.assign(run, done, { status: "error", error: `结果保存失败：${safeError(error)}` }); }
    this.emit("run", { run: this.publicRun(run) });
    if (saved) this.runs.set(run.id, this.store.records.get(run.id));
  }

  saveSkipped(id, task) {
    const pending = task.finally(() => { this.pendingFinishes.delete(id); this.payloads.delete(id); });
    this.pendingFinishes.set(id, pending);
  }

  async execute(run, control) {
    run.status = "running"; run.startedAt = new Date().toISOString();
    run.progress = advanceProgress(run.progress, "start", { at: this.progressNow() });
    let bytes = 0, lastCheckpoint = Date.now();
    const timeoutMs = run.timeoutMs ?? this.timeoutMs;
    control.startedMonoMs = this.monoNow(); control.lastDataMonoMs = null; control.timeoutMs = timeoutMs; control.progressPublishedMonoMs = control.startedMonoMs;
    const timer = timeoutMs ? setTimeout(() => { control.reason = "timeout"; control.abort.abort(); }, timeoutMs) : null;
    try {
      Object.assign(run, await this.store.save(run));
      this.emit("run", { run: this.publicRun(run) });
      const meta = await this.gateway.generate(this.payloads.get(run.id), {
        signal: control.abort.signal,
        account: readRunTarget(run).account,
        session:control.physicalRequestId,beforeFetch:()=>this.prepareFetch(run,control),onFetch:()=>this.fetched(run,control),
        onChunk: ({ content = "", reasoning = "", usage, modelEvent = false }) => {
          if (control.finishing || !ACTIVE.has(run.status)) return;
          bytes += Buffer.byteLength(content) + Buffer.byteLength(reasoning);
          if (bytes > 4 * 1024 * 1024) { control.reason = "oversize"; control.abort.abort(); throw invalid("生成输出超过 4 MiB，已停止"); }
          if (content && run.firstContentMs === null) run.firstContentMs = Date.now() - Date.parse(run.startedAt);
          run.content += content; run.reasoning += reasoning;
          if (usage) { run.usage = usage; run.usageRevision = (run.usageRevision || 0) + 1; this.observeUsage(control,usage,run.usageRevision); }
          this.recordProgress(run, control, { content, reasoning, usage, modelEvent });
          if (content || reasoning || usage) this.emit("delta", { id: run.id, content, reasoning, contentChars: run.content.length, reasoningChars: run.reasoning.length, firstContentMs: run.firstContentMs,
            ...(usage ? { usage, tokens: tokenUsage(run), usageRevision: run.usageRevision } : {}) });
          if (Date.now() - lastCheckpoint >= 2000) {
            lastCheckpoint = Date.now();
            this.store.save(run).catch((error) => { control.reason = "storage"; control.error = error; control.abort.abort(); });
          }
        },
      });
      if (control.reason) throw new Error("Aborted");
      if(meta.usage)this.observeUsage(control,meta.usage,(run.usageRevision||0)+1);
      await this.finish(run, { ...meta, ...(run.kind === "candy" ? run.task ? gradeTask(run.task, run.content, meta.finishReason) : classifyCandy(run.content, meta.finishReason) : classifyResult(run.content, meta.finishReason)) });
    } catch (error) {
      if(error.readmit&&!control.fetchCalled){await this.readmit(run,control);return;}
      const status = ["cancelled", "shutdown"].includes(control.reason) ? (control.reason === "shutdown" ? "interrupted" : "cancelled") : "error";
      const message = { timeout: "生成超时，已终止上游请求", cancelled: "已取消生成，已有输出已保留", shutdown: "服务重新启动，生成已中断",
        oversize: "生成输出超过 4 MiB，已停止", storage: `结果保存失败：${safeError(control.error)}` }[control.reason] || safeError(error);
      const cooling=this.queuePolicy.noteFailure(run,error);
      await this.finish(run, { status, error: message, ...(cooling||{}), ...(error.upstreamStatus ? { upstreamStatus: error.upstreamStatus, retryAfterMs: error.retryAfterMs, requestId: error.requestId } : {}), failureKind: control.reason || (!control.fetchCalled ? error.usageStorage ? 'usage_storage' : 'target_unavailable' : error.upstreamStatus === 401 || error.upstreamStatus === 403 ? 'auth' : error.upstreamStatus === 429 ? 'rate' : 'gateway') });
    } finally { clearTimeout(timer); this.stopProgress(control); }
  }

  async executeSample(run, index, control) {
    run.status = "running"; run.startedAt ||= new Date().toISOString();
    const config = this.payloads.get(run.id); let lastSaved = Date.now(), lastEmitted = 0, pendingEmission = null;
    const publish = () => { clearTimeout(pendingEmission); pendingEmission = null; if (!ACTIVE.has(run.status)) return; lastEmitted = Date.now(); this.emit("run", { run: this.publicRun(run) }); };
    const timeoutMs = run.timeoutMs ?? this.timeoutMs;
    const current = run.samples[index]; current.startedAt = new Date().toISOString(); current.state = "waiting";
    current.progress = advanceProgress(current.progress, "start", { at: this.progressNow() }); this.aggregateProgress(run);
    control.startedMonoMs = this.monoNow(); control.lastDataMonoMs = null; control.timeoutMs = timeoutMs; control.progressPublishedMonoMs = control.startedMonoMs;
    control.publishProgress = publish; control.stopEmission = () => { clearTimeout(pendingEmission); pendingEmission = null; };
    const timer = timeoutMs ? setTimeout(() => { control.reason = "timeout"; control.abort.abort(); }, timeoutMs) : null;
    const checkpoint = (value = run) => this.store.save(value).then(saved => { run.files = saved.files; });
    try {
      if (run.accountTarget?.mode === 'pinned') await this.gateway.assertAccount(run.provider, run.accountTarget, run.model);
      await checkpoint(); publish();
      const sample = await sampleFingerprint(this.gateway, { model: run.model, api: run.api, effort: run.effort, maxTokens: run.maxTokens,
        strict: run.strict, serviceTier: run.serviceTier, account: run.account }, run.challenges[index], {
        signal: control.abort.signal,
        beforeFetch:()=>this.prepareFetch(run,control),onFetch:()=>this.fetched(run,control),
        onProgress: event => this.recordProgress(run, control, event, index),
        onUpdate: value => {
          if (control.finishing || !ACTIVE.has(run.status)) return;
          const previous = run.samples[index], changed = Object.entries(value).some(([key, item]) => ["usage", "provenance"].includes(key) ? JSON.stringify(item) !== JSON.stringify(previous[key]) : item !== previous[key]);
          run.samples[index] = { ...previous, ...value }; if (!changed) return; run.revision++;
          if(value.usage){control.usageRevision=(control.usageRevision||0)+1;this.observeUsage(control,value.usage,control.usageRevision);}
          if (value.first_byte_ms != null && run.firstContentMs === null) run.firstContentMs = Date.now() - Date.parse(run.startedAt);
          if (Date.now() - lastEmitted >= 100 || !["waiting", "streaming"].includes(value.state)) publish();
          else pendingEmission ||= setTimeout(publish, 100 - (Date.now() - lastEmitted));
          if (Date.now() - lastSaved >= 2000) {
            lastSaved = Date.now(); checkpoint().catch(error => { control.reason = "storage"; control.error = error; control.abort.abort(); });
          }
        },
      });
      this.stopProgress(control);
      if(sample.upstreamStatus)this.queuePolicy.noteFailure(run,sample);
      if (control.reason === "timeout") { sample.state = "failed"; sample.failureKind = 'timeout'; sample.error = "指纹采样超时，已终止上游请求"; }
      if (control.reason === "storage") { sample.state = "failed"; sample.failureKind = 'storage'; sample.error = `采样保存失败：${safeError(control.error)}`; }
      const previous = run.samples[index];
      run.samples[index] = { ...previous, ...sample, progress: advanceProgress(previous.progress, "saving", { at: this.progressNow() }) }; run.revision++; publish();
      const ended = { ...run.samples[index], finishedAt: new Date().toISOString(), progress: advanceProgress(run.samples[index].progress, "end", { at: this.progressNow() }) };
      await checkpoint({ ...run, samples: run.samples.map((value, i) => i === index ? ended : value) });
      run.samples[index] = ended; run.revision++; this.aggregateProgress(run); publish();
    } catch (error) {
      if (error.readmit && !control.fetchCalled) { await this.readmit(run, control); return; }
      this.stopProgress(control);
      run.samples[index] = { ...run.samples[index], state: control.reason === "cancelled" || control.reason === "shutdown" ? "cancelled" : "failed", error: safeError(error),
        failureKind: control.reason || (!control.fetchCalled ? error.usageStorage ? 'usage_storage' : 'target_unavailable' : [401, 403].includes(error.upstreamStatus) ? 'auth' : error.upstreamStatus === 429 ? 'rate' : 'gateway'), ...(error.upstreamStatus ? { upstreamStatus: error.upstreamStatus } : {}),
        finishedAt: new Date().toISOString(), progress: advanceProgress(run.samples[index].progress, "end", { at: this.progressNow() }) };
      run.revision++; this.aggregateProgress(run); publish();
    } finally { clearTimeout(timer); this.stopProgress(control); if (control.fetchCalled && control.reservation) await this.usage.complete(control.physicalRequestId).catch(error => this.emit('queue-error', { error: safeError(error) })); }
    if (config && run.samples.every(sample => sample.progress.phase === "ended")) await this.finishFingerprint(run, config);
  }

  endQueuedSample(sample, message) {
    sample.state = "cancelled"; sample.error = message; sample.finishedAt = new Date().toISOString(); sample.elapsed_ms = 0;
    sample.progress = advanceProgress(sample.progress || newProgress(), "end", { at: this.progressNow() });
  }

  async finishFingerprint(run, config) {
    if (config.finishing) return;
    config.finishing = true;
    const routes = run.samples.map(sample => sample.routing), evidence = routes.find(route => route?.verification === 'mismatch') || routes.find(route => route?.reportedAccountId);
    run.routing = { ...routingEvidence(readRunTarget(run).account, { accountId: evidence?.reportedAccountId, provider: evidence?.provider, model: evidence?.model }, evidence?.source || null),
      verification: routes.some(route => route?.verification === 'mismatch') ? 'mismatch' : routes.every(route => route?.verification === 'verified') ? 'verified' : 'unavailable' };
    const cancelled = config.cancelReason || (run.samples.some(sample => sample.state === "cancelled") ? "cancelled" : "");
    let status = "completed", error = "", analysis = null;
    if (cancelled) { status = cancelled === "shutdown" ? "interrupted" : "cancelled"; error = cancelled === "shutdown" ? "服务关闭，采样已中断；已有回答保留" : "指纹检测已取消，已有回答保留"; }
    else if (run.samples.some(sample => sample.provenance?.mismatch)) { status = "error"; error = "实际账号、供应商或模型路由与所选目标不一致，本次不评分"; }
    else {
      const accepted = run.samples.filter(sample => sample.state === "complete" || (!run.strict && sample.state === "truncated"));
      if (!accepted.length || (run.strict && accepted.length !== 3)) { status = "error"; error = run.strict ? "严格模式需要三次完整、未截断的采样" : "没有有效采样，原始回答和错误已保留"; }
      else {
        try {
          analysis = config.detector.analyze(accepted.map(sample => ({ text: sample.text, expected_count: sample.expected_count })), { strict: run.strict });
          if (["unscorable", "not_model"].includes(analysis.decision)) { status = "invalid"; error = analysis.decision === "not_model" ? "数字变化方式与参考库不符，未生成排名" : "有效回答不足，无法评分"; }
        } catch (err) { status = "error"; error = `指纹评分失败：${safeError(err)}`; }
      }
    }
    run.revision++;
    await this.finish(run, { status, error, analysis, usage: sumUsage(run.samples) });
  }

  async cancel(id) {
    const run = this.get(id);
    if (!run) throw invalid("没有找到这个运行结果", 404);
    await this.cancelMany([run], "cancelled");
    return this.publicRun(run);
  }

  async cancelBatch(batchId) {
    if (!UUID.test(batchId)) throw invalid("批次 ID 无效");
    const members = [...this.runs.values()].filter(run => batchKey(run) === batchId);
    if (!members.length) throw invalid("没有找到这个批次", 404);
    await this.cancelMany(members, "cancelled"); return members.map(run => this.publicRun(run));
  }

  async cancelMany(members, reason) {
    this.schedulingPaused++;
    try {
      const unfinished = members.filter(run => ACTIVE.has(run.status)), ids = new Set(unfinished.map(run => run.id));
      this.queue = this.queue.filter(key => !ids.has(this.queuedId(key)));
      const waits = [];
      for (const run of unfinished) {
        const config = this.payloads.get(run.id);
        if (run.kind === "fingerprint" && config) {
          config.cancelReason = reason;
          for (const sample of run.samples) if (sample.state === "queued") this.endQueuedSample(sample, "采样未开始，已取消");
        }
      }
      for (const [key, control] of this.active) if (ids.has(control.id || key)) { control.reason = reason; control.abort.abort(); waits.push(control.promise); }
      for (const run of unfinished) if (!this.busy(run.id)) {
        if (run.kind === "fingerprint") { const config = this.payloads.get(run.id); if (config) waits.push(this.finishFingerprint(run, config)); }
        else waits.push(this.finish(run, { status: reason === "shutdown" ? "interrupted" : "cancelled", error: reason === "shutdown" ? "服务关闭，任务未开始" : "已取消排队" }));
      }
      await Promise.all(waits);
      for (const id of ids) this.payloads.delete(id);
    } finally { this.schedulingPaused--; this.pump(); }
  }

  async close() {
    this.closed = true;
    clearTimeout(this.queueTimer);
    const stopping = this.cancelMany([...this.runs.values()], "shutdown");
    await this.bank?.close();
    await this.submissions.catch(() => {});
    await Promise.all([...this.pendingFinishes.values()]);
    await stopping;
    await Promise.all([...this.active.values()].map(control => control.promise?.catch(() => {})));
    await this.pumping;
    await Promise.all([...this.store.pending.values()].map(task => task.catch(() => {})));
    this.queue = []; this.payloads.clear();
    await this.usage?.close();await this.queuePolicy.close();
  }
}
