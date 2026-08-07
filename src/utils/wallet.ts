import fs from 'node:fs';
import path from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { TOKEN4U_DATA_DIR, TOKEN4U_WALLET_KEY } from '../config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LocalWallet {
  address: string;
  privateKey: `0x${string}`;
  isNew: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function walletFilePath(): string {
  return path.join(TOKEN4U_DATA_DIR, 'wallet.json');
}

function accountFromKey(privateKey: string): { address: string } {
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  return { address: account.address };
}

function normalizeKey(raw: string): `0x${string}` {
  return raw.startsWith('0x') ? (raw as `0x${string}`) : (`0x${raw}` as `0x${string}`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load the local wallet from disk, or from `TOKEN4U_WALLET_KEY` env var.
 *
 * Returns `null` when no wallet exists. The caller should instruct the agent
 * to run `token4u_wallet action=create` to generate one.
 */
export async function loadLocalWallet(): Promise<LocalWallet | null> {
  // 1. Env var takes priority — never persist env-provided keys to disk
  if (TOKEN4U_WALLET_KEY) {
    const key = normalizeKey(TOKEN4U_WALLET_KEY);
    const { address } = accountFromKey(key);
    return { address, privateKey: key, isNew: false };
  }

  // 2. Persisted wallet file
  try {
    const raw = fs.readFileSync(walletFilePath(), 'utf-8');
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (
      data &&
      typeof data.address === 'string' &&
      typeof data.privateKey === 'string' &&
      data.address.startsWith('0x')
    ) {
      return {
        address: data.address,
        privateKey: normalizeKey(data.privateKey),
        isNew: false,
      };
    }
  } catch {
    // File doesn't exist or is unreadable — return null below
  }

  return null;
}

/**
 * Load existing wallet or generate a new one.
 *
 * Priority:
 * 1. `TOKEN4U_WALLET_KEY` env var — returns that key, never writes to disk
 * 2. Existing `wallet.json` — loads and validates the address field
 * 3. Generate a fresh keypair with `viem generatePrivateKey()` →
 *    persist to `wallet.json` (mode `0o600`)
 *
 * @returns The wallet with `isNew: true` when a fresh key was just generated.
 */
export async function getOrCreateLocalWallet(): Promise<LocalWallet> {
  // 1. Env var
  if (TOKEN4U_WALLET_KEY) {
    const key = normalizeKey(TOKEN4U_WALLET_KEY);
    const { address } = accountFromKey(key);
    return { address, privateKey: key, isNew: false };
  }

  // 2. Existing file
  const existing = await loadLocalWallet();
  if (existing) return existing;

  // 3. Generate new keypair
  const privateKey = generatePrivateKey();
  const { address } = accountFromKey(privateKey);

  // Ensure data directory exists
  fs.mkdirSync(TOKEN4U_DATA_DIR, { recursive: true });

  const walletData = {
    address,
    privateKey,
    createdAt: new Date().toISOString(),
  };

  fs.writeFileSync(walletFilePath(), JSON.stringify(walletData, null, 2) + '\n', {
    mode: 0o600,
  });

  return { address, privateKey, isNew: true };
}

/**
 * Shortcut: return the local wallet address, or `null` when none exists.
 */
export async function getLocalWalletAddress(): Promise<string | null> {
  const wallet = await loadLocalWallet();
  return wallet?.address ?? null;
}

/**
 * Return the absolute path to the wallet key file (for display).
 */
export function getWalletFilePath(): string {
  return walletFilePath();
}
