import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BudgetState } from '../types.js';
import {
  token4u,
  Token4uApiError,
} from '../utils/token4u-api.js';
import type { ConsumptionItem, PaginatedConsumption } from '../utils/token4u-api.js';

// ---------------------------------------------------------------------------
// Result type (shared with wallet.ts — keep in sync)
// ---------------------------------------------------------------------------

export interface ToolCallResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok(text: string, structured: Record<string, unknown>): ToolCallResult {
  return { content: [{ type: 'text', text }], structuredContent: structured };
}

function fail(message: string): ToolCallResult {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { error: message },
    isError: true,
  };
}

function failApi(err: Token4uApiError): ToolCallResult {
  return fail(`API Error: ${err.message}`);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatConsumptionItem(item: ConsumptionItem): string {
  const model = item.model ?? '-';
  const totalTokens = item.total_tokens ?? '-';
  const credits = item.credits ?? '-';
  const amountUsd = item.amount_usd ?? '-';
  const txHash = item.tx_hash ?? '-';
  const createTime = item.create_time ?? '-';
  return `${model} | ${totalTokens} | ${credits} | ${amountUsd} | ${txHash} | ${createTime}`;
}

function formatConsumptionPage(page: PaginatedConsumption): string {
  const header = `Consumption records (total: ${page.total})\n`;
  const colHeader = 'model | total_tokens | credits | amount_usd | tx_hash | create_time\n';
  const sep = `${'-'.repeat(80)}\n`;
  const rows = page.items.map((item) => formatConsumptionItem(item)).join('\n');

  const lines: string[] = [header + colHeader + sep + rows];

  // Pagination info if total > items length.
  if (page.total > 0 && page.items.length > 0) {
    lines.push(
      `\nShowing ${page.items.length} of ${page.total} records. ` +
        'Use page/page_size to navigate.',
    );
  }

  return lines.join('');
}

// ---------------------------------------------------------------------------
// Core logic (exported for testing)
// ---------------------------------------------------------------------------

export interface ConsumptionDeps {
  getConsumption: (address: string, page: number, pageSize: number) => Promise<PaginatedConsumption>;
}

/**
 * Query x402 consumption records for a given EVM address.
 *
 * This is a public API — no login required.
 *
 * @param address  EVM wallet address (0x...).
 * @param page     1-indexed page number (default 1).
 * @param pageSize Items per page (default 10).
 * @param deps     Injected dependencies for testability.
 */
export async function getConsumptionAction(
  address: string,
  page: number,
  pageSize: number,
  deps?: ConsumptionDeps,
): Promise<ToolCallResult> {
  // Guard: address is required.
  if (!address || address.trim() === '') {
    return fail('Address is required (0x... EVM wallet address).');
  }

  const getter = deps?.getConsumption ?? token4u.getConsumption.bind(token4u);

  let result: PaginatedConsumption;
  try {
    result = await getter(address, page, pageSize);
  } catch (err) {
    if (err instanceof Token4uApiError) return failApi(err);
    return fail(`Error: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!result.items || result.items.length === 0) {
    return ok(`No consumption records found for address ${address}.`, {
      data: [],
      total: result.total ?? 0,
      page,
      page_size: pageSize,
    });
  }

  const text = formatConsumptionPage(result);

  return ok(text, {
    data: result.items,
    total: result.total,
    page,
    page_size: pageSize,
  });
}

// ---------------------------------------------------------------------------
// MCP tool registration
// ---------------------------------------------------------------------------

export function registerConsumptionTool(
  server: McpServer,
  _budget: BudgetState,
): void {
  server.registerTool(
    'token4u_consumption',
    {
      description:
        'Query x402 consumption records for a given EVM wallet address. ' +
        'Public API — no login required. ' +
        'Returns per-call records with model, token usage, credits, amount paid in USD, ' +
        'transaction hash, and timestamp.',
      inputSchema: {
        address: z
          .string()
          .describe('EVM wallet address (0x...) to query x402 consumption records for'),
        page: z
          .number()
          .optional()
          .describe('Page number, default 1'),
        page_size: z
          .number()
          .optional()
          .describe('Page size, default 10'),
      },
    },
    async (params) => {
      const address = typeof params.address === 'string' ? params.address : '';
      const page =
        typeof params.page === 'number' && params.page > 0 ? params.page : 1;
      const pageSize =
        typeof params.page_size === 'number' && params.page_size > 0
          ? params.page_size
          : 10;

      try {
        return await getConsumptionAction(address, page, pageSize);
      } catch (err) {
        if (err instanceof Token4uApiError) return failApi(err);
        return fail(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}
