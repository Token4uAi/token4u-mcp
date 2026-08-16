import os from 'os';
import path from 'path';

export const TOKEN4U_API_URL =
  process.env.TOKEN4U_API_URL ?? 'https://token4u.ai';

export const TOKEN4U_DATA_DIR =
  process.env.TOKEN4U_DATA_DIR ?? path.join(os.homedir(), '.token4u-mcp');

export const TOKEN4U_WALLET_KEY = process.env.TOKEN4U_WALLET_KEY;

export const TOKEN4U_BUDGET_LIMIT = process.env.TOKEN4U_BUDGET_LIMIT;

/**
 * Upstream x402 chat-completion timeout in ms.
 *
 * Default 300s: deepseek-v4-flash (and other thinking models) spend a large
 * fraction of generation time on reasoning_content before producing the
 * final answer. The previous hard 30s AbortSignal.timeout caused long,
 * reasoning-heavy requests to be aborted server-side with
 * "The operation was aborted due to timeout" (HTTP 500) — the 0.3.17
 * reasoning passthrough (T112) was unreachable for exactly the requests it
 * was meant to fix. Override via TOKEN4U_TIMEOUT_MS.
 */
export const TOKEN4U_TIMEOUT_MS = process.env.TOKEN4U_TIMEOUT_MS
  ? parseInt(process.env.TOKEN4U_TIMEOUT_MS, 10)
  : 300_000;

/**
 * Activity-based idle timeout for streaming chat responses (ms).
 *
 * While a stream is being read, every arriving chunk resets this timer; only
 * when no chunk lands for this long is the stream aborted. This is the primary
 * disconnect mechanism for long thinking-model streams (T117) — a stream that
 * keeps producing data is never cut, no matter how long the total wall-clock
 * time is. Default 60s. Override via TOKEN4U_STREAM_IDLE_TIMEOUT_MS.
 */
export const TOKEN4U_STREAM_IDLE_TIMEOUT_MS = process.env
  .TOKEN4U_STREAM_IDLE_TIMEOUT_MS
  ? parseInt(process.env.TOKEN4U_STREAM_IDLE_TIMEOUT_MS, 10)
  : 60_000;

/**
 * Total streaming safety-net timeout (ms).
 *
 * A hard upper bound on a single streaming segment (main fetch or top-up
 * resume) to prevent a deadlock where the server keeps the connection open
 * forever without ever closing it. The idle timeout above does the
 * day-to-day disconnection; this is only a backstop. Default 900s — long
 * enough for large contexts (39–51 萬 tokens) + thinking models whose total
 * stream time can exceed 300s. Override via TOKEN4U_STREAM_TOTAL_TIMEOUT_MS.
 */
export const TOKEN4U_STREAM_TOTAL_TIMEOUT_MS = process.env
  .TOKEN4U_STREAM_TOTAL_TIMEOUT_MS
  ? parseInt(process.env.TOKEN4U_STREAM_TOTAL_TIMEOUT_MS, 10)
  : 900_000;

export const TOKEN4U_PROXY_PORT = process.env.TOKEN4U_PROXY_PORT
  ? parseInt(process.env.TOKEN4U_PROXY_PORT, 10)
  : null;

export const TOKEN4U_PROXY_KEY = process.env.TOKEN4U_PROXY_KEY;

export const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

export const BASE_CHAIN_ID = 8453;

/** Base RPC URL for on-chain allowance / nonce checks (eth_call). */
export const BASE_RPC_URL =
  process.env.BASE_RPC_URL ?? 'https://mainnet.base.org';

export const EIP3009_DOMAIN = {
  name: 'USD Coin',
  version: '2',
  chainId: 8453,
  verifyingContract: USDC_BASE,
};

// ---------------------------------------------------------------------------
// EIP-2612 domain (USDC on Base — shared with EIP-3009 above)
// ---------------------------------------------------------------------------

/** EIP-712 domain for USDC EIP-2612 permit on Base. */
export const USDC_EIP2612_DOMAIN = {
  name: 'USD Coin',
  version: '2',
  chainId: 8453,
  verifyingContract: USDC_BASE,
} as const;

// ---------------------------------------------------------------------------
// Permit2 constants (upto scheme)
// ---------------------------------------------------------------------------

/** Permit2 canonical contract (CREATE2, same address on all EVM chains). */
export const PERMIT2_CONTRACT =
  '0x000000000022D473030F116dDEE9F6B43aC78BA3';

/** x402 Upto Permit2 proxy — the spender in PermitWitnessTransferFrom. */
export const PERMIT2_SPENDER =
  '0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002';

/** EIP-712 domain for Permit2 (no version, no salt). */
export const PERMIT2_DOMAIN = {
  name: 'Permit2',
  chainId: 8453,
  verifyingContract: PERMIT2_CONTRACT,
} as const;

// ---------------------------------------------------------------------------
// ABIs for on-chain reads (eth_call)
// ---------------------------------------------------------------------------

/** ERC-20 allowance(address,address) → uint256 ABI. */
export const ERC20_ALLOWANCE_ABI = [
  {
    type: 'function',
    name: 'allowance',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
] as const;

/** EIP-2612 nonces(address) → uint256 ABI. */
export const USDC_NONCES_ABI = [
  {
    type: 'function',
    name: 'nonces',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
] as const;

// ---------------------------------------------------------------------------
// EIP-2612 Permit typed-data types
// ---------------------------------------------------------------------------

/** EIP-2612 Permit(address owner, address spender, uint256 value, uint256 nonce, uint256 deadline). */
export const EIP2612_PERMIT_TYPES = {
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;
