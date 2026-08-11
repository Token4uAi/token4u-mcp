// 驗證 T77：session 耗盡後 resume 應被拒絕（Session exhausted）
import { fetchX402Quote, pickFirstAccept, signEip3009, buildPaymentHeader } from './src/utils/x402';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'fs';

const wallet = JSON.parse(readFileSync('/home/sdadmin/.token4u-mcp/test-wallet.json', 'utf8'));
const account = privateKeyToAccount(wallet.privateKey);
const url = 'https://token4u.ai/v1/chat/completions';

async function main() {
  // 1. 拿 quote + 付款
  const body = { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'Say hello world' }], stream: true };
  const quote = await fetchX402Quote(url, body, 30000);
  const accepted = pickFirstAccept(quote.accepts);
  const payload = await signEip3009(wallet.privateKey, accepted, account.address, { validForSec: 300 });
  const sig = buildPaymentHeader(accepted, payload, url, 'Chat completion');

  // 2. 第一次調用（建立 session）
  const res1 = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'PAYMENT-SIGNATURE': sig },
    body: JSON.stringify(body),
  });
  const sessionId = res1.headers.get('X-402-SESSION');
  console.log('第1次 HTTP:', res1.status, 'session:', sessionId);
  await res1.body?.cancel();

  // 3. 用同 session resume（無新付款）— 應被拒絕（Session exhausted 或正常 resume）
  const resumeBody = { ...body, messages: [{ role: 'user', content: 'Say hello again' }] };
  const res2 = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'PAYMENT-SIGNATURE': sig, 'X-402-RESUME': sessionId },
    body: JSON.stringify(resumeBody),
  });
  const text2 = await res2.text();
  console.log('第2次 resume HTTP:', res2.status);
  console.log('回應:', text2.slice(0, 300));
}

main().catch(e => console.error('❌', e.message));
