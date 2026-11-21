import { randomUUID, createHash } from "node:crypto";
import { buildPayload, DEFAULT_MAX_TOKENS, DEFAULT_TIMEOUT_MS, generationTimeout, invalid, safeError } from "./gateway.mjs";
import { classifyResult, summary, SAVED_SUMMARY } from "./result.mjs";
import { ACTIVE, UUID } from "./store.mjs";
import { generateChallenges } from "../vendor/lmfpd-sdk/index.js";
import { sampleFingerprint, fingerprintApi } from "./fingerprint-sample.mjs";
import { CANDY_PROMPT, CANDY_VERSION, classifyCandy } from "./candy.mjs";
import { sumUsage, tokenUsage } from "./usage.mjs";
import { automaticResultKey, indexAutomaticResults } from "./automatic-results.mjs";
import { batchKey, historyBatches } from "./history-groups.mjs";
import { retestSources, originalConditions, abnormalRetest } from "./retest.mjs";

export const RETENTION_DAYS = 7;
export const HISTORY_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

const freshRun = fields => ({ ...fields, status: "queued", startedAt: null, finishedAt: null, firstContentMs: null, elapsedMs: null,
  finishReason: "", usage: null, requestId: "", content: "", reasoning: "", html: "", error: "" });
const fingerprintFields = (conditions, loadedBank) => ({ api: conditions.api, requestedApi: conditions.requestedApi, strict: conditions.strict,
  serviceTier: conditions.serviceTier, account: conditions.account, challenges: conditions.challenges,
  samples: conditions.challenges.map(challenge => ({ state: "queued", text: "", raw_text: "", count: 0, expected_count: challenge.expected_count,
    first_byte_ms: null, response_model: null, response_id: null, error: null })), analysis: null, bank: loadedBank.meta, revision: 0 });

export class Runner {
  constructor({ store, gateway, bank, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    this.store = store; this.gateway = gateway; this.timeoutMs = generationTimeout(timeoutMs);
    this.bank = bank; this.schedulingPaused = 0; this.pendingFinishes = new Map();
    this.runs = new Map(store.records);
    this.queue = []; this.active = new Map(); this.listeners = new Set(); this.payloads = new Map();
    this.catalog = []; this.catalogAt = 0; this.submissions = Promise.resolve(); this.closed = false;
  }

  get(id) { const run = this.runs.get(id); return run?.[SAVED_SUMMARY] ? this.store.getSync(id) : run || null; }
  async read(id) { const run = this.runs.get(id); return run?.[SAVED_SUMMARY] ? this.store.get(id) : run || null; }
  busy(id) { return this.pendingFinishes.has(id) || [...this.active.entries()].some(([key, control]) => (control.id || key) === id); }
  queuedId(key) { return key.split(":")[0]; }
  list() { return [...this.runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(summary); }
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
    const task = this.submissions.catch(() => {}).then(() => this.create(request, context));
    this.submissions = task;
    return task;
  }

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
        if (conditions.kind === "fingerprint") {
          if (!this.bank) throw invalid("当前后端不支持指纹检测");
          const sha = conditions.bank.sha256;
          if (!checkedBanks.has(sha)) checkedBanks.set(sha, this.bank.snapshotBytes(sha));
          await checkedBanks.get(sha);
          if (conditions.account) {
            this.retestAccounts ||= this.gateway.accounts().finally(() => { this.retestAccounts = null; });
            const accounts = await this.retestAccounts;
            if (!accounts.some(account => account.provider === source.provider && account.id === conditions.account)) throw invalid("原固定账号当前不可用");
          }
        }
      } catch (error) { reason = safeError(error); }
      items.push({ id: source.id, kind: source.kind || "pelican", run: summary(source), conditions, available: !reason, reason, abnormal: abnormalRetest(source) });
    }
    return { items, catalog };
  }

  retest(request) {
    const task = this.submissions.catch(() => {}).then(() => this.createRetest(request));
    this.submissions = task; return task;
  }

  async createRetest(request) {
    if (this.closed) throw invalid("服务正在关闭", 503);
    if (typeof request?.operationId !== "string" || !UUID.test(request.operationId)) throw invalid("复测操作标识无效");
    if (!Array.isArray(request.runIds) || !request.runIds.length || request.runIds.some(id => typeof id !== "string" || !UUID.test(id)) || new Set(request.runIds).size !== request.runIds.length) throw invalid("复测源记录无效或重复");
    const selectionHash = createHash("sha256").update([...request.runIds].sort().join("\n")).digest("hex");
    const prior = [...this.runs.values()].filter(run => run.retest?.operationId === request.operationId);
    if (prior.length) {
      if (prior.length !== request.runIds.length || prior.some(run => run.retest.selectionHash !== selectionHash)) throw invalid("复测操作已使用或部分记录已清理，请重新打开复测", 409);
      return { batchId: batchKey(prior[0]), runs: prior.map(summary) };
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
        ...(loadedBank ? fingerprintFields(conditions, loadedBank) : { prompt: conditions.prompt,
          promptHash: createHash("sha256").update(conditions.prompt).digest("hex"),
          ...(conditions.kind === "candy" ? { candy: { version: conditions.candyVersion, expected: 21, answer: null, verdict: "incomplete" } } : {}) }),
        retest: { sourceRunId: source.id, sourceBatchId: batchKey(source), sourceTime: conditions.sourceTime,
          sourceMode: source.source === "automatic" ? "automatic" : "manual", operationId: request.operationId, selectionHash } });
      entries.push({ run, payload: loadedBank ? { detector: loadedBank.detector, finishing: false, cancelReason: "" } : buildPayload(model, conditions) });
    }
    const created = await this.persistPrepared(entries);
    return { batchId: roundId, runs: created.map(summary) };
  }

  cleanup(request) {
    const task = this.submissions.catch(() => {}).then(() => this.prune(request));
    this.submissions = task;
    return task;
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

  async prune(request) {
    if (this.closed) throw invalid("服务正在关闭", 503);
    if (!request || !["all", "before", "batch", "daily"].includes(request.mode)) throw invalid("请选择有效的清理方式");
    let candidates = [...this.runs.values()];
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
    const outcome = { removed: [], skippedActive: 0, errors: [] };
    for (const run of candidates) {
      if (ACTIVE.has(run.status) || this.busy(run.id)) { outcome.skippedActive++; continue; }
      const finished = Date.parse(run.finishedAt), retainedAt = Number.isFinite(finished) ? finished : Date.parse(run.createdAt);
      if (request.mode === "before" && !(retainedAt < cutoff)) continue;
      try { await this.store.remove(run.id); this.runs.delete(run.id); outcome.removed.push(run.id); }
      catch (error) { outcome.errors.push({ id: run.id, error: safeError(error) }); }
    }
    if (outcome.removed.length) this.emit("removed", { ids: outcome.removed });
    return outcome;
  }

  async create(request, context = {}) {
    if (this.closed) throw invalid("服务正在关闭", 503);
    if (!request || !Array.isArray(request.models) || request.models.length < 1) throw invalid("请选择至少一个模型");
    const kind = request.kind || "pelican";
    if (!["pelican", "fingerprint", "candy"].includes(kind)) throw invalid("测试模式无效");
    const prompt = kind === "candy" ? CANDY_PROMPT : request.prompt;
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
    const ids = request.models.map((m) => m?.id);
    if (new Set(ids).size !== ids.length) throw invalid("同一批次不能重复选择模型");
    const catalog = await this.models();
    const byId = new Map(catalog.map(model => [model.id, model]));
    const selected = request.models.map((pick) => {
      const model = byId.get(pick?.id);
      if (!model) throw invalid("所选模型不在当前目录中，请刷新模型列表");
      const effort = pick.effort || "";
      const payload = buildPayload(model, { ...request, prompt: kind === "fingerprint" ? "数字指纹采样" : prompt, maxTokens, effort });
      const account = pick.account || "";
      if (typeof account !== "string" || account.length > 256 || /[\x00-\x1f\x7f]/.test(account)) throw invalid("固定账号标识无效");
      return { model, effort, account, payload };
    });
    const loadedBank = kind === "fingerprint" ? await this.bank.load() : null;
    const challenges = kind === "fingerprint" ? generateChallenges(3) : null;
    if (this.closed) throw invalid("服务正在关闭", 503);
    const batchId = randomUUID(), createdAt = new Date().toISOString();
    const entries = [], linked = [];
    const automaticResults = context.source === "automatic" ? indexAutomaticResults(this.runs.values()) : null;
      for (const { model, effort, account, payload } of selected) {
        const member = context.members?.[model.id];
        if (member) {
          const triggerKeys = new Set((context.plans || []).map(ref => ref.triggerKey).filter(Boolean));
          const prior = automaticResults?.get(automaticResultKey(member.favoriteId, model.id, kind, context.scheduledAt)) || [...this.runs.values()].find(run => run.favoriteId === member.favoriteId && run.kind === kind &&
            (context.source === "automatic"
              ? run.source === "automatic" && run.plans?.some(ref => triggerKeys.has(ref.triggerKey))
              : run.compareKey === member.compareKey && ACTIVE.has(run.status)));
          if (prior) { linked.push({ ...summary(prior), linked: true }); continue; }
        }
        const run = freshRun({ id: randomUUID(), batchId, kind, model: model.id, modelName: model.name, provider: model.provider, providerName: model.providerName, effort,
          ...(member ? { ...member, roundId: context.roundId, source: context.source, plans: context.plans || [], expiresAt: context.expiresAt, scheduledAt: context.scheduledAt } : {}),
          ...(kind === "fingerprint" ? fingerprintFields({ api: maxTokens === 0 && fingerprintApi(request.api, model) === "messages" ? "chat_completions" : fingerprintApi(request.api, model), requestedApi: request.api || "auto", strict: request.strict || false, serviceTier: request.serviceTier || "default", account, challenges }, loadedBank)
            : { prompt, promptHash: createHash("sha256").update(prompt).digest("hex"), ...(kind === "candy" ? { candy: { version: CANDY_VERSION, expected: 21, answer: null, verdict: "incomplete" } } : {}) }), maxTokens, concurrency, timeoutMs,
          createdAt });
        entries.push({ run, payload: kind === "fingerprint" ? { detector: loadedBank.detector, finishing: false, cancelReason: "" } : payload });
      }
    const created = await this.persistPrepared(entries);
    return [...created.map(summary), ...linked];
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
    for (const run of created) { this.queue.push(...(run.kind === "fingerprint" ? run.challenges.map((_, index) => `${run.id}:${index}`) : [run.id])); this.emit("run", { run: summary(run) }); }
    this.pump();
    return created;
  }

  pump() {
    if (this.closed || this.schedulingPaused) return;
    const counts = new Map(); let automaticCount = 0;
    for (const [key, control] of this.active) {
      const batchId = this.runs.get(control.id || key)?.batchId;
      if (this.runs.get(control.id || key)?.source === "automatic") automaticCount++;
      counts.set(batchId, (counts.get(batchId) || 0) + 1);
    }
    for (let index = 0; index < this.queue.length;) {
      const key = this.queue[index], id = this.queuedId(key), sampleIndex = key.includes(":") ? Number(key.split(":")[1]) : null;
      const run = this.runs.get(id);
      const eligible = run?.kind === "fingerprint" ? ACTIVE.has(run.status) && run.samples[sampleIndex]?.state === "queued" : run?.status === "queued";
      if (!eligible) { if (run?.kind !== "fingerprint") this.payloads.delete(id); this.queue.splice(index, 1); continue; }
      if (run.source === "automatic" && !this.automaticEligible?.(run)) {
        this.queue = this.queue.filter(queued => this.queuedId(queued) !== id);
        if (run.kind === "fingerprint") {
          const config = this.payloads.get(id); if (config) config.cancelReason = "cancelled";
          for (const sample of run.samples) if (sample.state === "queued") { sample.state = "cancelled"; sample.error = "计划已暂停、修改或超出时间窗"; }
          if (!this.busy(id) && config) this.saveSkipped(id, this.finishFingerprint(run, config));
        } else { run.status = "cancelled"; this.saveSkipped(id, this.finish(run, { status: "cancelled", error: "计划已暂停、修改或超出时间窗" })); }
        continue;
      }
      const count = counts.get(run.batchId) || 0;
      const batchLimit = run.concurrency ?? 2, automaticLimit = this.automaticConcurrency ?? 3;
      if ((batchLimit > 0 && count >= batchLimit) || (run.source === "automatic" && automaticLimit > 0 && automaticCount >= automaticLimit)) { index++; continue; }
      this.queue.splice(index, 1); counts.set(run.batchId, count + 1);
      if (run.source === "automatic") automaticCount++;
      const control = { id, sampleIndex, abort: new AbortController(), reason: "", promise: null };
      this.active.set(key, control);
      control.promise = (run.kind === "fingerprint" ? this.executeSample(run, sampleIndex, control) : this.execute(run, control)).finally(() => {
        this.active.delete(key);
        if (!this.busy(id) && !this.queue.some(key => this.queuedId(key) === id)) this.payloads.delete(id);
        this.pump();
      });
    }
  }

  async finish(run, patch) {
    const done = { ...run, ...patch, finishedAt: new Date().toISOString(),
      elapsedMs: run.startedAt ? Date.now() - Date.parse(run.startedAt) : 0 };
    let saved = false;
    try { Object.assign(run, await this.store.save(done)); saved = true; }
    catch (error) { Object.assign(run, done, { status: "error", error: `结果保存失败：${safeError(error)}` }); }
    this.emit("run", { run: summary(run) });
    if (saved) this.runs.set(run.id, this.store.records.get(run.id));
  }

  saveSkipped(id, task) {
    const pending = task.finally(() => { this.pendingFinishes.delete(id); this.payloads.delete(id); });
    this.pendingFinishes.set(id, pending);
  }

  async execute(run, control) {
    run.status = "running"; run.startedAt = new Date().toISOString();
    let bytes = 0, lastCheckpoint = Date.now();
    const timeoutMs = run.timeoutMs ?? this.timeoutMs;
    const timer = timeoutMs ? setTimeout(() => { control.reason = "timeout"; control.abort.abort(); }, timeoutMs) : null;
    try {
      Object.assign(run, await this.store.save(run));
      this.emit("run", { run: summary(run) });
      const meta = await this.gateway.generate(this.payloads.get(run.id), {
        signal: control.abort.signal,
        onChunk: ({ content = "", reasoning = "", usage }) => {
          bytes += Buffer.byteLength(content) + Buffer.byteLength(reasoning);
          if (bytes > 4 * 1024 * 1024) { control.reason = "oversize"; control.abort.abort(); throw invalid("生成输出超过 4 MiB，已停止"); }
          if (content && run.firstContentMs === null) run.firstContentMs = Date.now() - Date.parse(run.startedAt);
          run.content += content; run.reasoning += reasoning;
          if (usage) { run.usage = usage; run.usageRevision = (run.usageRevision || 0) + 1; }
          this.emit("delta", { id: run.id, content, reasoning, contentChars: run.content.length, reasoningChars: run.reasoning.length, firstContentMs: run.firstContentMs,
            ...(usage ? { usage, tokens: tokenUsage(run), usageRevision: run.usageRevision } : {}) });
          if (Date.now() - lastCheckpoint >= 2000) {
            lastCheckpoint = Date.now();
            this.store.save(run).catch((error) => { control.reason = "storage"; control.error = error; control.abort.abort(); });
          }
        },
      });
      if (control.reason) throw new Error("Aborted");
      await this.finish(run, { ...meta, ...(run.kind === "candy" ? classifyCandy(run.content, meta.finishReason) : classifyResult(run.content, meta.finishReason)) });
    } catch (error) {
      const status = ["cancelled", "shutdown"].includes(control.reason) ? (control.reason === "shutdown" ? "interrupted" : "cancelled") : "error";
      const message = { timeout: "生成超时，已终止上游请求", cancelled: "已取消生成，已有输出已保留", shutdown: "服务重新启动，生成已中断",
        oversize: "生成输出超过 4 MiB，已停止", storage: `结果保存失败：${safeError(control.error)}` }[control.reason] || safeError(error);
      await this.finish(run, { status, error: message });
    } finally { clearTimeout(timer); }
  }

  async executeSample(run, index, control) {
    run.status = "running"; run.startedAt ||= new Date().toISOString();
    const config = this.payloads.get(run.id); let lastSaved = Date.now(), lastEmitted = 0, pendingEmission = null;
    const publish = () => { clearTimeout(pendingEmission); pendingEmission = null; lastEmitted = Date.now(); this.emit("run", { run: summary(run) }); };
    const timeoutMs = run.timeoutMs ?? this.timeoutMs;
    const timer = timeoutMs ? setTimeout(() => { control.reason = "timeout"; control.abort.abort(); }, timeoutMs) : null;
    const checkpoint = () => this.store.save(run).then(saved => { run.files = saved.files; });
    try {
      await checkpoint(); this.emit("run", { run: summary(run) });
      const sample = await sampleFingerprint(this.gateway, { model: run.model, api: run.api, effort: run.effort, maxTokens: run.maxTokens,
        strict: run.strict, serviceTier: run.serviceTier, account: run.account }, run.challenges[index], {
        signal: control.abort.signal,
        onUpdate: value => {
          run.samples[index] = value; run.revision++;
          if (value.first_byte_ms != null && run.firstContentMs === null) run.firstContentMs = Date.now() - Date.parse(run.startedAt);
          if (Date.now() - lastEmitted >= 100 || !["waiting", "streaming"].includes(value.state)) publish();
          else pendingEmission ||= setTimeout(publish, 100 - (Date.now() - lastEmitted));
          if (Date.now() - lastSaved >= 2000) {
            lastSaved = Date.now(); checkpoint().catch(error => { control.reason = "storage"; control.error = error; control.abort.abort(); });
          }
        },
      });
      if (control.reason === "timeout") { sample.state = "failed"; sample.error = "指纹采样超时，已终止上游请求"; }
      if (control.reason === "storage") { sample.state = "failed"; sample.error = `采样保存失败：${safeError(control.error)}`; }
      run.samples[index] = sample; run.revision++;
      await checkpoint();
    } catch (error) {
      run.samples[index] = { ...run.samples[index], state: control.reason === "cancelled" || control.reason === "shutdown" ? "cancelled" : "failed", error: safeError(error) };
      run.revision++;
    } finally { clearTimeout(timer); if (pendingEmission) publish(); }
    if (config && run.samples.every(sample => !["queued", "waiting", "streaming"].includes(sample.state))) await this.finishFingerprint(run, config);
  }

  async finishFingerprint(run, config) {
    if (config.finishing) return;
    config.finishing = true;
    const cancelled = config.cancelReason || (run.samples.some(sample => sample.state === "cancelled") ? "cancelled" : "");
    let status = "completed", error = "", analysis = null;
    if (cancelled) { status = cancelled === "shutdown" ? "interrupted" : "cancelled"; error = cancelled === "shutdown" ? "服务关闭，采样已中断；已有回答保留" : "指纹检测已取消，已有回答保留"; }
    else if (run.samples.some(sample => sample.provenance?.mismatch)) { status = "error"; error = "实际供应商或模型路由与所选目标不一致，本次不评分"; }
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
    return summary(run);
  }

  async cancelBatch(batchId) {
    if (!UUID.test(batchId)) throw invalid("批次 ID 无效");
    const members = [...this.runs.values()].filter(run => batchKey(run) === batchId);
    if (!members.length) throw invalid("没有找到这个批次", 404);
    await this.cancelMany(members, "cancelled"); return members.map(summary);
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
          for (const sample of run.samples) if (sample.state === "queued") { sample.state = "cancelled"; sample.error = "采样未开始，已取消"; }
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
    await this.bank?.close();
    await this.submissions.catch(() => {});
    await Promise.all([...this.pendingFinishes.values()]);
    await this.cancelMany([...this.runs.values()], "shutdown");
    this.queue = []; this.payloads.clear();
  }
}
