// 用 token4u-mcp 的 paidChatCompletion 付款調用 live GLM-5.2
import { paidChatCompletion } from './src/utils/x402';
import { readFileSync } from 'fs';

const wallet = JSON.parse(readFileSync('/home/sdadmin/.token4u-mcp/test-wallet.json', 'utf8'));

async function main() {
  const result = await paidChatCompletion(
    'https://token4u.ai',
    {
      model: 'z-ai/glm-5.2',
      messages: [{ role: 'user', content: '1+1=? 簡單回答' }],
    },
    wallet.privateKey,
    { validForSec: 300 }
  );
  console.log('✅ 調用成功!');
  console.log('content:', result.content);
  console.log('model:', result.model);
  console.log('paidUsd:', result.paidUsd);
  console.log('usage:', JSON.stringify(result.usage));
  console.log('sessionId:', result.sessionId);
}

main().catch(e => console.error('❌ 失敗:', e.message));
