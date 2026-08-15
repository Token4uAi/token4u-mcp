/**
 * token4u-mcp OpenAI-compatible adapter — standalone launcher.
 *
 * Usage:
 *   TOKEN4U_WALLET_KEY=<private-key> ADAPTER_PORT=8787 npx tsx scripts/start-adapter.ts
 *
 * Exposes /v1/models and /v1/chat/completions; every call is paid via x402
 * using the wallet from TOKEN4U_WALLET_KEY (or ~/.token4u-mcp/wallet.json).
 * Each call is appended to ~/.token4u-mcp/call-log.jsonl for billing.
 */
import { startOpenAIAdapter } from '../src/adapter/openai-server.js';

const port = Number(process.env.ADAPTER_PORT ?? 8787);

startOpenAIAdapter(port)
  .then((server) => {
    const addr = server.address();
    const actualPort =
      typeof addr === 'object' && addr !== null ? addr.port : port;
    console.log(`[token4u-adapter] listening on :${actualPort} (v0.3.18)`);
  })
  .catch((err: unknown) => {
    console.error('[token4u-adapter] failed to start:', err);
    process.exit(1);
  });
