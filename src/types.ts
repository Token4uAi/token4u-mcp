export interface BudgetState {
  limit: number | null;
  spent: number;
  calls: number;
  agents: Map<string, AgentBudget>;
}

export interface AgentBudget {
  limit: number;
  spent: number;
  calls: number;
}

// ---------------------------------------------------------------------------
// Usage (token counts + cache)
// ---------------------------------------------------------------------------

export interface Usage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** Tokens read from cache (prompt_tokens_details.cached_tokens). */
  cachedTokens?: number;
  /** Tokens written to cache (prompt_tokens_details.cached_creation_tokens). */
  cacheCreationTokens?: number;
}

// ---------------------------------------------------------------------------
// Permit2 types (upto scheme)
// ---------------------------------------------------------------------------

export interface Permit2Witness {
  to: string;
  facilitator: string;
  validAfter: string;
}

export interface Permit2Authorization {
  /** Signer address (the wallet that signed the permit). */
  from: `0x${string}`;
  permitted: {
    token: string;
    amount: string;
  };
  spender: string;
  nonce: string;
  deadline: string;
  witness: Permit2Witness;
  signature: `0x${string}`;
}

// ---------------------------------------------------------------------------
// Gas sponsoring extensions (x402 CDP gasless approve)
// ---------------------------------------------------------------------------

/** Extension key for EIP-2612 gas sponsoring. */
export const EIP2612_GAS_SPONSORING_KEY = 'eip2612GasSponsoring';

/** Extension key for ERC-20 approval gas sponsoring (CDP). */
export const ERC20_APPROVAL_GAS_SPONSORING_KEY = 'erc20ApprovalGasSponsoring';

/** EIP-2612 permit data sent by the client for gasless Permit2 approval. */
export interface Eip2612PermitInfo {
  from: string;
  asset: string;
  spender: string;
  amount: string;
  nonce: string;
  deadline: string;
  signature: `0x${string}`;
  version: string;
}
