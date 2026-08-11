// 證明: 帶 system prompt 連調 3 次 → cache 命中
import { paidChatCompletion } from './src/utils/x402';
import { readFileSync } from 'fs';
const wallet = JSON.parse(readFileSync('/home/sdadmin/.token4u-mcp/test-wallet.json', 'utf8'));

const SYSTEM = '你是量化數據工程師，擅長分析美股板塊數據。你的職責包括：1) 診斷數據異常 2) 分析板塊強弱 3) TRS 對沖建議 4) 半導體/科技板塊監控。請使用繁體中文回答。';

async function main() {
  for (let i = 1; i <= 3; i++) {
    const r = await paidChatCompletion('https://token4u.ai',
      { model: 'deepseek-v4-flash', messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `第 ${i} 次提問: 半導體板塊今天表現如何？` },
      ]},
      wallet.privateKey, { validForSec: 300 });
    console.log(`第${i}次: usage=${JSON.stringify(r.usage)}`);
  }
}
main().catch(e => console.error('❌', e.message));
