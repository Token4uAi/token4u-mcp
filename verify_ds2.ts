// 用無前綴 model 名調用 live deepseek-v4-flash
import { paidChatCompletion } from './src/utils/x402';
import { readFileSync } from 'fs';

const wallet = JSON.parse(readFileSync('/home/sdadmin/.token4u-mcp/test-wallet.json', 'utf8'));

async function main() {
  const result = await paidChatCompletion(
    'https://token4u.ai',
    {
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: '1+1=? 簡單回答' }],
    },
    wallet.privateKey,
    { validForSec: 300 }
  );
  console.log('✅ 調用成功!');
  console.log('content:', JSON.stringify(result.content));
  console.log('paidUsd:', result.paidUsd);
  console.log('usage:', JSON.stringify(result.usage));
}

main().catch(e => console.error('❌ 失敗:', e.message));
