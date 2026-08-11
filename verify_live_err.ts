import { paidChatCompletion } from './src/utils/x402';
import { readFileSync } from 'fs';
const wallet = JSON.parse(readFileSync('/home/sdadmin/.token4u-mcp/test-wallet.json', 'utf8'));

async function main() {
  try {
    const r = await paidChatCompletion('https://token4u.ai',
      { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: '1+1=?' }] },
      wallet.privateKey, { validForSec: 300 });
    console.log('✅', r.paidUsd, JSON.stringify(r.usage));
  } catch (e: any) {
    console.log('❌ message:', e.message);
    console.log('❌ status:', e.status);
    if (e.details) console.log('❌ details:', e.details.slice(0, 500));
    if (e.responseText) console.log('❌ body:', e.responseText.slice(0, 500));
    // PaymentError 可能有原始 body
    console.log('❌ 完整:', JSON.stringify(e).slice(0, 600));
  }
}
main();
