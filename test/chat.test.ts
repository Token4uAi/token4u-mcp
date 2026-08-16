import { describe, it } from 'node:test';
import assert from 'node:assert';

import { chatWithToken4u, PaymentError } from '../src/tools/chat.js';
import type { ChatInput, ChatDeps } from '../src/tools/chat.js';
import type { BudgetState } from '../src/types.js';
import type { LocalWallet } from '../src/utils/wallet.js';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;

const TEST_WALLET: LocalWallet = {
  privateKey: TEST_PRIVATE_KEY,
  address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  isNew: false,
};

const TEST_API_URL = 'https://test.token4u.ai';

/** Standard chat input for tests. */
const CHAT_INPUT: ChatInput = {
  model: 'deepseek-v3',
  messages: [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'Hello!' },
  ],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBudget(overrides?: Partial<BudgetState>): BudgetState {
  return {
    limit: null,
    spent: 0,
    calls: 0,
    agents: new Map(),
    ...overrides,
  };
}

/**
 * Build a `ChatDeps` instance where every method is a no-op (returns the
 * happy-path default). Individual tests override the methods they care about.
 */
function makeDeps(overrides?: Partial<ChatDeps>): ChatDeps {
  return {
    loadWallet: async () => TEST_WALLET,
    paidChat: async (_url, _body, _key) => ({
      content: 'Hello! How can I help?',
      model: 'deepseek-v3',
      paidUsd: 0.01,
    }),
    apiUrl: TEST_API_URL,
    ...overrides,
  };
}

/** Extract the body dict passed to `paidChat` so we can assert against it. */
function captureBody(
  onBody: (body: Record<string, unknown>) => void,
): ChatDeps['paidChat'] {
  return async (_url, body) => {
    onBody(body);
    return {
      content: 'Captured',
      model: 'deepseek-v3',
      paidUsd: 0.005,
    };
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('chatWithToken4u', () => {
  // -----------------------------------------------------------------------
  // No wallet
  // -----------------------------------------------------------------------

  it('returns isError when no local wallet is found', async () => {
    const deps = makeDeps({ loadWallet: async () => null });
    const budget = makeBudget();

    const result = await chatWithToken4u(CHAT_INPUT, budget, deps);

    assert.strictEqual(result.isError, true);
    assert.ok(result.text.includes('No local wallet found'));
    assert.ok(result.text.includes('token4u_wallet'));
    assert.ok(result.text.includes('create'));
  });

  // -----------------------------------------------------------------------
  // Budget exceeded
  // -----------------------------------------------------------------------

  it('rejects new calls when budget limit is exceeded (spent >= limit)', async () => {
    const budget = makeBudget({ limit: 0.01, spent: 0.01 });
    const deps = makeDeps();

    const result = await chatWithToken4u(CHAT_INPUT, budget, deps);

    assert.strictEqual(result.isError, true);
    assert.ok(result.text.includes('Budget limit'));
    assert.ok(result.text.includes('0.01'));
    assert.ok(result.text.includes('TOKEN4U_BUDGET_LIMIT'));
  });

  it('rejects new calls when spent is already over limit', async () => {
    const budget = makeBudget({ limit: 0.01, spent: 0.02 });
    const deps = makeDeps();

    const result = await chatWithToken4u(CHAT_INPUT, budget, deps);

    assert.strictEqual(result.isError, true);
    assert.ok(result.text.includes('Budget limit'));
  });

  it('allows calls when spent is under limit', async () => {
    const budget = makeBudget({ limit: 0.02, spent: 0.005 });
    const deps = makeDeps();

    const result = await chatWithToken4u(CHAT_INPUT, budget, deps);

    assert.strictEqual(result.isError, false);
  });

  it('allows all calls when limit is null (unlimited)', async () => {
    const budget = makeBudget({ limit: null, spent: 9999 });
    const deps = makeDeps();

    const result = await chatWithToken4u(CHAT_INPUT, budget, deps);

    assert.strictEqual(result.isError, false);
  });

  // -----------------------------------------------------------------------
  // Success flow — body assembly
  // -----------------------------------------------------------------------

  it('sends stream:true in the request body', async () => {
    let captured: Record<string, unknown> = {};
    const budget = makeBudget();
    const deps = makeDeps({ paidChat: captureBody((b) => (captured = b)) });

    await chatWithToken4u(CHAT_INPUT, budget, deps);

    assert.strictEqual(captured.stream, true);
    assert.strictEqual(captured.model, 'deepseek-v3');
    assert.deepStrictEqual(captured.messages, CHAT_INPUT.messages);
    // max_tokens and temperature should NOT be present when omitted.
    assert.strictEqual(
      'max_tokens' in captured,
      false,
      'max_tokens should be absent when not provided',
    );
    assert.strictEqual(
      'temperature' in captured,
      false,
      'temperature should be absent when not provided',
    );
  });

  it('includes max_tokens and temperature in body when provided', async () => {
    let captured: Record<string, unknown> = {};
    const budget = makeBudget();
    const deps = makeDeps({ paidChat: captureBody((b) => (captured = b)) });

    const input: ChatInput = {
      model: 'deepseek-v3',
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 500,
      temperature: 0.7,
    };

    await chatWithToken4u(input, budget, deps);

    assert.strictEqual(captured.max_tokens, 500);
    assert.strictEqual(captured.temperature, 0.7);
  });

  it('includes temperature when it is 0 (defined, not undefined)', async () => {
    let captured: Record<string, unknown> = {};
    const budget = makeBudget();
    const deps = makeDeps({ paidChat: captureBody((b) => (captured = b)) });

    const input: ChatInput = {
      model: 'deepseek-v3',
      messages: [{ role: 'user', content: 'Hi' }],
      temperature: 0,
    };

    await chatWithToken4u(input, budget, deps);

    // temperature === 0 is defined, so it should be included.
    assert.strictEqual(captured.temperature, 0);
  });

  it('passes retryEmptyContent: true to paidChat (T118)', async () => {
    let capturedOpts: Record<string, unknown> | undefined;
    const budget = makeBudget();
    const deps = makeDeps({
      paidChat: async (_url, _body, _key, opts) => {
        capturedOpts = opts as Record<string, unknown> | undefined;
        return { content: 'OK', model: 'deepseek-v3', paidUsd: 0.01 };
      },
    });

    const result = await chatWithToken4u(CHAT_INPUT, budget, deps);

    assert.strictEqual(result.isError, false);
    assert.ok(capturedOpts, 'paidChat should have been called with options');
    assert.strictEqual(capturedOpts?.retryEmptyContent, true);
  });

  // -----------------------------------------------------------------------
  // Success flow — budget tracking
  // -----------------------------------------------------------------------

  it('increments budget.spent and budget.calls after a successful call', async () => {
    const budget = makeBudget();
    const deps = makeDeps({
      paidChat: async () => ({
        content: 'OK',
        model: 'deepseek-v3',
        paidUsd: 0.03,
      }),
    });

    assert.strictEqual(budget.spent, 0);
    assert.strictEqual(budget.calls, 0);

    await chatWithToken4u(CHAT_INPUT, budget, deps);

    assert.strictEqual(budget.spent, 0.03, 'spent should increase by paidUsd');
    assert.strictEqual(budget.calls, 1, 'calls should increment by 1');
  });

  it('accumulates budget correctly across multiple calls', async () => {
    const budget = makeBudget();
    const deps = makeDeps({
      paidChat: async () => ({
        content: 'OK',
        model: 'deepseek-v3',
        paidUsd: 0.01,
      }),
    });

    await chatWithToken4u(CHAT_INPUT, budget, deps);
    await chatWithToken4u(CHAT_INPUT, budget, deps);
    await chatWithToken4u(CHAT_INPUT, budget, deps);

    assert.strictEqual(budget.spent, 0.03);
    assert.strictEqual(budget.calls, 3);
  });

  // -----------------------------------------------------------------------
  // Success flow — response format
  // -----------------------------------------------------------------------

  it('formats the text response in blockrun-mcp style', async () => {
    const budget = makeBudget();
    const deps = makeDeps({
      paidChat: async () => ({
        content: 'Hello world!',
        model: 'deepseek-v3',
        paidUsd: 0.01,
      }),
    });

    const result = await chatWithToken4u(CHAT_INPUT, budget, deps);

    assert.strictEqual(result.isError, false);
    // [model | N msgs]\n\n{content}
    assert.ok(result.text.startsWith('[deepseek-v3 | 2 msgs]'));
    assert.ok(result.text.includes('\n\nHello world!'));
  });

  it('falls back to input.model when paidChat returns no model', async () => {
    const budget = makeBudget();
    const deps = makeDeps({
      paidChat: async () => ({
        content: 'Hi',
        // model is intentionally omitted.
        paidUsd: 0.01,
      }),
    });

    const result = await chatWithToken4u(
      { model: 'my-model', messages: [{ role: 'user', content: 'x' }] },
      budget,
      deps,
    );

    assert.ok(result.text.startsWith('[my-model | 1 msgs]'));
  });

  it('includes structuredContent with model_used, response, and paid_usd', async () => {
    const budget = makeBudget();
    const deps = makeDeps({
      paidChat: async () => ({
        content: 'Structured output',
        model: 'deepseek-v3',
        paidUsd: 0.015,
      }),
    });

    const result = await chatWithToken4u(CHAT_INPUT, budget, deps);

    assert.ok(result.structuredContent);
    assert.strictEqual(result.structuredContent?.model_used, 'deepseek-v3');
    assert.strictEqual(
      result.structuredContent?.response,
      'Structured output',
    );
    assert.strictEqual(result.structuredContent?.paid_usd, 0.015);
    assert.strictEqual(
      result.structuredContent?.session_id,
      undefined,
      'session_id should be absent when no session',
    );
  });

  it('includes session_id in structuredContent when returned', async () => {
    const budget = makeBudget();
    const deps = makeDeps({
      paidChat: async () => ({
        content: 'With session',
        model: 'deepseek-v3',
        paidUsd: 0.01,
        sessionId: 'sess-xyz-123',
      }),
    });

    const result = await chatWithToken4u(CHAT_INPUT, budget, deps);

    assert.strictEqual(result.structuredContent?.session_id, 'sess-xyz-123');
  });

  // -----------------------------------------------------------------------
  // PaymentError
  // -----------------------------------------------------------------------

  it('returns isError with deposit hint when PaymentError is thrown', async () => {
    const budget = makeBudget();
    const deps = makeDeps({
      paidChat: async () => {
        throw new PaymentError(
          'Insufficient USDC balance',
          402,
          '{"error":"insufficient"}',
        );
      },
    });

    const result = await chatWithToken4u(CHAT_INPUT, budget, deps);

    assert.strictEqual(result.isError, true);
    assert.ok(result.text.includes('Payment rejected'));
    assert.ok(result.text.includes('USDC balance'));
    assert.ok(result.text.includes('token4u_wallet'));
    assert.ok(result.text.includes('deposit'));
    assert.ok(result.text.includes('Insufficient USDC balance'));
  });

  it('does NOT update budget when PaymentError occurs', async () => {
    const budget = makeBudget();
    const deps = makeDeps({
      paidChat: async () => {
        throw new PaymentError('insufficient balance');
      },
    });

    await chatWithToken4u(CHAT_INPUT, budget, deps);

    assert.strictEqual(budget.spent, 0, 'spent should NOT change on error');
    assert.strictEqual(budget.calls, 0, 'calls should NOT change on error');
  });

  // -----------------------------------------------------------------------
  // Generic errors
  // -----------------------------------------------------------------------

  it('returns isError with "Error: " prefix for generic errors', async () => {
    const budget = makeBudget();
    const deps = makeDeps({
      paidChat: async () => {
        throw new Error('Network timeout');
      },
    });

    const result = await chatWithToken4u(CHAT_INPUT, budget, deps);

    assert.strictEqual(result.isError, true);
    assert.ok(result.text.startsWith('Error: '));
    assert.ok(result.text.includes('Network timeout'));
  });

  it('handles non-Error throws (string)', async () => {
    const budget = makeBudget();
    const deps = makeDeps({
      paidChat: async () => {
        // eslint-disable-next-line no-throw-literal
        throw 'raw string error';
      },
    });

    const result = await chatWithToken4u(CHAT_INPUT, budget, deps);

    assert.strictEqual(result.isError, true);
    assert.ok(result.text.startsWith('Error: '));
    assert.ok(result.text.includes('raw string error'));
  });

  it('does NOT update budget when generic error occurs', async () => {
    const budget = makeBudget({ spent: 1, calls: 5 });
    const deps = makeDeps({
      paidChat: async () => {
        throw new Error('fail');
      },
    });

    await chatWithToken4u(CHAT_INPUT, budget, deps);

    assert.strictEqual(budget.spent, 1, 'spent should not change');
    assert.strictEqual(budget.calls, 5, 'calls should not change');
  });
});
