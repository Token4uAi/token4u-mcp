import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'token4u-wallet-test-'));
}

// All tests that need TOKEN4U_DATA_DIR isolation must dynamically import —
// static imports of project code transitively evaluate config.ts and lock in
// the TOKEN4U_DATA_DIR value before the test can override it.

async function importWalletUtils() {
  return import('../src/utils/wallet.js');
}

async function importWalletTools() {
  return import('../src/tools/wallet.js');
}

// ---------------------------------------------------------------------------
// Set up a shared temp data dir BEFORE any project module is loaded.
// The describe blocks all share this dir; individual tests clean wallet.json
// as needed.
// ---------------------------------------------------------------------------

const SHARED_DATA_DIR = tmpDir();

before(() => {
  process.env.TOKEN4U_DATA_DIR = SHARED_DATA_DIR;
  delete process.env.TOKEN4U_WALLET_KEY;
});

after(() => {
  fs.rmSync(SHARED_DATA_DIR, { recursive: true, force: true });
  delete process.env.TOKEN4U_DATA_DIR;
});

// ---------------------------------------------------------------------------
// Wallet utils — basic CRUD
// ---------------------------------------------------------------------------

describe('getOrCreateLocalWallet / loadLocalWallet', () => {
  let walletMod: Awaited<ReturnType<typeof importWalletUtils>>;

  before(async () => {
    walletMod = await importWalletUtils();
    // Ensure clean state
    const wp = path.join(SHARED_DATA_DIR, 'wallet.json');
    if (fs.existsSync(wp)) fs.unlinkSync(wp);
  });

  it('generates a new wallet on first call and persists to wallet.json', async () => {
    const result = await walletMod.getOrCreateLocalWallet();

    assert.ok(result.isNew, 'isNew should be true on first creation');
    assert.ok(
      result.address.startsWith('0x'),
      `expected 0x-prefixed address, got ${result.address}`,
    );
    assert.equal(result.address.length, 42);
    assert.ok(result.privateKey.startsWith('0x'));
    assert.equal(result.privateKey.length, 66);

    const walletPath = path.join(SHARED_DATA_DIR, 'wallet.json');
    assert.ok(fs.existsSync(walletPath), 'wallet.json should exist');

    const raw = fs.readFileSync(walletPath, 'utf-8');
    const data = JSON.parse(raw);
    assert.equal(data.address, result.address);
    assert.equal(data.privateKey, result.privateKey);
    assert.ok(typeof data.createdAt === 'string');

    const stat = fs.statSync(walletPath);
    assert.strictEqual(
      stat.mode & 0o777,
      0o600,
      `Expected 0o600 but got ${(stat.mode & 0o777).toString(8)}`,
    );
  });

  it('loadLocalWallet returns the same wallet on second call', async () => {
    const first = await walletMod.getOrCreateLocalWallet();

    const second = await walletMod.loadLocalWallet();
    assert.ok(second, 'loadLocalWallet should return the wallet');
    assert.equal(second!.address, first.address);
    assert.equal(second!.privateKey, first.privateKey);
    assert.equal(second!.isNew, false, 'loaded wallet should have isNew = false');
  });

  it('getLocalWalletAddress returns the address', async () => {
    const addr = await walletMod.getLocalWalletAddress();
    assert.ok(typeof addr === 'string');
    assert.ok(addr!.startsWith('0x'));
  });

  it('loadLocalWallet returns null when no wallet exists', async () => {
    const walletPath = path.join(SHARED_DATA_DIR, 'wallet.json');
    if (fs.existsSync(walletPath)) fs.unlinkSync(walletPath);

    const result = await walletMod.loadLocalWallet();
    assert.strictEqual(result, null);
  });

  it('getOrCreateLocalWallet recreates wallet after deletion', async () => {
    const walletPath = path.join(SHARED_DATA_DIR, 'wallet.json');
    if (fs.existsSync(walletPath)) fs.unlinkSync(walletPath);

    const result = await walletMod.getOrCreateLocalWallet();
    assert.ok(result.isNew, 'isNew should be true after wallet was deleted');
    assert.ok(fs.existsSync(walletPath));
  });
});

// ---------------------------------------------------------------------------
// Wallet tool action tests — status / create / setup
// ---------------------------------------------------------------------------

describe('walletActionStatus', () => {
  it('shows "No local wallet" when none exists', async () => {
    // Ensure no wallet exists
    const walletPath = path.join(SHARED_DATA_DIR, 'wallet.json');
    if (fs.existsSync(walletPath)) fs.unlinkSync(walletPath);

    const tools = await importWalletTools();
    const result = await tools.walletActionStatus();

    assert.equal(result.isError, undefined);
    assert.ok(result.content[0].text.includes('No local wallet found'));
    assert.ok(result.content[0].text.includes('action "create"'));

    const sc = result.structuredContent;
    assert.strictEqual(sc.local_wallet_address, null);
    assert.strictEqual(sc.is_new, false);
  });

  it('shows address and loaded status when wallet exists', async () => {
    const walletMod = await importWalletUtils();
    await walletMod.getOrCreateLocalWallet();

    const tools = await importWalletTools();
    const result = await tools.walletActionStatus();

    assert.equal(result.isError, undefined);
    const text = result.content[0].text;
    assert.ok(text.includes('Address: 0x'));
    assert.ok(text.includes('Status: loaded'));

    const sc = result.structuredContent;
    assert.ok(typeof sc.local_wallet_address === 'string');
    assert.ok((sc.local_wallet_address as string).startsWith('0x'));
    assert.strictEqual(sc.is_new, false);
  });
});

describe('walletActionCreate', () => {
  it('creates new wallet on first call', async () => {
    // Ensure no wallet exists
    const walletPath = path.join(SHARED_DATA_DIR, 'wallet.json');
    if (fs.existsSync(walletPath)) fs.unlinkSync(walletPath);

    const tools = await importWalletTools();
    const result = await tools.walletActionCreate();

    assert.equal(result.isError, undefined);
    const text = result.content[0].text;
    assert.ok(text.includes('New local wallet created'), 'should indicate new wallet');
    assert.ok(text.includes('SECURITY NOTICE'));

    const sc = result.structuredContent;
    assert.equal(sc.is_new, true);
    assert.ok((sc.address as string).startsWith('0x'));
    assert.ok((sc.key_file as string).includes('wallet.json'));
  });

  it('loads existing wallet on second call', async () => {
    const tools = await importWalletTools();
    // First creates, second loads
    await tools.walletActionCreate();
    const second = await tools.walletActionCreate();

    assert.equal(second.isError, undefined);
    assert.equal(second.structuredContent.is_new, false);
    assert.ok(second.content[0].text.includes('loaded'));
  });
});

describe('walletActionSetup', () => {
  it('returns funding guidance with address and key file', async () => {
    const tools = await importWalletTools();
    const result = await tools.walletActionSetup();

    assert.equal(result.isError, undefined);
    const text = result.content[0].text;

    // Key content checks
    assert.ok(text.includes('How to fund'), 'should include funding title');
    assert.ok(text.includes('0x'), 'should include wallet address');
    assert.ok(text.includes('USDC'), 'should mention USDC');
    assert.ok(text.includes('Base'), 'should mention Base network');
    assert.ok(text.includes('MetaMask'), 'should mention MetaMask');
    assert.ok(text.includes('wallet.json'), 'should mention key file path');
    assert.ok(text.includes('0o600'), 'should mention permissions');

    const sc = result.structuredContent;
    assert.ok((sc.address as string).startsWith('0x'));
    assert.ok((sc.key_file as string).includes('wallet.json'));
  });

  it('creates wallet if none exists yet', async () => {
    // Ensure no wallet exists
    const walletPath = path.join(SHARED_DATA_DIR, 'wallet.json');
    if (fs.existsSync(walletPath)) fs.unlinkSync(walletPath);

    const tools = await importWalletTools();
    const result = await tools.walletActionSetup();

    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.is_new, true, 'should auto-create wallet');
    assert.ok(result.content[0].text.includes('0x'));
  });
});
