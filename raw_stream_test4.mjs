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

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'PAYMENT-SIGNATURE': paymentSig },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  console.log('HTTP:', res.status);
  console.log('body 前400:', text.slice(0, 400));
  console.log('content-type:', res.headers.get('content-type'));
}

main().catch(e => console.error('❌', e.message));
