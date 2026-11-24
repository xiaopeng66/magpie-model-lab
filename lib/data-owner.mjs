import { mkdir, lstat, open, readFile, unlink, rmdir } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { randomUUID } from "node:crypto";

const unavailable = message => Object.assign(new Error(message), { status: 503 });
async function plainDirectory(path, allowMissing = false) {
  for (let at = path; ; at = dirname(at)) {
    try {
      const stat = await lstat(at);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable("保存路径包含非普通目录，无法取得写入所有权");
    } catch (error) { if (!allowMissing || error.code !== "ENOENT") throw error; }
    if (dirname(at) === at) return;
  }
}
export async function acquireDataOwner(dataDir) {
  const root = resolve(dataDir); await plainDirectory(root, true); await mkdir(root, { recursive: true }); await plainDirectory(root);
  const dir = join(root, ".data-owner"), path = join(dir, "owner.json"), token = randomUUID();
  try { await mkdir(dir); }
  catch (error) {
    if (error.code === "EEXIST") throw unavailable("结果目录已有写入所有者或异常退出残留；请先停止插件并备份，核实无写者后离线处理 .data-owner");
    throw error;
  }
  let created = false;
  try {
    const file = await open(path, "wx", 0o600); created = true;
    try { await file.writeFile(JSON.stringify({ token, pid: process.pid, startedAt: new Date().toISOString() })); await file.sync(); }
    finally { await file.close(); }
  } catch (error) {
    if (created) await unlink(path).catch(() => {});
    await rmdir(dir).catch(() => {}); throw error;
  }
  let released = false;
  return { async release() {
    if (released) return;
    let stat;
    try { stat = await lstat(dir); } catch (error) { if (error.code === "ENOENT") { released = true; return; } throw error; }
    await plainDirectory(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable("写入所有权目录已改变，保留现场");
    const ownerStat = await lstat(path);
    if (!ownerStat.isFile() || ownerStat.isSymbolicLink() || ownerStat.size > 4096) throw unavailable("写入所有权文件已改变，保留现场");
    if (JSON.parse(await readFile(path, "utf8")).token !== token) throw unavailable("写入所有权 token 已改变，保留现场");
    await unlink(path); await rmdir(dir); released = true;
  } };
}
