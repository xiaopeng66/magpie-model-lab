import { randomUUID, createHash } from "node:crypto";
import { buildPayload, DEFAULT_MAX_TOKENS, invalid, safeError } from "./gateway.mjs";
import { classifyResult, summary } from "./result.mjs";
import { ACTIVE, UUID } from "./store.mjs";
import { generateChallenges } from "../vendor/lmfpd-sdk/index.js";
import { sampleFingerprint, fingerprintApi } from "./fingerprint-sample.mjs";
import { CANDY_PROMPT, CANDY_VERSION, classifyCandy } from "./candy.mjs";
import { sumUsage, tokenUsage } from "./usage.mjs";
import { automaticResultKey, indexAutomaticResults } from "./automatic-results.mjs";

export const RETENTION_DAYS = 7;

export class Runner {
  constructor({ store, gateway, bank, timeoutMs = 600000 }) {
    this.store = store; this.gateway = gateway; this.timeoutMs = timeoutMs;
    this.bank = bank; this.schedulingPaused = 0; this.pendingFinishes = new Map();
    this.runs = new Map(store.records);
    this.queue = []; this.active = new Map(); this.listeners = new Set(); this.payloads = new Map();
    this.catalog = []; this.catalogAt = 0; this.submissions = Promise.resolve(); this.closed = false;
  }

  get(id) { return this.runs.get(id) || null; }
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

  cleanup(request) {
    const task = this.submissions.catch(() => {}).then(() => this.prune(request));
    this.submissions = task;
    return task;
  }

  async prune(request) {
    if (this.closed) throw invalid("服务正在关闭", 503);
    if (!request || !["all", "before", "batch"].includes(request.mode)) throw invalid("请选择有效的清理方式");
    let candidates = [...this.runs.values()];
    if (request.mode === "batch") {
      if (typeof request.batchId !== "string" || !UUID.test(request.batchId)) throw invalid("批次 ID 无效");
      candidates = candidates.filter(run => (run.roundId || run.batchId || run.id) === request.batchId);
      if (!candidates.length) throw invalid("没有找到这个批次", 404);
      if (candidates.some(run => ACTIVE.has(run.status) || this.busy(run.id))) throw invalid("本批仍有任务未完成，请结束后再删除", 409);
    }
    let cutoff = Infinity;
    if (request.mode === "before") {
      if (typeof request.before !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(request.before)) throw invalid("清理时间需为有效 UTC 时间");
      cutoff = Date.parse(request.before);
      if (!Number.isFinite(cutoff) || new Date(cutoff).toISOString().slice(0, 19) !== request.before.slice(0, 19)) throw invalid("清理时间无效");
    }
    const outcome = { removed: [], skippedActive: 0, errors: [] };
    for (const run of candidates) {
      if (ACTIVE.has(run.status) || this.busy(run.id)) { outcome.skippedActive++; continue; }
      if (request.mode === "before" && !(Date.parse(run.finishedAt || run.createdAt) < cutoff)) continue;
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
    const created = [], attempted = [], linked = [];
    const automaticResults = context.source === "automatic" ? indexAutomaticResults(this.runs.values()) : null;
    try {
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
        const run = { id: randomUUID(), batchId, kind, model: model.id, modelName: model.name, provider: model.provider, providerName: model.providerName, effort,
          ...(member ? { ...member, roundId: context.roundId, source: context.source, plans: context.plans || [], expiresAt: context.expiresAt, scheduledAt: context.scheduledAt } : {}),
          ...(kind === "fingerprint" ? { api: maxTokens === 0 && fingerprintApi(request.api, model) === "messages" ? "chat_completions" : fingerprintApi(request.api, model), requestedApi: request.api || "auto", strict: request.strict || false, serviceTier: request.serviceTier || "default", account,
            challenges, samples: challenges.map(challenge => ({ state: "queued", text: "", raw_text: "", count: 0, expected_count: challenge.expected_count,
              first_byte_ms: null, response_model: null, response_id: null, error: null })), analysis: null, bank: loadedBank.meta, revision: 0 }
            : { prompt, promptHash: createHash("sha256").update(prompt).digest("hex"), ...(kind === "candy" ? { candy: { version: CANDY_VERSION, expected: 21, answer: null, verdict: "incomplete" } } : {}) }), maxTokens, concurrency,
          status: "queued", createdAt, startedAt: null, finishedAt: null,
          firstContentMs: null, elapsedMs: null, finishReason: "", usage: null, requestId: "", content: "", reasoning: "", html: "", error: "" };
        attempted.push(run.id);
        const saved = await this.store.save(run);
        created.push(saved); this.payloads.set(saved.id, kind === "fingerprint" ? { detector: loadedBank.detector, finishing: false, cancelReason: "" } : payload);
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
    for (const run of created) { this.queue.push(...(kind === "fingerprint" ? challenges.map((_, index) => `${run.id}:${index}`) : [run.id])); this.emit("run", { run: summary(run) }); }
    this.pump();
    return [...created.map(summary), ...linked];
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
    try { Object.assign(run, await this.store.save(done)); }
    catch (error) { Object.assign(run, done, { status: "error", error: `结果保存失败：${safeError(error)}` }); }
    this.emit("run", { run: summary(run) });
  }

  saveSkipped(id, task) {
    const pending = task.finally(() => { this.pendingFinishes.delete(id); this.payloads.delete(id); });
    this.pendingFinishes.set(id, pending);
  }

  async execute(run, control) {
    run.status = "running"; run.startedAt = new Date().toISOString();
    let bytes = 0, lastCheckpoint = Date.now();
    const timer = setTimeout(() => { control.reason = "timeout"; control.abort.abort(); }, this.timeoutMs);
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
    const timer = setTimeout(() => { control.reason = "timeout"; control.abort.abort(); }, this.timeoutMs);
    const checkpoint = () => this.store.save(run).then(saved => { run.files = saved.files; });
    try {
      await checkpoint(); this.emit("run", { run: summary(run) });
      const sample = await sampleFingerprint(this.gateway, { model: run.model, api: run.api, effort: run.effort, maxTokens: run.maxTokens,
        strict: run.strict, serviceTier: run.serviceTier, account: run.account }, run.challenges[index], {
        signal: control.abort.signal,
        onUpdate: value => {
          run.samples[index] = value; run.revision++;
          if (value.first_byte_ms != null && run.firstContentMs === null) run.firstContentMs = value.first_byte_ms;
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
    const members = [...this.runs.values()].filter(run => (run.roundId || run.batchId || run.id) === batchId);
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
