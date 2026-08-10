import { paidChatCompletion } from './src/utils/x402';
import { readFileSync } from 'fs';

const wallet = JSON.parse(readFileSync('/home/sdadmin/.token4u-mcp/test-wallet.json', 'utf8'));
const BASE = 'System: 你是一個專業的數據分析助手，擅長處理結構化數據。\n' +
  '1. 公司 2024 年營收 1.2 億元，同比增長 23%\n2. 淨利潤 3400 萬\n3. 用戶總數 500 萬\n4. 研發投入佔營收 15%\n5. 現金儲備 6800 萬\n6. 員工 320 人\n';

async function main() {
  for (let i = 1; i <= 2; i++) {
    console.log(`\n=== 第 ${i} 次 ===`);
    const result = await paidChatCompletion(
      'https://token4u.ai',
      { model: 'deepseek-v4-flash', messages: [
        { role: 'system', content: BASE },
        { role: 'user', content: '請總結經營狀況' },
      ]},
      wallet.privateKey,
      { validForSec: 300 }
    );
    console.log('usage:', JSON.stringify(result.usage));
    console.log('reasoningContent 前50:', JSON.stringify(result.reasoningContent)?.slice(0, 50));
    console.log('content 前50:', JSON.stringify(result.content).slice(0, 50));
  }
}

main().catch(e => console.error('❌', e.message));
