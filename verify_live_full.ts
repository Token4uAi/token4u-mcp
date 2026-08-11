// live 全面驗證：external permit2 付款 + reasoning + cache + 實際 settle
import { paidChatCompletion } from './src/utils/x402';
import { readFileSync } from 'fs';
const wallet = JSON.parse(readFileSync('/home/sdadmin/.token4u-mcp/test-wallet.json', 'utf8'));

const SYSTEM = '你是量化數據工程師，擅長分析美股板塊數據、TRS 對沖策略和半導體行業監控。' +
  '你的職責包括：1) 診斷數據異常 2) 分析板塊強弱 3) TRS 對沖建議 4) 半導體/科技板塊監控。請使用繁體中文回答。';

async function main() {
  // 1. 小調用（驗證 settle 實際 — 應 < floor）
  const r1 = await paidChatCompletion('https://token4u.ai',
    { model: 'deepseek-v4-flash', messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: '1+1=?' }] },
    wallet.privateKey, { validForSec: 300 });
  console.log('1️⃣ 小調用（deepseek）:');
  console.log('  content:', r1.content.slice(0, 40));
  console.log('  paidUsd:', r1.paidUsd);
  console.log('  usage:', JSON.stringify(r1.usage));

  // 2. 連調 3 次（驗證 cache）
  console.log('\n2️⃣ cache 測試（同 system 連調 3 次）:');
  for (let i = 1; i <= 3; i++) {
    const r = await paidChatCompletion('https://token4u.ai',
      { model: 'deepseek-v4-flash', messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: `第 ${i} 次: 半導體板塊今天表現如何？` }] },
      wallet.privateKey, { validForSec: 300 });
    console.log(`  第${i}次: usage=${JSON.stringify(r.usage)}`);
  }

  // 3. GLM（驗證 reasoning + 長輸出）
  console.log('\n3️⃣ GLM-5.2（reasoning + 輸出）:');
  const r3 = await paidChatCompletion('https://token4u.ai',
    { model: 'z-ai/glm-5.2', messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: '半導體放量時如何做 TRS 對沖？簡短回答' }] },
    wallet.privateKey, { validForSec: 300 });
  console.log('  content:', r3.content.slice(0, 40));
  console.log('  reasoningContent:', r3.reasoningContent ? r3.reasoningContent.slice(0, 40) + '...' : '(無)');
  console.log('  paidUsd:', r3.paidUsd);
  console.log('  usage:', JSON.stringify(r3.usage));
}
main().catch(e => console.error('❌', e.message));
