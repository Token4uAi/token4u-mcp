import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  getConsumptionAction,
  type ConsumptionDeps,
} from '../src/tools/consumption.js';
import { Token4uApiError } from '../src/utils/token4u-api.js';
import type { ConsumptionItem, PaginatedConsumption } from '../src/utils/token4u-api.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURE_ITEMS: ConsumptionItem[] = [
  {
    id: 'c1',
    user_id: 'u1',
    session_id: 'sess-001',
    from_address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    plan_id: 'plan-free',
    agent_id: 'agent-demo',
    model: 'deepseek-v3',
    prompt_tokens: 50,
    completion_tokens: 30,
    total_tokens: 80,
    credits: 1,
    amount_usd: 0.001,
    tx_hash: '0xabc123',
    status: 'confirmed',
    create_time: '2026-08-06T10:00:00Z',
  },
  {
    id: 'c2',
    user_id: 'u1',
    session_id: 'sess-002',
    from_address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    plan_id: 'plan-free',
    agent_id: 'agent-demo',
    model: 'deepseek-v3',
    prompt_tokens: 100,
    completion_tokens: 50,
    total_tokens: 150,
    credits: 2,
    amount_usd: 0.002,
    tx_hash: '0xdef456',
    status: 'confirmed',
    create_time: '2026-08-06T11:00:00Z',
  },
];

const FIXTURE_PAGE: PaginatedConsumption = {
  items: FIXTURE_ITEMS,
  total: 2,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps(overrides?: Partial<ConsumptionDeps>): ConsumptionDeps {
  return {
    getConsumption: async () => FIXTURE_PAGE,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getConsumptionAction', () => {
  // ---------------------------------------------------------------------------
  // Success
  // ---------------------------------------------------------------------------

  it('returns formatted consumption records on success (2 items)', async () => {
    const deps = makeDeps();
    const result = await getConsumptionAction(
      '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      1,
      10,
      deps,
    );

    assert.strictEqual(result.isError, undefined);
    // Verify structured content.
    assert.ok(result.structuredContent);
    assert.strictEqual(result.structuredContent.total, 2);
    assert.strictEqual(result.structuredContent.page, 1);
    assert.strictEqual(result.structuredContent.page_size, 10);
    assert.strictEqual(
      (result.structuredContent.data as ConsumptionItem[]).length,
      2,
    );

    // Verify text format.
    const text = result.content[0].text;
    assert.ok(text.includes('Consumption records (total: 2)'));
    assert.ok(text.includes('deepseek-v3'));
    assert.ok(text.includes('0xabc123'));
    assert.ok(text.includes('0xdef456'));
    // Column headers.
    assert.ok(text.includes('model | total_tokens | credits | amount_usd | tx_hash | create_time'));
  });

  it('returns "no records" message when items array is empty', async () => {
    const deps = makeDeps({
      getConsumption: async () => ({ items: [], total: 0 }),
    });

    const result = await getConsumptionAction(
      '0x0000000000000000000000000000000000000000',
      1,
      10,
      deps,
    );

    assert.strictEqual(result.isError, undefined);
    assert.ok(result.content[0].text.includes('No consumption records found'));
    assert.deepStrictEqual(result.structuredContent?.data, []);
    assert.strictEqual(result.structuredContent?.total, 0);
  });

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  it('returns isError when address is empty string', async () => {
    const deps = makeDeps();
    const result = await getConsumptionAction('', 1, 10, deps);

    assert.strictEqual(result.isError, true);
    assert.ok(result.content[0].text.includes('Address is required'));
  });

  it('returns isError when address is whitespace only', async () => {
    const deps = makeDeps();
    const result = await getConsumptionAction('   ', 1, 10, deps);

    assert.strictEqual(result.isError, true);
    assert.ok(result.content[0].text.includes('Address is required'));
  });

  // ---------------------------------------------------------------------------
  // API error
  // ---------------------------------------------------------------------------

  it('returns isError when API throws Token4uApiError', async () => {
    const deps = makeDeps({
      getConsumption: async () => {
        throw new Token4uApiError(500, { message: 'Internal server error' });
      },
    });

    const result = await getConsumptionAction(
      '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      1,
      10,
      deps,
    );

    assert.strictEqual(result.isError, true);
    assert.ok(result.content[0].text.includes('API Error'));
    assert.ok(result.content[0].text.includes('Internal server error'));
  });

  it('returns isError when API throws a generic Error', async () => {
    const deps = makeDeps({
      getConsumption: async () => {
        throw new Error('Network timeout');
      },
    });

    const result = await getConsumptionAction(
      '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      1,
      10,
      deps,
    );

    assert.strictEqual(result.isError, true);
    assert.ok(result.content[0].text.startsWith('Error: '));
    assert.ok(result.content[0].text.includes('Network timeout'));
  });
});
