import { describe, it } from 'node:test';
import assert from 'node:assert';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { initializeMcpServer } from '../src/mcp-handler.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Integration', () => {
  // -----------------------------------------------------------------------
  // Tool registration
  // -----------------------------------------------------------------------

  describe('initializeMcpServer', () => {
    it('registers 3 tools without throwing', () => {
      const server = new McpServer({
        name: 'token4u-mcp-test',
        version: '0.0.0',
      });

      let result: { tools: string[] };
      assert.doesNotThrow(() => {
        result = initializeMcpServer(server);
      });

      // Verify the return value contains the expected tool names.
      assert.ok(result!);
      assert.ok(Array.isArray(result!.tools));
      assert.strictEqual(result!.tools.length, 3);

      const expected = ['wallet', 'chat', 'consumption'];
      const sorted = [...result!.tools].sort();
      const expectedSorted = [...expected].sort();
      assert.deepStrictEqual(sorted, expectedSorted);
    });
  });
});
