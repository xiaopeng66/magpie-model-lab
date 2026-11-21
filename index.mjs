import { join } from "node:path";
import { startServer } from "./lib/server.mjs";

let service;
export default {
  id: "magpie-pelican-bench",
  server: async (input, options) => {
    if (!service) {
      const port = Number(options?.port || 3489);
      const config = input.directory || input.worktree;
      const pending = startServer({ port, bankSource: options?.bankSource, ...(config ? { dataDir: join(config, "magpie-pelican-bench", "runs") } : {}) });
      service = pending;
      try {
        const current = await pending;
        current.ready.then((p) => { if (p) console.log(`[pelican-bench] ready on 127.0.0.1:${p}`); }).catch(async (error) => {
          console.error(`[pelican-bench] ${error.message}`);
          await current.close().catch(error => console.error(`[pelican-bench] ${error.message}`));
          if (service === pending) service = undefined;
        });
      } catch (error) { if (service === pending) service = undefined; throw error; }
    }
    await service;
    return {};
  },
};
