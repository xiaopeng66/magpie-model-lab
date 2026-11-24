import fs, { mkdir, readdir, readFile, open, lstat, realpath, rm } from "node:fs/promises";
import { readFileSync, lstatSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { invalid } from "./gateway.mjs";
import { summary, SAVED_SUMMARY } from "./result.mjs";
import { validProgress, advanceProgress } from "./progress.mjs";
import { readRunTarget } from './targets.mjs';
import { validateTask } from './suites.mjs';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const ACTIVE = new Set(["queued", "running"]);
const STATUSES = new Set([...ACTIVE, "completed", "invalid", "truncated", "cancelled", "error", "interrupted"]);
const object = value => value && typeof value === "object" && !Array.isArray(value);
const optionalStrings = (value, keys) => keys.every(key => value[key] == null || typeof value[key] === "string");
const optionalTime = value => value == null || value === "" || typeof value === "string" && Number.isFinite(Date.parse(value));
function validPhysicalRequests(value) {
  return value == null || Array.isArray(value) && value.every(request => object(request) && ['reserved', 'started', 'released'].includes(request.state) &&
    (request.physicalRequestId == null || typeof request.physicalRequestId === 'string' && UUID.test(request.physicalRequestId)) &&
    (request.admissionPolicyHash == null || typeof request.admissionPolicyHash === 'string' && request.admissionPolicyHash.length > 0 && request.admissionPolicyHash.length <= 256) &&
    (request.sampleIndex == null || Number.isInteger(request.sampleIndex) && request.sampleIndex >= 0 && request.sampleIndex < 3) && optionalTime(request.startedAt));
}

function validDisplayMetadata(run) {
  if (!validPhysicalRequests(run.physicalRequests)) return false;
  if (run.task != null) { try { validateTask(run.task); if (run.kind !== 'candy' || run.prompt !== run.task.prompt) return false; } catch { return false; } }
  if (run.grade != null && (!object(run.grade) || !['match', 'mismatch', 'review', 'incomplete'].includes(run.grade.verdict) || ![run.grade.answer, run.grade.expected].every(value => value == null || Number.isFinite(value) || typeof value === 'string' && value.length <= 40))) return false;
  if (run.experimentId != null && (!UUID.test(run.experimentId) || run.experimentId !== run.batchId || !Number.isSafeInteger(run.repetitionIndex) || run.repetitionIndex < 0 || !Number.isSafeInteger(run.executionIndex) || run.executionIndex < 0)) return false;
  if (run.accountTarget != null || run.targetKey != null) {
    try {
      const target = readRunTarget(run);
      if (run.kind === 'fingerprint' && (run.account || '') !== (target.account.id || '')) return false;
    } catch { return false; }
  }
  if (run.timeoutMs != null && (!Number.isSafeInteger(run.timeoutMs) || run.timeoutMs < 0 || run.timeoutMs > 2147483647)) return false;
  if (run.samples != null && (!Array.isArray(run.samples) || run.samples.some(sample => !object(sample) || !optionalStrings(sample, ["raw_text", "text", "error"])))) return false;
  if (!["scheduledAt", "startedAt", "finishedAt", "expiresAt"].every(key => optionalTime(run[key]))) return false;
  if (!optionalStrings(run, ["model", "modelName", "provider", "providerName", "effort", "source", "prompt", "promptHash", "compareKey", "api", "requestedApi", "account", "serviceTier"])) return false;
  if (run.favoriteId != null && (typeof run.favoriteId !== "string" || !UUID.test(run.favoriteId))) return false;
  if (run.plans != null && (!Array.isArray(run.plans) || run.plans.some(plan => !object(plan) || typeof plan.id !== "string" || !UUID.test(plan.id) ||
      !optionalStrings(plan, ["name", "triggerKey", "expiresAt"]) || !optionalTime(plan.expiresAt) || (plan.revision != null && (!Number.isSafeInteger(plan.revision) || plan.revision < 1))))) return false;
  if (run.candy != null && (!object(run.candy) || !["match", "mismatch", "review", "incomplete"].includes(run.candy.verdict) ||
      (run.candy.answer != null && !Number.isFinite(run.candy.answer)) || !optionalStrings(run.candy, ["version"]))) return false;
  if (run.retest != null && (!object(run.retest) || ["sourceRunId", "sourceBatchId", "operationId"].some(key => typeof run.retest[key] !== "string" || !UUID.test(run.retest[key])) ||
      !["manual", "automatic"].includes(run.retest.sourceMode) || typeof run.retest.sourceTime !== "string" || !Number.isFinite(Date.parse(run.retest.sourceTime)) ||
      !/^[a-f0-9]{64}$/.test(run.retest.selectionHash || ""))) return false;
  if (run.files != null && (!object(run.files) || Object.values(run.files).some(path => typeof path !== "string"))) return false;
  if (run.analysis != null) {
    if (!object(run.analysis) || !optionalStrings(run.analysis, ["decision", "family_prediction_name"]) || (run.analysis.probability != null && !Number.isFinite(run.analysis.probability))) return false;
    if (run.analysis.results != null && (!Array.isArray(run.analysis.results) || run.analysis.results.some(item => !object(item) ||
        !optionalStrings(item, ["model", "display_name"]) || ["probability", "score"].some(key => item[key] != null && !Number.isFinite(item[key]))))) return false;
  }
  return true;
}

function validRecord(run, id) {
  return run && run.id === id && STATUSES.has(run.status) && typeof run.createdAt === "string" && Number.isFinite(Date.parse(run.createdAt)) &&
    ["batchId", "roundId"].every(key => run[key] == null || typeof run[key] === "string" && UUID.test(run[key])) && (run.kind == null || ["pelican", "fingerprint", "candy"].includes(run.kind)) &&
    ["content", "reasoning", "html", "error"].every(key => run[key] == null || typeof run[key] === "string") && validDisplayMetadata(run) &&
    (run.kind !== "fingerprint" || Array.isArray(run.samples) && run.samples.length === 3 && Array.isArray(run.challenges) && run.challenges.length === 3 &&
      run.samples.every(sample => sample && typeof sample.raw_text === "string" && typeof sample.text === "string" && ["queued", "waiting", "streaming", "complete", "truncated", "failed", "cancelled"].includes(sample.state)));
}

function indexRecord(run) {
  if (ACTIVE.has(run.status)) return run;
  const { content, reasoning, html, payload, samples, ...meta } = run;
  return { ...meta, ...(samples ? { samples: samples.map(({ text, raw_text, ...sample }) => sample) } : {}),
    hasHTML: Boolean(html), contentChars: content?.length || 0, reasoningChars: reasoning?.length || 0, [SAVED_SUMMARY]: summary(run) };
}

function parseRecord(text, id) {
  let run; try { run = JSON.parse(text); } catch { throw invalid('保存记录不是有效的 JSON', 502); }
  if (!validRecord(run, id)) throw invalid("保存记录无效，无法读取", 502);
  sanitizeProgress(run);
  return run;
}

function sanitizeProgress(run, strict = false) {
  for (const target of [run, ...(run.samples || [])]) {
    delete target.runtimeTiming;
    if (target.progress !== undefined && !validProgress(target.progress)) {
      if (strict) throw invalid("新写入的运行进度格式无效");
      delete target.progress; target.progressWarning = "运行进度格式不可用，已降级明细；原始结果仍可读取";
    }
    if (target !== run && !["startedAt", "finishedAt"].every(key => optionalTime(target[key]))) {
      if (strict) throw invalid("采样进度时间无效");
      delete target.startedAt; delete target.finishedAt; target.progressWarning = "采样进度时间不可用，已降级明细";
    }
  }
}

function regularFile(stat) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024) throw invalid("保存记录不是有效的普通文件", 502);
}

export class RunStore {
  constructor(dataDir) {
    this.dir = resolve(dataDir);
    this.records = new Map();
    this.pending = new Map();
    this.sizes = new Map();
  }

  path(id) {
    if (!UUID.test(id)) throw invalid("运行 ID 无效");
    return join(this.dir, id);
  }

  async init() {
    await mkdir(this.dir, { recursive: true });
    const root = await lstat(this.dir);
    if (!root.isDirectory() || root.isSymbolicLink()) throw invalid("保存目录不是普通目录");
    let interrupted = 0, unreadable = 0, progressWarnings = 0;
    for (const entry of await readdir(this.dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
      try {
        const path = join(this.path(entry.name), "run.json");
        const stat = await lstat(path);
        regularFile(stat);
        let run = parseRecord(await readFile(path, "utf8"), entry.name);
        if (run.progressWarning || run.samples?.some(sample => sample.progressWarning)) progressWarnings++;
        if (ACTIVE.has(run.status)) {
          run.status = "interrupted"; run.error = "服务重新启动，上次测试已中断；已有输出已保留";
          run.finishedAt = new Date().toISOString();
          if (run.progress) run.progress = advanceProgress(run.progress, "end", { at: run.finishedAt });
          if (run.kind === "fingerprint") { run.analysis = null; for (const sample of run.samples) {
            if (["queued", "waiting", "streaming"].includes(sample.state)) { sample.state = "cancelled"; sample.error = "服务重新启动，采样已中断"; }
            if (sample.progress && sample.progress.phase !== "ended") { sample.progress = advanceProgress(sample.progress, "end", { at: run.finishedAt }); sample.finishedAt = run.finishedAt; }
          } }
          run = await this.save(run);
          interrupted++;
        }
        else if (run.status === "completed" && run.html && !/^[a-f0-9]{64}$/.test(run.previewKey || "")) {
          run.previewKey = randomBytes(32).toString("hex");
          await this.atomic(path, JSON.stringify(run, null, 2));
        }
        this.records.set(run.id, indexRecord(run));
        this.sizes.set(run.id, (await lstat(path)).size);
      } catch { unreadable++; }
    }
    this.unreadable = unreadable; this.progressWarnings = progressWarnings;
    return { interrupted, unreadable, ...(progressWarnings ? { progressWarnings } : {}) };
  }

  async atomic(path, text) {
    const temp = `${path}.${randomUUID()}.tmp`;
    const file = await open(temp, "wx", 0o600);
    try {
      try { await file.writeFile(text, "utf8"); } finally { await file.close(); }
      // Windows can briefly reject replacing a just-written file; keep the original until rename succeeds.
      for (let attempt = 0; ; attempt++) {
        try { await fs.rename(temp, path); break; }
        catch (error) {
          if (process.platform !== "win32" || error.code !== "EPERM" || attempt === 5) throw error;
          await delay(50);
        }
      }
    } finally { await rm(temp, { force: true }).catch(() => {}); }
  }

  async save(run) {
    const dir = this.path(run.id);
    const snapshot = structuredClone(run);
    if (!validPhysicalRequests(snapshot.physicalRequests) || (snapshot.accountTarget != null || snapshot.targetKey != null) && !validDisplayMetadata(snapshot)) throw invalid('运行账号目标或元数据无效');
    sanitizeProgress(snapshot, true);
    if (snapshot.status === "completed" && snapshot.html) {
      if (!/^[a-f0-9]{64}$/.test(snapshot.previewKey || "")) snapshot.previewKey = randomBytes(32).toString("hex");
    } else delete snapshot.previewKey;
    snapshot.files = { metadata: join(dir, "run.json"), response: join(dir, "response.txt"),
      ...(run.kind === "fingerprint" ? { samples: join(dir, "samples.json") } : {}),
      ...(run.reasoning ? { reasoning: join(dir, "reasoning.txt") } : {}),
      ...(run.html ? { html: join(dir, "result.html") } : {}) };
    const prior = this.pending.get(run.id) || Promise.resolve();
    const task = prior.catch(() => {}).then(async () => {
      const root = await lstat(this.dir);
      if (!root.isDirectory() || root.isSymbolicLink()) throw invalid("保存目录不是普通目录");
      await mkdir(dir, { recursive: true });
      const stat = await lstat(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalid("运行目录不是普通目录");
      await this.atomic(snapshot.files.response, snapshot.kind === "fingerprint" ? snapshot.samples.map((sample, index) => `--- 采样 ${index + 1} ---\n${sample.raw_text}`).join("\n\n") : snapshot.content || "");
      if (snapshot.files.samples) await this.atomic(snapshot.files.samples, JSON.stringify(snapshot.samples, null, 2));
      if (snapshot.reasoning) await this.atomic(snapshot.files.reasoning, snapshot.reasoning);
      if (snapshot.html) await this.atomic(snapshot.files.html, snapshot.html);
      const metadata = JSON.stringify(snapshot, null, 2);
      await this.atomic(snapshot.files.metadata, metadata);
      this.records.set(run.id, indexRecord(snapshot)); this.sizes.set(run.id, Buffer.byteLength(metadata));
      return snapshot;
    });
    this.pending.set(run.id, task);
    try { return await task; }
    finally { if (this.pending.get(run.id) === task) this.pending.delete(run.id); }
  }

  async get(id) {
    this.path(id);
    await this.pending.get(id);
    const run = this.records.get(id);
    if (!run?.[SAVED_SUMMARY]) return run || null;
    const dir = this.path(id), stat = await lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalid("保存记录目录无效", 502);
    const path = join(dir, "run.json"); regularFile(await lstat(path));
    return parseRecord(await readFile(path, "utf8"), id);
  }

  // Preserve the runner's synchronous in-process accessor; HTTP reads use get().
  getSync(id) {
    const run = this.records.get(id);
    if (!run?.[SAVED_SUMMARY]) return run || null;
    const dir = this.path(id), stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalid("保存记录目录无效", 502);
    const path = join(dir, "run.json"); regularFile(lstatSync(path));
    return parseRecord(readFileSync(path, "utf8"), id);
  }

  async remove(id) {
    const dir = this.path(id);
    const prior = this.pending.get(id) || Promise.resolve();
    const task = prior.catch(() => {}).then(async () => {
      try {
        const [rootStat, stat] = await Promise.all([lstat(this.dir), lstat(dir)]);
        if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !stat.isDirectory() || stat.isSymbolicLink()) {
          throw invalid("清理目录不是普通目录，已跳过");
        }
        const [root, target] = await Promise.all([realpath(this.dir), realpath(dir)]);
        const normalize = (path) => process.platform === "win32" ? path.toLowerCase() : path;
        // Verify the physical UUID directory is directly inside the configured output root before deletion.
        if (normalize(dirname(target)) !== normalize(root)) throw invalid("清理目标不在结果目录内，已跳过");
        await rm(target, { recursive: true, force: true });
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      this.records.delete(id);
      this.sizes.delete(id);
    });
    this.pending.set(id, task);
    try { await task; }
    finally { if (this.pending.get(id) === task) this.pending.delete(id); }
  }

  list() {
    return [...this.records.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(summary);
  }
}
