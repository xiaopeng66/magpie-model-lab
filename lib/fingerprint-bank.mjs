import { mkdir, lstat, readFile, writeFile, rename, rm } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import * as zlib from "node:zlib";
import { loadDetector, DEFAULT_DATA_URLS, decompress } from "../vendor/lmfpd-sdk/index.js";
import { boundedBytes, invalid, safeError } from "./gateway.mjs";

export const FINGERPRINT_SDK = "0.2.0";
const HEX = /^[a-f0-9]{64}$/;
const BANK_LIMIT = 8 * 1024 * 1024, COMPRESSED_LIMIT = 32 * 1024 * 1024, DETECTOR_LIMIT = 128 * 1024 * 1024;
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

async function localBytes(path, limit) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw invalid("参考库文件不是有效的普通文件", 502);
  return readFile(path);
}

function unpack(bytes) {
  if (bytes.length < 8) throw invalid("参考库缓存损坏", 502);
  const length = bytes.readUInt32LE(0);
  if (length > BANK_LIMIT || length + 4 >= bytes.length) throw invalid("参考库缓存长度无效", 502);
  const bundle = bytes.subarray(4, length + 4), detector = bytes.subarray(length + 4);
  const bank = JSON.parse(bundle.toString("utf8"));
  validate(bank, detector);
  return { bundle, detector, bank };
}

function validate(bank, detector) {
  if (bank?.schema !== "lmfpd-data-v1" || bank?.detector_schema !== "shared-detector-v2" || !Array.isArray(bank.models) || typeof bank.built_at !== "string") throw invalid("参考库格式与当前检测器不兼容", 502);
  const file = bank.files?.["shared_detector.bin"];
  if (!HEX.test(file?.sha256 || "") || (detector && digest(detector) !== file.sha256)) throw invalid("参考库文件哈希校验失败", 502);
}

function decode(bytes) {
  if (bytes.length < 6 || bytes.readUInt32LE(0) !== 0xfd2fb528) throw invalid("参考库压缩格式无效", 502);
  const flag = bytes[4], single = Boolean(flag & 32), field = flag >> 6, dict = flag & 3;
  let offset = single ? 5 : 6;
  if (!single) {
    const base = 2 ** (10 + (bytes[5] >> 3)), window = base + base / 8 * (bytes[5] & 7);
    if (window > DETECTOR_LIMIT) throw invalid("参考库解压窗口过大", 502);
  }
  offset += dict === 3 ? 4 : dict;
  const width = field ? 2 ** field : single ? 1 : 0;
  if (!width || offset + width > bytes.length) throw invalid("参考库压缩头未声明完整长度", 502);
  const size = width === 8 ? Number(bytes.readBigUInt64LE(offset)) : bytes.readUIntLE(offset, width) + (field === 1 ? 256 : 0);
  if (!Number.isSafeInteger(size) || size < 8 || size > DETECTOR_LIMIT) throw invalid("参考库检测器大小无效", 502);
  const output = typeof zlib.zstdDecompressSync === "function" ? zlib.zstdDecompressSync(bytes, { maxOutputLength: size }) : decompress(bytes, new Uint8Array(size));
  if (output.length !== size) throw invalid("参考库解压长度校验失败", 502);
  return Buffer.from(output);
}

export class FingerprintBank {
  constructor({ dir, source = DEFAULT_DATA_URLS } = {}) {
    this.dir = resolve(dir); this.source = source; this.current = null; this.loading = null;
    this.abort = new AbortController(); this.lastError = ""; this.initialized = false;
    this.local = typeof source === "string" && !/^https?:\/\//i.test(source);
  }

  status() { return { state: this.current ? "ready" : this.loading ? "loading" : "missing", updating: Boolean(this.loading), meta: this.current?.meta || null, local: this.local, error: this.lastError }; }

  async root() {
    await mkdir(this.dir, { recursive: true }); const stat = await lstat(this.dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalid("参考库保存目录不是普通目录");
  }

  async init() {
    if (this.initialized) return;
    await this.root(); this.initialized = true;
    try {
      const pointer = JSON.parse((await localBytes(join(this.dir, "current.json"), 65536)).toString("utf8"));
      if (!HEX.test(pointer.sha256 || "")) throw new Error("Invalid reference pointer");
      const bytes = await localBytes(join(this.dir, `${pointer.sha256}.bin`), BANK_LIMIT + DETECTOR_LIMIT + 4);
      if (digest(bytes) !== pointer.sha256) throw invalid("参考库快照哈希校验失败", 502);
      this.current = await this.install(bytes, false);
    } catch (error) { if (error.code !== "ENOENT") this.lastError = safeError(error); }
  }

  async install(bytes, persist = true) {
    await this.root(); const { bundle, detector, bank } = unpack(bytes);
    const stage = join(this.dir, `.stage-${randomUUID()}`);
    try {
      await mkdir(stage); await writeFile(join(stage, "unified_bank.json"), bundle, { mode: 0o600 });
      await writeFile(join(stage, "shared_detector.bin"), detector, { mode: 0o600 });
      const instance = await loadDetector({ source: stage });
      const meta = { sdkVersion: FINGERPRINT_SDK, builtAt: bank.built_at, modelCount: bank.models.length, sha256: digest(bytes), detectorSha256: digest(detector) };
      if (persist) {
        const target = join(this.dir, `${meta.sha256}.bin`);
        try {
          const existing = await localBytes(target, BANK_LIMIT + DETECTOR_LIMIT + 4);
          if (digest(existing) !== meta.sha256) throw invalid("已有参考快照损坏", 502);
        } catch (error) { if (error.code !== "ENOENT") throw error; await this.atomic(target, bytes); }
        await this.atomic(join(this.dir, "current.json"), JSON.stringify(meta));
      }
      return { detector: instance, meta };
    } finally {
      if (dirname(resolve(stage)) === this.dir) await rm(stage, { recursive: true, force: true });
    }
  }

  async atomic(path, bytes) {
    const temp = `${path}.${randomUUID()}.tmp`;
    try { await writeFile(temp, bytes, { mode: 0o600 }); await rename(temp, path); }
    finally { await rm(temp, { force: true }).catch(() => {}); }
  }

  async load() {
    await this.init(); if (this.current) return this.current;
    return this.refresh();
  }

  refresh() {
    if (this.loading) return this.loading;
    const task = this.download().then(value => { this.current = value; this.lastError = ""; return value; })
      .catch(error => { this.lastError = safeError(error); throw invalid(`参考库更新失败：${this.lastError}`, 502); })
      .finally(() => { if (this.loading === task) this.loading = null; });
    this.loading = task; return task;
  }

  async download() {
    await this.init(); this.abort.signal.throwIfAborted();
    if (this.local) {
      const source = resolve(this.source), stat = await lstat(source);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalid("本地参考库目录无效", 502);
      const bundle = await localBytes(join(source, "unified_bank.json"), BANK_LIMIT);
      const detector = await localBytes(join(source, "shared_detector.bin"), DETECTOR_LIMIT);
      return this.install(this.pack(bundle, detector));
    }
    const sources = Array.isArray(this.source) ? this.source : [this.source]; const failures = [];
    for (const value of sources) {
      try {
        const source = new URL(value);
        if (!["https:", "http:"].includes(source.protocol) || source.username || source.password || source.search || source.hash) throw invalid("参考库来源地址无效");
        if (!source.pathname.endsWith("/")) source.pathname += "/";
        const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(180000)]);
        const get = async (path, limit, timeout) => {
          const response = await fetch(new URL(path, source), { signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]), redirect: "error" });
          if (!response.ok) { await response.body?.cancel(); throw invalid(`参考库下载 HTTP ${response.status}`, 502); }
          return boundedBytes(response, limit);
        };
        const bundle = await get("bundle.json", BANK_LIMIT, 10000), bank = JSON.parse(bundle.toString("utf8")); validate(bank);
        const file = bank.files["shared_detector.bin"];
        if (!Array.isArray(file.parts) || !file.parts.length || file.parts.some(part => typeof part !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.zst$/.test(part) || part.includes(".."))) throw invalid("参考库分块路径无效", 502);
        let total = 0; const parts = [];
        for (const part of file.parts) { const bytes = await get(`chunks/${part}`, COMPRESSED_LIMIT - total, 120000); total += bytes.length; parts.push(bytes); }
        if (file.bytes != null && file.bytes !== total) throw invalid("参考库下载长度校验失败", 502);
        const detector = decode(Buffer.concat(parts, total));
        return await this.install(this.pack(bundle, detector));
      } catch (error) { if (this.abort.signal.aborted) throw error; failures.push(safeError(error)); }
    }
    throw invalid(failures.join("；") || "没有可用参考库来源", 502);
  }

  pack(bundle, detector) { const prefix = Buffer.alloc(4); prefix.writeUInt32LE(bundle.length); return Buffer.concat([prefix, bundle, detector]); }
  async close() { this.abort.abort(); await this.loading?.catch(() => {}); }
}
