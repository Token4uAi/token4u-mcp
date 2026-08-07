// E2E 連通測試：token4u-mcp x402 流程 vs dev.token4u.ai
// 唔使私鑰：402 quote（證明 MCP client 連到 token4u）
// 有私鑰：完整 paidChatCompletion（402 → 簽名 → retry → stream）
import { fetchX402Quote, pickFirstAccept, paidChatCompletion, PaymentError } from "../src/utils/x402.js";

const BASE = "https://dev.token4u.ai";
const MODEL = "deepseek-v3";

const body = {
  model: MODEL,
  messages: [{ role: "user", content: "Hi! Reply with exactly: pong" }],
  max_tokens: 50,
  stream: true,
};

console.log(`=== 1. 402 quote (${BASE}, model=${MODEL}) ===`);
try {
  const quote = await fetchX402Quote(`${BASE}/v1/chat/completions`, body, 15000);
  console.log("x402Version:", quote.x402Version);
  for (const a of quote.accepts) {
    console.log(`  scheme=${a.scheme} payTo=${a.payTo} amount=${a.amount} ($${(Number(a.amount) / 1e6).toFixed(4)}) network=${a.network} asset=${a.asset}`);
    if (a.extra) console.log("  extra:", JSON.stringify(a.extra));
  }
  console.log("✅ 402 quote OK — MCP client ↔ token4u 連通");
} catch (e) {
  const err = e as Error;
  console.log("❌ quote failed:", err.message);
  process.exit(1);
}

// 完整支付流程（用 ~/.token4u-mcp/wallet.json 私鑰；可能因無 USDC settle fail，但驗證簽名/verify 階段）
const WALLET_FILE = `${process.env.HOME}/.token4u-mcp/wallet.json`;
try {
  const envKey = process.env.TOKEN4U_WALLET_KEY;
  let privateKey: `0x${string}` = (envKey && envKey.startsWith("0x") ? envKey : `0x${envKey}`) as `0x${string}`;
  let walletLabel = "env TOKEN4U_WALLET_KEY";
  if (!envKey) {
    const { readFileSync } = await import("node:fs");
    const wallet = JSON.parse(readFileSync(WALLET_FILE, "utf-8"));
    privateKey = wallet.privateKey as `0x${string}`;
    walletLabel = wallet.address;
  }
  console.log(`\n=== 2. paidChatCompletion (wallet=${walletLabel}) ===`);
  const result = await paidChatCompletion(BASE, body, privateKey, { timeoutMs: 60000 });
  console.log("✅ PAYED OK");
  console.log("  content:", JSON.stringify(result.content?.slice(0, 120)));
  console.log("  model:", result.model);
  console.log("  paidUsd:", result.paidUsd);
  console.log("  sessionId:", result.sessionId);
} catch (e) {
  if (e instanceof PaymentError) {
    console.log("❌ PaymentError:", e.message);
  } else {
    const err = e as Error;
    console.log("❌ error:", err.message);
    console.log("   (stack):", err.stack?.split("\n").slice(0, 4).join("\n   "));
  }
}
