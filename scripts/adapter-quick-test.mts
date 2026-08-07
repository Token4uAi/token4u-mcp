import { startOpenAIAdapter } from "../src/adapter/openai-server.js";
const s = await startOpenAIAdapter(8799);
console.log("ADAPTER STARTED, port:", (s.address() as any).port);
const r = await fetch("http://localhost:8799/v1/models");
console.log("GET /v1/models status:", r.status);
setTimeout(() => { s.close(); process.exit(0); }, 3000);
