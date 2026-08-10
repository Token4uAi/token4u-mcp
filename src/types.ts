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
// Permit2 types (upto scheme)
// ---------------------------------------------------------------------------

export interface Permit2Witness {
  to: string;
  facilitator: string;
  validAfter: string;
}

export interface Permit2Authorization {
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
