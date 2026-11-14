import { join } from "node:path";
import { startServer } from "./lib/server.mjs";

let service;
export default {
  id: "magpie-pelican-bench",
  server: async (input, options) => {
    if (!service) {
      const port = Number(options?.port || 3489);
      const config = input.directory || input.worktree;
      service = startServer({ port, bankSource: options?.bankSource, ...(config ? { dataDir: join(config, "magpie-pelican-bench", "runs") } : {}) });
      const current = await service;
      current.ready.then((p) => { if (p) console.log(`[pelican-bench] ready on 127.0.0.1:${p}`); }).catch((error) => console.error(`[pelican-bench] ${error.message}`));
    }
    await service;
    return {};
  },
};
