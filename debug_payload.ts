// Debug: 看 MCP 發送的 permit2 payload 結構
import { fetchX402Quote, pickFirstAccept, signPermit2, buildPaymentHeader } from './src/utils/x402';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'fs';
const wallet = JSON.parse(readFileSync('/home/sdadmin/.token4u-mcp/test-wallet.json', 'utf8'));

async function main() {
  const url = 'https://token4u.ai/v1/chat/completions';
  const body = { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: '1+1=?' }] };
  const quote = await fetchX402Quote(url, body, 30000);
  const accepted = pickFirstAccept(quote.accepts);
  console.log('accepted:', JSON.stringify(accepted).slice(0, 300));

  const account = privateKeyToAccount(wallet.privateKey);
  const payload = await signPermit2(wallet.privateKey, accepted, account.address, { validForSec: 300 });
  console.log('\npermit2Authorization:', JSON.stringify(payload.permit2Authorization).slice(0, 400));
  const sig = payload.permit2Authorization?.signature;
  console.log('\nsignature 長度:', sig?.length, '前 20:', sig?.slice(0, 20));
}
main().catch(e => console.error('❌', e.message));
