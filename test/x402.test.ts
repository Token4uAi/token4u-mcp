import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

import { recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import {
  fetchX402Quote,
  pickFirstAccept,
  signEip3009,
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

describe('signEip3009', () => {
  it('produces a valid EIP-3009 TransferWithAuthorization signature', async () => {
    const payload = await signEip3009(
      TEST_PRIVATE_KEY,
      FIXTURE_ACCEPT,
      TEST_ADDRESS,
      { validForSec: 3600 },
    );

    // signEip3009 always returns authorization + signature.
    const sig = payload.signature!;
    const auth = payload.authorization!;

    // Verify structure.
    assert.ok(sig.startsWith('0x'));
    assert.strictEqual(auth.from, TEST_ADDRESS);
    assert.strictEqual(auth.to, FIXTURE_ACCEPT.payTo);
    assert.strictEqual(auth.value, FIXTURE_ACCEPT.amount);
    assert.strictEqual(auth.validAfter, '0');
    assert.ok(auth.nonce.startsWith('0x'));
    assert.strictEqual(auth.nonce.length, 66); // 32 bytes hex

    // Verify the signature cryptographically.
    const recovered = await recoverTypedDataAddress({
      domain: {
        name: 'USD Coin',
        version: '2',
        chainId: 8453,
        verifyingContract:
          '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      },
      types: {
        TransferWithAuthorization: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
        ],
      },
      primaryType: 'TransferWithAuthorization',
      message: {
        from: TEST_ADDRESS as `0x${string}`,
        to: FIXTURE_ACCEPT.payTo as `0x${string}`,
        value: BigInt(FIXTURE_ACCEPT.amount),
        validAfter: 0n,
        validBefore: BigInt(Number(auth.validBefore)),
        nonce: auth.nonce as `0x${string}`,
      },
      signature: sig,
    });

    assert.strictEqual(
      recovered.toLowerCase(),
      TEST_ADDRESS.toLowerCase(),
    );
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
