import { paidChatCompletion } from './src/utils/x402';
import { readFileSync } from 'fs';
const wallet = JSON.parse(readFileSync('/home/sdadmin/.token4u-mcp/test-wallet.json', 'utf8'));
async function main() {
  const t0 = Date.now();
  try {
    const r = await paidChatCompletion('https://token4u.ai',
      { model: 'z-ai/glm-5.2', messages: [{ role: 'user', content: '請詳細解釋 TRS 對沖策略在半導體板塊的應用，包括風險管理、Delta 調整和實例分析，至少 800 字。' }] },
      wallet.privateKey, { validForSec: 600, timeoutMs: 300000, maxPaymentAttempts: 3 });
    console.log(`✅ GLM: paid=${r.paidUsd} ct=${r.usage?.completionTokens} content=${r.content.length}chars (${((Date.now()-t0)/1000).toFixed(1)}s)`);
  } catch (e: any) {
    console.log('❌', (e.body || e.message || '').slice(0, 250));
  }
}
main();
