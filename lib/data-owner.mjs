import { mkdir, lstat, open, readFile, unlink, rmdir, readdir, rename, realpath } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { createServer } from "node:net";

const unavailable = message => Object.assign(new Error(message), { status: 503 });
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const LEASE = "win32-pipe-v1";
async function plainDirectory(path, allowMissing = false) {
  for (let at = path; ; at = dirname(at)) {
    try {
      const stat = await lstat(at);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable("保存路径包含非普通目录，无法取得写入所有权");
    } catch (error) { if (!allowMissing || error.code !== "ENOENT") throw error; }
    if (dirname(at) === at) return;
  }
}

async function windowsLease(root) {
  // UNC shares need a cross-machine lock; retain the conservative disk-marker policy there.
  if (process.platform !== "win32" || root.startsWith("\\\\")) return null;
  const name = "\\\\.\\pipe\\magpie-model-lab-owner-" + createHash("sha256").update(root.toLowerCase()).digest("hex");
  const server = createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => {
    const failed = error => reject(error.code === "EADDRINUSE" ? unavailable("结果目录已有活动写入者；请关闭其他插件实例后重试") : error);
    server.once("error", failed);
    server.listen(name, () => { server.off("error", failed); server.unref(); resolve(); });
  });
  return { close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

async function inspectMarker(root, dir) {
  await plainDirectory(root);
  const stat = await lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable("写入所有权目录已改变，保留现场");
  const names = await readdir(dir);
  if (names.length !== 1 || names[0] !== "owner.json") throw unavailable("写入所有权标记不完整或含未知文件，保留现场；请离线核实后恢复");
  const path = join(dir, "owner.json"), ownerStat = await lstat(path);
  if (!ownerStat.isFile() || ownerStat.isSymbolicLink() || ownerStat.size > 4096) throw unavailable("写入所有权文件已改变，保留现场");
  const bytes = await readFile(path, "utf8");
  let owner;
  try { owner = JSON.parse(bytes); } catch { throw unavailable("写入所有权标记损坏，保留现场；请离线核实后恢复"); }
  if (!owner || typeof owner !== "object" || Array.isArray(owner)) throw unavailable("写入所有权标记无效，保留现场");
  return { owner, bytes };
}

async function recoverMarker(root, dir) {
  try { await lstat(dir); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  const before = await inspectMarker(root, dir), { owner } = before;
  if (typeof owner.token !== "string" || !UUID.test(owner.token) || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || owner.pid > 0xffffffff || typeof owner.startedAt !== "string" || !Number.isFinite(Date.parse(owner.startedAt)) || (owner.lease !== undefined && owner.lease !== LEASE)) {
    throw unavailable("无法确认旧写入所有权，保留现场；请离线核实后恢复");
  }
  if (owner.lease !== LEASE) {
    let dead = false;
    try { process.kill(owner.pid, 0); } catch (error) { dead = error.code === "ESRCH"; }
    if (!dead) throw unavailable("旧版写入进程仍在运行或无法核实，保留现场；请先正常关闭旧插件");
  }
  if ((await inspectMarker(root, dir)).bytes !== before.bytes) throw unavailable("写入所有权标记已改变，保留现场");
  await rename(dir, join(root, `.data-owner.stale-${randomUUID()}`));
}

async function writeMarker(dir, owner) {
  const path = join(dir, "owner.json");
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(owner)); await file.sync(); }
  finally { await file.close(); }
}

export async function acquireDataOwner(dataDir) {
  let root = resolve(dataDir); await plainDirectory(root, true); await mkdir(root, { recursive: true }); await plainDirectory(root);
  root = await realpath(root);
  const dir = join(root, ".data-owner"), path = join(dir, "owner.json"), token = randomUUID();
  const lease = await windowsLease(root);
  let created = false, staging;
  try {
    const owner = { token, pid: process.pid, startedAt: new Date().toISOString(), ...(lease ? { lease: LEASE } : {}) };
    if (lease) {
      await recoverMarker(root, dir);
      staging = join(root, `.data-owner.pending-${token}`);
      await mkdir(staging, { mode: 0o700 }); created = true;
      await writeMarker(staging, owner);
      // Publish a complete marker atomically; a crash cannot leave a half-created active marker.
      await rename(staging, dir); created = false;
    } else {
      try { await mkdir(dir); }
      catch (error) { if (error.code === "EEXIST") throw unavailable("结果目录已有写入所有者或异常退出残留；请先停止插件并备份，核实无写者后离线处理 .data-owner"); throw error; }
      created = true; await writeMarker(dir, owner); created = false;
    }
  } catch (error) {
    if (created) { const own = staging || dir; await unlink(join(own, "owner.json")).catch(() => {}); await rmdir(own).catch(() => {}); }
    await lease?.close(); throw error;
  }
  let released = false;
  return { async release() {
    if (released) return;
    try { await lstat(dir); } catch (error) { if (error.code === "ENOENT") { await lease?.close(); released = true; return; } throw error; }
    if ((await inspectMarker(root, dir)).owner.token !== token) throw unavailable("写入所有权 token 已改变，保留现场");
    if (lease) {
      const retired = join(root, `.data-owner.released-${token}`);
      // Remove the active name atomically too, so interrupted cleanup cannot strand an empty lock.
      await rename(dir, retired);
      try { await unlink(join(retired, "owner.json")); await rmdir(retired); }
      finally { await lease.close(); released = true; }
    } else { await unlink(path); await rmdir(dir); released = true; }
  } };
}
