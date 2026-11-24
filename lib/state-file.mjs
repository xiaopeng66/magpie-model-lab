import fs, { mkdir, lstat, readFile, open, unlink } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { invalid, safeError } from "./gateway.mjs";

export function parsePrivateJSON(bytes) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw invalid('本地文件不是有效的 UTF-8 JSON', 503); }
}

// RYP: the two small private state files share durable replacement, not RunStore's multi-file writes.
export class StateFile {
  constructor(dataDir, name, initial, validate, { maxBytes = 1024 * 1024, label } = {}) {
    this.root = resolve(dataDir); this.dir = join(this.root, name); this.path = join(this.dir, "state.json");
    this.data = initial; this.validate = validate; this.pending = Promise.resolve(); this.closed = false; this.recoveryError = "";
    this.maxBytes = maxBytes; this.label = label || (name === '.settings' ? '设置' : name === '.favorites' ? '收藏配置' : '记录保护');
  }
  async directory(path) {
    for (let current = path; ; current = dirname(current)) {
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalid("配置路径不是普通目录", 503);
      if (dirname(current) === current) return;
    }
  }
  async regular(path, allowMissing = false) {
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > this.maxBytes) throw invalid("配置不是允许大小内的普通文件", 503);
      return true;
    } catch (error) { if (allowMissing && error.code === "ENOENT") return false; throw error; }
  }
  async init() {
    try {
      await this.directory(this.root);
      let existed = true;
      try { await lstat(this.dir); } catch (error) { if (error.code !== "ENOENT") throw error; existed = false; }
      if (!existed) { await mkdir(this.dir); await this.replace(this.path, this.data); }
      await this.directory(this.dir); await this.regular(this.path);
      const value = parsePrivateJSON(await readFile(this.path)); this.validate(value); this.data = value;
    } catch (error) { this.pause(error); }
  }
  pause(error) { this.recoveryError = `本地${this.label}恢复失败，相关写入已暂停：${safeError(error)}；原文件已保留，请备份后离线恢复`; }
  snapshot() { return structuredClone(this.data); }
  enqueue(task) {
    if (this.closed || this.recoveryError) return Promise.reject(invalid(this.recoveryError || "配置正在关闭", 503));
    const accepted = this.pending.catch(() => {}).then(() => { if (this.recoveryError) throw invalid(this.recoveryError, 503); return task(); }); this.pending = accepted; return accepted;
  }
  async replace(path, value) {
    await this.directory(this.root); await this.directory(this.dir); await this.regular(path, true);
    const text = JSON.stringify(value, null, 2);
    if (Buffer.byteLength(text) > this.maxBytes) throw invalid(`本地${this.label}总大小超出 ${this.maxBytes / 1024 / 1024} MiB`, 413);
    const temp = join(this.dir, `state.${randomUUID()}.tmp`), file = await open(temp, "wx", 0o600);
    try {
      try { await file.writeFile(text, "utf8"); await file.sync(); } finally { await file.close(); }
      // RYP: apply the existing history-write retry window to Windows private-state replacement too.
      for (let attempt = 0; ; attempt++) {
        try { await this.regular(path, true); await fs.rename(temp, path); break; }
        catch (error) {
          if (process.platform !== 'win32' || error.code !== 'EPERM' || attempt === 5) throw error;
          await delay(50);
        }
      }
    } finally { await unlink(temp).catch(error => { if (error.code !== "ENOENT") console.error(`[model-lab] temporary state: ${safeError(error)}`); }); }
  }
  async commit(next) {
    this.validate(next);
    if (Buffer.byteLength(JSON.stringify(next, null, 2)) > this.maxBytes) throw invalid(`本地${this.label}总大小超出 ${this.maxBytes / 1024 / 1024} MiB`, 413);
    try {
      await this.regular(this.path);
      const disk = parsePrivateJSON(await readFile(this.path)); this.validate(disk);
      if (JSON.stringify(disk) !== JSON.stringify(this.data)) throw invalid("配置文件在服务外发生变化，请重启核对后再保存", 409);
      await this.replace(join(this.dir, "state.previous.json"), this.data);
      await this.replace(this.path, next); this.data = next;
    } catch (error) { this.pause(error); throw invalid(this.recoveryError, error.status || 503); }
  }
  async close() { this.closed = true; await this.pending.catch(() => {}); }
}
