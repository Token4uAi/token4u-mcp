import os from 'os';
import path from 'path';

export const TOKEN4U_API_URL =
  process.env.TOKEN4U_API_URL ?? 'https://token4u.ai';

export const TOKEN4U_DATA_DIR =
  process.env.TOKEN4U_DATA_DIR ?? path.join(os.homedir(), '.token4u-mcp');

export const TOKEN4U_WALLET_KEY = process.env.TOKEN4U_WALLET_KEY;

export const TOKEN4U_BUDGET_LIMIT = process.env.TOKEN4U_BUDGET_LIMIT;

export const TOKEN4U_PROXY_PORT = process.env.TOKEN4U_PROXY_PORT
  ? parseInt(process.env.TOKEN4U_PROXY_PORT, 10)
  : null;

export const TOKEN4U_PROXY_KEY = process.env.TOKEN4U_PROXY_KEY;

export const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

export const BASE_CHAIN_ID = 8453;

export const EIP3009_DOMAIN = {
  name: 'USD Coin',
  version: '2',
  chainId: 8453,
  verifyingContract: USDC_BASE,
};
