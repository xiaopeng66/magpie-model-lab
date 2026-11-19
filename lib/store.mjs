import { mkdir, readdir, readFile, open, rename, lstat, realpath, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { invalid } from "./gateway.mjs";
import { summary } from "./result.mjs";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const ACTIVE = new Set(["queued", "running"]);
const STATUSES = new Set([...ACTIVE, "completed", "invalid", "truncated", "cancelled", "error", "interrupted"]);
const object = value => value && typeof value === "object" && !Array.isArray(value);
const optionalStrings = (value, keys) => keys.every(key => value[key] == null || typeof value[key] === "string");

function validDisplayMetadata(run) {
  if (!optionalStrings(run, ["model", "modelName", "provider", "providerName", "effort", "source", "prompt", "promptHash", "compareKey", "api", "requestedApi", "account", "serviceTier"])) return false;
  if (run.favoriteId != null && (typeof run.favoriteId !== "string" || !UUID.test(run.favoriteId))) return false;
  if (run.plans != null && (!Array.isArray(run.plans) || run.plans.some(plan => !object(plan) || typeof plan.id !== "string" || !UUID.test(plan.id) ||
      !optionalStrings(plan, ["name", "triggerKey", "expiresAt"]) || (plan.revision != null && (!Number.isSafeInteger(plan.revision) || plan.revision < 1))))) return false;
  if (run.candy != null && (!object(run.candy) || !["match", "mismatch", "review", "incomplete"].includes(run.candy.verdict) ||
      (run.candy.answer != null && !Number.isFinite(run.candy.answer)) || !optionalStrings(run.candy, ["version"]))) return false;
  if (run.files != null && (!object(run.files) || Object.values(run.files).some(path => typeof path !== "string"))) return false;
  if (run.analysis != null) {
    if (!object(run.analysis) || !optionalStrings(run.analysis, ["decision", "family_prediction_name"]) || (run.analysis.probability != null && !Number.isFinite(run.analysis.probability))) return false;
    if (run.analysis.results != null && (!Array.isArray(run.analysis.results) || run.analysis.results.some(item => !object(item) ||
        !optionalStrings(item, ["model", "display_name"]) || ["probability", "score"].some(key => item[key] != null && !Number.isFinite(item[key]))))) return false;
  }
  return true;
}

export class RunStore {
  constructor(dataDir) {
    this.dir = resolve(dataDir);
    this.records = new Map();
    this.pending = new Map();
  }

  path(id) {
    if (!UUID.test(id)) throw invalid("运行 ID 无效");
    return join(this.dir, id);
  }

  async init() {
    await mkdir(this.dir, { recursive: true });
    const root = await lstat(this.dir);
    if (!root.isDirectory() || root.isSymbolicLink()) throw invalid("保存目录不是普通目录");
    let interrupted = 0, unreadable = 0;
    for (const entry of await readdir(this.dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
      try {
        const path = join(this.path(entry.name), "run.json");
        const stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024) throw new Error("Invalid saved run");
        let run = JSON.parse(await readFile(path, "utf8"));
        if (!run || run.id !== entry.name || !STATUSES.has(run.status) || typeof run.createdAt !== "string" || !Number.isFinite(Date.parse(run.createdAt)) ||
            ["batchId", "roundId"].some(key => run[key] != null && (typeof run[key] !== "string" || !UUID.test(run[key]))) || (run.kind != null && !["pelican", "fingerprint", "candy"].includes(run.kind)) ||
            ["content", "reasoning", "html", "error"].some(key => run[key] != null && typeof run[key] !== "string") || !validDisplayMetadata(run)) throw new Error("Invalid saved run");
        if (run.kind === "fingerprint" && (!Array.isArray(run.samples) || run.samples.length !== 3 || !Array.isArray(run.challenges) || run.challenges.length !== 3 ||
            run.samples.some(sample => !sample || typeof sample.raw_text !== "string" || typeof sample.text !== "string" || !["queued", "waiting", "streaming", "complete", "truncated", "failed", "cancelled"].includes(sample.state)))) throw new Error("Invalid fingerprint samples");
        if (ACTIVE.has(run.status)) {
          run.status = "interrupted"; run.error = "服务重新启动，上次测试已中断；已有输出已保留";
          if (run.kind === "fingerprint") { run.analysis = null; for (const sample of run.samples) if (["queued", "waiting", "streaming"].includes(sample.state)) { sample.state = "cancelled"; sample.error = "服务重新启动，采样已中断"; } }
          run.finishedAt = new Date().toISOString();
          run = await this.save(run);
          interrupted++;
        }
        else if (run.status === "completed" && run.html && !/^[a-f0-9]{64}$/.test(run.previewKey || "")) {
          run.previewKey = randomBytes(32).toString("hex");
          await this.atomic(path, JSON.stringify(run, null, 2));
        }
        this.records.set(run.id, run);
      } catch { unreadable++; }
    }
    this.unreadable = unreadable;
    return { interrupted, unreadable };
  }

  async atomic(path, text) {
    const temp = `${path}.${randomUUID()}.tmp`;
    const file = await open(temp, "wx", 0o600);
    try {
      try { await file.writeFile(text, "utf8"); } finally { await file.close(); }
      await rename(temp, path);
    } finally { await rm(temp, { force: true }).catch(() => {}); }
  }

  async save(run) {
    const dir = this.path(run.id);
    const snapshot = structuredClone(run);
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
      await this.atomic(snapshot.files.metadata, JSON.stringify(snapshot, null, 2));
      this.records.set(run.id, snapshot);
      return snapshot;
    });
    this.pending.set(run.id, task);
    try { return await task; }
    finally { if (this.pending.get(run.id) === task) this.pending.delete(run.id); }
  }

  async get(id) {
    this.path(id);
    await this.pending.get(id);
    return this.records.get(id) || null;
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
    });
    this.pending.set(id, task);
    try { await task; }
    finally { if (this.pending.get(id) === task) this.pending.delete(id); }
  }

  list() {
    return [...this.records.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(summary);
  }
}
