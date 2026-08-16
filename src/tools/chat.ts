import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { BudgetState } from '../types.js';
import { TOKEN4U_API_URL, TOKEN4U_TIMEOUT_MS } from '../config.js';
import { loadLocalWallet } from '../utils/wallet.js';
import type { LocalWallet } from '../utils/wallet.js';
import { paidChatCompletion, PaymentError } from '../utils/x402.js';
import type { PaidChatResult, PaidChatOptions } from '../utils/x402.js';

// Re-export for test convenience.
export { PaymentError };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChatInput {
  model: string;
  messages: Array<{ role: string; content: string }>;
  max_tokens?: number;
  temperature?: number;
}

export interface ChatWithToken4uResult {
  isError: boolean;
  text: string;
  structuredContent?: Record<string, unknown>;
}

/**
 * Injectable dependencies for `chatWithToken4u`.
 *
 * In production the defaults wire to the real `loadLocalWallet`,
 * `paidChatCompletion`, and `TOKEN4U_API_URL`. Tests inject mocks through
 * this interface so they never touch the filesystem or the network.
 */
export interface ChatDeps {
  loadWallet: () => LocalWallet | null | Promise<LocalWallet | null>;
  paidChat: (
    baseUrl: string,
    body: Record<string, unknown>,
    privateKey: `0x${string}`,
    opts?: PaidChatOptions,
  ) => Promise<PaidChatResult>;
  apiUrl: string;
}

const defaultDeps: ChatDeps = {
  loadWallet: async () => loadLocalWallet(),
  paidChat: paidChatCompletion,
  apiUrl: TOKEN4U_API_URL,
};

// ---------------------------------------------------------------------------
// Core logic (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Execute a paid chat completion through token4u's x402 endpoint.
 *
 * This is the pure-logic core — it does **not** touch the MCP layer so it
 * can be tested with injected mocks.
 */
export async function chatWithToken4u(
  input: ChatInput,
  budget: BudgetState,
  deps: ChatDeps = defaultDeps,
): Promise<ChatWithToken4uResult> {
  // 1. Load local wallet.
  const wallet = await deps.loadWallet();
  if (!wallet) {
    return {
      isError: true,
      text: 'No local wallet found. Run token4u_wallet with action="create" first.',
    };
  }

  // 2. Budget check — reject when already at or over the limit.
  if (budget.limit !== null && budget.spent >= budget.limit) {
    return {
      isError: true,
      text:
        `Budget limit of $${budget.limit.toFixed(2)} exceeded ` +
        `(spent: $${budget.spent.toFixed(2)}). ` +
        `Increase TOKEN4U_BUDGET_LIMIT or wait for the current budget window to reset.`,
    };
  }

  // 3. Build request body (stream: true per the token4u API contract).
  const body: Record<string, unknown> = {
    model: input.model,
    messages: input.messages,
    stream: true,
  };
  if (input.max_tokens !== undefined) body.max_tokens = input.max_tokens;
  if (input.temperature !== undefined) body.temperature = input.temperature;

  // 4. Execute the x402 paid chat completion.
  let result: PaidChatResult;
  try {
    result = await deps.paidChat(deps.apiUrl, body, wallet.privateKey, {
      timeoutMs: TOKEN4U_TIMEOUT_MS,
      // T118: thinking models (deepseek-v4-flash) randomly return empty
      // `content`. Re-run the full paid flow up to 2× on empty content so
      // the MCP tool doesn't surface an empty answer to the caller. Each
      // retry pays again — result.paidUsd is the cumulative total.
      retryEmptyContent: true,
    });
  } catch (err) {
    if (err instanceof PaymentError) {
      return {
        isError: true,
        text:
          'Payment rejected — check your USDC balance. ' +
          'Run token4u_wallet action=deposit to get the top-up address.\n\n' +
          `Error: ${err.message}`,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      text: `Error: ${message}`,
    };
  }

  // 5. Update budget tracking.
  budget.spent += result.paidUsd;
  budget.calls += 1;

  // 6. Format response (blockrun-mcp style).
  const model = result.model ?? input.model;
  const msgCount = input.messages.length;
  const text = `[${model} | ${msgCount} msgs]\n\n${result.content}`;

  const structuredContent: Record<string, unknown> = {
    model_used: model,
    response: result.content,
    paid_usd: result.paidUsd,
  };
  if (result.sessionId) {
    structuredContent.session_id = result.sessionId;
  }

  return { isError: false, text, structuredContent };
}

// ---------------------------------------------------------------------------
// MCP tool registration
// ---------------------------------------------------------------------------

export function registerChatTool(
  server: McpServer,
  budget: BudgetState,
): void {
  server.registerTool(
    'token4u_chat',
    {
      description:
        'Chat with AI models via token4u using x402 micropayments (USDC on Base). ' +
        'Each call is priced per-model and paid via an EIP-3009 authorization ' +
        'from your local wallet. Requires a wallet — run token4u_wallet ' +
        'action=create first.',
      inputSchema: {
        model: z.string().describe('token4u model name (e.g. deepseek-v3)'),
        messages: z.array(
          z.object({
            role: z.enum(['system', 'user', 'assistant']),
            content: z.string(),
          }),
        ),
        max_tokens: z
          .number()
          .optional()
          .describe('Maximum tokens in the response'),
        temperature: z
          .number()
          .optional()
          .describe('Sampling temperature (0-2)'),
      },
    },
    async (params) => {
      const input: ChatInput = {
        model: params.model as string,
        messages: params.messages as Array<{ role: string; content: string }>,
        max_tokens: params.max_tokens as number | undefined,
        temperature: params.temperature as number | undefined,
      };

      const result = await chatWithToken4u(input, budget);

      return {
        content: [{ type: 'text' as const, text: result.text }],
        isError: result.isError,
        ...(result.structuredContent
          ? { structuredContent: result.structuredContent }
          : {}),
      };
    },
  );
}
