import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  Token4uClient,
  Token4uApiError,
} from '../src/utils/token4u-api.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a unique temp directory, removed in afterEach. */
function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'token4u-test-'));
}

/** Minimal fetch mock that records the last call. */
function mockFetch(
  responses: Array<{ status: number; body: unknown }>,
): { calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let idx = 0;

  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = responses[idx] ?? responses[responses.length - 1];
    idx++;
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  return { calls };
}

function restoreFetch(): void {
  // @ts-expect-error restore original
  globalThis.fetch = undefined;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Token4uClient', () => {
  let dataDir: string;
  let client: Token4uClient;

  beforeEach(() => {
    dataDir = tmpDir();
    client = new Token4uClient({
      baseUrl: 'https://test.token4u.ai',
      dataDir,
    });
  });

  afterEach(() => {
    restoreFetch();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // login
  // -----------------------------------------------------------------------

  describe('login()', () => {
    it('POST to correct path with correct body and writes session.json', async () => {
      const { calls } = mockFetch([
        {
          status: 200,
          body: { success: true, data: { token: 'tok_abc123', username: 'alice' } },
        },
      ]);

      await client.login('alice', 's3cret');

      // Check the fetch call
      assert.equal(calls.length, 1);
      assert.ok(calls[0].url.endsWith('/api/user/login'));
      assert.equal(calls[0].init.method, 'POST');
      assert.equal(
        (calls[0].init.headers as Record<string, string>)?.['Content-Type'],
        'application/json',
      );

      const reqBody = JSON.parse(calls[0].init.body as string);
      assert.deepStrictEqual(reqBody, { username: 'alice', password: 's3cret' });

      // Check session file
      const sessionPath = path.join(dataDir, 'session.json');
      assert.ok(fs.existsSync(sessionPath));

      const session = JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));
      assert.equal(session.token, 'tok_abc123');
      assert.equal(session.username, 'alice');
      assert.ok(typeof session.loggedInAt === 'string');

      // Check file permissions (mode 0o600)
      const stat = fs.statSync(sessionPath);
      assert.strictEqual(
        (stat.mode & 0o777),
        0o600,
        `Expected 0o600 but got ${(stat.mode & 0o777).toString(8)}`,
      );
    });

    it('handles flat token response shape (no data wrapper)', async () => {
      mockFetch([
        { status: 200, body: { token: 'tok_flat' } },
      ]);

      await client.login('bob', 'pw');

      const session = client.getSession();
      assert.ok(session);
      assert.equal(session?.token, 'tok_flat');
    });

    it('throws Token4uApiError on 401 response', async () => {
      mockFetch([
        { status: 401, body: { message: 'Invalid credentials' } },
      ]);

      await assert.rejects(
        () => client.login('bad', 'wrong'),
        (err: unknown) => {
          assert.ok(err instanceof Token4uApiError);
          if (err instanceof Token4uApiError) {
            assert.equal(err.statusCode, 401);
            assert.ok(
              (err.body as { message?: string })?.message?.includes('Invalid'),
            );
          }
          return true;
        },
      );
    });

    it('throws when response has no token', async () => {
      mockFetch([
        { status: 200, body: { success: true, data: { no_token: 1 } } },
      ]);

      await assert.rejects(
        () => client.login('x', 'y'),
        /token/,
      );
    });
  });

  // -----------------------------------------------------------------------
  // getSession / hasSession / logout
  // -----------------------------------------------------------------------

  describe('session persistence', () => {
    it('getSession returns null before login', () => {
      assert.strictEqual(client.getSession(), null);
      assert.strictEqual(client.hasSession(), false);
    });

    it('hasSession returns true after login', async () => {
      mockFetch([
        { status: 200, body: { token: 'tok' } },
      ]);

      await client.login('u', 'p');
      assert.strictEqual(client.hasSession(), true);
      assert.strictEqual(client.getSession()?.token, 'tok');
    });

    it('logout removes session', async () => {
      mockFetch([
        { status: 200, body: { token: 'tok' } },
      ]);

      await client.login('u', 'p');
      assert.strictEqual(client.hasSession(), true);

      client.logout();
      assert.strictEqual(client.hasSession(), false);
      assert.ok(!fs.existsSync(path.join(dataDir, 'session.json')));
    });

    it('logout is idempotent when no session exists', () => {
      client.logout();
      // no throw
    });
  });

  // -----------------------------------------------------------------------
  // No-session guard
  // -----------------------------------------------------------------------

  it('throws "not authenticated" when calling API methods without login', async () => {
    await assert.rejects(
      () => client.getInternalWalletInfo(),
      /login|authenticated/i,
    );
  });

  // -----------------------------------------------------------------------
  // getTransactions — query params
  // -----------------------------------------------------------------------

  describe('getTransactions()', () => {
    it('passes page and page_size as query parameters', async () => {
      // login first
      mockFetch([
        { status: 200, body: { token: 'tok' } },
        {
          status: 200,
          body: { success: true, data: { data: [], total: 0 } },
        },
      ]);
      await client.login('u', 'p');

      const result = await client.getTransactions(3, 25);

      // Grab the second call (first was login)
      const calls = (
        globalThis.fetch as unknown as {
          mock?: { calls: Array<{ url: string }> };
        }
      )?.mock?.calls;

      // We can't easily reach mockFetch's `calls` after the fact, so let's
      // re-do with a fresh setup where we capture everything together.
    });

    it('passes page and page_size as query parameters (clean)', async () => {
      restoreFetch();

      const capturedUrls: string[] = [];
      globalThis.fetch = (async (url: string | URL) => {
        capturedUrls.push(String(url));
        return new Response(
          JSON.stringify({ success: true, data: { data: [], total: 0 } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }) as typeof fetch;

      // We need a session — write one manually
      fs.writeFileSync(
        path.join(dataDir, 'session.json'),
        JSON.stringify({ token: 'tok', username: 'u', loggedInAt: new Date().toISOString() }),
        { mode: 0o600 },
      );

      await client.getTransactions(5, 50);
      restoreFetch();

      assert.equal(capturedUrls.length, 1);
      const url = capturedUrls[0];
      assert.ok(url.includes('/api/internal/x402/transactions?'));
      assert.ok(url.includes('page=5'));
      assert.ok(url.includes('page_size=50'));
    });
  });

  // -----------------------------------------------------------------------
  // Token4uApiError
  // -----------------------------------------------------------------------

  describe('Token4uApiError', () => {
    it('sets name, statusCode, and message from string body', () => {
      const err = new Token4uApiError(500, 'Server error');
      assert.equal(err.name, 'Token4uApiError');
      assert.equal(err.statusCode, 500);
      assert.ok(err.message.includes('500'));
      assert.ok(err.message.includes('Server error'));
    });

    it('extracts message from object body', () => {
      const err = new Token4uApiError(403, { message: 'Forbidden' });
      assert.ok(err.message.includes('Forbidden'));
    });
  });
});
