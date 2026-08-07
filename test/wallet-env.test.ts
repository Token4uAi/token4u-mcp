import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// This file tests the TOKEN4U_WALLET_KEY env var path.
// It MUST run in a separate process from wallet.test.ts because config.ts
// is cached at the module level once first imported.
// ---------------------------------------------------------------------------

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'token4u-wallet-env-'));
}

async function importWalletUtils() {
  return import('../src/utils/wallet.js');
}

// ---------------------------------------------------------------------------
// TOKEN4U_WALLET_KEY env takes priority
// ---------------------------------------------------------------------------

describe('getOrCreateLocalWallet with TOKEN4U_WALLET_KEY env', () => {
  let dataDir: string;
  let walletMod: Awaited<ReturnType<typeof importWalletUtils>>;

  before(async () => {
    dataDir = tmpDir();
    process.env.TOKEN4U_DATA_DIR = dataDir;
    // Anvil test account #0 private key
    process.env.TOKEN4U_WALLET_KEY =
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

    walletMod = await importWalletUtils();
  });

  after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    delete process.env.TOKEN4U_DATA_DIR;
    delete process.env.TOKEN4U_WALLET_KEY;
  });

  it('uses env key and does NOT write wallet.json', async () => {
    const result = await walletMod.getOrCreateLocalWallet();

    assert.equal(result.isNew, false, 'env wallet should have isNew = false');
    assert.equal(
      result.privateKey,
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    );
    // Expected address for anvil account #0
    assert.equal(
      result.address.toLowerCase(),
      '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
    );

    // wallet.json should NOT be created
    const walletPath = path.join(dataDir, 'wallet.json');
    assert.ok(
      !fs.existsSync(walletPath),
      'wallet.json should NOT exist when using env key',
    );
  });

  it('loadLocalWallet also returns the env key', async () => {
    const result = await walletMod.loadLocalWallet();
    assert.ok(result);
    assert.equal(
      result!.privateKey,
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    );
  });
});
