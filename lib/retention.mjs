import { randomBytes, createHash } from "node:crypto";
import { readdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { invalid } from "./gateway.mjs";

export function retentionCandidates(runs, { days, now = Date.now(), isBusy = () => false, isProtected = () => false }) {
  if (!(days === null || Number.isInteger(days) && days >= 1 && days <= 36500)) throw invalid("保留天数需为 1–36500 的整数，或永久保留");
  const result = { candidateIds: [], skippedActive: 0, skippedProtected: 0, invalidTimes: 0 };
  if (days === null) return result;
  const cutoff = now - days * 86400000;
  for (const run of runs) {
    if (["queued", "running"].includes(run.status) || isBusy(run.id)) { result.skippedActive++; continue; }
    const at = Date.parse(run.finishedAt || run.createdAt);
    if (!Number.isFinite(at)) { result.invalidTimes++; continue; }
    if (!(at < cutoff)) continue;
    if (isProtected(run.id)) { result.skippedProtected++; continue; }
    result.candidateIds.push(run.id);
  }
  return result;
}
const digest = context => createHash("sha256").update(JSON.stringify({ days: context.days, previewAt: context.previewAt, settingsRevision: context.settingsRevision,
  annotationsRevision: context.annotationsRevision, ids: [...context.candidateIds].sort() })).digest("hex");
export class RetentionPreviews {
  constructor({ now = Date.now, ttlMs = 300000 } = {}) { this.now = now; this.ttlMs = ttlMs; this.tokens = new Map(); }
  discardExpired() { for (const [token, item] of this.tokens) if (this.now() >= item.expiresAt) this.tokens.delete(token); }
  issue(context) {
    this.discardExpired(); if (this.tokens.size >= 100) throw invalid("待确认的保留预览过多，请稍后重试", 409);
    const previewToken = randomBytes(32).toString("hex"), expiresAt = this.now() + this.ttlMs;
    this.tokens.set(previewToken, { context: structuredClone(context), digest: digest(context), expiresAt });
    return { previewToken, expiresAt: new Date(expiresAt).toISOString() };
  }
  context(token) { this.discardExpired(); const value = this.tokens.get(token); if (!value) throw invalid("保留预览已过期、已使用或服务已重启，请重新预览", 409); return structuredClone(value.context); }
  verify(token, context) { this.context(token); if (this.tokens.get(token).digest !== digest(context)) throw invalid("保护、设置或预览候选已变化，请重新预览", 409); }
  consume(token) { if (!this.tokens.delete(token)) throw invalid("保留预览已使用", 409); }
}

export async function measureRunFiles(store, ids, { concurrency = 8, deadlineMs = 2000, readDirectory = readdir, stat = lstat } = {}) {
  let cursor = 0, total = 0, partial = false, stopped = false, timer;
  const scan = async () => {
    while (!stopped && cursor < ids.length) {
      const path = store.path(ids[cursor++]);
      try {
        const root = await stat(path); if (stopped) return;
        if (!root.isDirectory() || root.isSymbolicLink()) { partial = true; continue; }
        const names = await readDirectory(path);
        for (const name of names) {
          if (stopped) return;
          const value = await stat(join(path, typeof name === "string" ? name : name.name)); if (stopped) return;
          if (value.isFile() && !value.isSymbolicLink()) total += value.size; else partial = true;
        }
      } catch { if (!stopped) partial = true; }
    }
  };
  try {
    await Promise.race([Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, scan)), new Promise(resolve => { timer = setTimeout(() => { partial = true; stopped = true; resolve(); }, deadlineMs); })]);
    return { measuredFileBytes: total, partial, measuredAt: new Date().toISOString() };
  } finally { stopped = true; clearTimeout(timer); }
}
