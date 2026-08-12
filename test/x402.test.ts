import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

import { recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import {
  fetchX402Quote,
  pickFirstAccept,
  signPermit2,
  signEip2612Permit,
  detectGasSponsoringExtensions,
  checkAllowance,
  buildPaymentHeader,
  paidChatCompletion,
  PaymentError,
} from '../src/utils/x402.js';

import type {
  X402Accept,
  X402Quote,
  PaymentPayload,
} from '../src/utils/x402.js';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;

// anvil test account #0
const TEST_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

const FIXTURE_ACCEPT: X402Accept = {
  scheme: 'eip3009',
  network: 'base',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  amount: '1000000', // 1 USDC (6 decimals)
  payTo: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  extra: {},
};

const FIXTURE_QUOTE: X402Quote = {
  x402Version: 2,
  accepts: [FIXTURE_ACCEPT],
};

const PAYMENT_REQUIRED_HEADER = Buffer.from(
  JSON.stringify(FIXTURE_QUOTE),
).toString('base64');

// ---------------------------------------------------------------------------
// fetch helpers
// ---------------------------------------------------------------------------

/** Save and restore the global fetch. */
let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(
  ...responses: Array<{
    status: number;
    headers?: Record<string, string>;
    body: string | (() => string);
  }>
): void {
  let callIdx = 0;
  globalThis.fetch = (async (_url: unknown, _init?: unknown) => {
    const r = responses[callIdx] ?? responses[responses.length - 1];
    callIdx += 1;

    const bodyStr = typeof r.body === 'function' ? r.body() : r.body;

    return {
      status: r.status,
      headers: new Headers(r.headers ?? {}),
      text: async () => bodyStr,
      json: async () => JSON.parse(bodyStr),
      body: bodyStr
        ? new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(bodyStr));
              controller.close();
            },
          })
        : null,
    } as unknown as Response;
  }) as typeof fetch;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fetchX402Quote', () => {
  it('parses PAYMENT-REQUIRED header (base64 JSON)', async () => {
    mockFetch({
      status: 402,
      headers: { 'PAYMENT-REQUIRED': PAYMENT_REQUIRED_HEADER },
      body: '',
    });

    const quote = await fetchX402Quote('https://token4u.ai/v1/chat/completions', {
      model: 'test',
      messages: [],
    });

    assert.strictEqual(quote.x402Version, 2);
    assert.strictEqual(quote.accepts.length, 1);
    assert.strictEqual(quote.accepts[0].scheme, 'eip3009');
    assert.strictEqual(quote.accepts[0].amount, '1000000');
  });

  it('falls back to JSON body when PAYMENT-REQUIRED header is absent', async () => {
    mockFetch({
      status: 402,
      headers: {},
      body: JSON.stringify(FIXTURE_QUOTE),
    });

    const quote = await fetchX402Quote('https://token4u.ai/v1/chat/completions', {
      model: 'test',
      messages: [],
    });

    assert.strictEqual(quote.x402Version, 2);
    assert.strictEqual(quote.accepts.length, 1);
    assert.strictEqual(quote.accepts[0].payTo, FIXTURE_ACCEPT.payTo);
  });

  it('throws PaymentError when server does not respond 402', async () => {
    mockFetch({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ choices: [] }),
    });

    await assert.rejects(
      () =>
        fetchX402Quote('https://token4u.ai/v1/chat/completions', {
          model: 'test',
          messages: [],
        }),
      (err: unknown) => {
        assert.ok(err instanceof PaymentError);
        assert.ok(
          (err as PaymentError).message.includes('200'),
          `Expected message to include "200", got: ${(err as PaymentError).message}`,
        );
        return true;
      },
    );
  });
});

describe('pickFirstAccept', () => {
  it('returns the first accept entry', () => {
    const result = pickFirstAccept(FIXTURE_QUOTE.accepts);
    assert.deepStrictEqual(result, FIXTURE_ACCEPT);
  });

  it('throws PaymentError for empty array', () => {
    assert.throws(() => pickFirstAccept([]), PaymentError);
  });
});

describe('buildPaymentHeader', () => {
  it('encodes a valid base64 PAYMENT-SIGNATURE header', () => {
    const payload: PaymentPayload = {
      authorization: {
        from: TEST_ADDRESS,
        to: FIXTURE_ACCEPT.payTo,
        value: FIXTURE_ACCEPT.amount,
        validAfter: '0',
        validBefore: '9999999999',
        nonce: '0x' + 'ab'.repeat(32),
      },
      signature: '0xdeadbeef',
    };

    const header = buildPaymentHeader(
      FIXTURE_ACCEPT,
      payload,
      'https://token4u.ai/v1/chat/completions',
      'Chat completion',
    );

    // Decode and verify structure.
    const decoded = JSON.parse(
      Buffer.from(header, 'base64').toString('utf-8'),
    ) as Record<string, unknown>;

    assert.strictEqual(decoded.x402Version, 2);
    assert.strictEqual(decoded.scheme, FIXTURE_ACCEPT.scheme);

    // resource
    const resource = decoded.resource as Record<string, unknown>;
    assert.strictEqual(resource.url, 'https://token4u.ai/v1/chat/completions');
    assert.strictEqual(resource.description, 'Chat completion');
    assert.strictEqual(resource.mimeType, 'application/json');

    // accepted
    const accepted = decoded.accepted as Record<string, unknown>;
    assert.strictEqual(accepted.amount, FIXTURE_ACCEPT.amount);
    assert.strictEqual(accepted.payTo, FIXTURE_ACCEPT.payTo);

    // payload
    const p = decoded.payload as Record<string, unknown>;
    const auth = p.authorization as Record<string, unknown>;
    assert.strictEqual(auth.from, TEST_ADDRESS);
    assert.strictEqual(p.signature, '0xdeadbeef');
  });
});

describe('paidChatCompletion', () => {
  it('completes the full x402 flow (402 → SSE stream)', async () => {
    // Build an SSE stream response.
    const sseChunks = [
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello"}}]}\n\n',
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":" world"}}]}\n\n',
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n',
      'data: [DONE]\n\n',
    ];

    const sseBody = sseChunks.join('');

    mockFetch(
      // First call — 402 with quote.
      {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': PAYMENT_REQUIRED_HEADER },
        body: '',
      },
      // Second call — 200 SSE stream.
      {
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'X-402-SESSION': 'sess-abc',
        },
        body: sseBody,
      },
    );

    const result = await paidChatCompletion(
      'https://token4u.ai',
      { model: 'test', messages: [{ role: 'user', content: 'hi' }] },
      TEST_PRIVATE_KEY,
      { validForSec: 3600 },
    );

    assert.strictEqual(result.content, 'Hello world');
    assert.strictEqual(result.paidUsd, 1.0); // 1000000 / 1e6 = 1 USD
    assert.strictEqual(result.sessionId, 'sess-abc');
    assert.ok(result.usage);
    assert.strictEqual(result.usage?.promptTokens, 10);
    assert.strictEqual(result.usage?.completionTokens, 5);
    assert.strictEqual(result.usage?.totalTokens, 15);
  });

  it('throws PaymentError when payment is rejected (second 402)', async () => {
    mockFetch(
      // First call — 402 with quote (successful quoting).
      {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': PAYMENT_REQUIRED_HEADER },
        body: '',
      },
      // Second call — 402 again (payment rejected).
      {
        status: 402,
        headers: {},
        body: JSON.stringify({ error: 'insufficient balance' }),
      },
    );

    await assert.rejects(
      () =>
        paidChatCompletion(
          'https://token4u.ai',
          { model: 'test', messages: [{ role: 'user', content: 'hi' }] },
          TEST_PRIVATE_KEY,
        ),
      (err: unknown) => {
        assert.ok(err instanceof PaymentError);
        assert.ok(
          (err as PaymentError).message.includes('Payment rejected'),
          `Expected "Payment rejected", got: ${(err as PaymentError).message}`,
        );
        return true;
      },
    );
  });

  it('handles non-SSE JSON success response', async () => {
    const jsonBody = JSON.stringify({
      id: 'chatcmpl-2',
      object: 'chat.completion',
      model: 'test-model',
      choices: [
        { index: 0, message: { role: 'assistant', content: 'JSON response' } },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      session_id: 'sess-json',
    });

    mockFetch(
      {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': PAYMENT_REQUIRED_HEADER },
        body: '',
      },
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: jsonBody,
      },
    );

    const result = await paidChatCompletion(
      'https://token4u.ai',
      { model: 'test', messages: [{ role: 'user', content: 'hi' }] },
      TEST_PRIVATE_KEY,
    );

    assert.strictEqual(result.content, 'JSON response');
    assert.strictEqual(result.model, 'test-model');
    assert.strictEqual(result.paidUsd, 1.0);
    assert.strictEqual(result.sessionId, 'sess-json');
    assert.ok(result.usage);
    assert.strictEqual(result.usage?.totalTokens, 8);
  });
});

// ---------------------------------------------------------------------------
// Gas sponsoring extension tests (T83)
// ---------------------------------------------------------------------------

const PERMIT2_CONTRACT = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

const FIXTURE_PERMIT2_ACCEPT: X402Accept = {
  scheme: 'upto',
  network: 'base',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  amount: '1000000',
  payTo: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  extra: {
    assetTransferMethod: 'permit2',
    facilitatorAddress: '0x8f5cb67b49555e614892b7233cfddebfb746e531',
    eip2612GasSponsoring: { version: 1 },
  },
};

/** JSON-RPC eth_call success response returning a zero uint256. */
const RPC_ZERO_RESULT = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  result:
    '0x0000000000000000000000000000000000000000000000000000000000000000',
});

/** JSON-RPC eth_call response for a non-zero allowance (1 USDC = 1000000). */
const RPC_ALLOWANCE_1USDC = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  result:
    '0x00000000000000000000000000000000000000000000000000000000000f4240',
});

/**
 * Mock fetch that discriminates between the token4u API and Base RPC calls
 * so we can return realistic eth_call results alongside 402/200 responses.
 */
function mockFetchWithRpc(
  rpcResponses: Record<string, string>,
  ...httpResponses: Array<{
    status: number;
    headers?: Record<string, string>;
    body: string | (() => string);
  }>
): void {
  let httpIdx = 0;

  globalThis.fetch = (async (url: unknown, init?: unknown) => {
    const urlStr = String(url);
    // Detect Base RPC calls (eth_call).
    if (urlStr.includes('mainnet.base.org') || urlStr.includes('base.rpc')) {
      const bodyStr =
        typeof init === 'object' && init !== null
          ? String((init as Record<string, unknown>).body ?? '')
          : '';
      // Match by the encoded function selector in the call data.
      if (bodyStr.includes('"method":"eth_call"')) {
        // allowance(address,address) → selector 0xdd62ed3e
        if (bodyStr.includes('0xdd62ed3e')) {
          const r = rpcResponses.allowance ?? RPC_ZERO_RESULT;
          return new Response(r, {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        // nonces(address) → selector 0x7ecebe00
        if (bodyStr.includes('0x7ecebe00')) {
          const r = rpcResponses.nonces ?? RPC_ZERO_RESULT;
          return new Response(r, {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
      }
      // Fallback RPC response.
      return new Response(RPC_ZERO_RESULT, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    // Regular HTTP response.
    const r = httpResponses[httpIdx] ?? httpResponses[httpResponses.length - 1];
    httpIdx += 1;

    const bodyStr = typeof r.body === 'function' ? r.body() : r.body;

    return {
      status: r.status,
      headers: new Headers(r.headers ?? {}),
      text: async () => bodyStr,
      json: async () => JSON.parse(bodyStr),
      body: bodyStr
        ? new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(bodyStr));
              controller.close();
            },
          })
        : null,
    } as unknown as Response;
  }) as typeof fetch;
}

describe('detectGasSponsoringExtensions', () => {
  it('detects eip2612GasSponsoring in accept.extra', () => {
    const result = detectGasSponsoringExtensions(FIXTURE_PERMIT2_ACCEPT);
    assert.strictEqual(result.eip2612GasSponsoring, true);
    assert.strictEqual(result.erc20ApprovalGasSponsoring, false);
  });

  it('detects erc20ApprovalGasSponsoring in accept.extra', () => {
    const accept: X402Accept = {
      ...FIXTURE_PERMIT2_ACCEPT,
      extra: {
        assetTransferMethod: 'permit2',
        facilitatorAddress: '0x8f5cb67b49555e614892b7233cfddebfb746e531',
        erc20ApprovalGasSponsoring: { version: 1 },
      },
    };
    const result = detectGasSponsoringExtensions(accept);
    assert.strictEqual(result.eip2612GasSponsoring, false);
    assert.strictEqual(result.erc20ApprovalGasSponsoring, true);
  });

  it('returns false for both when extra has no sponsoring keys', () => {
    const accept: X402Accept = {
      ...FIXTURE_PERMIT2_ACCEPT,
      extra: {
        assetTransferMethod: 'permit2',
        facilitatorAddress: '0x8f5cb67b49555e614892b7233cfddebfb746e531',
      },
    };
    const result = detectGasSponsoringExtensions(accept);
    assert.strictEqual(result.eip2612GasSponsoring, false);
    assert.strictEqual(result.erc20ApprovalGasSponsoring, false);
  });

  it('handles undefined extra', () => {
    const accept: X402Accept = {
      ...FIXTURE_PERMIT2_ACCEPT,
      extra: undefined,
    };
    const result = detectGasSponsoringExtensions(accept);
    assert.strictEqual(result.eip2612GasSponsoring, false);
    assert.strictEqual(result.erc20ApprovalGasSponsoring, false);
  });
});

describe('signEip2612Permit', () => {
  it('produces a valid EIP-2612 Permit signature', async () => {
    // Mock the nonces RPC call to return 0.
    mockFetchWithRpc(
      { nonces: RPC_ZERO_RESULT },
      // No HTTP calls needed for signEip2612Permit alone.
      { status: 200, headers: {}, body: '' },
    );

    const info = await signEip2612Permit(
      TEST_PRIVATE_KEY,
      FIXTURE_PERMIT2_ACCEPT,
      TEST_ADDRESS,
      { validForSec: 3600 },
    );

    // Verify structure.
    assert.strictEqual(info.from, TEST_ADDRESS);
    assert.strictEqual(info.asset, FIXTURE_PERMIT2_ACCEPT.asset);
    assert.strictEqual(info.spender, PERMIT2_CONTRACT);
    assert.strictEqual(info.amount, FIXTURE_PERMIT2_ACCEPT.amount);
    assert.strictEqual(info.nonce, '0');
    assert.ok(info.signature.startsWith('0x'));
    assert.strictEqual(info.version, '1');

    // Verify signature cryptographically.
    const recovered = await recoverTypedDataAddress({
      domain: {
        name: 'USD Coin',
        version: '2',
        chainId: 8453,
        verifyingContract:
          '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      },
      types: {
        Permit: [
          { name: 'owner', type: 'address' },
          { name: 'spender', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
      primaryType: 'Permit',
      message: {
        owner: TEST_ADDRESS as `0x${string}`,
        spender: PERMIT2_CONTRACT as `0x${string}`,
        value: BigInt(FIXTURE_PERMIT2_ACCEPT.amount),
        nonce: 0n,
        deadline: BigInt(info.deadline),
      },
      signature: info.signature,
    });

    assert.strictEqual(recovered.toLowerCase(), TEST_ADDRESS.toLowerCase());
  });
});

describe('checkAllowance', () => {
  it('returns true when allowance >= amount', async () => {
    mockFetchWithRpc(
      { allowance: RPC_ALLOWANCE_1USDC },
      { status: 200, headers: {}, body: '' },
    );

    const result = await checkAllowance(TEST_ADDRESS, '1000000');
    assert.strictEqual(result, true);
  });

  it('returns false when allowance < amount', async () => {
    mockFetchWithRpc(
      { allowance: RPC_ZERO_RESULT },
      { status: 200, headers: {}, body: '' },
    );

    const result = await checkAllowance(TEST_ADDRESS, '1000000');
    assert.strictEqual(result, false);
  });

  it('returns true (fail-open) on RPC error', async () => {
    // Return a non-JSON response to simulate RPC failure.
    globalThis.fetch = (async () => {
      return new Response('not json', { status: 502 });
    }) as typeof fetch;

    const result = await checkAllowance(TEST_ADDRESS, '1000000');
    assert.strictEqual(result, true);
  });
});

describe('paidChatCompletion — gasless approve (T83)', () => {
  const PERMIT2_QUOTE_HEADER = Buffer.from(
    JSON.stringify({
      x402Version: 2,
      accepts: [FIXTURE_PERMIT2_ACCEPT],
    }),
  ).toString('base64');

  it('attaches EIP-2612 permit when allowance is insufficient', async () => {
    // Build SSE success response.
    const sseBody = [
      'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"OK"}}]}\n\n',
      'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ].join('');

    mockFetchWithRpc(
      {
        allowance: RPC_ZERO_RESULT, // insufficient
        nonces: RPC_ZERO_RESULT,    // nonce = 0
      },
      // Call 1: 402 with quote (has eip2612GasSponsoring in extra).
      {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': PERMIT2_QUOTE_HEADER },
        body: '',
      },
      // Call 2: 200 SSE success.
      {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: sseBody,
      },
    );

    const result = await paidChatCompletion(
      'https://token4u.ai',
      { model: 'test', messages: [{ role: 'user', content: 'hi' }] },
      TEST_PRIVATE_KEY,
      { validForSec: 3600, timeoutMs: 5000 },
    );

    assert.strictEqual(result.content, 'OK');
    assert.strictEqual(result.paidUsd, 1.0);
  });

  it('proceeds normally when allowance is sufficient (no EIP-2612 needed)', async () => {
    const sseBody = [
      'data: {"id":"c2","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"OK"}}]}\n\n',
      'data: {"id":"c2","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ].join('');

    // Allowance is sufficient — no EIP-2612 extension should be attached.
    mockFetchWithRpc(
      { allowance: RPC_ALLOWANCE_1USDC },
      {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': PERMIT2_QUOTE_HEADER },
        body: '',
      },
      {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: sseBody,
      },
    );

    const result = await paidChatCompletion(
      'https://token4u.ai',
      { model: 'test', messages: [{ role: 'user', content: 'hi' }] },
      TEST_PRIVATE_KEY,
      { validForSec: 3600, timeoutMs: 5000 },
    );

    assert.strictEqual(result.content, 'OK');
    assert.strictEqual(result.paidUsd, 1.0);
  });

  it('throws descriptive error when allowance insufficient + no EIP-2612', async () => {
    // accept without any gas-sponsoring extension keys.
    const noExtAccept: X402Accept = {
      ...FIXTURE_PERMIT2_ACCEPT,
      extra: {
        assetTransferMethod: 'permit2',
        facilitatorAddress: '0x8f5cb67b49555e614892b7233cfddebfb746e531',
      },
    };
    const noExtHeader = Buffer.from(
      JSON.stringify({ x402Version: 2, accepts: [noExtAccept] }),
    ).toString('base64');

    mockFetchWithRpc(
      { allowance: RPC_ZERO_RESULT },
      {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': noExtHeader },
        body: '',
      },
      // No second HTTP call needed — should throw before the second request.
      { status: 200, headers: {}, body: '' },
    );

    await assert.rejects(
      () =>
        paidChatCompletion(
          'https://token4u.ai',
          { model: 'test', messages: [{ role: 'user', content: 'hi' }] },
          TEST_PRIVATE_KEY,
          { validForSec: 3600 },
        ),
      (err: unknown) => {
        assert.ok(err instanceof PaymentError);
        assert.ok(
          (err as PaymentError).message.includes('Insufficient USDC allowance'),
          `Expected allowance error, got: ${(err as PaymentError).message}`,
        );
        return true;
      },
    );
  });

  it('falls back to CDP approval sponsoring when allowance is insufficient (T94: permit2 only)', async () => {
    const cdpAccept: X402Accept = {
      ...FIXTURE_PERMIT2_ACCEPT,
      extra: {
        assetTransferMethod: 'permit2',
        facilitatorAddress: '0x8f5cb67b49555e614892b7233cfddebfb746e531',
        erc20ApprovalGasSponsoring: { version: 1 },
      },
    };
    const cdpHeader = Buffer.from(
      JSON.stringify({ x402Version: 2, accepts: [cdpAccept] }),
    ).toString('base64');

    mockFetchWithRpc(
      { allowance: RPC_ZERO_RESULT },
      {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': cdpHeader },
        body: '',
      },
      { status: 200, headers: {}, body: '' },
    );

    // T94: with EIP-3009 removed, allowance=0 + erc20ApprovalGasSponsoring
    // attempts the gas-sponsored approve path instead of an allowance error.
    await assert.doesNotReject(
      () =>
        paidChatCompletion(
          'https://token4u.ai',
          { model: 'test', messages: [{ role: 'user', content: 'hi' }] },
          TEST_PRIVATE_KEY,
          { validForSec: 3600 },
        ),
      (err: unknown) =>
        err instanceof PaymentError &&
        (err as PaymentError).message.includes('Insufficient USDC allowance'),
    );
  });
});
