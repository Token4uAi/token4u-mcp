// 直接看 live deepseek 的原始流式回應（用 x402 付款流程 + 原始 SSE）
import { fetchX402Quote, pickFirstAccept, signEip3009, buildPaymentHeader } from './src/utils/x402.ts';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'fs';

const wallet = JSON.parse(readFileSync('/home/sdadmin/.token4u-mcp/test-wallet.json', 'utf8'));
const account = privateKeyToAccount(wallet.privateKey);
const url = 'https://token4u.ai/v1/chat/completions';
const body = { model: 'deepseek/deepseek-v4-flash', messages: [{ role: 'user', content: '1+1=? 簡單回答' }], stream: true };

async function main() {
  // 1. 拿 quote
  const quote = await fetchX402Quote(url, body, 20000);
  console.log('quote accepts:', quote.accepts.length);
  const accepted = pickFirstAccept(quote.accepts);
  console.log('選中 scheme:', accepted.scheme, 'atm:', accepted.extra?.assetTransferMethod);

  // 2. 簽名
  const payload = await signEip3009(wallet.privateKey, accepted, account.address, { validForSec: 300 });
  const header = buildPaymentHeader(payload, url, 'Chat completion');

  // 3. 帶付款 header 請求（看原始 SSE）
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...header },
    body: JSON.stringify(body),
  });
  console.log('HTTP:', res.status);

  if (res.body) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let count = 0;
    while (count < 10) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      // 只印 delta 相關行
      for (const line of text.split('\n')) {
        if (line.startsWith('data: ') && line !== 'data: [DONE]') {
          try {
            const d = JSON.parse(line.slice(6));
            const delta = d.choices?.[0]?.delta;
            if (delta) {
              console.log('delta keys:', Object.keys(delta), 'content:', JSON.stringify(delta.content)?.slice(0, 50), 'reasoning:', JSON.stringify(delta.reasoning_content)?.slice(0, 50));
              count++;
            }
          } catch {}
        }
      }
    }
  }
}

main().catch(e => console.error('❌', e.message));
