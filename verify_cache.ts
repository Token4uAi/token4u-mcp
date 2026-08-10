// 用 MCP 調用兩次同 prompt — 看 usage 有沒有 cache 數據
import { paidChatCompletion } from './src/utils/x402';
import { readFileSync } from 'fs';

const wallet = JSON.parse(readFileSync('/home/sdadmin/.token4u-mcp/test-wallet.json', 'utf8'));
const PROMPT = 'Say hello, this is a cache test with a reasonably long prompt to trigger caching behavior in the system. The quick brown fox jumps over the lazy dog multiple times.';

async function main() {
  for (let i = 1; i <= 2; i++) {
    console.log(`\n=== 第 ${i} 次調用（同 prompt）===`);
    const result = await paidChatCompletion(
      'https://token4u.ai',
      {
        model: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: PROMPT }],
      },
      wallet.privateKey,
      { validForSec: 300 }
    );
    console.log('content:', JSON.stringify(result.content).slice(0, 80));
    console.log('usage:', JSON.stringify(result.usage));
  }
}

main().catch(e => console.error('❌ 失敗:', e.message));
