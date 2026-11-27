import { mkdir, lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { DEFAULT_PROMPT, DEFAULT_MAX_TOKENS, DEFAULT_TIMEOUT_MS, generationTimeout, buildPayload, invalid, safeError } from "./gateway.mjs";
import { UUID } from "./store.mjs";
import { CANDY_VERSION } from "./candy.mjs";
import { dailyTimes, dailySlots, MAX_DAILY_SLOTS } from "./scheduler.mjs";
import { automaticResultKey, indexAutomaticResults } from "./automatic-results.mjs";
import { normalizeTarget, readFavoriteTarget } from './targets.mjs';
import { StateFile, parsePrivateJSON } from './state-file.mjs';

export const TEST_KINDS = ["candy", "fingerprint", "pelican"];
const positive = (value, name) => { if (!Number.isSafeInteger(value) || value < 1) throw invalid(`${name}需为正整数`); return value; };
const concurrencyLimit = (value, name) => { if (!Number.isSafeInteger(value) || value < 0) throw invalid(`${name}需为非负整数，0 表示不设上限`); return value; };
const clock = value => typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
const kindsOf = values => { if (!Array.isArray(values) || !values.length || values.some(kind => !TEST_KINDS.includes(kind))) throw invalid("请选择测试类型"); return [...new Set(values)]; };
const idsOf = values => { if (!Array.isArray(values) || !values.length || values.some(id => typeof id !== "string" || !UUID.test(id))) throw invalid("请选择收藏模型"); return [...new Set(values)]; };
const object = value => value && typeof value === "object" && !Array.isArray(value);
const planDefaults = () => ({ name: "自动测试", mode: "times", times: ["09:00"], intervalMinutes: 60, start: "09:00", end: "18:00", allDay: false,
  days: [1, 2, 3, 4, 5], timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, enabled: false });

function fingerprintOptions(value = {}) {
  if (!object(value)) throw invalid("指纹参数无效");
  const fp = { api: "auto", strict: false, serviceTier: "default", account: "", ...value };
  if (!["auto", "responses", "chat_completions", "messages"].includes(fp.api) || typeof fp.strict !== "boolean" || !["default", "flex", "fast", "ultrafast"].includes(fp.serviceTier) ||
      typeof fp.account !== "string" || fp.account.length > 256 || /[\x00-\x1f\x7f]/.test(fp.account)) throw invalid("指纹参数无效");
  return { api: fp.api, strict: fp.strict, serviceTier: fp.serviceTier, account: fp.account };
}

export function validateSchedule(value) {
  if (typeof value.name !== "string" || !value.name.trim() || value.name.length > 80) throw invalid("计划名称需为 1–80 字");
  if (!["times", "interval"].includes(value.mode) || typeof value.enabled !== "boolean" || typeof value.allDay !== "boolean") throw invalid("计划设置无效");
  if (!Array.isArray(value.days) || !value.days.length || value.days.some(day => !Number.isInteger(day) || day < 0 || day > 6)) throw invalid("请选择重复日期");
  if (!Array.isArray(value.times) || !value.times.length || value.times.some(time => !clock(time))) throw invalid("时间需为 HH:mm");
  if (!clock(value.start) || !clock(value.end) || (!value.allDay && value.mode === "interval" && value.start === value.end)) throw invalid("请设置不同的开始和结束时间，或选择全天");
  positive(value.intervalMinutes, "间隔分钟数");
  try { if (typeof value.timeZone !== "string") throw new Error(); new Intl.DateTimeFormat("en", { timeZone: value.timeZone }); } catch { throw invalid("时区无效"); }
}

export function restoreFavoritesState(saved) {
  if (!object(saved) || ![1, 2, 3].includes(saved.schema) || typeof saved.enabled !== "boolean" || !Array.isArray(saved.favorites) || !Array.isArray(saved.plans) || !Array.isArray(saved.claims)) throw invalid("收藏配置格式无效");
  if (saved.schema === 3 && (!Number.isSafeInteger(saved.revision) || saved.revision < 0)) throw invalid('收藏配置 revision 无效');
  concurrencyLimit(saved.concurrency, "自动并行数");
  const ids = new Set(), models = new Set(), planIds = new Set(), pairs = new Set(), claimKeys = new Set();
  const favorites = saved.favorites.map(value => {
    if (!object(value) || typeof value.id !== "string" || !UUID.test(value.id) || typeof value.modelId !== "string" || !value.modelId || ids.has(value.id)) throw invalid("收藏模型配置无效");
    const target = normalizeTarget({ modelId: value.modelId, account: saved.schema === 3 ? value.account : undefined, ...(saved.schema === 3 ? { targetKey: value.targetKey } : {}) });
    if (models.has(target.targetKey)) throw invalid('收藏模型账号目标重复');
    ids.add(value.id); models.add(target.targetKey);
    const favorite = { effort: "", maxTokens: DEFAULT_MAX_TOKENS, timeoutMs: DEFAULT_TIMEOUT_MS, prompt: DEFAULT_PROMPT, ...value };
    generationTimeout(favorite.timeoutMs);
    for (const key of ["modelName", "provider", "providerName", "createdAt", "lastRunAt"]) if (favorite[key] != null && typeof favorite[key] !== "string") throw invalid("收藏模型信息无效");
    buildPayload({ id: favorite.modelId, efforts: [favorite.effort] }, favorite);
    favorite.fingerprint = fingerprintOptions(favorite.fingerprint);
    if (target.account.mode === 'pinned' && favorite.fingerprint.account) throw invalid('固定账号收藏不能包含旧指纹账号 override');
    if (saved.schema === 3) { favorite.account = target.account; favorite.targetKey = target.targetKey; }
    if (favorite.concurrency !== undefined && !object(favorite.concurrency)) throw invalid("收藏并行数无效");
    favorite.concurrency = Object.fromEntries([["candy", 3], ["pelican", 2], ["fingerprint", 3]].map(([kind, fallback]) => [kind, concurrencyLimit(favorite.concurrency?.[kind] ?? fallback, "收藏并行数")]));
    return favorite;
  });
  const plans = saved.plans.map(value => {
    if (!object(value) || typeof value.id !== "string" || !UUID.test(value.id) || planIds.has(value.id)) throw invalid("计划 ID 无效");
    planIds.add(value.id);
    if (typeof value.enabled !== "boolean" || !["times", "interval"].includes(value.mode) || !Array.isArray(value.days) || typeof value.timeZone !== "string" ||
        (value.mode === "times" && !Array.isArray(value.times)) || (value.mode === "interval" && (!Number.isSafeInteger(value.intervalMinutes) || typeof value.allDay !== "boolean" ||
          (!value.allDay && (!clock(value.start) || !clock(value.end)))))) throw invalid("计划缺少有效的执行时间");
    const plan = { ...planDefaults(), ...value, favoriteIds: idsOf(value.favoriteIds), kinds: kindsOf(value.kinds) };
    positive(plan.revision, "计划版本"); validateSchedule(plan);
    if (plan.resumeAfter != null && (typeof plan.resumeAfter !== 'string' || !Number.isFinite(Date.parse(plan.resumeAfter)))) throw invalid('计划恢复边界无效');
    if (plan.migrationReason != null && (typeof plan.migrationReason !== "string" || plan.enabled)) throw invalid("迁移计划需重新设置");
    if (plan.favoriteIds.some(id => !ids.has(id))) throw invalid("计划包含不存在的模型");
    if (saved.schema >= 2) {
      if (plan.favoriteIds.length !== 1 || plan.kinds.length !== 1 || !["candy", "pelican"].includes(plan.kinds[0])) throw invalid("计划需对应一个模型的一种自动测试");
      const pair = `${plan.favoriteIds[0]}:${plan.kinds[0]}`;
      if (pairs.has(pair)) throw invalid("同模型测试计划重复"); pairs.add(pair); dailyTimes(plan);
    }
    return plan;
  });
  for (const claim of saved.claims) {
    if (!object(claim) || typeof claim.key !== "string" || !claim.key || claimKeys.has(claim.key) || typeof claim.at !== "string" || !Number.isFinite(Date.parse(claim.at)) ||
        (claim.state !== undefined && !["started", "error", "skipped", "missed"].includes(claim.state)) || (claim.runId !== undefined && (typeof claim.runId !== "string" || !UUID.test(claim.runId))) ||
        (claim.reason !== undefined && typeof claim.reason !== "string")) throw invalid("计划执行记录无效");
    claimKeys.add(claim.key);
  }
  return { ...saved, favorites, plans };
}

export function comparisonKey(favorite, kind) {
  const params = { model: favorite.modelId, effort: favorite.effort, maxTokens: favorite.maxTokens, kind,
    ...(favorite.timeoutMs != null && favorite.timeoutMs !== DEFAULT_TIMEOUT_MS ? { timeoutMs: favorite.timeoutMs } : {}),
    ...(kind === "candy" ? { version: CANDY_VERSION } : kind === "pelican" ? { prompt: favorite.prompt } : favorite.fingerprint),
    ...(favorite.account?.mode === 'pinned' ? { targetKey: readFavoriteTarget(favorite, kind).targetKey } : {}) };
  return createHash("sha256").update(JSON.stringify(params)).digest("hex");
}

export class Favorites {
  constructor({ dir, runner }) {
    this.dir = join(dir, ".favorites"); this.path = join(this.dir, "state.json"); this.runner = runner;
    this.state = { schema: 3, revision: 0, favorites: [], plans: [], enabled: true, concurrency: 3, claims: [] };
    this.file = new StateFile(dir, '.favorites', this.state, value => restoreFavoritesState(value));
    this.pending = Promise.resolve(); this.dispatches = Promise.resolve(); this.closed = false; this.recoveryError = "";
    runner.automaticEligible = run => this.eligible(run);
  }

  async checkDirectory() {
    for (const dir of [this.runner.store.dir, this.dir]) {
      const stat = await lstat(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalid("收藏保存目录不是普通目录");
    }
  }

  async init() {
    const createdDirectory = await mkdir(this.dir, { recursive: true }); await this.checkDirectory();
    try {
      await this.file.regular(this.path);
      const saved = parsePrivateJSON(await readFile(this.path)), restored = restoreFavoritesState(saved);
      this.state = saved.schema === 1 ? await this.migrate(restored, saved) : restored;
      if (this.state.schema === 2) this.state = await this.migrateTargets(this.state, saved.schema === 2 ? saved : this.state);
    } catch (error) { if (error.code !== "ENOENT" || !createdDirectory) {
      this.state.enabled = false; this.recoveryError = `收藏配置读取失败：${safeError(error)}`;
      throw invalid(this.recoveryError, 500);
    } }
    this.recoveryError = "";
    if (!await this.file.regular(this.path, true)) await this.file.replace(this.path, this.state);
    this.file.data = parsePrivateJSON(await readFile(this.path));
    this.runner.automaticConcurrency = this.state.concurrency;
  }

  async migrate(saved, original = saved) {
    let backup = join(this.dir, "state-v1-backup.json");
    try { await writeFile(backup, JSON.stringify(original, null, 2), { flag: "wx", mode: 0o600 }); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      backup = join(this.dir, `state-v1-backup-${randomUUID()}.json`);
      await writeFile(backup, JSON.stringify(original, null, 2), { flag: "wx", mode: 0o600 });
    }
    const groups = new Map();
    for (const plan of saved.plans) for (const id of plan.favoriteIds || []) for (const kind of plan.kinds || []) {
      if (!["candy", "pelican"].includes(kind) || !saved.favorites.some(f => f.id === id)) continue;
      const key = `${id}:${kind}`; if (!groups.has(key)) groups.set(key, { id, kind, originals: [] }); groups.get(key).originals.push(plan);
    }
    const plans = [...groups.values()].map(({ id, kind, originals }) => {
      let reason = originals.length > 1 ? "旧计划重叠，请重新设置" : "";
      try { dailyTimes(originals[0]); } catch { reason ||= "旧计划超过每天 24 次，请重新设置"; }
      return { ...originals[0], id: randomUUID(), revision: 1, favoriteIds: [id], kinds: [kind],
        enabled: !reason && saved.enabled && originals[0].enabled,
        ...(reason ? { mode: "times", times: ["09:00"], migrationReason: reason } : {}) };
    });
    const next = { ...saved, schema: 2, plans, enabled: true, migrationBackup: backup };
    await this.runner.store.atomic(this.path, JSON.stringify(next, null, 2)); return next;
  }
  async migrateTargets(saved, original) {
    const backup = join(this.dir, `state-v2-backup-${randomUUID()}.json`);
    await this.file.replace(backup, original);
    const next = { ...saved, schema: 3, revision: 0, favorites: saved.favorites.map(f => ({ ...f, ...normalizeTarget({ modelId: f.modelId }), modelId: f.modelId })) };
    restoreFavoritesState(next); await this.file.replace(this.path, next); return next;
  }

  snapshot(at = new Date()) {
    const state = structuredClone(this.state); delete state.claims;
    if (this.recoveryError) { state.readOnly = true; state.error = this.recoveryError; }
    state.favorites = state.favorites.map(favorite => ({ ...favorite,
      available: this.runner.catalog.some(model => model.id === favorite.modelId && (!favorite.effort || model.efforts.includes(favorite.effort))),
      compareKeys: Object.fromEntries(TEST_KINDS.map(kind => [kind, comparisonKey(favorite, kind)])) }));
    const claims = new Map(this.state.claims.map(claim => [claim.key, claim]));
    const models = new Map(state.favorites.map(favorite => [favorite.id, favorite]));
    const results = indexAutomaticResults(this.runner.runs.values());
    state.maxDailySlots = MAX_DAILY_SLOTS;
    state.plans = state.plans.map(plan => {
      const today = dailySlots(plan, at);
      today.slots = today.slots.map(slot => {
        const f = models.get(plan.favoriteIds[0]);
        const run = results.get(automaticResultKey(plan.favoriteIds[0], f.modelId, plan.kinds[0], slot.at, readFavoriteTarget(f, plan.kinds[0])));
        if (run) return { ...slot, state: "started", runId: run.id };
        const claim = claims.get(slot.key);
        return { ...slot, ...(claim ? { state: claim.state || "missed", reason: claim.reason || "", ...(claim.runId ? { runId: claim.runId } : {}) } : {}) };
      });
      return { ...plan, today };
    });
    return state;
  }

  transact(change) {
    const task = this.pending.catch(() => {}).then(async () => {
      if (this.closed) throw invalid("服务正在关闭", 503);
      if (this.recoveryError) throw invalid(this.recoveryError, 503);
      const next = structuredClone(this.state), value = await change(next);
      next.revision = (this.state.revision || 0) + 1;
      await this.checkDirectory();
      try { await this.file.commit(next); }
      catch (error) {
        // A failed replacement may be retried only when the original complete state is still on disk.
        try {
          await this.file.regular(this.path);
          const disk = parsePrivateJSON(await readFile(this.path)); restoreFavoritesState(disk);
          if (JSON.stringify(disk) === JSON.stringify(this.file.data)) this.file.recoveryError = '';
          else this.recoveryError = this.file.recoveryError || '收藏配置出现外部修改，请重启核对';
        } catch { this.recoveryError = this.file.recoveryError || '收藏配置无法核对，写入与调度已暂停'; }
        throw error;
      }
      this.state = next; this.runner.automaticConcurrency = next.concurrency;
      this.runner.pump(); this.runner.emit("favorites", {});
      return structuredClone(value);
    });
    this.pending = task; return task;
  }

  async save(input) {
    if (!input || typeof input.modelId !== "string") throw invalid("请选择模型");
    return this.transact(async state => {
      const model = (await this.runner.models()).find(model => model.id === input.modelId);
      if (!model) throw invalid("收藏模型已不可用，请刷新模型目录");
      if (input.account?.mode === 'pinned') input = { ...input, account: await this.runner.gateway.assertAccount(model.provider, input.account, model.id) };
      return this.applyFavorite(state, input, model);
    });
  }

  applyFavorite(state, input, model) {
    const original = input.id ? state.favorites.find(f => f.id === input.id) : null;
    const target = normalizeTarget({ modelId: model.id, account: input.account ?? original?.account });
    const existing = input.id ? original : state.favorites.find(f => f.targetKey === target.targetKey);
    if (input.id && !existing) throw invalid("收藏不存在", 404);
    if (!input.id && existing) return existing;
    if (existing && existing.targetKey !== target.targetKey) throw invalid('更改账号绑定请添加为新账号目标');
    if (state.favorites.some(f => f.targetKey === target.targetKey && f !== existing)) throw invalid("这个模型账号目标已在收藏中");
    const effort = input.effort ?? existing?.effort ?? "", maxTokens = input.maxTokens ?? existing?.maxTokens ?? DEFAULT_MAX_TOKENS;
    const timeoutMs = generationTimeout(input.timeoutMs ?? existing?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const prompt = input.prompt ?? existing?.prompt ?? DEFAULT_PROMPT;
    buildPayload(model, { prompt, maxTokens, effort });
    if (input.fingerprint !== undefined && !object(input.fingerprint)) throw invalid("指纹参数无效");
    if (input.concurrency !== undefined && !object(input.concurrency)) throw invalid("收藏并行数无效");
    const fp = fingerprintOptions({ ...existing?.fingerprint, ...input.fingerprint });
    if (target.account.mode === 'pinned' && fp.account) throw invalid('固定账号收藏不能同时设置旧指纹账号');
    const favorite = { id: existing?.id || randomUUID(), modelId: model.id, modelName: model.name, provider: model.provider, providerName: model.providerName,
      account: target.account, targetKey: target.targetKey,
      effort, maxTokens, timeoutMs, prompt, fingerprint: { api: fp.api, strict: fp.strict, serviceTier: fp.serviceTier, account: fp.account },
      concurrency: { candy: concurrencyLimit(input.concurrency?.candy ?? existing?.concurrency?.candy ?? 3, "糖果并行数"),
        pelican: concurrencyLimit(input.concurrency?.pelican ?? existing?.concurrency?.pelican ?? 2, "动画并行数"),
        fingerprint: concurrencyLimit(input.concurrency?.fingerprint ?? existing?.concurrency?.fingerprint ?? 3, "指纹并行数") },
      createdAt: existing?.createdAt || new Date().toISOString(), lastRunAt: existing?.lastRunAt || "" };
    if (existing) state.favorites[state.favorites.indexOf(existing)] = favorite; else state.favorites.push(favorite);
    return favorite;
  }

  async manage(input) {
    if (!object(input) || !Array.isArray(input.edits ?? []) || !Array.isArray(input.removeIds ?? [])) throw invalid("管理设置格式无效");
    const edits = input.edits ?? [], removeIds = input.removeIds ?? [];
    if (edits.some(edit => !object(edit) || !UUID.test(edit.id || "") || typeof edit.modelId !== "string") ||
        removeIds.some(id => typeof id !== "string" || !UUID.test(id)) || new Set(removeIds).size !== removeIds.length ||
        new Set(edits.map(edit => edit.id)).size !== edits.length || edits.some(edit => removeIds.includes(edit.id))) throw invalid("管理设置包含无效或重复模型");
    return this.transact(async state => {
      const models = edits.length ? await this.runner.models() : [];
      for (const id of removeIds) if (!state.favorites.some(favorite => favorite.id === id)) throw invalid("收藏不存在，请刷新模型列表", 404);
      for (const edit of edits) {
        const model = models.find(model => model.id === edit.modelId);
        if (!model) throw invalid("收藏模型已不可用，请刷新模型目录");
        this.applyFavorite(state, edit, model);
      }
      state.favorites = state.favorites.filter(favorite => !removeIds.includes(favorite.id));
      state.plans = state.plans.filter(plan => !plan.favoriteIds.some(id => removeIds.includes(id)));
      if (input.concurrency !== undefined) state.concurrency = concurrencyLimit(input.concurrency, "自动并行数");
      return { edited: edits.map(edit => edit.id), removed: removeIds, concurrency: state.concurrency };
    });
  }

  remove({ id }) {
    return this.transact(state => {
      if (!state.favorites.some(f => f.id === id)) throw invalid("收藏不存在", 404);
      state.favorites = state.favorites.filter(f => f.id !== id);
      state.plans = state.plans.filter(plan => !plan.favoriteIds.includes(id));
      return { removed: id };
    });
  }

  async savePlan(input) {
    const parameters = input?.parameters;
    if (parameters !== undefined && !object(parameters)) throw invalid("模型参数格式无效");
    return this.transact(async state => {
      const models = parameters ? await this.runner.models() : [];
      if (!input || typeof input !== "object") throw invalid("计划格式无效");
      const prior = input.id ? state.plans.find(plan => plan.id === input.id) : null;
      if (input.id && !prior) throw invalid("计划不存在", 404);
      const value = { ...planDefaults(), ...prior, ...input };
      const favoriteIds = idsOf(value.favoriteIds), kinds = kindsOf(value.kinds);
      if (favoriteIds.length !== 1) throw invalid("每个计划只能设置一个模型");
      if (kinds.length !== 1) throw invalid("每个计划只能设置一种测试");
      if (!["candy", "pelican"].includes(kinds[0])) throw invalid("自动计划只支持糖果和动画测试");
      if (state.plans.some(p => p.id !== prior?.id && p.favoriteIds[0] === favoriteIds[0] && p.kinds[0] === kinds[0])) throw invalid("这个模型的同类计划已存在，请编辑原计划", 409);
      if (prior && (prior.favoriteIds[0] !== favoriteIds[0] || prior.kinds[0] !== kinds[0])) throw invalid("不能更改计划所属的模型或测试类型");
      if (favoriteIds.some(id => !state.favorites.some(f => f.id === id))) throw invalid("计划包含已取消的收藏");
      validateSchedule(value);
      if (parameters) {
        const favorite = state.favorites.find(f => f.id === favoriteIds[0]), model = models.find(model => model.id === favorite.modelId);
        if (!model) throw invalid("收藏模型已不可用，请刷新模型目录");
        const patch = Object.fromEntries(["effort", "maxTokens", "timeoutMs", "prompt"].filter(key => Object.hasOwn(parameters, key)).map(key => [key, parameters[key]]));
        this.applyFavorite(state, { ...patch, id: favorite.id, modelId: favorite.modelId }, model);
      }
      const plan = { id: prior?.id || randomUUID(), revision: (prior?.revision || 0) + 1, name: value.name.trim(), favoriteIds, kinds,
        mode: value.mode, times: [...new Set(value.times)].sort(), intervalMinutes: value.intervalMinutes, start: value.start, end: value.end,
        allDay: value.allDay, days: [...new Set(value.days)].sort(), timeZone: value.timeZone, enabled: value.enabled };
      if(prior?.resumeAfter)plan.resumeAfter=prior.enabled===false&&plan.enabled?new Date().toISOString():prior.resumeAfter;
      dailyTimes(plan);
      // Pausing preserves today's slot/result identity; editing the schedule creates a new revision.
      if (prior && JSON.stringify({ ...prior, enabled: false, revision: 0 }) === JSON.stringify({ ...plan, enabled: false, revision: 0 })) plan.revision = prior.revision;
      if (prior) state.plans[state.plans.indexOf(prior)] = plan; else state.plans.push(plan);
      return plan;
    });
  }

  removePlan({ id }) { return this.transact(state => { if (!state.plans.some(p => p.id === id)) throw invalid("计划不存在", 404); state.plans = state.plans.filter(p => p.id !== id); return { removed: id }; }); }
  settings(input) { return this.transact(state => {
    if (input.enabled !== undefined) { if (typeof input.enabled !== "boolean") throw invalid("自动开关无效"); if(!state.enabled&&input.enabled)for(const plan of state.plans)if(plan.resumeAfter)plan.resumeAfter=new Date().toISOString();state.enabled = input.enabled; }
    if (input.concurrency !== undefined) state.concurrency = concurrencyLimit(input.concurrency, "自动并行数");
    return { enabled: state.enabled, concurrency: state.concurrency };
  }); }

  eligible(run) {
    return this.state.enabled && Date.parse(run.expiresAt) > Date.now() && this.state.favorites.some(f => f.id === run.favoriteId) &&
      run.plans?.some(ref => Date.parse(ref.expiresAt || run.expiresAt) > Date.now() && this.state.plans.some(p => p.id === ref.id && p.revision === ref.revision && p.enabled && (!p.resumeAfter || Date.parse(run.scheduledAt)>Date.parse(p.resumeAfter)) && p.favoriteIds.includes(run.favoriteId) && p.kinds.includes(run.kind)));
  }

  run(input, context = {}) {
    const task = this.dispatches.catch(() => {}).then(() => this.dispatch(input, context)); this.dispatches = task; return task;
  }

  async dispatch(input, context) {
    if (this.closed) throw invalid("服务正在关闭", 503);
    if (this.recoveryError) throw invalid(this.recoveryError, 503);
    const ids = idsOf(input?.ids), kinds = kindsOf(input?.kinds), state = this.state;
    const favorites = ids.map(id => state.favorites.find(f => f.id === id));
    if (favorites.some(f => !f)) throw invalid("所选收藏不存在，请刷新");
    if (input.continueRound && (context.source === "automatic" || !UUID.test(input.continueRound) || ![...this.runner.runs.values()].some(run => run.roundId === input.continueRound && run.source === "manual"))) throw invalid("关联轮次已失效，请重新开始");
    const roundId = context.roundId || input.continueRound || randomUUID(), result = { roundId, runs: [], linked: [], errors: [] }, groups = new Map();
    const catalog = await this.runner.models();
    for (const favorite of favorites) for (const kind of kinds) {
      if (!catalog.some(m => m.id === favorite.modelId && (!favorite.effort || m.efforts.includes(favorite.effort)))) { result.errors.push({ favoriteId: favorite.id, kind, error: "模型或思考档位已不可用" }); continue; }
      const target = readFavoriteTarget(favorite, kind);
      const params = { kind, maxTokens: favorite.maxTokens, timeoutMs: favorite.timeoutMs, concurrency: favorite.concurrency[kind], ...(kind === "pelican" ? { prompt: favorite.prompt } : kind === "fingerprint" ? { api: favorite.fingerprint.api, strict: favorite.fingerprint.strict, serviceTier: favorite.fingerprint.serviceTier } : {}) };
      const key = JSON.stringify(params);
      if (!groups.has(key)) groups.set(key, { request: { ...params, targets: [] }, members: {} });
      const group = groups.get(key);
      if (group.members[target.targetKey]) throw invalid('两个收藏在此测试中解析为重复账号目标，请调整旧指纹绑定');
      group.request.targets.push({ modelId: favorite.modelId, effort: favorite.effort, account: target.account });
      group.members[target.targetKey] = { favoriteId: favorite.id, compareKey: comparisonKey(favorite, kind) };
    }
    for (const { request, members } of groups.values()) {
      try {
        const runs = await this.runner.submit(request, { ...context, source: context.source || "manual", roundId, members });
        for (const run of runs) (run.linked ? result.linked : result.runs).push(run);
      } catch (error) { result.errors.push({ kind: request.kind, error: safeError(error) }); }
    }
    if (result.runs.length) await this.transact(next => {
      for (const favorite of next.favorites) if (result.runs.some(run => run.favoriteId === favorite.id)) favorite.lastRunAt = new Date().toISOString();
    });
    return result;
  }

  claim(occurrences, at) {
    return this.transact(state => {
      const cutoff = Date.parse(at) - 8 * 86400000; state.claims = state.claims.filter(claim => Date.parse(claim.at) >= cutoff);
      const fresh = occurrences.filter(item => !state.claims.some(claim => claim.key === item.key) && state.enabled && state.plans.some(p => p.id === item.plan.id && p.revision === item.plan.revision && p.enabled));
      state.claims.push(...fresh.map(item => ({ key: item.key, at })));
      return fresh;
    });
  }
  setClaimOutcome(refs, outcome) {
    return this.transact(state => {
      const keys = new Set(refs.map(ref => ref.triggerKey));
      for (const claim of state.claims) if (keys.has(claim.key)) Object.assign(claim, outcome);
    });
  }
  async close() { this.closed = true; await this.dispatches.catch(() => {}); await this.pending.catch(() => {}); }
}
