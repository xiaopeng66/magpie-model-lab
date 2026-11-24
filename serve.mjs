import { parseArgs } from "node:util";
import { startServer } from "./lib/server.mjs";

const { values } = parseArgs({ options: {
  port: { type: "string", default: "3489" }, "data-dir": { type: "string" }, gateway: { type: "string" }, "bank-source": { type: "string" },
  "parent-stdin": { type: "boolean", default: false },
} });
const pending = startServer({ port: Number(values.port), dataDir: values["data-dir"], gatewayUrl: values.gateway, bankSource: values["bank-source"] });
let closing;
const close = () => closing ||= pending.then(service => service.close()).then(() => process.exit(0), error => { console.error(error.message); process.exit(1); });
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, close);
if (values["parent-stdin"]) { process.stdin.once("end", close); process.stdin.resume(); }
const service = await pending;
const port = await service.ready;
if (port) console.log(`Model Lab http://127.0.0.1:${port}/\nResults: ${service.dataDir}`);
