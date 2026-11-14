import { parseArgs } from "node:util";
import { startServer } from "./lib/server.mjs";

const { values } = parseArgs({ options: {
  port: { type: "string", default: "3489" }, "data-dir": { type: "string" }, gateway: { type: "string" }, "bank-source": { type: "string" },
} });
const service = await startServer({ port: Number(values.port), dataDir: values["data-dir"], gatewayUrl: values.gateway, bankSource: values["bank-source"] });
const port = await service.ready;
if (port) console.log(`Model Lab http://127.0.0.1:${port}/\nResults: ${service.dataDir}`);
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, async () => { await service.close(); process.exit(0); });
