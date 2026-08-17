import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import type http from 'node:http';

import { startOpenAIAdapter } from '../src/adapter/openai-server.js';
import type { AdapterDeps, OpenAIModelList } from '../src/adapter/openai-server.js';
import type { PaidChatResult } from '../src/utils/x402.js';
import { PaymentError } from '../src/utils/x402.js';
import type { LocalWallet } from '../src/utils/wallet.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_WALLET: LocalWallet = {
  address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  isNew: false,
};

const MOCK_CHAT_RESULT: PaidChatResult = {
  content: 'Hello from token4u!',
  model: 'deepseek-v3',
  paidUsd: 0.001,
  sessionId: 'sess-test',
  usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
};

function setupAdapter(
  deps: Partial<AdapterDeps> = {},
): Promise<{ baseUrl: string; server: http.Server }> {
  return startOpenAIAdapter(0, deps).then((server) => {
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 8787;
    return { baseUrl: `http://localhost:${port}`, server };
  });
}

function fakePaidChat(_result?: PaidChatResult) {
  return async () => _result ?? MOCK_CHAT_RESULT;
}

function fakePaidChatError(msg: string) {
  return async () => {
    throw new PaymentError(msg, 402, JSON.stringify({ error: msg }));
  };
}

function fakeLoadWallet(wallet: LocalWallet | null) {
  return async () => wallet;
}

/** Mock globalThis.fetch for the /api/pricing endpoint. */
function mockPricingResponse(
  status: number,
  body: unknown,
): { restore: () => void } {
  const original = globalThis.fetch as typeof fetch;

  globalThis.fetch = (async (url: unknown, _init?: unknown) => {
    const urlStr = String(url);
    if (urlStr.includes('/api/pricing')) {
      return {
        status,
        ok: status >= 200 && status < 300,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => body,
        text: async () => JSON.stringify(body),
        body: null,
      } as unknown as Response;
    }
    // Pass through other requests.
    return original(url as RequestInfo, _init as RequestInit | undefined);
  }) as typeof fetch;

  return {
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

// Save/restore env for auth tests.
function setEnv(key: string, value: string | undefined) {
  const prev = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  return () => {
    if (prev === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prev;
    }
  };
}

let originalFetch: typeof fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.TOKEN4U_PROXY_KEY;
});

// ---------------------------------------------------------------------------
// GET /v1/models
// ---------------------------------------------------------------------------

describe('GET /v1/models', () => {
  it('returns model list from /api/pricing (data array)', async () => {
    const pricingBody = {
      data: [
        { model_name: 'deepseek-v3', created: 1735689600, provider: 'deepseek' },
        { model_name: 'gpt-4o-mini', created: 1710800000, provider: 'openai' },
      ],
    };
    const mock = mockPricingResponse(200, pricingBody);
    const { baseUrl, server } = await setupAdapter();

    try {
      const res = await fetch(`${baseUrl}/v1/models`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers.get('content-type'), 'application/json');

      const json = (await res.json()) as OpenAIModelList;
      assert.strictEqual(json.object, 'list');
      assert.ok(Array.isArray(json.data));
      assert.ok(json.data.length >= 2);

      const deepseek = json.data.find((m) => m.id === 'deepseek-v3');
      assert.ok(deepseek);
      assert.strictEqual(deepseek.object, 'model');
      assert.strictEqual(deepseek.owned_by, 'deepseek');
      assert.strictEqual(deepseek.created, 1735689600);
    } finally {
      server.close();
      mock.restore();
    }
  });

  it('returns model list from /api/pricing (top-level array)', async () => {
    const pricingBody = [
      { id: 'claude-sonnet-5', provider: 'anthropic' },
    ];
    const mock = mockPricingResponse(200, pricingBody);
    const { baseUrl, server } = await setupAdapter();

    try {
      const res = await fetch(`${baseUrl}/v1/models`);
      assert.strictEqual(res.status, 200);

      const json = (await res.json()) as OpenAIModelList;
      assert.strictEqual(json.object, 'list');
      const model = json.data.find((m) => m.id === 'claude-sonnet-5');
      assert.ok(model);
      assert.strictEqual(model.owned_by, 'anthropic');
    } finally {
      server.close();
      mock.restore();
    }
  });

  it('falls back to default models when /api/pricing fails', async () => {
    const mock = mockPricingResponse(500, { error: 'down' });
    const { baseUrl, server } = await setupAdapter();

    try {
      const res = await fetch(`${baseUrl}/v1/models`);
      assert.strictEqual(res.status, 200);

      const json = (await res.json()) as OpenAIModelList;
      assert.strictEqual(json.object, 'list');
      // Should contain at least deepseek-v3 and gpt-4o-mini.
      const ids = json.data.map((m) => m.id);
      assert.ok(ids.includes('deepseek-v3'), `Expected deepseek-v3, got: ${ids.join(',')}`);
      assert.ok(ids.includes('gpt-4o-mini'), `Expected gpt-4o-mini, got: ${ids.join(',')}`);
    } finally {
      server.close();
      mock.restore();
    }
  });

  it('falls back when /api/pricing returns empty array', async () => {
    const mock = mockPricingResponse(200, { data: [] });
    const { baseUrl, server } = await setupAdapter();

    try {
      const res = await fetch(`${baseUrl}/v1/models`);
      assert.strictEqual(res.status, 200);

      const json = (await res.json()) as OpenAIModelList;
      // Should fall back — empty array triggers fallback.
      const ids = json.data.map((m) => m.id);
      assert.ok(ids.includes('deepseek-v3'));
    } finally {
      server.close();
      mock.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// POST /v1/chat/completions — success
// ---------------------------------------------------------------------------

describe('POST /v1/chat/completions — success', () => {
  it('returns OpenAI-format completion', async () => {
    const { baseUrl, server } = await setupAdapter({
      paidChat: fakePaidChat(),
      loadWallet: fakeLoadWallet(MOCK_WALLET),
    });

    try {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'deepseek-v3',
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers.get('content-type'), 'application/json');

      const json = (await res.json()) as Record<string, unknown>;
      assert.strictEqual(json.object, 'chat.completion');
      assert.ok(typeof json.id === 'string' && json.id.startsWith('chatcmpl-'));
      assert.strictEqual(json.model, 'deepseek-v3');
      assert.ok(typeof json.created === 'number');

      const choices = json.choices as Array<Record<string, unknown>>;
      assert.strictEqual(choices.length, 1);
      assert.strictEqual(choices[0].index, 0);

      const message = choices[0].message as Record<string, unknown>;
      assert.strictEqual(message.role, 'assistant');
      assert.strictEqual(message.content, 'Hello from token4u!');
      assert.strictEqual(choices[0].finish_reason, 'stop');

      const usage = json.usage as Record<string, unknown> | undefined;
      assert.ok(usage);
      assert.strictEqual(usage.prompt_tokens, 10);
      assert.strictEqual(usage.completion_tokens, 5);
      assert.strictEqual(usage.total_tokens, 15);
    } finally {
      server.close();
    }
  });

  it('passes through extra params (max_tokens, temperature)', async () => {
    let capturedBody: Record<string, unknown> | null = null;

    const { baseUrl, server } = await setupAdapter({
      paidChat: async (_url, body) => {
        capturedBody = body;
        return MOCK_CHAT_RESULT;
      },
      loadWallet: fakeLoadWallet(MOCK_WALLET),
    });

    try {
      await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'deepseek-v3',
          messages: [{ role: 'user', content: 'Hi' }],
          max_tokens: 256,
          temperature: 0.7,
        }),
      });

      assert.ok(capturedBody);
      assert.strictEqual((capturedBody as Record<string, unknown>).max_tokens, 256);
      assert.strictEqual((capturedBody as Record<string, unknown>).temperature, 0.7);
      // stream should NOT be in captured body (it's stripped).
      assert.strictEqual((capturedBody as Record<string, unknown>).stream, undefined);
    } finally {
      server.close();
    }
  });

  it('passes retryEmptyContent: true to paidChat (T118)', async () => {
    let capturedOpts: Record<string, unknown> | undefined;

    const { baseUrl, server } = await setupAdapter({
      paidChat: async (_url, _body, _key, opts) => {
        capturedOpts = opts as Record<string, unknown> | undefined;
        return MOCK_CHAT_RESULT;
      },
      loadWallet: fakeLoadWallet(MOCK_WALLET),
    });

    try {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'deepseek-v3',
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      });

      assert.strictEqual(res.status, 200);
      assert.ok(capturedOpts, 'paidChat should have been called with options');
      assert.strictEqual(capturedOpts?.retryEmptyContent, true);
    } finally {
      server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// POST /v1/chat/completions — streaming
// ---------------------------------------------------------------------------

describe('POST /v1/chat/completions — streaming', () => {
  it('returns SSE stream when stream:true', async () => {
    const { baseUrl, server } = await setupAdapter({
      paidChat: fakePaidChat(),
      loadWallet: fakeLoadWallet(MOCK_WALLET),
    });

    try {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'deepseek-v3',
          messages: [{ role: 'user', content: 'Hello' }],
          stream: true,
        }),
      });

      assert.strictEqual(res.status, 200);
      assert.ok(
        (res.headers.get('content-type') ?? '').includes('text/event-stream'),
      );

      const text = await res.text();
      const lines = text
        .split('\n')
        .map((l) => l.trimEnd())
        .filter((l) => l.startsWith('data: '));

      assert.ok(lines.length >= 2, `Expected >=2 SSE lines, got: ${text}`);

      // Last line should be [DONE].
      assert.strictEqual(lines[lines.length - 1], 'data: [DONE]');

      // First line should be a chunk with the content.
      const chunkJson = lines[0].slice(6); // strip "data: "
      const chunk = JSON.parse(chunkJson) as Record<string, unknown>;
      assert.strictEqual(chunk.object, 'chat.completion.chunk');
      const choices = chunk.choices as Array<Record<string, unknown>>;
      const delta = choices[0].delta as Record<string, unknown>;
      assert.strictEqual(delta.content, 'Hello from token4u!');
    } finally {
      server.close();
    }
  });

  it('forwards finish_reason from onDelta deltas (T119)', async () => {
    const { baseUrl, server } = await setupAdapter({
      paidChat: async (_url, _body, _key, opts) => {
        opts?.onDelta?.({
          content: 'Hi',
          reasoningContent: undefined,
          finishReason: 'stop',
        });
        return MOCK_CHAT_RESULT;
      },
      loadWallet: fakeLoadWallet(MOCK_WALLET),
    });

    try {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'deepseek-v3',
          messages: [{ role: 'user', content: 'Hi' }],
          stream: true,
        }),
      });

      const text = await res.text();
      const lines = text
        .split('\n')
        .map((l) => l.trimEnd())
        .filter((l) => l.startsWith('data: '));

      assert.strictEqual(lines[lines.length - 1], 'data: [DONE]');

      const chunkLines = lines.filter((l) => l !== 'data: [DONE]');
      assert.strictEqual(chunkLines.length, 1);
      const chunk = JSON.parse(chunkLines[0].slice(6)) as Record<string, unknown>;
      const choices = chunk.choices as Array<Record<string, unknown>>;
      assert.strictEqual(choices[0].finish_reason, 'stop');
    } finally {
      server.close();
    }
  });

  it('emits an explicit error chunk when the final content is empty (T119)', async () => {
    const { baseUrl, server } = await setupAdapter({
      paidChat: async () => ({
        content: '',
        model: 'deepseek-v3',
        paidUsd: 0.001,
      }),
      loadWallet: fakeLoadWallet(MOCK_WALLET),
    });

    try {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'deepseek-v3',
          messages: [{ role: 'user', content: 'Hi' }],
          stream: true,
        }),
      });

      const text = await res.text();
      const lines = text
        .split('\n')
        .map((l) => l.trimEnd())
        .filter((l) => l.startsWith('data: '));

      assert.strictEqual(lines[lines.length - 1], 'data: [DONE]');

      const chunkLines = lines.filter((l) => l !== 'data: [DONE]');
      assert.strictEqual(chunkLines.length, 1);
      const chunk = JSON.parse(chunkLines[0].slice(6)) as Record<string, unknown>;
      assert.strictEqual((chunk.choices as unknown[]).length, 0);
      const err = chunk.error as Record<string, unknown>;
      assert.ok(err);
      assert.strictEqual(err.type, 'server_error');
    } finally {
      server.close();
    }
  });

  it('terminates the stream immediately via onEmptyContent on empty content (T120)', async () => {
    let onEmptyWired = false;
    const { baseUrl, server } = await setupAdapter({
      paidChat: async (_url, _body, _key, opts) => {
        // Simulate x402: the first attempt is empty → fire onEmptyContent so
        // the adapter ends the client now; the (background) retries resolve
        // with still-empty content afterwards.
        opts?.onEmptyContent?.();
        onEmptyWired = true;
        return { content: '', model: 'deepseek-v3', paidUsd: 0.002 };
      },
      loadWallet: fakeLoadWallet(MOCK_WALLET),
    });

    try {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'deepseek-v3',
          messages: [{ role: 'user', content: 'Hi' }],
          stream: true,
        }),
      });

      const text = await res.text();
      const lines = text
        .split('\n')
        .map((l) => l.trimEnd())
        .filter((l) => l.startsWith('data: '));

      assert.ok(onEmptyWired, 'adapter should pass onEmptyContent to paidChat');
      assert.strictEqual(lines[lines.length - 1], 'data: [DONE]');

      const chunkLines = lines.filter((l) => l !== 'data: [DONE]');
      assert.strictEqual(chunkLines.length, 1);
      const chunk = JSON.parse(chunkLines[0].slice(6)) as Record<string, unknown>;
      assert.strictEqual((chunk.choices as unknown[]).length, 0);
      const err = chunk.error as Record<string, unknown>;
      assert.ok(err);
      assert.strictEqual(err.code, 'empty_completion');
    } finally {
      server.close();
    }
  });

  it('maps finish_reason "tool_calls" to "stop" (T120)', async () => {
    const { baseUrl, server } = await setupAdapter({
      paidChat: async (_url, _body, _key, opts) => {
        opts?.onDelta?.({ content: 'Hi', finishReason: 'tool_calls' });
        return MOCK_CHAT_RESULT;
      },
      loadWallet: fakeLoadWallet(MOCK_WALLET),
    });

    try {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'deepseek-v3',
          messages: [{ role: 'user', content: 'Hi' }],
          stream: true,
        }),
      });

      const text = await res.text();
      const lines = text
        .split('\n')
        .map((l) => l.trimEnd())
        .filter((l) => l.startsWith('data: '));

      assert.strictEqual(lines[lines.length - 1], 'data: [DONE]');

      const chunkLines = lines.filter((l) => l !== 'data: [DONE]');
      assert.strictEqual(chunkLines.length, 1);
      const chunk = JSON.parse(chunkLines[0].slice(6)) as Record<string, unknown>;
      const choices = chunk.choices as Array<Record<string, unknown>>;
      assert.strictEqual(choices[0].finish_reason, 'stop');
    } finally {
      server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// POST /v1/chat/completions — errors
// ---------------------------------------------------------------------------

describe('POST /v1/chat/completions — errors', () => {
  it('returns 400 for missing model', async () => {
    const { baseUrl, server } = await setupAdapter({
      loadWallet: fakeLoadWallet(MOCK_WALLET),
    });

    try {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'Hi' }] }),
      });

      assert.strictEqual(res.status, 400);
      const json = (await res.json()) as Record<string, unknown>;
      const err = json.error as Record<string, unknown>;
      assert.ok(String(err.message).includes('model'));
    } finally {
      server.close();
    }
  });

  it('returns 400 for missing messages', async () => {
    const { baseUrl, server } = await setupAdapter({
      loadWallet: fakeLoadWallet(MOCK_WALLET),
    });

    try {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'deepseek-v3' }),
      });

      assert.strictEqual(res.status, 400);
    } finally {
      server.close();
    }
  });

  it('returns 400 for empty messages array', async () => {
    const { baseUrl, server } = await setupAdapter({
      loadWallet: fakeLoadWallet(MOCK_WALLET),
    });

    try {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'deepseek-v3', messages: [] }),
      });

      assert.strictEqual(res.status, 400);
    } finally {
      server.close();
    }
  });

  it('returns 400 for invalid JSON body', async () => {
    const { baseUrl, server } = await setupAdapter();

    try {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json {{{',
      });

      assert.strictEqual(res.status, 400);
    } finally {
      server.close();
    }
  });

  it('returns 500 when no wallet exists', async () => {
    const { baseUrl, server } = await setupAdapter({
      loadWallet: fakeLoadWallet(null),
    });

    try {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'deepseek-v3',
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      });

      assert.strictEqual(res.status, 500);
      const json = (await res.json()) as Record<string, unknown>;
      const err = json.error as Record<string, unknown>;
      assert.ok(
        String(err.message).includes('wallet'),
        `Expected wallet mention, got: ${err.message as string}`,
      );
    } finally {
      server.close();
    }
  });

  it('returns 402 on PaymentError', async () => {
    const { baseUrl, server } = await setupAdapter({
      paidChat: fakePaidChatError('Insufficient USDC balance'),
      loadWallet: fakeLoadWallet(MOCK_WALLET),
    });

    try {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'deepseek-v3',
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      });

      assert.strictEqual(res.status, 402);
      const json = (await res.json()) as Record<string, unknown>;
      const err = json.error as Record<string, unknown>;
      assert.strictEqual(err.type, 'payment_required');
      assert.strictEqual(err.code, 'x402_payment_rejected');
      assert.ok(
        String(err.message).includes('Insufficient USDC balance'),
      );
    } finally {
      server.close();
    }
  });

  it('returns 500 on generic error', async () => {
    const { baseUrl, server } = await setupAdapter({
      paidChat: async () => {
        throw new Error('Boom!');
      },
      loadWallet: fakeLoadWallet(MOCK_WALLET),
    });

    try {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'deepseek-v3',
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      });

      assert.strictEqual(res.status, 500);
      const json = (await res.json()) as Record<string, unknown>;
      const err = json.error as Record<string, unknown>;
      assert.ok(String(err.message).includes('Boom!'));
    } finally {
      server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// POST /v1/chat/completions — auth (TOKEN4U_PROXY_KEY)
// ---------------------------------------------------------------------------

describe('POST /v1/chat/completions — auth', () => {
  let restoreKey: () => void;

  afterEach(() => {
    if (restoreKey) restoreKey();
  });

  it('returns 401 when proxy key is set and auth header is missing', async () => {
    restoreKey = setEnv('TOKEN4U_PROXY_KEY', 'secret-api-key');

    const { baseUrl, server } = await setupAdapter({
      loadWallet: fakeLoadWallet(MOCK_WALLET),
    });

    try {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'deepseek-v3',
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      });

      assert.strictEqual(res.status, 401);
      const json = (await res.json()) as Record<string, unknown>;
      const err = json.error as Record<string, unknown>;
      assert.strictEqual(err.type, 'authentication_error');
    } finally {
      server.close();
    }
  });

  it('returns 401 when proxy key is set and auth header is wrong', async () => {
    restoreKey = setEnv('TOKEN4U_PROXY_KEY', 'secret-api-key');

    const { baseUrl, server } = await setupAdapter({
      loadWallet: fakeLoadWallet(MOCK_WALLET),
    });

    try {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer wrong-key',
        },
        body: JSON.stringify({
          model: 'deepseek-v3',
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      });

      assert.strictEqual(res.status, 401);
    } finally {
      server.close();
    }
  });

  it('returns 200 when proxy key is set and auth header is correct', async () => {
    restoreKey = setEnv('TOKEN4U_PROXY_KEY', 'secret-api-key');

    const { baseUrl, server } = await setupAdapter({
      paidChat: fakePaidChat(),
      loadWallet: fakeLoadWallet(MOCK_WALLET),
    });

    try {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer secret-api-key',
        },
        body: JSON.stringify({
          model: 'deepseek-v3',
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      });

      assert.strictEqual(res.status, 200);
    } finally {
      server.close();
    }
  });

  it('accepts any key when proxy key is not set', async () => {
    const { baseUrl, server } = await setupAdapter({
      paidChat: fakePaidChat(),
      loadWallet: fakeLoadWallet(MOCK_WALLET),
    });

    try {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer anything-goes',
        },
        body: JSON.stringify({
          model: 'deepseek-v3',
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      });

      assert.strictEqual(res.status, 200);
    } finally {
      server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

describe('Misc', () => {
  it('returns 404 for unknown routes', async () => {
    const { baseUrl, server } = await setupAdapter();

    try {
      const res = await fetch(`${baseUrl}/v1/unknown`);
      assert.strictEqual(res.status, 404);

      const json = (await res.json()) as Record<string, unknown>;
      const err = json.error as Record<string, unknown>;
      assert.ok(String(err.message).includes('Not found'));
    } finally {
      server.close();
    }
  });

  it('starts on port 0 (OS-assigned)', async () => {
    const { baseUrl, server } = await setupAdapter();

    try {
      assert.ok(baseUrl.includes('localhost'));
      // Verify the server is actually listening.
      const res = await fetch(`${baseUrl}/v1/models`);
      assert.strictEqual(res.status, 200);
    } finally {
      server.close();
    }
  });
});
