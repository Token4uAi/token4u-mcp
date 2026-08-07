import fs from 'node:fs';
import path from 'node:path';
import { TOKEN4U_API_URL, TOKEN4U_DATA_DIR } from '../config.js';

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class Token4uApiError extends Error {
  readonly statusCode: number;
  readonly body: unknown;

  constructor(statusCode: number, body: unknown) {
    const msg =
      typeof body === 'string'
        ? body
        : body && typeof body === 'object' && 'message' in body
          ? String((body as Record<string, unknown>).message)
          : JSON.stringify(body);
    super(`Token4u API error ${statusCode}: ${msg}`);
    this.name = 'Token4uApiError';
    this.statusCode = statusCode;
    this.body = body;
  }
}

// ---------------------------------------------------------------------------
// Session types
// ---------------------------------------------------------------------------

export interface SessionData {
  token: string;
  username: string;
  loggedInAt: string;
}

// ---------------------------------------------------------------------------
// API response types
// ---------------------------------------------------------------------------

export interface WalletInfo {
  wallet_address?: string;
  wallet_network?: string;
  usdc_balance?: string;
  wallet_initialized?: boolean;
}

export interface DepositInfo {
  wallet_address: string;
  network: string;
  token_symbol: string;
  note?: string;
}

export interface ExportKeyResult {
  private_key_masked?: string;
  private_key?: string;
}

export interface TransactionItem {
  id?: string;
  tx_hash?: string;
  type?: string;
  amount?: string;
  status?: string;
  created_at?: string;
  [key: string]: unknown;
}

export interface PaginatedTransactions {
  data: TransactionItem[];
  total: number;
}

export interface ConsumptionItem {
  id: string;
  user_id: string;
  session_id: string;
  from_address: string;
  plan_id?: string;
  agent_id?: string;
  model?: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  credits?: number;
  amount_usd?: number;
  tx_hash?: string;
  status?: string;
  create_time?: string;
}

export interface PaginatedConsumption {
  items: ConsumptionItem[];
  total: number;
}

// ---------------------------------------------------------------------------
// Client options (injectable for tests)
// ---------------------------------------------------------------------------

export interface Token4uClientOptions {
  baseUrl?: string;
  dataDir?: string;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class Token4uClient {
  readonly #baseUrl: string;
  readonly #dataDir: string;

  constructor(options: Token4uClientOptions = {}) {
    this.#baseUrl = options.baseUrl ?? TOKEN4U_API_URL;
    this.#dataDir = options.dataDir ?? TOKEN4U_DATA_DIR;
  }

  // -----------------------------------------------------------------------
  // Session management
  // -----------------------------------------------------------------------

  /** POST /api/user/login — authenticate and persist session token. */
  async login(username: string, password: string): Promise<void> {
    const url = `${this.#baseUrl}/api/user/login`;
    const body = JSON.stringify({ username, password });

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    if (!res.ok) {
      const errBody = await this.#safeJson(res);
      throw new Token4uApiError(res.status, errBody);
    }

    const json = (await res.json()) as Record<string, unknown>;

    // Handle both {success, data: {token, ...}} and {token} shapes
    const token: string | undefined =
      (json.data as Record<string, unknown> | undefined)?.token as
        | string
        | undefined
        ?? (json.token as string | undefined);

    if (!token) {
      throw new Error('Login response did not include a token');
    }

    const session: SessionData = {
      token,
      username,
      loggedInAt: new Date().toISOString(),
    };

    fs.mkdirSync(this.#dataDir, { recursive: true });
    const sessionPath = this.#sessionPath();
    fs.writeFileSync(sessionPath, JSON.stringify(session), { mode: 0o600 });
  }

  /** Read the persisted session, or null when no session file exists. */
  getSession(): SessionData | null {
    try {
      const raw = fs.readFileSync(this.#sessionPath(), 'utf-8');
      return JSON.parse(raw) as SessionData;
    } catch {
      return null;
    }
  }

  /** True when a valid session file exists on disk. */
  hasSession(): boolean {
    return this.getSession() !== null;
  }

  /** Remove the persisted session file. */
  logout(): void {
    try {
      fs.unlinkSync(this.#sessionPath());
    } catch {
      // Already gone — fine
    }
  }

  // -----------------------------------------------------------------------
  // Internal x402 wallet endpoints
  // -----------------------------------------------------------------------

  async createInternalWallet(): Promise<unknown> {
    return this.#api('POST', '/api/internal/x402/wallet/create');
  }

  async getInternalWalletInfo(): Promise<WalletInfo> {
    return this.#api('GET', '/api/internal/x402/wallet/info') as Promise<WalletInfo>;
  }

  async syncInternalBalance(): Promise<unknown> {
    return this.#api('POST', '/api/internal/x402/wallet/sync-balance');
  }

  async getInternalDepositInfo(): Promise<DepositInfo> {
    return this.#api('GET', '/api/internal/x402/wallet/deposit') as Promise<DepositInfo>;
  }

  async exportInternalKey(): Promise<ExportKeyResult> {
    return this.#api('GET', '/api/internal/x402/wallet/export-key') as Promise<ExportKeyResult>;
  }

  async deleteInternalKey(): Promise<unknown> {
    return this.#api('POST', '/api/internal/x402/wallet/delete-key');
  }

  async getInternalBalance(): Promise<unknown> {
    return this.#api('GET', '/api/internal/x402/balance');
  }

  async getTransactions(
    page = 1,
    pageSize = 10,
  ): Promise<PaginatedTransactions> {
    const params = new URLSearchParams({
      page: String(page),
      page_size: String(pageSize),
    });
    return this.#api(
      'GET',
      `/api/internal/x402/transactions?${params.toString()}`,
    ) as Promise<PaginatedTransactions>;
  }

  // -----------------------------------------------------------------------
  // Public endpoint (no auth required)
  // -----------------------------------------------------------------------

  /**
   * Query x402 consumption records for a given EVM address.
   *
   * This is a public endpoint — no login or Bearer token needed.
   *
   * @param address  EVM wallet address (0x...).
   * @param page     1-indexed page number (default 1).
   * @param pageSize Items per page (default 10).
   */
  async getConsumption(
    address: string,
    page = 1,
    pageSize = 10,
  ): Promise<PaginatedConsumption> {
    const params = new URLSearchParams({
      address,
      page: String(page),
      page_size: String(pageSize),
    });

    const res = await fetch(
      `${this.#baseUrl}/api/user/x402/consumption?${params.toString()}`,
    );

    if (!res.ok) {
      const errBody = await this.#safeJson(res);
      throw new Token4uApiError(res.status, errBody);
    }

    const json = (await res.json()) as Record<string, unknown>;

    // token4u wraps responses in {success, data: {items, total}, ...}
    // Unwrap `data` when present.
    const data = (
      'data' in json
        ? (json.data as Record<string, unknown>)
        : json
    ) as { items?: ConsumptionItem[]; total?: number };

    return {
      items: Array.isArray(data.items) ? data.items : [],
      total: typeof data.total === 'number' ? data.total : 0,
    };
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  #sessionPath(): string {
    return path.join(this.#dataDir, 'session.json');
  }

  async #safeJson(res: Response): Promise<unknown> {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }

  async #api(
    method: string,
    pathWithQuery: string,
    reqBody?: unknown,
  ): Promise<unknown> {
    const session = this.getSession();
    if (!session) {
      throw new Error(
        'Not authenticated — call login() first, or ensure a valid session exists',
      );
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${session.token}`,
      'Content-Type': 'application/json',
    };

    const init: RequestInit = { method, headers };
    if (reqBody !== undefined && method !== 'GET') {
      init.body = JSON.stringify(reqBody);
    }

    const res = await fetch(`${this.#baseUrl}${pathWithQuery}`, init);

    if (!res.ok) {
      const errBody = await this.#safeJson(res);
      throw new Token4uApiError(res.status, errBody);
    }

    const json = (await res.json()) as Record<string, unknown>;

    // token4u wraps responses in {success, data, ...} — unwrap `data` when present
    if ('data' in json) {
      return json.data;
    }
    return json;
  }
}

// ---------------------------------------------------------------------------
// Default singleton instance
// ---------------------------------------------------------------------------

export const token4u = new Token4uClient();
