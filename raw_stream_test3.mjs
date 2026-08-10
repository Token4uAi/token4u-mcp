// 正確用法: buildPaymentHeader 回傳 base64 → PAYMENT-SIGNATURE header
import { fetchX402Quote, pickFirstAccept, signEip3009, buildPaymentHeader } from './src/utils/x402.ts';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'fs';

const wallet = JSON.parse(readFileSync('/home/sdadmin/.token4u-mcp/test-wallet.json', 'utf8'));
const account = privateKeyToAccount(wallet.privateKey);
const url = 'https://token4u.ai/v1/chat/completions';
const body = { model: 'deepseek/deepseek-v4-flash', messages: [{ role: 'user', content: '1+1=? 簡單回答' }], stream: true };

async function main() {
  const quote = await fetchX402Quote(url, body, 20000);
  const accepted = pickFirstAccept(quote.accepts);
  const payload = await signEip3009(wallet.privateKey, accepted, account.address, { validForSec: 300 });
  const paymentSig = buildPaymentHeader(accepted, payload, url, 'Chat completion');
  console.log('payment-signature 前50:', paymentSig.slice(0, 50));

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'PAYMENT-SIGNATURE': paymentSig },
    body: JSON.stringify(body),
  });
  console.log('HTTP:', res.status, res.statusText);

  if (res.body) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let count = 0;
    let buffer = '';
    while (count < 15) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('data: ') && line.trim() !== 'data: [DONE]') {
          try {
            const d = JSON.parse(line.slice(6));
            if (d.choices?.[0]?.delta) {
              const delta = d.choices[0].delta;
              console.log(`delta keys=[${Object.keys(delta)}] content=${JSON.stringify(delta.content)?.slice(0,40)} reasoning_content=${JSON.stringify(delta.reasoning_content)?.slice(0,40)}`);
              count++;
            } else if (d.usage) {
              console.log('usage:', JSON.stringify(d.usage).slice(0, 150));
            }
          } catch {}
        }
      }
    }
  } else {
    console.log('body:', (await res.text()).slice(0, 300));
  }
}

main().catch(e => console.error('❌', e.message));
