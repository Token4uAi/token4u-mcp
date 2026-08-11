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
