import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BudgetState } from './types.js';
import { registerWalletTool } from './tools/wallet.js';
import { registerChatTool } from './tools/chat.js';
import { registerConsumptionTool } from './tools/consumption.js';

export function initializeMcpServer(server: McpServer): { tools: string[] } {
  const budget: BudgetState = {
    limit: process.env.TOKEN4U_BUDGET_LIMIT
      ? parseFloat(process.env.TOKEN4U_BUDGET_LIMIT)
      : null,
    spent: 0,
    calls: 0,
    agents: new Map(),
  };

  registerWalletTool(server, budget);
  registerChatTool(server, budget);
  registerConsumptionTool(server, budget);

  return { tools: ['wallet', 'chat', 'consumption'] };
}
