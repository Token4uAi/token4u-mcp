// MCP 全面測試：多模型 + prompt 大小 + reasoning/cache 欄位
import { paidChatCompletion } from './src/utils/x402';
import { readFileSync } from 'fs';
const wallet = JSON.parse(readFileSync('/home/sdadmin/.token4u-mcp/test-wallet.json', 'utf8'));

const SYSTEM = '你是量化數據工程師，擅長分析美股板塊數據、TRS 對沖策略和半導體行業監控。' + 
  '你的職責包括：1) 診斷數據異常 2) 分析板塊強弱 3) TRS 對沖建議 4) 半導體/科技板塊監控。請使用繁體中文回答。';

const tests = [
  { name: 'deepseek 小', model: 'deepseek/deepseek-v4-flash', msgs: [{role:'system',content:SYSTEM},{role:'user',content:'1+1=?'}] },
  { name: 'deepseek 中', model: 'deepseek/deepseek-v4-flash', msgs: [{role:'system',content:SYSTEM},{role:'user',content:'請簡述半導體板塊的 TRS 對沖策略'}] },
  { name: 'GLM 小', model: 'z-ai/glm-5.2', msgs: [{role:'system',content:SYSTEM},{role:'user',content:'1+1=?'}] },
  { name: 'GLM 中', model: 'z-ai/glm-5.2', msgs: [{role:'system',content:SYSTEM},{role:'user',content:'請分析半導體放量時如何做 TRS 對沖'}] },
];

async function main() {
  for (const t of tests) {
    try {
      const r = await paidChatCompletion('https://dev.token4u.ai', { model: t.model, messages: t.msgs }, wallet.privateKey, { validForSec: 300 });
      console.log(`\n✅ ${t.name}:`);
      console.log(`  content: ${r.content.slice(0, 50)}`);
      console.log(`  reasoningContent: ${r.reasoningContent ? r.reasoningContent.slice(0, 30) + '...' : '(無)'}`);
      console.log(`  paidUsd: ${r.paidUsd}`);
      console.log(`  usage: ${JSON.stringify(r.usage)}`);
    } catch (e) {
      console.log(`\n❌ ${t.name}: ${e.message}`);
    }
  }
}
main().catch(e => console.error('FATAL', e.message));
