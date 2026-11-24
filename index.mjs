import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

let service;
export default {
  id: "magpie-pelican-bench",
  server: async (input, options) => {
    if (!service) {
      const port = Number(options?.port || 3489);
      const config = input.directory || input.worktree;
      const args = [fileURLToPath(new URL("./serve.mjs", import.meta.url)), "--port", String(port), "--parent-stdin"];
      if (config) args.push("--data-dir", join(config, "magpie-pelican-bench", "runs"));
      if (options?.bankSource) args.push("--bank-source", options.bankSource);
      // Magpie exits its host on stdin EOF without calling a plugin disposal hook.
      // A private pipe lets this service drain accepted writes before releasing its data directory.
      const child = spawn(process.execPath, args, { stdio: ["pipe", "pipe", "inherit"], detached: true, windowsHide: true });
      const drain = () => child.stdin.end();
      // The host may wait on other plugins' RPCs after EOF; our service must already be closing then.
      process.stdin.once("end", drain);
      if (process.stdin.readableEnded) drain();
      child.once("close", () => process.stdin.removeListener("end", drain));
      // Windows Magpie sweeps its entire job when the host exits; keep it alive until this child has drained.
      const hostExit = process.exit;
      let requestedExit;
      const exitAfterDrain = code => {
        requestedExit ||= { code: code ?? process.exitCode };
        drain();
        if (child.exitCode !== null || child.signalCode !== null) hostExit.call(process, requestedExit.code);
      };
      if (process.platform === "win32") {
        process.exit = exitAfterDrain;
        child.once("close", () => {
          if (process.exit === exitAfterDrain) process.exit = hostExit;
          if (requestedExit) hostExit.call(process, requestedExit.code);
        });
      }
      const pending = new Promise((resolve, reject) => {
        let buffer = "";
        const timeout = setTimeout(() => { child.stdin.end(); reject(new Error("模型实验室后台启动未确认")); }, 20000);
        child.once("error", error => { clearTimeout(timeout); reject(error); });
        child.once("exit", code => { clearTimeout(timeout); reject(new Error(`模型实验室后台已退出（${code}）`)); });
        child.stdout.on("data", bytes => {
          buffer += bytes.toString("utf8");
          let end;
          while ((end = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
            if (/^Model Lab http:\/\/127\.0\.0\.1:\d+\/$/.test(line)) { clearTimeout(timeout); console.log(`[pelican-bench] ready on 127.0.0.1:${port}`); resolve(child); }
          }
          buffer = buffer.slice(-16384);
        });
      });
      service = pending;
      child.once("exit", () => { if (service === pending) service = undefined; });
      try {
        await pending;
      } catch (error) { child.stdin.end(); if (service === pending) service = undefined; throw error; }
    }
    await service;
    return {};
  },
};
