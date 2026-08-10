# Token4u MCP Server

透過 x402 微支付讓 AI agent 調用 LLM API + 查詢 x402 消費明細。

**純 external x402 模式**：MCP server 本地管理 wallet 私鑰（`~/.token4u-mcp/wallet.json`，0o600），所有支付走 x402 鏈上 USDC（Base network），無需 token4u 帳號。

## Installation

### via npx (recommended)

```bash
claude mcp add token4u-mcp -- npx -y token4u-mcp
```

### Local build

```bash
npm install
npm run build
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `TOKEN4U_API_URL` | `https://token4u.ai` | token4u API base URL |
| `TOKEN4U_WALLET_KEY` | _(optional)_ | Local wallet private key (takes priority over file) |
| `TOKEN4U_BUDGET_LIMIT` | _(optional)_ | Max USD budget for LLM calls |
| `TOKEN4U_DATA_DIR` | `~/.token4u-mcp` | Directory for wallet key and session storage |

## Tools

### 1. `token4u_wallet` — Manage Local Wallet

Create and manage a local signing wallet for x402 payments.

**Status**（default）— check wallet state:

```
token4u_wallet action=status
```

**Create** — generate a new local wallet keypair or load an existing one:

```
token4u_wallet action=create
```

The private key is stored at `~/.token4u-mcp/wallet.json` with 0o600 permissions
and never leaves this MCP server.

**Setup** — get step-by-step funding guidance:

```
token4u_wallet action=setup
```

Shows your wallet address and instructions for depositing USDC on Base network.

### 2. `token4u_chat` — Paid LLM Chat

Call AI models via token4u, paid with USDC on Base via x402.

```
token4u_chat model=deepseek-v3 messages=[{"role":"user","content":"Hello!"}]
```

### 3. `token4u_consumption` — View Consumption Records

Query x402 consumption records for a given EVM wallet address (public API — no login required).

```
token4u_consumption address=0xYourWalletAddress page=1
```

## Funding Your Wallet

This MCP server runs in **pure external x402 mode** — your local wallet must be
funded with USDC on Base before making paid LLM calls.

### Quick Start

1. **Create a wallet**（if you haven't already）:
   ```
   token4u_wallet action=create
   ```

2. **Get funding instructions**:
   ```
   token4u_wallet action=setup
   ```

3. **Send USDC on Base** to the wallet address shown. You can use:
   - MetaMask (or any EVM wallet) connected to Base network
   - Coinbase / exchange withdrawal to Base
   - Any Base bridge to on-ramp USDC

4. **Verify the balance** is visible on-chain (e.g., basescan.org) —
   the x402 protocol reads your USDC balance directly from the chain.

### Self-Custody

Your private key is at `~/.token4u-mcp/wallet.json` (permissions: 0o600).
You can import it into MetaMask or any EVM wallet for self-management:

- **MetaMask**: Settings → Import Account → paste the private key
- **Rabby / Frame**: similar "Import Private Key" flow

⚠️ Anyone with this private key can spend your USDC. Never share it.

## x402 Flow

Each paid LLM call follows the x402 micropayment protocol:

1. **402 Quote** — POST without payment → server responds with HTTP 402 + payment details (price, recipient, network)
2. **Authorization Signature** — Sign a typed data message authorizing the USDC transfer:
   - **Permit2** (`upto` scheme with `assetTransferMethod=permit2`) — sign a `PermitWitnessTransferFrom` authorising a ceiling amount; the server settles only the actual cost post-execution (≤ ceiling)
   - **EIP-3009** (`exact` scheme or legacy `upto`) — sign a `TransferWithAuthorization` for the exact amount
3. **PAYMENT-SIGNATURE** — Re-send the request with a base64-encoded `PAYMENT-SIGNATURE` header containing the signed authorization
4. **SSE Stream** — Server verifies the signature and streams the LLM response via Server-Sent Events

## Security

- **Private keys** are stored at `~/.token4u-mcp/wallet.json` with `0o600` permissions
- Private keys **never leave** this machine — all EIP-3009 and Permit2 signing happens locally
- No token4u account required — the MCP server manages its own local wallet
- All payments are on-chain USDC transfers on Base network

## Development

```bash
# Install dependencies
npm install

# Type check
npm run typecheck

# Run tests
npm test

# Build
npm run build

# Run locally
node dist/index.js
```

## License

MIT
