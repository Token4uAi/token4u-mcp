import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BudgetState } from '../types.js';
import {
  getOrCreateLocalWallet,
  loadLocalWallet,
  getWalletFilePath,
} from '../utils/wallet.js';

// ---------------------------------------------------------------------------
// Result type (exported for tests)
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

// ---------------------------------------------------------------------------
// Action: status (default)
// ---------------------------------------------------------------------------

export async function walletActionStatus(): Promise<ToolCallResult> {
  const local = await loadLocalWallet();
  const lines: string[] = [];

  lines.push('=== Local Wallet ===');
  if (local) {
    lines.push(`Address: ${local.address}`);
    lines.push('Status: loaded');
  } else {
    lines.push('No local wallet found. Use action "create" to generate one.');
  }

  return ok(lines.join('\n'), {
    local_wallet_address: local?.address ?? null,
    is_new: local?.isNew ?? false,
  });
}

// ---------------------------------------------------------------------------
// Action: create
// ---------------------------------------------------------------------------

export async function walletActionCreate(): Promise<ToolCallResult> {
  const wallet = await getOrCreateLocalWallet();
  const keyFile = getWalletFilePath();

  const lines: string[] = [
    wallet.isNew
      ? '✅ New local wallet created!'
      : '✅ Local wallet loaded.',
    '',
    `Address: ${wallet.address}`,
    `Key file: ${keyFile}`,
    '',
    '⚠️  SECURITY NOTICE:',
    '- The private key is stored locally with 0o600 permissions.',
    '- It never leaves this MCP server.',
    '- Keep your key file secure and never share it.',
  ];

  return ok(lines.join('\n'), {
    address: wallet.address,
    is_new: wallet.isNew,
    key_file: keyFile,
  });
}

// ---------------------------------------------------------------------------
// Action: setup — funding guidance
// ---------------------------------------------------------------------------

export async function walletActionSetup(): Promise<ToolCallResult> {
  const wallet = await getOrCreateLocalWallet();
  const keyFile = getWalletFilePath();

  const lines: string[] = [
    '💰 How to fund your x402 wallet',
    '',
    `Your local wallet address: ${wallet.address}`,
    '',
    '=== Deposit USDC (Base Network) ===',
    '',
    '1. Open MetaMask (or any EVM wallet) and switch to Base network.',
    '2. Send USDC on Base to the address above.',
    '3. Wait for the transaction to confirm (~1-2 blocks).',
    '',
    '=== Export Private Key (self-custody) ===',
    '',
    `Your private key is stored at: ${keyFile}`,
    'File permissions: 0o600 (owner read/write only).',
    '',
    'You can import this key into MetaMask or any EVM wallet:',
    `- MetaMask: Settings → Import Account → paste the private key from ${keyFile}`,
    '- Rabby / Frame: similar "Import Private Key" flow.',
    '',
    '⚠️  WARNING:',
    '- Anyone with this private key can spend your USDC.',
    '- Never share your private key or wallet.json file.',
    '- This is a self-custody wallet — no recovery if key is lost.',
  ];

  return ok(lines.join('\n'), {
    address: wallet.address,
    is_new: wallet.isNew,
    key_file: keyFile,
  });
}

// ---------------------------------------------------------------------------
// MCP tool registration
// ---------------------------------------------------------------------------

/** Union of known action names (kept in sync with the zod schema). */
type WalletAction = 'status' | 'create' | 'setup';

export function registerWalletTool(
  server: McpServer,
  _budget: BudgetState,
): void {
  server.registerTool(
    'token4u_wallet',
    {
      description:
        'Manage local x402 wallet — create keypair, check status, and get funding guidance.\n\n' +
        'This is a pure external x402 mode: the MCP server manages a local wallet ' +
        '(~/.token4u-mcp/wallet.json, 0o600). All payments go through on-chain x402 USDC ' +
        'transactions on Base network. No token4u account or internal wallet required.\n\n' +
        'Actions:\n' +
        '- status (default): Show local wallet address and whether it is newly created.\n' +
        '- create: Generate a new local wallet keypair or load an existing one. ' +
        'The private key is stored at ~/.token4u-mcp/wallet.json with 0o600 permissions ' +
        'and never leaves this machine.\n' +
        '- setup: Show step-by-step funding instructions — how to send USDC on Base ' +
        'to your local wallet address, and how to export the private key for self-custody.',
      inputSchema: {
        action: z
          .enum(['status', 'create', 'setup'])
          .optional()
          .default('status')
          .describe('Which wallet operation to perform'),
      },
    },
    async (params) => {
      const action = params.action as WalletAction;

      try {
        switch (action) {
          case 'status':
            return await walletActionStatus();
          case 'create':
            return await walletActionCreate();
          case 'setup':
            return await walletActionSetup();
          default:
            return fail(`Unknown action: ${action}`);
        }
      } catch (err) {
        return fail(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}
