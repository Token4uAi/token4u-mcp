// dev 驗證：permit2 付款 + 實際 settle
import { paidChatCompletion } from './src/utils/x402';
import { readFileSync } from 'fs';
const wallet = JSON.parse(readFileSync('/home/sdadmin/.token4u-mcp/test-wallet.json', 'utf8'));
async function main() {
  const r = await paidChatCompletion('https://dev.token4u.ai',
    { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }] },
    wallet.privateKey, { validForSec: 300 });
  console.log('✅ 調用成功');
  console.log('content:', r.content.slice(0, 40));
  console.log('paidUsd:', r.paidUsd);
  console.log('usage:', JSON.stringify(r.usage));
  console.log('sessionId:', r.sessionId);
}
main().catch(e => console.error('❌', e.message));
