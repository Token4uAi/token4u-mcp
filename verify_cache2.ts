// 中型 prompt 測試 cache 命中（DeepSeek 官方）
import { paidChatCompletion } from './src/utils/x402';
import { readFileSync } from 'fs';

const wallet = JSON.parse(readFileSync('/home/sdadmin/.token4u-mcp/test-wallet.json', 'utf8'));

// 中型 prompt（~500 tokens — 長一點觸發 cache）
const BASE = 'System: 你是一個專業的數據分析助手，擅長處理結構化數據和報告生成。\n\n' +
  '背景資料：\n' +
  '1. 公司 2024 年營收為 1.2 億元人民幣，同比增長 23%\n' +
  '2. 淨利潤 3400 萬，增長 18%\n' +
  '3. 用戶總數突破 500 萬，月活躍 120 萬\n' +
  '4. 主要產品線：企業 SaaS、移動應用、數據服務\n' +
  '5. 研發投入佔營收 15%，共 1800 萬\n' +
  '6. 銷售成本率 42%，管理費用率 18%\n' +
  '7. 現金儲備 6800 萬，無長期負債\n' +
  '8. 員工總數 320 人，其中技術團隊 145 人\n' +
  '9. 客戶續約率 87%，客戶滿意度 4.6/5\n' +
  '10. 2025 年計劃：新產品發布、國際市場拓展、AI 能力升級\n\n';

async function main() {
  // 同一長 prompt 調 3 次（第 2、3 次應 cache 命中）
  for (let i = 1; i <= 3; i++) {
    console.log(`\n=== 第 ${i} 次調用（同長 prompt）===`);
    const result = await paidChatCompletion(
      'https://token4u.ai',
      {
        model: 'deepseek-v4-flash',
        messages: [
          { role: 'system', content: BASE },
          { role: 'user', content: '請根據以上資料總結公司 2024 年的經營狀況，並預測 2025 年趨勢。' },
        ],
      },
      wallet.privateKey,
      { validForSec: 300 }
    );
    console.log('usage:', JSON.stringify(result.usage));
    console.log('content 前60:', JSON.stringify(result.content).slice(0, 60));
  }
}

main().catch(e => console.error('❌ 失敗:', e.message));
