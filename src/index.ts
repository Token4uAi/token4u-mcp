#!/usr/bin/env node

import { readFileSync } from 'fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { initializeMcpServer } from './mcp-handler.js';
import { startOpenAIAdapter } from './adapter/openai-server.js';

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
) as { version: string };
const VERSION: string = pkg.version;

function handleCliMetadataFlags(): void {
  const args = process.argv.slice(2);

  if (args.includes('--version') || args.includes('-v')) {
    console.log(VERSION);
    process.exit(0);
  }

  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: token4u-mcp [options]');
    console.log('');
    console.log('Options:');
    console.log('  -h, --help       Show this help message');
    console.log('  -v, --version    Print version');
    console.log('  --profile <name> Use a named profile');
    process.exit(0);
  }
}

async function main(): Promise<void> {
  handleCliMetadataFlags();

  const server = new McpServer({ name: 'token4u-mcp', version: VERSION });
  const { tools } = initializeMcpServer(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(
    `Token4u MCP Server started (v${VERSION}) — stdio transport — ${tools.length} tools: ${tools.join(', ')}`,
  );

  // -- OpenAI-compatible HTTP adapter (DISABLED) -----------------------------
  // T95b: the --serve / TOKEN4U_PROXY_PORT adapter mode is temporarily
  // disabled — it is not supported in this release. The flag is ignored so
  // the MCP server always runs stdio-only. Re-enable once the adapter is
  // stable and supported again.
  const args = process.argv.slice(2);
  const serveIdx = args.indexOf('--serve');
  const hasServeFlag = serveIdx !== -1;

  const proxyPort: number | null = (() => {
    if (process.env.TOKEN4U_PROXY_PORT) {
      return parseInt(process.env.TOKEN4U_PROXY_PORT, 10);
    }
    if (hasServeFlag) {
      const nextArg = args[serveIdx + 1];
      if (nextArg && /^\d+$/.test(nextArg)) {
        return parseInt(nextArg, 10);
      }
      return 8787; // default port
    }
    return null;
  })();

  if (proxyPort !== null) {
    console.error(
      '[token4u-mcp] OpenAI-compatible adapter mode is DISABLED in this release (--serve / TOKEN4U_PROXY_PORT ignored). The MCP server runs stdio-only.',
    );
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
