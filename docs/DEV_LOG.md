# token4u-mcp Development Log

## T1 — 專案 scaffold + MCP server entry

**日期**: 2026-08-05
**狀態**: 已完成

### 建立檔案總覽

| 檔案 | 職責 |
|---|---|
| `package.json` | 專案 metadata、scripts（build/dev/start/typecheck/test）、dependencies（@modelcontextprotocol/sdk, zod, viem）、devDependencies（tsup, tsx, typescript, @types/node），engines >= node 20.19 |
| `tsconfig.json` | TypeScript 配置：strict、ES2022、ESNext module、bundler resolution、outDir dist、rootDir .、skipLibCheck |
| `src/index.ts` | MCP Server 入口：讀取 package.json version、處理 --version/--help CLI flags、建立 McpServer → StdioServerTransport → connect |
| `src/mcp-handler.ts` | 初始化 McpServer：建立 BudgetState、依序註冊 4 個 tool（wallet/chat/transactions/account）、回傳 tool 名稱列表 |
| `src/types.ts` | 型別定義：`BudgetState`（limit/spent/calls/agents Map）、`AgentBudget`（limit/spent/calls） |
| `src/config.ts` | 環境變數與常數：TOKEN4U_API_URL、TOKEN4U_DATA_DIR、TOKEN4U_WALLET_KEY、USDC_BASE（Base 鏈）、BASE_CHAIN_ID、EIP3009_DOMAIN |
| `src/utils/http.ts` | HTTP 工具函數：`fetchWithTimeout`（30s 預設 timeout）、`parseJsonSafe`（try/catch json parsing） |
| `src/tools/wallet.ts` | Tool stub：`token4u_wallet` — action 參數（optional），回傳 "not implemented yet" |
| `src/tools/chat.ts` | Tool stub：`token4u_chat` — model + messages 參數（required），回傳 "not implemented yet" |
| `src/tools/transactions.ts` | Tool stub：`token4u_transactions` — page/page_size 參數（optional），回傳 "not implemented yet" |
| `src/tools/account.ts` | Tool stub：`token4u_account` — action 參數（optional），回傳 "not implemented yet" |

### 架構決策

- 採用 TypeScript ESM（`type: module`），所有 relative import 使用 `.js` extension
- 參考 blockrun-mcp 架構：`src/index.ts` → `mcp-handler.ts` → `tools/*` + `utils/*`
- 4 個 tool 目前均為 stub，handler body 回傳 `{ content: [{ type: 'text', text: '...' }], isError: true }`
- 所有 tool register 函數接受統一的 `(server, budget)` 簽名，方便後續擴展
- BudgetState 由 mcp-handler 建立並傳遞給各 tool，目前僅解析 `TOKEN4U_BUDGET_LIMIT` env
- 使用 Zod v4 做 input schema 定義
- 使用 viem 做鏈上操作（USDC Base 鏈 EIP-3009 授權轉帳）

### 驗證

```bash
npm install && npm run typecheck
```

## T2 — token4u REST API client（login + internal x402 wallet + transactions）

**日期**: 2026-08-05
**狀態**: 已完成

### 建立檔案

| 檔案 | 職責 |
|---|---|
| `src/utils/token4u-api.ts` | Token4u REST API 封裝：Token4uApiError、Token4uClient class、endpoint 方法、session 管理、default singleton |
| `test/token4u-api.test.ts` | 13 個測試用例：login、session、logout、API guard、getTransactions query params、Token4uApiError |

### 實作細節

**Token4uApiError**:
- extends Error，含 `statusCode: number` + `body: unknown`
- 自動從 body 提取 message（支援 string / `{message}` / JSON fallback）

**Token4uClient**:
- constructor 接受 `Token4uClientOptions`（`baseUrl?`, `dataDir?`），方便測試注入
- 預設值從 `config.ts` 讀取 `TOKEN4U_API_URL` / `TOKEN4U_DATA_DIR`
- 使用 node 20+ 原生 `fetch`，無額外 HTTP 依賴

**Session 管理**:
- `login(username, password)`: POST `/api/user/login` → 解析 token（支援 `{success, data: {token}}` 及 `{token}` 兩種回應格式）→ 寫入 `session.json`（mode `0o600`，自動 `mkdir -p` data dir）
- `getSession()`: 讀取 `session.json`，回傳 `SessionData | null`
- `hasSession()`: boolean
- `logout()`: 刪除 `session.json`（idempotent）

**私有 `#api(method, path, body?)`**:
- 自動附加 `Authorization: Bearer <token>` + `Content-Type: application/json`
- 無 session 時拋 Error 提示需先 login
- `!res.ok` → 拋 `Token4uApiError`
- 成功後自動 unwrap token4u 包裝格式（取 `data` 欄位；無 `data` 時回傳整個 body）

**Endpoint 方法**（全部經 `#api()`）:
- `createInternalWallet()` — POST /api/internal/x402/wallet/create
- `getInternalWalletInfo()` — GET /api/internal/x402/wallet/info → `WalletInfo`
- `syncInternalBalance()` — POST /api/internal/x402/wallet/sync-balance
- `getInternalDepositInfo()` — GET /api/internal/x402/wallet/deposit → `DepositInfo`
- `exportInternalKey()` — GET /api/internal/x402/wallet/export-key → `ExportKeyResult`
- `deleteInternalKey()` — POST /api/internal/x402/wallet/delete-key
- `getInternalBalance()` — GET /api/internal/x402/balance
- `getTransactions(page, pageSize)` — GET /api/internal/x402/transactions?page=&page_size= → `PaginatedTransactions`

**TypeScript interfaces**:
- `SessionData { token, username, loggedInAt }`
- `WalletInfo { wallet_address?, wallet_network?, usdc_balance?, wallet_initialized? }`
- `DepositInfo { wallet_address, network, token_symbol, note? }`
- `ExportKeyResult { private_key_masked?, private_key? }`
- `TransactionItem { id?, tx_hash?, type?, amount?, status?, created_at?, [key: string]: unknown }`
- `PaginatedTransactions { data: TransactionItem[], total: number }`

### 測試策略

- 使用 `node:test` + `tsx --test`
- mock `globalThis.fetch` 直接注入 Response
- data dir 使用 `os.tmpdir()` + `fs.mkdtempSync()`，`afterEach` 自動 `rm -rf` 清理
- 測試涵蓋：login 成功（path/body/session 寫入/0o600）、401 拋錯、無 token 拋錯、flat token shape、session CRUD、未登入 guard、getTransactions query params、Token4uApiError 屬性

### 驗證

```bash
npx tsx --test test/token4u-api.test.ts   # 13/13 pass
npx tsc --noEmit                           # clean
```

## T3 — x402 協議 utils（402 quote + EIP-3009 簽名 + PAYMENT-SIGNATURE + SSE stream）

**日期**: 2026-08-05
**狀態**: 已完成

### 建立檔案

| 檔案 | 職責 |
|---|---|
| `src/utils/x402.ts` | x402 微支付協議 client 端：fetchX402Quote、pickFirstAccept、signEip3009、buildPaymentHeader、paidChatCompletion、PaymentError |
| `src/utils/chat-stream.ts` | SSE text/event-stream reader：streamChatCompletion 解析 OpenAI 格式 data: 行、累加 content、處理 [DONE] sentinel、回傳 {content, usage?, sessionId?, model?} |
| `test/x402.test.ts` | 10 個測試用例：402 quote parsing (header + body fallback)、PaymentError、signEip3009 簽名驗證、buildPaymentHeader、paidChatCompletion 完整流程、402 reject 路徑 |

### 實作細節

**型別定義**:
- `X402Accept` — { scheme, network, asset, amount, payTo, extra? }
- `X402Quote` — { x402Version, accepts }
- `Eip3009Authorization` — { from, to, value, validAfter, validBefore, nonce }
- `PaymentPayload` — { authorization: Eip3009Authorization, signature: \`0x${string}\` }
- `PaidChatResult` — { content, model?, paidUsd, sessionId?, usage? }
- `PaidChatOptions` — { timeoutMs?, validForSec?, resourceDescription? }

**PaymentError**:
- extends Error，含 `statusCode?: number` + `body?: string`
- 用於 sign 失敗及 402 payment reject 場景

**fetchX402Quote(url, body, timeoutMs?)**:
- POST 無 auth header，期望 HTTP 402
- 優先 parse `PAYMENT-REQUIRED` header（base64 → JSON）
- header 不存在時 fallback 到 JSON body 解析
- 非 402 status 直接拋 PaymentError（含 status + body）

**pickFirstAccept(accepts)**:
- 回傳 accepts[0]
- 空陣列拋 PaymentError

**signEip3009(privateKey, accepted, from, opts?)**:
- 使用 viem `privateKeyToAccount` → `signTypedData`
- domain: `{ name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC_BASE }`（與 config.ts EIP3009_DOMAIN 一致）
- types: TransferWithAuthorization（from/to/value/validAfter/validBefore/nonce）
- nonce: `crypto.randomBytes(32)` → hex
- validBefore: `Math.floor(Date.now()/1000) + validForSec`（預設 3600s）
- 回傳 `{ authorization, signature }`

**buildPaymentHeader(accepted, payload, resourceUrl, resourceDescription)**:
- 組 x402Version/scheme/resource/accepted/payload object
- `Buffer.from(JSON.stringify(obj)).toString('base64')`

**paidChatCompletion(baseUrl, body, privateKey, opts?)**:
- 完整流程：402 quote → pick accept → sign EIP-3009 → build payment header → re-send with PAYMENT-SIGNATURE
- 第二次 402 → 拋 PaymentError('Payment rejected. Check your USDC balance.')
- SSE (`text/event-stream`) → `streamChatCompletion()`
- 非 SSE → `res.json()` parse
- sessionId: 從 SSE data (`session_id`) 或 response header (`X-402-SESSION`) 取得
- paidUsd = `Number(accepted.amount) / 1e6`（USDC 6 decimals → dollars）

**streamChatCompletion(res, onDelta?)**:
- 使用 `res.body.getReader()` + `TextDecoder` 逐行 split
- `data: ` 前綴行 → JSON.parse → 累加 `choices[0].delta.content`
- `data: [DONE]` → 停止
- 非 JSON 行及 SSE comment（`:` 開頭）忽略
- error 行 → 拋 Error
- usage 從 chunk 提取（prompt_tokens/completion_tokens/total_tokens）
- sessionId 從 `session_id` 欄位提取
- 回傳 `{ content, usage?, sessionId?, model? }`

### 測試策略

- 使用 `node:test` + `tsx --test`
- mock `globalThis.fetch` 注入自訂 Response 序列（含 body ReadableStream）
- 使用 anvil 測試帳號 #0 私鑰: `0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80`
- signEip3009 驗證：使用 viem `recoverTypedDataAddress` 確認 recovered address 與 from 一致
- paidChatCompletion 成功路徑：mock fetch 序列 402 → 200 SSE，驗證 content 彙整正確、paidUsd 計算正確
- paidChatCompletion 402 reject：mock 兩次 402 → 拋 PaymentError

### 驗證

```bash
npx tsx --test test/x402.test.ts   # 10/10 pass
npx tsc --noEmit                    # clean
```

## T5 — token4u_chat tool 實作（x402 支付調用 LLM + streaming + budget）

**日期**: 2026-08-05
**狀態**: 已完成

### 建立/修改檔案

| 檔案 | 職責 |
|---|---|
| `src/utils/wallet.ts` | 本地 wallet 載入工具：`loadLocalWallet()` — 從 `TOKEN4U_WALLET_KEY` env var 或 `wallet.json` 讀取（async，回傳 `LocalWallet \| null`） |
| `src/tools/chat.ts` | `token4u_chat` 完整實作：`chatWithToken4u()` 核心邏輯 + `registerChatTool()` MCP 包裝 |
| `test/chat.test.ts` | 19 個測試用例 — dependency injection 模式，mock 所有外部依賴 |

### 實作細節

**`src/utils/wallet.ts`**:
- `loadLocalWallet()`: async 函數，優先讀取 `TOKEN4U_WALLET_KEY` env var，fallback 到 `~/.token4u-mcp/wallet.json`
- 不自動生成私鑰 — 由 `token4u_wallet action=create` 明確觸發
- `LocalWallet` 型別: `{ address: string, privateKey: \`0x${string}\`, isNew: boolean }`
- 輔助函數: `getOrCreateLocalWallet()`（自動生成 + persist）、`getLocalWalletAddress()`、`getWalletFilePath()`

**`src/tools/chat.ts`** — 核心函數 `chatWithToken4u(input, budget, deps?)`:

**ChatDeps** — dependency injection interface:
```typescript
interface ChatDeps {
  loadWallet: () => LocalWallet | null | Promise<LocalWallet | null>;
  paidChat: (baseUrl, body, privateKey, opts?) => Promise<PaidChatResult>;
  apiUrl: string;
}
```

**Handler 流程**:
1. `loadWallet()` → 無 wallet 回 `isError` 提示 `token4u_wallet action=create`
2. Budget 檢查: `budget.limit !== null && budget.spent >= budget.limit` → 拒絕新 call（簡化: 只追蹤成功後成本，x402 quote 先知真價）
3. 組 body: `{ model, messages, stream: true, ...(max_tokens?), ...(temperature?)}` — `temperature=0` 會被正確包含（`!== undefined` 檢查）
4. 調用 `paidChatCompletion(TOKEN4U_API_URL, body, privateKey)` 完成 402→簽名→retry→SSE stream
5. 成功後: `budget.spent += paidUsd; budget.calls += 1`
6. 回傳格式（blockrun-mcp 風格）:
   - `text`: `[deepseek-v3 | 2 msgs]\n\n{response}`
   - `structuredContent`: `{ model_used, response, paid_usd, session_id? }`

**錯誤處理**:
- `PaymentError`（402 reject / balance 不足）→ `isError` + 提示 `token4u_wallet action=deposit`
- 其他 error → `Error: {message}` 格式
- 所有錯誤路徑均不更新 budget

**`registerChatTool(server, budget)`** — MCP 包裝:
- `inputSchema`: `model: z.string().describe()`, `messages: z.array(z.object({ role: z.enum(['system','user','assistant']), content: z.string() }))`, `max_tokens: z.number().optional().describe()`, `temperature: z.number().optional().describe()`
- description 清楚解釋 x402 微支付（USDC on Base）+ 本地 wallet 需求
- handler: 將 MCP params 轉為 `ChatInput` → 調用 `chatWithToken4u` → 回傳 `{ content, isError, structuredContent? }`

**Re-export**: `export { PaymentError }` 方便測試 import

### 測試策略

- 使用 `node:test` + `tsx --test`
- 採用 **dependency injection** 模式（`ChatDeps` interface）——不 mock module，注入 mock 函數
- 19 個測試用例：

| 分類 | 測試用例 |
|---|---|
| 無 wallet | `loadWallet` 回 `null` → `isError` + 提示 create wallet |
| Budget 超限 | `limit=spent` 拒絕；`spent>limit` 拒絕；`spent<limit` 允許；`limit=null` 不限 |
| Body 組裝 | `stream:true` 確認；`max_tokens`/`temperature` 傳遞；`temperature=0` 正確包含；未提供時不 exist |
| Budget 追蹤 | 成功後 `spent += paidUsd`；`calls += 1`；跨多次 call 累加正確 |
| 回傳格式 | `[model \| N msgs]` 格式；model fallback；`structuredContent` 欄位；`session_id` 存在/不存在 |
| PaymentError | 提示 deposit + USDC balance；不更新 budget |
| 通用錯誤 | `Error: ` 前綴；string throw 處理；不更新 budget |

### 驗證

```bash
npx tsx --test test/chat.test.ts   # 19/19 pass
npx tsc --noEmit                    # clean
npm test                            # 42/42 pass (chat 19 + API 13 + x402 10)
```

## T4 — token4u_wallet tool 實作（本地 key store + internal wallet 操作）

**日期**: 2026-08-05
**狀態**: 已完成

### 建立/修改檔案

| 檔案 | 職責 |
|---|---|
| `src/utils/wallet.ts` | 本地 wallet 完整實作：`getOrCreateLocalWallet()`、`loadLocalWallet()`、`getLocalWalletAddress()`、`getWalletFilePath()` |
| `src/tools/wallet.ts` | `token4u_wallet` 完整實作：7 個 action（status/create/init/sync-balance/deposit/export-key/delete-key），每個 action 抽出獨立 export 函數 |
| `test/wallet.test.ts` | 22 個測試用例：wallet utils CRUD + 7 個 action 測試 + Token4uApiError 處理 |
| `test/wallet-env.test.ts` | 2 個測試用例：`TOKEN4U_WALLET_KEY` env var 優先路徑（獨立檔案確保 module cache 隔離） |

### 實作細節

**`src/utils/wallet.ts`** — 本地 key store:

- **`LocalWallet` type**: `{ address: string; privateKey: \`0x${string}\`; isNew: boolean }`
- **`loadLocalWallet()`** (async): 優先讀取 `TOKEN4U_WALLET_KEY` env var → fallback `wallet.json`。env key 永唔寫入 disk。檔案唔存在或 address 欄位無效 → 回傳 `null`
- **`getOrCreateLocalWallet()`** (async):
  1. `TOKEN4U_WALLET_KEY` env var → 直接回傳（isNew=false）
  2. `loadLocalWallet()` → 存在就回傳
  3. `viem generatePrivateKey()` + `privateKeyToAccount` → `mkdir -p TOKEN4U_DATA_DIR` → 寫 `wallet.json`（JSON `{address, privateKey, createdAt}`，mode `0o600`）→ 回傳 `isNew=true`
- **`getLocalWalletAddress()`** (async): 捷徑，無 wallet 回 `null`
- **`getWalletFilePath()`**: 回傳 wallet.json 絕對路徑（for display）
- **私鑰格式**: 使用 `normalizeKey()` helper 確保 `0x` 前綴（兼容 env var 冇 `0x` 嘅輸入）

**`src/tools/wallet.ts`** — 7 個 action:

每個 action 抽出獨立 export async 函數（如 `walletActionStatus(client)`），接受 `Token4uClient` 注入。`registerTool` handler 只係薄包裝，dispatch + top-level try/catch。

**Return type** `ToolCallResult`:
```typescript
interface ToolCallResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
  [key: string]: unknown;  // MCP SDK 要求的 index signature
}
```

**Action 行為**:

| Action | 行為 |
|---|---|
| **status** (default) | 顯示 local wallet address + token4u internal wallet 資訊。有 session → call `getInternalWalletInfo()`；冇 session → 顯示 "not logged in — run token4u_account login"。`structuredContent: { local_wallet_address, internal_wallet: {...}|null, logged_in: bool }` |
| **create** | `getOrCreateLocalWallet()` → 回傳 address + key file 路徑 + 安全提示（私鑰 0o600，永不離開 MCP server）。`structuredContent: { address, is_new, key_file }` |
| **init** | 需要 session 或 username+password。冇 session 但提供 credentials → 先 `login()`。然後 `createInternalWallet()` → 回傳 wallet_address/network/usdc_balance。冇 session 又冇 credentials → `isError` 提示 |
| **sync-balance** | 需要 session → `syncInternalBalance()` → 回傳 usdc_balance。冇 session → `isError` 提示 login |
| **deposit** | 需要 session → `getInternalDepositInfo()` → 回傳充值地址 + network + token_symbol + note（提示 Base network USDC） |
| **export-key** | 需要 session → `exportInternalKey()` → 回傳 `private_key_masked` + `private_key` + 警告（暴露私鑰風險，只喺遷移錢包時用） |
| **delete-key** | 需要 session → `deleteInternalKey()` → 回傳成功 message + 警告（IRREVERSIBLE，刪除後冇得恢復） |

**錯誤處理**: 每個 action 內部 try/catch `Token4uApiError` → 顯示 `API Error: {message}`。Handler 頂層 catch 其他 error → `Error: {message}`。全部用 `isError: true` 標記。

**inputSchema**:
```typescript
{
  action: z.enum(['status','create','init','sync-balance','deposit','export-key','delete-key'])
    .optional().default('status').describe('Which wallet operation to perform'),
  username: z.string().optional().describe('token4u username (required for init when not logged in)'),
  password: z.string().optional().describe('token4u password (required for init when not logged in)'),
}
```

**description**: 長 description 教 agent 點用每個 action（blockrun-mcp 風格），清楚標示風險（export-key/delete-key 警告）。

### 測試策略

- 使用 `node:test` + `tsx --test`
- **Module cache 隔離**: `test/wallet-env.test.ts` 獨立檔案測試 `TOKEN4U_WALLET_KEY` env 路徑，因為 ESM module cache 令同一個 process 入面冇辦法切換 env var 後重新 evaluation
- **wallet utils 測試** (7 用例): 第一次生成 + 驗證 wallet.json 存在 + 0o600、第二次 load 同一地址、刪除後 null、刪除後重新生成 isNew=true、getLocalWalletAddress 捷徑
- **wallet-env 測試** (2 用例): env key 優先（isNew=false）、唔寫 wallet.json；loadLocalWallet 都回 env key
- **wallet tool action 測試** (13 用例):
  - **mockClient 工廠**: `spy()` wrapper 記錄所有 method call，`overrides` 在 spy 外面 merge（確保 override 嘅 method 都會被記錄）
  - **status**: 冇 session 時唔 call API → structuredContent 檢查；有 session 時 call `getInternalWalletInfo`
  - **init**: 冇 session 冇 credentials → isError；有 username/password → call login({user,pass}) → call createInternalWallet；已有 session → 唔 call login
  - **sync-balance / deposit / export-key / delete-key**: 冇 session → isError + login 提示；有 session → 正常 call API + 驗證回傳格式
  - **deposit 格式驗證**: 確認 deposit_address / network / token_symbol / note / IMPORTANT warning
  - **export-key structuredContent**: `private_key_masked` + `private_key` 都存在 + WARNING
  - **delete-key**: IRREVERSIBLE warning + `{success: true}`
  - **walletActionCreate**: 第一次 `isNew=true` + "New local wallet created"；第二次 `isNew=false`
- **Token4uApiError 處理** (2 用例): walletActionInit login 401 → `API Error: Invalid credentials`；walletActionDeposit 500 → `API Error: Internal server error`

### 與其他模組的兼容性

- **`src/tools/chat.ts`** (T5 實作): 已使用 `loadLocalWallet` 同 `LocalWallet` type。`ChatDeps.loadWallet` 簽名係 `() => Promise<LocalWallet | null>` → `loadLocalWallet` 保持 async 兼容
- **`src/utils/token4u-api.ts`** (T2): 冇改動，tool action 透過 `Token4uClient` 注入使用
- **`src/config.ts`**: 使用既有 `TOKEN4U_DATA_DIR` + `TOKEN4U_WALLET_KEY` constants

### 驗證

```bash
npx tsx --test test/wallet.test.ts test/wallet-env.test.ts   # 24/24 pass
npx tsc --noEmit                                               # clean
npm test                                                       # 66/66 pass (wallet 24 + chat 19 + API 13 + x402 10)
```

## T6 — transactions + account tools 實作 + README + 整合測試

**日期**: 2026-08-05
**狀態**: 已完成

### 建立/修改檔案

| 檔案 | 職責 |
|---|---|
| `src/tools/account.ts` | `token4u_account` 完整實作：`accountAction()` 核心邏輯（login/status/logout）+ `registerAccountTool()` MCP 包裝 |
| `src/tools/transactions.ts` | `token4u_transactions` 完整實作：`getTransactionsAction()` 核心邏輯（分頁查詢 + 格式化輸出）+ `registerTransactionsTool()` MCP 包裝 |
| `README.md` | 專案文件：安裝、環境變數表、4 個 tool 用法範例、x402 流程簡述、安全性說明 |
| `test/integration.test.ts` | 6 個整合測試：initializeMcpServer 註冊驗證 + accountAction status/login/logout + getTransactionsAction 未登入 guard |

### 實作細節

**`src/tools/account.ts`** — `token4u_account` tool:

**核心函數** `accountAction(action, params, client, deps?)`:
- `action`: `'login' | 'status' | 'logout'`
- `params`: `{ username?, password? }`
- `client`: `Token4uClient` 注入（方便測試）
- `deps?`: `{ loadWallet?, apiUrl? }` 可選依賴注入

**Action 行為**:

| Action | 行為 |
|---|---|
| **login** | 檢查 username+password 必須提供 → `client.login()` → 回傳成功訊息（masked username）+ 提示可 run `token4u_wallet status`。`maskUsername()` helper：email → `fi***@domain.com`；non-email → `ab***`。`structuredContent: { logged_in: true, username, masked_username }` |
| **status** (default) | `client.hasSession()` + `client.getSession()` + `loadLocalWallet()` → 顯示登入狀態（含 masked username + loggedInAt）+ local wallet address + base URL。`structuredContent: { logged_in, base_url, local_wallet, session_username?, session_logged_in_at? }` |
| **logout** | `client.logout()` → 回傳成功訊息。記錄 `was_logged_in` 狀態。`structuredContent: { logged_in: false, was_logged_in }` |

**錯誤處理**:
- login 冇 username/password → `isError` + 提示用法
- `Token4uApiError` → `API Error: {message}`
- Handler 頂層 catch 其他 error → `Error: {message}`

**`registerAccountTool(server, budget)`** — MCP 包裝:
- `inputSchema`: `action: z.enum(['login','status','logout']).optional().default('status').describe(...)`、`username: z.string().optional().describe(...)`、`password: z.string().optional().describe(...)`
- description: 解釋三種 action 用途，強調 login 後先用到 internal x402 wallet API
- handler: dispatch action → 調用 `accountAction()` → 回傳 `{ content, isError?, structuredContent? }`

---

**`src/tools/transactions.ts`** — `token4u_transactions` tool:

**核心函數** `getTransactionsAction(page, pageSize, client)`:
- `page`: 1-indexed（預設 1）
- `pageSize`: items per page（預設 10）
- `client`: `Token4uClient` 注入

**Handler 流程**:
1. Session guard: `client.hasSession()` → 冇 session 回 `isError` 提示 login
2. `client.getTransactions(page, pageSize)` → 取得 `PaginatedTransactions { data, total }`
3. 空 data → 回傳 "No transactions found." + `{ data: [], total, page, page_size }`
4. 格式化文字輸出：header（total）+ col header（id | status | amount | tx_hash | created_at）+ separator + 每筆一行
5. `structuredContent: { data: TransactionItem[], total, page, page_size }`

**格式化**:
- `formatTransaction(item)`: 提取 `id/status/amount/tx_hash/created_at`，缺失顯示 `-`
- `formatTransactionsPage(page)`: header + column header + 80-char separator + rows

**`registerTransactionsTool(server, budget)`** — MCP 包裝:
- `inputSchema`: `page: z.number().optional().describe('Page number, default 1')`、`page_size: z.number().optional().describe('Page size, default 10')`
- description: 簡介查詢交易明細，需要先 login
- handler: parse page/pageSize（fallback to 1/10）→ 調用 `getTransactionsAction()` → 回傳

**錯誤處理**:
- 冇 session → `isError` + "Not logged in"
- `Token4uApiError` → `failApi()`
- 其他 error → `Error: {message}`

---

**`README.md`**:
- 標題 + 一句簡介
- 安裝: `claude mcp add`（npx）同 local build 兩種方式
- 環境變數表: `TOKEN4U_API_URL`、`TOKEN4U_WALLET_KEY`、`TOKEN4U_BUDGET_LIMIT`、`TOKEN4U_DATA_DIR`（含預設值同說明）
- Tools 用法範例: 6 個 markdown code block（account login、wallet create、wallet init、wallet deposit、chat、transactions）
- x402 流程簡述: 402 quote → EIP-3009 signature → PAYMENT-SIGNATURE → SSE
- 安全性: 私鑰 0o600、session token 0o600、永唔離開本機
- Development section: install/typecheck/test/build/run

---

**`test/integration.test.ts`**:
- 使用 `node:test` + `tsx --test`
- `before`/`after` hooks 管理 temp data dir（`fs.mkdtempSync` + `rmSync` cleanup）
- `makeClient(tmpDir)`: factory helper 建立指向 temp dir 嘅 `Token4uClient`

**6 個測試用例**:

| 分類 | 測試用例 |
|---|---|
| initializeMcpServer | 建立 real `McpServer` instance → `initializeMcpServer(server)` 唔 throw → 回傳 `{ tools: ['wallet','chat','transactions','account'] }`（sort 後比對） |
| accountAction status | 冇 session → `logged_in: false` + base_url 正確 + local_wallet null or address |
| accountAction status（有 session） | 手動寫 `session.json`（0o600）→ `logged_in: true` + session_username 正確 + text 含 "Logged in: yes" |
| accountAction logout | 手動寫 session → logout → `logged_in: false` + `was_logged_in: true` + session file 已刪除 |
| accountAction login（冇 credentials） | 冇 username/password → `isError` + error 含 "required"；有 username 冇 password 同樣 `isError` |
| getTransactionsAction（未登入） | 冇 session → `isError` + error 含 "login" |

### 驗證

```bash
npm run typecheck  # clean
npm test           # 72/72 pass (integration 6 + chat 19 + wallet 24 + API 13 + x402 10)
npm run build      # success
node dist/index.js --version  # 0.1.0
```

## T11 — consumption tool + paidChatCompletion sessionId from header

**日期**: 2026-08-06
**狀態**: 已完成

### 建立/修改檔案

| 檔案 | 職責 |
|---|---|
| `src/utils/token4u-api.ts` | 新增 `getConsumption(address, page, pageSize)` — public endpoint（無需 auth）、`ConsumptionItem` / `PaginatedConsumption` 型別 |
| `src/tools/consumption.ts` | 新 tool `token4u_consumption`：`getConsumptionAction()` 核心邏輯 + `registerConsumptionTool()` MCP 包裝 |
| `src/mcp-handler.ts` | 新增 `registerConsumptionTool` import + 註冊呼叫 + tools list 加 `'consumption'` |
| `test/consumption.test.ts` | 6 個測試用例（dependency injection mock） |
| `test/integration.test.ts` | 更新工具數量從 4 → 5 |

### 實作細節

**`src/utils/token4u-api.ts`** — 新增 `getConsumption` 方法：

- **端點**: `GET {baseUrl}/api/user/x402/consumption?address=&page=&page_size=`
- **Public endpoint** — 唔使用私有 `#api()`（嗰個強制帶 Bearer token + 要求 session），改為直接 `fetch`
- 以 `URLSearchParams` 組 query string
- 成功後 unwrap token4u 包裝格式（取 `data` 欄位；無 `data` 時回傳整個 body）
- `!res.ok` → 拋 `Token4uApiError`

**型別定義**:
```typescript
interface ConsumptionItem {
  id: string;
  user_id: string;
  session_id: string;
  from_address: string;
  plan_id?: string;
  agent_id?: string;
  model?: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  credits?: number;
  amount_usd?: number;
  tx_hash?: string;
  status?: string;
  create_time?: string;
}

interface PaginatedConsumption {
  items: ConsumptionItem[];
  total: number;
}
```

---

**`src/tools/consumption.ts`** — `token4u_consumption` tool:

**核心函數** `getConsumptionAction(address, page, pageSize, deps?)`:
- `address`: EVM wallet 地址（0x...），必填
- `page`: 1-indexed（預設 1）
- `pageSize`: items per page（預設 10）
- `deps?`: `{ getConsumption }` dependency injection（方便測試）

**Handler 流程**:
1. 空 address → `isError` + "Address is required"
2. 調用 `deps.getConsumption(address, page, pageSize)`（fallback to `token4u.getConsumption`）
3. 空 items → 回傳 "No consumption records found for address ..."
4. 格式化文字輸出：header（total）+ col header（model | total_tokens | credits | amount_usd | tx_hash | create_time）+ separator + 每筆一行 + 尾段總數/分頁提示
5. `structuredContent: { data: ConsumptionItem[], total, page, page_size }`
6. `Token4uApiError` → `API Error: {message}`；其他 error → `Error: {message}`

**格式化**:
- `formatConsumptionItem(item)`: 提取 `model/total_tokens/credits/amount_usd/tx_hash/create_time`，缺失顯示 `-`
- `formatConsumptionPage(page)`: header + column header + 80-char separator + rows + 分頁導航提示

**`registerConsumptionTool(server, budget)`** — MCP 包裝:
- Tool 名: `token4u_consumption`
- `inputSchema`: `address: z.string().describe('EVM wallet 地址（0x...）')`、`page: z.number().optional().describe(...)`、`page_size: z.number().optional().describe(...)`
- description: 清楚說明係 public API、唔使登入、回傳 x402 consumption 明細

---

**`src/mcp-handler.ts`**:
- Import `registerConsumptionTool` from `./tools/consumption.js`
- 在 `initializeMcpServer` 中調用 `registerConsumptionTool(server, budget)`
- tools list 新增 `'consumption'` → `['wallet', 'chat', 'transactions', 'account', 'consumption']`

---

**`x402.ts` sessionId from header** (已在 T3 實作，無需修改):
- `paidChatCompletion` 在 Step 8 從 `response.headers.get('X-402-SESSION')` 取得 sessionId
- 優先級：SSE body `session_id` > `X-402-SESSION` header
- 測試已涵蓋在 `test/x402.test.ts` 的 SSE test case（SSE chunks 無 session_id，全靠 header）

### 測試策略

**`test/consumption.test.ts`** — 6 個測試用例：

| 分類 | 測試用例 |
|---|---|
| 成功格式 | mock `getConsumption` 回 2 筆 → 驗證文字格式（含 header/col header/rows/分頁導航）+ structuredContent（data/total/page/page_size） |
| 空結果 | mock 回空 items + total=0 → 驗證 "No consumption records found" + structuredContent data 為 [] |
| 必填驗證 | address 空字串 → isError；address 純空白 → isError |
| API error | mock 拋 `Token4uApiError(500)` → isError + "API Error" + message |
| 通用 error | mock 拋 `Error('Network timeout')` → isError + "Error: " + "Network timeout" |

**`test/integration.test.ts`**:
- `initializeMcpServer` 測試: 預期工具數量 4 → 5，expected 列表加 `'consumption'`

### 驗證

```bash
npm run typecheck  # clean
npm test           # 78/78 pass (consumption 6 + integration 改為 5 tools + 其他不變)
```

## T13 — OpenAI-compatible HTTP adapter（localhost:PORT/v1）

**日期**: 2026-08-06
**狀態**: 已完成

### 建立/修改檔案

| 檔案 | 職責 |
|---|---|
| `src/adapter/openai-server.ts` | **新建** — OpenAI-compatible HTTP adapter：`node:http` 原生 server、GET /v1/models + POST /v1/chat/completions、dependency injection |
| `src/config.ts` | **修改** — 新增 `TOKEN4U_PROXY_PORT`、`TOKEN4U_PROXY_KEY` exports |
| `src/index.ts` | **修改** — MCP connect 後根據 env/--serve flag 啟動 HTTP adapter |
| `test/adapter.test.ts` | **新建** — 17 個測試用例（models、chat completions、streaming、auth、errors、misc） |

### 實作細節

**`src/adapter/openai-server.ts`** — 核心 adapter：

- **Dependency injection** — `AdapterDeps { paidChat, loadWallet, apiUrl }`，`startOpenAIAdapter(port, deps?)` 接受 partial deps，未提供時使用真實實作（`paidChatCompletion`、`loadLocalWallet`、`TOKEN4U_API_URL`）
- **GET /v1/models** — fetch `{apiUrl}/api/pricing`（public endpoint），支援多種 response 格式（`{data:[...]}`、`{models:[...]}`、`{pricing:[...]}`、top-level array），提取 `model_name/id/name` 欄位轉換為 OpenAI `{object:'list', data:[{id, object:'model', created, owned_by}]}` 格式；fetch 失敗時回退到 minimal 清單（deepseek-v3、gpt-4o-mini）並寫 warning log
- **POST /v1/chat/completions** — 完整流程：
  1. Auth check：`TOKEN4U_PROXY_KEY` env 設定時強制需要 `Authorization: Bearer <KEY>` header，不符合即 401；未設定則接受所有請求
  2. Body parse + validation：JSON parse 失敗 → 400；`model`/`messages` 缺失或空 → 400
  3. `loadWallet()` → null 時 500 錯誤（提示 create wallet）
  4. 組 payload 呼叫 `paidChat(url, payload, privateKey)` — 自動 strip `stream` flag（paidChatCompletion 內部自行處理 streaming）
  5. 成功回傳 OpenAI 格式：
     - **非 streaming** (`stream` 未設或 falsy)：200 + `{id, object:'chat.completion', created, model, choices:[{index:0, message:{role:'assistant',content}, finish_reason:'stop'}], usage?}`
     - **Streaming** (`stream:true`)：200 + `text/event-stream` SSE，輸出單一 `data: {chunk}\n\n`（delta.content = 完整內容）+ `data: [DONE]\n\n`（簡化模式，OpenAI client 兼容）
  6. Error mapping：`PaymentError` → 402 `{error:{message, type:'payment_required', code:'x402_payment_rejected'}}`；generic error → 500
- **未知路由** → 404

**`src/config.ts`** 新增：
```typescript
export const TOKEN4U_PROXY_PORT = process.env.TOKEN4U_PROXY_PORT
  ? parseInt(process.env.TOKEN4U_PROXY_PORT, 10)
  : null;
export const TOKEN4U_PROXY_KEY = process.env.TOKEN4U_PROXY_KEY;
```

**`src/index.ts`** 整合：
- 匯入 `startOpenAIAdapter` from `./adapter/openai-server.js`
- `main()` 內 MCP connect 之後新增 adapter 起動邏輯：
  - 優先讀取 `TOKEN4U_PROXY_PORT` env（數字 port）
  - 其次檢查 `--serve` CLI flag（可選 port argument `--serve 8787`，無 port 時預設 8787）
  - 成功起動後 log `OpenAI-compatible adapter listening on http://localhost:{port}/v1`
  - 失敗時 log error 但不 crash（MCP stdio 繼續運作）

### 設計決策

- **選用 `node:http` 而非 Express** — 遵循專案指引，零額外依賴；路由以手寫 `if (method + pathname)` 處理，clean 且無 overhead
- **Streaming 簡化模式** — paidChatCompletion 內部已做 SSE 彙整，adapter 不回推逐 token delta，改以單一 delta chunk + [DONE] 輸出，保持 OpenAI client 兼容（OpenClaw 預設使用非 streaming，此處 stream 支援主要為 client library compatibility）
- **Dependency injection** — `startOpenAIAdapter` 接受可選 `deps`，測試可注入 mock `paidChat` 和 `loadWallet`，不用 hack global module state；`/api/pricing` 用 `globalThis.fetch` mock（與現有 test pattern 一致）
- **`/api/pricing` 韌性處理** — 支援多種 response 格式（array at `.data`、`.models`、`.pricing`、top-level），每種都嘗試；fetch 失敗或格式不匹配時自動降級到硬編碼的 fallback model list，確保 `/v1/models` 永遠回傳可用結果

### 測試策略

**`test/adapter.test.ts`** — 17 個測試用例：

| 分類 | 測試用例 |
|---|---|
| GET /v1/models | 正常 pricing response（data array）→ 驗證 OpenAIModelList 格式；top-level array 格式；fetch 失敗 → fallback models；空 array → fallback |
| POST success | 正常 completion → 驗證 id/object/model/choices/message/usage 格式；extra params（max_tokens, temperature）有 pass through，stream flag 有 strip |
| POST streaming | stream:true → 驗證 text/event-stream content-type + SSE 包含 delta content + [DONE] |
| POST errors | 缺 model → 400；缺 messages → 400；empty messages → 400；invalid JSON → 400；無 wallet → 500；PaymentError → 402 + type/code；generic error → 500 |
| POST auth | TOKEN4U_PROXY_KEY 設 + 無 header → 401；設 + 錯 key → 401；設 + 正確 key → 200；未設 → 接受任意 key |
| Misc | unknown route → 404；port 0 server 正常 listening |

### 驗證

```bash
npm run typecheck  # clean (0 errors)
npm test           # 98/98 pass (17 new adapter tests + 81 existing unchanged)
```

## T14 — token4u-mcp 簡化：純 external x402 模式

**日期**: 2026-08-06
**狀態**: 已完成

### 背景與決策

用戶決定移除 token4u internal wallet 管理功能，跟 blockrun-mcp 對齊——MCP server 自己管理 local wallet，全部走 external x402 支付。輕量化，無需 token4u 帳號。

### 改動清單

| 檔案 | 改動 |
|---|---|
| `src/tools/wallet.ts` | 重寫：移除 7 個 action 中的 5 個 internal wallet 操作（init/sync-balance/deposit/export-key/delete-key），保留 status/create，新增 setup。移除所有 token4u-api import（Token4uClient、Token4uApiError、WalletInfo）。inputSchema 精簡為 `z.enum(['status','create','setup']).optional().default('status')`。移除 username/password 參數 |
| `src/tools/account.ts` | **刪除** — login/logout 為 internal wallet 概念，無用途 |
| `src/tools/transactions.ts` | **刪除** — transactions 係 internal x402 wallet 交易明細（需 login），internal 概念 |
| `src/tools/consumption.ts` | 保留 — public by address，external x402 消費明細（無需改動，僅更新 comment） |
| `src/utils/token4u-api.ts` | **保留不動** — library 方法全保留（login/getTransactions/getInternalWalletInfo 等），日後如需 internal 功能只需重開 tool |
| `src/mcp-handler.ts` | 移除 registerAccountTool / registerTransactionsTool import + call。tools list 改為 `['wallet', 'chat', 'consumption']`（5 → 3） |
| `README.md` | Tools 清單改為 3 個（wallet/chat/consumption）。移除 account/transactions 說明。加「Funding Your Wallet」段：本地 wallet 地址 + Base USDC 充值方法 + self-custody 指引。標註「純 external x402 模式」 |
| `test/wallet.test.ts` | 重寫：移除 internal actions 所有測試（init/sync-balance/deposit/export-key/delete-key + Token4uApiError handling）。保留 utils CRUD 測試。新增 walletActionStatus（無 wallet + 有 wallet）、walletActionCreate（new + load）、walletActionSetup（funding guidance + auto-create）三組測試。移除 mockClient 工廠（無需 Token4uClient mock） |
| `test/integration.test.ts` | 重寫：tools 數量 5 → 3，expected list 改為 `['wallet','chat','consumption']`。移除 accountAction + getTransactionsAction 測試（共 6 個 test cases 全刪，因為相關 tool 已不存在）。移除 Token4uClient import |
| `docs/DEV_LOG.md` | 新增 T14 段落（本紀錄） |

### 三個 action 行為

| Action | 行為 |
|---|---|
| **status** (default) | `loadLocalWallet()` → 有 wallet：顯示 address + "Status: loaded"；無 wallet：顯示 "No local wallet found. Use action 'create' to generate one."。`structuredContent: { local_wallet_address, is_new }` |
| **create** | `getOrCreateLocalWallet()` → 第一次生成顯示 "✅ New local wallet created!"，第二次載入顯示 "✅ Local wallet loaded."。回傳 address + key file 位置 + SECURITY NOTICE。`structuredContent: { address, is_new, key_file }` |
| **setup** | `getOrCreateLocalWallet()` → 顯示完整充值指引：address、Base USDC deposit 方法（MetaMask 教學）、private key 匯出指引（MetaMask/Rabby import）、安全警告（self-custody、no recovery）。`structuredContent: { address, is_new, key_file }` |

### 設計決策

- **token4u-api.ts 完整保留**：library 層全部方法唔刪（login/getTransactions/getInternalWalletInfo 等），只係 tool 層唔 expose。日後如需 internal 功能只需重開 tool file
- **setup action 合併充值指引**：唔另開 action='deposit'，因為 deposit 原本 call token4u internal API。setup 純 offline——只顯示地址 + 指引文字，無需 API call
- **wallet tool 唔再需要 Token4uClient**：所有 action 純本地操作（loadLocalWallet / getOrCreateLocalWallet），無 API dependency
- **與 blockrun-mcp 對齊**：local wallet self-custody、external x402 USDC payment、無需 account/login

### 測試策略

- **test/wallet.test.ts**：11 個測試用例（5 utils CRUD + 2 status + 2 create + 2 setup），全部使用動態 import 確保 TOKEN4U_DATA_DIR 隔離
- **test/integration.test.ts**：1 個測試用例（initializeMcpServer 註冊 3 tools）
- **被刪除測試**：account/transactions 相關 ∼8 個測試用例（T6 integration tests + wallet internal action tests）
- **不受影響**：chat.test.ts（19）、consumption.test.ts（6）、adapter.test.ts（17）、token4u-api.test.ts（13）、x402.test.ts（10）、wallet-env.test.ts（2）——全部照舊

### 驗證

```bash
npm run typecheck  # clean
npm test           # 82/82 pass (減少 16 個測試 — wallet 內部 action ~13 + integration ~6 個 account/transactions；新增 3 個 setup test cases)
npm run build      # success
```

## T117 — MCP stream timeout 改 activity-based（有 chunk 就唔斷，idle 60s 先斷）

**日期**: 2026-08-16
**狀態**: 已完成

### 背景

大 context（39–51 萬 tokens）+ thinking model 的 stream 總時間可以超過 300s。舊 timeout 用 `AbortSignal.timeout(timeoutMs)`（`src/utils/x402.ts` 主 fetch / resume fetch）——一次性總時長炸彈，由 fetch 開始計時。即使 chunk 一路有返，時間一到照樣 abort（`The operation was aborted due to timeout` / `stream_interrupt_abort`）。官方 DeepSeek stream 唔會咁易斷，因為佢嘅 timeout 係 activity-based（有 chunk 到達就 reset timer）。

### 改動檔案

| 檔案 | 改動 |
|---|---|
| `src/config.ts` | 新增 `TOKEN4U_STREAM_IDLE_TIMEOUT_MS`（預設 `60_000`）與 `TOKEN4U_STREAM_TOTAL_TIMEOUT_MS`（預設 `900_000`），均可 env override |
| `src/utils/chat-stream.ts` | `streamChatCompletion` 新增第三參數 `opts?: StreamChatOptions`（`idleTimeoutMs` + `signal`）。read loop 改 activity-based：每次 `reader.read()` 前重新 arm idle timer，一收到 chunk 就 clear/reset；靜止超過 idle 時限先 abort。用 `Promise.race([reader.read(), abortPromise(idle), abortPromise(external)])` 令 idle / 外部 total signal 可以中斷 in-flight `read()`，abort 後 `reader.cancel()` 釋放連線 |
| `src/utils/x402.ts` | 主 stream fetch 同 top-up resume fetch 由 `AbortSignal.timeout(opts?.timeoutMs)` 改為 `AbortSignal.timeout(TOKEN4U_STREAM_TOTAL_TIMEOUT_MS)`（900s 一刀切安全網）；實際斷線交由 `streamChatCompletion(..., { idleTimeoutMs: TOKEN4U_STREAM_IDLE_TIMEOUT_MS, signal })` 主導。`fetchX402Quote`（402 quote）維持 `opts.timeoutMs` 不變 |
| `test/chat-stream.test.ts` | **新增** — 4 個測試：正常累積到 [DONE]、chunk 持續到就唔 abort（activity reset）、stream 靜止即 idle abort、外部 signal 中斷 stalled read |

### 實作細節

**T113 保留**：`src/tools/chat.ts` 仍傳 `timeoutMs: TOKEN4U_TIMEOUT_MS`（300s），唔使改。呢個 `timeoutMs` 係「總時長」，繼續用喺 402 quote fetch（`fetchX402Quote`）上；streaming 層則並存兩條新 timeout：idle 60s（chunk reset，主導斷線）+ 總時長 900s（一刀切，防死結）。

**idle timer 唔阻 event loop**：idle timer 用 `setTimeout(...)` + `idleTimer.unref()`，stream 完成/斷線時 `finally { clearIdleTimer() }` 清走，唔會令 process 因 idle timeout 而空轉。總時長用 `AbortSignal.timeout(900_000)`（Node 內部 unref，唔會 keep alive）。

**斷線語意**：
- 有 chunk 到 → idle timer 重置 → 總時長幾耐都唔斷（>300s thinking stream 完整到 [DONE]）。
- 靜止 60s 冇 chunk → `idleController.abort(new Error('Stream idle timeout: ...'))` → read 中斷 → `reader.cancel()` → 拋錯。
- 總時長 900s 到（安全網）→ fetch signal abort → read 中斷 → 拋錯。

### 驗證

```bash
npx tsc --noEmit   # exit 0（0 errors）
npm run build      # success（dist/index.js 48.55 KB + DTS）
npx tsx --test test/chat-stream.test.ts test/chat.test.ts   # 23/23 pass（4 新增 + 19 chat）
```

**已知 pre-existing 失敗（與本 task 無關，HEAD 上同樣失敗）**：`test/adapter.test.ts` 的 `returns SSE stream when stream:true`（T878 後 `fakePaidChat` 未 invoke `onDelta`）、`test/x402.test.ts` 的 `completes the full x402 flow` / `throws PaymentError when payment is rejected (second 402)` / `handles non-SSE JSON success response`（T94 permit2-only 後仍用 eip3009 fixture）與 `throws descriptive error when allowance insufficient + no EIP-2612`（T83e 後 EIP-2612 恆先試，無再拋 allowance error）。已用 `git stash` 在 HEAD 上覆現確認。

### 手動場景對應

- 大 context thinking model（>300s stream）唔再 abort → 回應完整到 `[DONE]`（總時長上限 900s，idle 有 chunk 就 reset）。
- 靜止測試：stream 中途 server 停咗唔出 chunk → 60s idle 後先斷。
- 短 output（max_tokens=3000）照常正常（chunk 密集，idle timer 不斷重置）。

## T118 — 空 content 自動 retry（8787/MCP 層，唔改 Hermes）

**日期**: 2026-08-17
**狀態**: 已完成

### 背景

deepseek-v4-flash 係 thinking model，response 隨機出現「content 空」——大部分 completion budget 用晒喺 `reasoning_content`，真正 answer content 留空。實測空率：官方 DeepSeek 4/5（80%）、8787 MCP 3/5（60%）。Hermes 以 MCP 做主力時，收到 content 空回應 → 判定 Empty response → retry 3 次 → fallback 去官方 → 用戶見到「用 MCP 就中斷」。T117 只解決咗 timeout abort，冇解決空 content——空 content 照樣觸發 Hermes fallback。

### 設計決策

- **retry 邏輯放喺 `paidChatCompletion`（x402.ts）單一源頭**，由 `retryEmptyContent?: boolean` option 開關（預設 false）。adapter 同 MCP tool 都傳 `true`，唔喺各自 caller 重複實作 retry loop，避免雙重 retry（3×3）。
- **每次 retry 都係「成個付款流程」重新執行**（新 402 quote + 新 permit + 新付款），唔係單單重試 stream——空 content 代表 model 本身燒晒 budget，要重新俾錢先有機會攞到正常 answer。
- **3 次都空 → 交返原結果**（content 空、paidUsd 累計），唔自己吞，由 Hermes fallback 機制接手。
- **`paidUsd` 回傳累計總額**（唔係最後一次 attempt 嘅單次金額），令 adapter 的 billing log（`call-log.jsonl`）同 chat tool 的 budget 追蹤都反映真實支出，方便對帳。
- **streaming 路徑唔使「resend headers」**：adapter 喺呼叫前已 `writeHead(200, text/event-stream)`，retry 喺 x402.ts 內部進行，`onDelta` 持續射入同一個已開啟的 SSE 連線，`[DONE]` 只喺最後一次 attempt 完結時寫一次。empty attempt 本身冇 content delta，retry 先射 content，client 端 aggregation 結果正確。

### 改動檔案

| 檔案 | 改動 |
|---|---|
| `src/utils/x402.ts` | `PaidChatOptions` 新增 `retryEmptyContent?: boolean` + `maxEmptyContentRetries?: number`（預設 2）。新增 `MAX_EMPTY_CONTENT_RETRIES = 2` 常數 + `isEmptyContent()` helper（trim 後長度 0 判定）。`paidChatCompletion` 成功拿到結果後，若 `retryEmptyContent` 且 content 空 → 重新呼叫 `_paidChatCompletionOnce`（全付款流程）最多 2 次；每 retry 前 log `[token4u-adapter] empty content, retry N/2`，retry 後 log 當次 paid + 累計 paid；回傳 `paidUsd` 設為跨 attempt 累計總額；`emptyContentDeadline = Date.now() + TOKEN4U_STREAM_TOTAL_TIMEOUT_MS` 做整體 900s 安全網，超時就唔再 retry |
| `src/adapter/openai-server.ts` | `paidChat(..., { timeoutMs, retryEmptyContent: true, onDelta })` — 傳 `retryEmptyContent: true`，T118 retry 喺 x402.ts 內部完成，adapter 層無需另開 loop |
| `src/tools/chat.ts` | `paidChat(..., { timeoutMs, retryEmptyContent: true })` — MCP tool 路徑同樣啟用 |

### 實作細節

**retry 唔會無限**：`maxEmptyContentRetries` 預設 2（總共 3 次嘗試），外加 `emptyContentDeadline` 整體 900s 安全網（T117 的 `TOKEN4U_STREAM_TOTAL_TIMEOUT_MS`）——單次 attempt 本身已經有 900s fetch signal，整體 retry 序列再以同一上限兜底，唔會因多次 retry 累積超過安全網。

**對帳 log**：每 retry 三行 log——
1. `[token4u-adapter] empty content, retry 1/2`（觸發 retry）
2. `[token4u-adapter] empty content, retry 1/2: paid $0.001000 this attempt (cumulative $0.002000)`
3. （若超時跳過）`[token4u-adapter] empty content, retry N/2 skipped: overall 900000ms safety net exceeded`

再加上 adapter billing log（`call-log.jsonl`）記錄的 `paidUsd` 已係累計總額，retry 咗幾多次、俾咗幾多次錢都清晰可見。

**成本 trade-off**：每次 retry 都係一次新付款（新 permit），空 content 率越高成本越高——呢個係以金錢換可用性嘅明確 trade-off，透過 log 清楚交代。

### 驗證

```bash
npx tsc --noEmit   # exit 0（0 errors）
npm run build      # success（dist/index.js 50.31 KB + DTS）
```

```bash
# 新增測試（5 個，全部通過）
npx tsx --test test/x402.test.ts   # 24 tests：20 pass / 4 fail（4 個皆 pre-existing，見下）
npx tsx --test test/chat.test.ts   # 20/20 pass（含 1 新「passes retryEmptyContent: true」）
npx tsx --test test/adapter.test.ts # 20/21 pass（含 1 新「passes retryEmptyContent: true」；1 個 pre-existing SSE failure）
```

**新增測試**：
- `test/x402.test.ts` — `paidChatCompletion — empty content retry (T118)`：① empty → retry → 成功（content `Hello`，paidUsd 2.0）② 3 次都空 → 交返空結果（paidUsd 3.0）③ `retryEmptyContent` 未設 → 唔 retry（paidUsd 1.0）
- `test/adapter.test.ts` — `passes retryEmptyContent: true to paidChat (T118)`：驗證 adapter 有傳 option
- `test/chat.test.ts` — `passes retryEmptyContent: true to paidChat (T118)`：驗證 MCP tool 有傳 option

**pre-existing 失敗（HEAD 上同樣失敗，與本 task 無關）**：`test/x402.test.ts` 的 `completes the full x402 flow` / `throws PaymentError when payment is rejected (second 402)` / `handles non-SSE JSON success response`（T94 permit2-only 後仍用 eip3009 fixture）與 `throws descriptive error when allowance insufficient + no EIP-2612`（T83e 後 EIP-2612 恆先試）；`test/adapter.test.ts` 的 `returns SSE stream when stream:true`（T878 後 `fakePaidChat` 未 invoke `onDelta`）。共 5 個，與 T117 紀錄一致。

### 手動場景對應

- 8787 stream + 非 stream：空 content 會自動再付費重試最多 2 次，成功攞到 content 就回傳（adapter 非 stream 返回 `content`；stream 返回連續 SSE chunk 至 `[DONE]`）。
- MCP tool 路徑（`token4u_chat`）：同樣啟用，空 content 自動重試，`budget.spent` 計入累計 `paidUsd`。
- 3 次都空：回傳原空結果，Hermes 接手 fallback，唔會卡死或隱藏。

## T119 — 修 8787 adapter streaming finish_reason 轉發缺陷（Hermes mid-stream drop 根因）

**日期**: 2026-08-17
**狀態**: 已完成

### 背景

Hermes 主 model 行 8787 時，gateway journal 每 ~16 秒報「Stream ended with no finish_reason after delivering text with no tool calls; treating as a mid-stream drop」→ EmptyStreamError → retry → fallback 官方。agent 調查（deleg_8b84c69a）確認三層根因：

1. `src/adapter/openai-server.ts` onDelta 轉發硬編碼 `finish_reason: null`——upstream finish_reason 喺 `chat-stream.ts` 讀咗（存 `finishReason`），但 adapter 從未帶上。Hermes 以「收到非 null finish_reason」為 stream 完成標準 → 即使 adapter 正常完成、收咗錢、寫咗 [DONE]，Hermes 都當 mid-stream drop。
2. `src/utils/chat-stream.ts` read loop 只有「body close / [DONE]」兩個出口，唔認非 null `finish_reason`——upstream 發咗 finish_reason 之後 adapter 仍等 [DONE]。
3. 大 prompt（195K tokens）upstream 空 content → T118 retry 期間 onDelta 繼續轉發（reasoning 碎片跨 retry 混合）→ Hermes 收到垃圾 stream。

### 改動檔案

| 檔案 | 改動 |
|---|---|
| `src/adapter/openai-server.ts` | onDelta chunk 嘅 `finish_reason` 由硬編碼 `null` 改為 `delta.finishReason ?? null`；streaming 成功路徑若最終 `content` 仍空 → 寫一個明確 error chunk（`choices: []` + `error`），再寫 [DONE]，唔再靜默返空 stream |
| `src/utils/chat-stream.ts` | read loop 喺收到非 null `finish_reason`（如 `stop`/`length`）即 `break`（喺 [DONE] 之前）；`finish_reason` 改喺 choice level 讀取（唔局限喺 `delta` 內），`onDelta` 喺有 `delta` 或 `finish_reason` 時都會觸發 |
| `src/utils/x402.ts` | T118 empty-content retry loop 期間 `onDelta` 暫停（retry 重新調 `_paidChatCompletionOnce` 時傳 `onDelta: undefined`，唔再射 reasoning 碎片）；第一個 attempt 嘅 `finish_reason` 延後（defer）唔即射，retry 成功先 flush 最終 content + finish_reason 一次 |
| `docs/DEV_LOG.md` | 新增 T119 段落（本紀錄） |

### 實作細節

**`openai-server.ts` onDelta**：
```typescript
finish_reason: delta.finishReason ?? null,
```
`DeltaCallback`（`chat-stream.ts`）已有 `finishReason?: string` field，型別透傳無需改動；`?? null` 處理 upstream 未帶 finish_reason 嘅 content/reasoning 碎片（保持 OpenAI streaming 格式——中間 chunk 為 null，最後 chunk 先有 `stop`）。

**`chat-stream.ts` break on finish_reason**：
- `finishReason` 由 choice level 提取（`typeof choice.finish_reason === 'string' && choice.finish_reason`），唔再局限於 `delta` 內——completion chunk 可能只帶 `finish_reason` 而 `delta` 為 `{}` 或 absent。
- `onDelta` 觸發條件改為 `delta || finishReason`，確保 finish_reason-only chunk 都透傳畀 caller。
- 收到 finish_reason → `reachedEnd = true` → `break` read loop（[DONE] 仍由 adapter 自行寫，協議需要）。[DONE] sentinel 同樣 set `reachedEnd`。

**`x402.ts` retry pause onDelta**：
- `retryEmptyContent` 啟用時，第一個 attempt 用 wrapper：content/reasoning 照常 incremental 射（T878/T112 保留），但 `finishReason` 被 strip（記入 `finalFinishReason`），唔會喺空 attempt 就提前向 client 宣告「stream 完成」。
- retry loop 內改傳 capture-only `onDelta`（只記 `finishReason`，唔 forward）——reasoning 碎片唔再跨 retry 混合。
- loop 完咗：`didRetry` 且最終有 content → flush `{content, reasoningContent, finishReason: 'stop'}` 一次；`didRetry` 且仍空 → 唔 forward（adapter 寫 error chunk）；冇 retry（happy path）→ forward terminal finish_reason（deferred 嗰個）。

**empty-content 終止信號**：adapter streaming 路徑喺 `result.content` trim 後為空時寫 error chunk（`type: 'server_error'`, `code: 'empty_completion'`）+ [DONE]，取代靜默空 stream（靜默空 stream 正係 Hermes 判 EmptyStreamError 嘅原因）。

### 驗證

```bash
npx tsc --noEmit   # exit 0（0 errors）
npm run build      # success（dist/index.js 51.69 KB + DTS）
```

```bash
# 相關測試（新增 5 個 T119 測試全 pass）
npx tsx --test test/chat-stream.test.ts test/chat.test.ts test/x402.test.ts
#   tests 51 / pass 47 / fail 4（4 個皆 pre-existing，見下）
npx tsx --test test/adapter.test.ts
#   tests 23 / pass 22 / fail 1（1 個 pre-existing，見下）
```

**新增測試（5 個）**：
- `test/chat-stream.test.ts` — `forwards finish_reason via onDelta (T119)`（onDelta 收到 finish_reason）；`terminates on finish_reason without waiting for [DONE] or body close (T119)`（stream 喺 finish_reason 後 stalled、唔發 [DONE]，loop 照樣終止）
- `test/x402.test.ts` — `pauses onDelta during retries and flushes final content once (T119)`（空 attempt 唔 forward finish_reason、retry 唔 forward 碎片、最終 flush content+finish_reason 一次）
- `test/adapter.test.ts` — `forwards finish_reason from onDelta deltas (T119)`（chunk 帶非 null finish_reason）；`emits an explicit error chunk when the final content is empty (T119)`（空 content 出 error chunk + [DONE]）

**pre-existing 失敗（HEAD 上同樣失敗，與本 task 無關）**：`test/x402.test.ts` 的 `completes the full x402 flow` / `throws PaymentError when payment is rejected (second 402)` / `handles non-SSE JSON success response`（T94 permit2-only 後仍用 eip3009 fixture）與 `throws descriptive error when allowance insufficient + no EIP-2612`（T83e 後 EIP-2612 恆先試）；`test/adapter.test.ts` 的 `returns SSE stream when stream:true`（T878 後 `fakePaidChat` 未 invoke `onDelta`）。共 5 個，與 T117/T118 紀錄一致。

### 手動場景對應

- 8787 stream 大 output（max_tokens 1500+）：Hermes 收到 content 碎片（finish_reason null）→ 最後 chunk finish_reason 非 null（`stop`）→ [DONE]，唔再判 mid-stream drop。
- 195K prompt 空 content：第一個 attempt 空 → 唔射 finish_reason、retry 唔射 reasoning 碎片 → retry 成功 flush content+finish_reason 一次 → [DONE]；3 次都空 → adapter 寫 error chunk + [DONE]，Hermes 見到明確 error 而唔係靜默空 stream。

## T120 — 修 8787 空 content retry 必敗 + 懸空 stream（bump max_tokens + 立即 error chunk）

**日期**: 2026-08-17
**狀態**: 已完成

### 背景

T119 已令 finish_reason 正確轉發、restart 後 gateway 0 次 mid-stream drop，但 8787 仍唔適合做 Hermes 主 model。agent 實測（deleg_28cee20b）確認殘留 3 個問題：

1. **空 content retry 必敗**：T118 的 empty-content retry 用同一 body 重跑（`_paidChatCompletionOnce` 用同一個 `requestBody`）——deepseek-v4-flash 係 thinking model，大 context / 細 budget 下 reasoning 燒盡 → content 空，retry 一模一樣必敗（每次 $0.02+，實測 35 分鐘燒 $0.46）。
2. **懸空 stream**：空 content 時 client 收唔到 error chunk + [DONE]，stream 懸空 150s–900s（error chunk + [DONE] 要等成個 retry 週期完成，每 attempt 30–90s）。
3. **新 failure mode**：finish_reason=`tool_calls` 但 tool_calls 空 array → Hermes gateway re-prompt（實測 2/7 turn ~28%）。

### 改動檔案

| 檔案 | 改動 |
|---|---|
| `src/utils/x402.ts` | ① `PaidChatOptions` 新增 `onEmptyContent?: () => void`。② 新增 `bumpMaxTokensForRetry()` + `EMPTY_RETRY_MIN_MAX_TOKENS=1024` / `EMPTY_RETRY_MAX_TOKENS_MULTIPLIER=4` 常數——retry 前 clone body 並把 `max_tokens` bump 到 `max(1024, 原值×4)`，唔改 caller 嘅 body。③ retry loop 開頭（第一次確定空 content 時、任何 retry 跑之前）fire 一次 `onEmptyContent` |
| `src/adapter/openai-server.ts` | ① streaming 路徑傳 `onEmptyContent` → `endStreamWithError()` 即刻寫 error chunk（choices 空 + error）+ [DONE] + `res.end()`。② 新增 `clientEnded` guard，防止 client 已終止後 background retry / final flush / catch block 再 `res.write`（write-after-end 會 crash）。③ onDelta 將 `finish_reason === 'tool_calls'` 映射為 `'stop'` |

### 設計決策

**bump max_tokens（問題 1）**：retry 重新調 `_paidChatCompletionOnce` 時，body 係傳入參數，retry 一定要 clone 一份先改 `max_tokens`（唔好改 caller 嘅 body）。`max_tokens` 缺失/非數字時視為 0 → bump 後即 `1024`，令 retry 恆有 output budget 唔會淨係燒 reasoning。唔做「system 加提示」——task 指引話太複雜可以唔做，只 bump max_tokens 已夠。

**立即 error（問題 2）——取捨判斷**：task 俾咗兩個選項——(a) 第一次空 content 即刻 error 終止 client，retry 繼續跑但結果唔轉發；(b) retry 成功先補發 content。我揀 **(a)**，原因：retry 每 attempt 30–90s、最多 3 次，等佢成功先補發 = client 又要等 0.5–4.5 分鐘，違反「client 唔好等幾分鐘」原則同「連續 5 輪全部 ≤60s」驗證目標。代價係「成功 retry 嘅 content 唔會再轉發」——但 retry 仍然照跑（bumped max_tokens 後有真實成功機會），其累計 `paidUsd` 照常入 billing log（`call-log.jsonl`），對帳準確、兼留低 retry 成功率供判斷 8787 可否做主 model 嘅診斷數據。

**onEmptyContent fire 時機**：喺 retry loop 開頭、deadline 檢查之前 fire（`emptyContentSignaled` flag 保證只 fire 一次）。咁 client 喺第一次確定空 content 當刻（未開始任何 retry）就收到終止信號，唔使等成個週期。retry 期間 `onDelta` 本來就 suppressed（T119），所以 background retry 唔會再向已關閉嘅 client 寫入。

**tool_calls → stop（問題 3）**：adapter 轉發 delta 只帶 `content` + `reasoning_content`，從未帶 `tool_calls`。upstream 發 `finish_reason='tool_calls'`（即使 tool_calls 空 array）會令 Hermes 以為要接 tool 而 re-prompt 成 loop。修法係喺 adapter onDelta 將 `'tool_calls'` 映射做 `'stop'`（補發正常完成信號）。呢個位置覆蓋晒所有 client-facing 路徑——第一個 attempt 嘅 finish_reason 係 deferred（T119），最終 flush 都係經同一個 adapter onDelta，所以映射一次搞掂。非 stream 路徑本就硬編碼 `finish_reason: 'stop'`，無影響。

### 驗證

```bash
npx tsc --noEmit   # exit 0（0 errors）
npm run build      # success（dist/index.js 52.29 KB + DTS）
```

```bash
npx tsx --test test/chat-stream.test.ts test/chat.test.ts test/x402.test.ts test/adapter.test.ts
#   tests 79 / pass 74 / fail 5（5 個皆 pre-existing，與 T117/T118/T119 一致）
```

**新增測試（5 個，全部通過）**：
- `test/x402.test.ts` — ① `bumps max_tokens on the empty-content retry without mutating the caller body (T120)`（用 `mockFetchCapturingBodies` 記錄每次 token4u POST body：attempt 1 付款 body `max_tokens=150`、retry body `max_tokens=1024`，且 caller 傳入嘅 body 未被改動）② `fires onEmptyContent exactly once on the first empty attempt (T120)`（空 attempt → fire 一次，retry 成功仍返 content）③ `does not fire onEmptyContent when the first attempt has content (T120)`（有 content 唔 fire）
- `test/adapter.test.ts` — ④ `terminates the stream immediately via onEmptyContent on empty content (T120)`（mock paidChat 觸發 `opts.onEmptyContent()` → SSE 即出 error chunk（`code:'empty_completion'`）+ [DONE]，只一個 chunk）⑤ `maps finish_reason "tool_calls" to "stop" (T120)`（`finish_reason` 由 `tool_calls` 轉為 `stop`）

**pre-existing 失敗（HEAD 上同樣失敗，與本 task 無關）**：`test/x402.test.ts` 的 `completes the full x402 flow` / `throws PaymentError when payment is rejected (second 402)` / `handles non-SSE JSON success response`（T94 permit2-only 後仍用 eip3009 fixture）與 `throws descriptive error when allowance insufficient + no EIP-2612`（T83e 後 EIP-2612 恆先試）；`test/adapter.test.ts` 的 `returns SSE stream when stream:true`（T878 後 `fakePaidChat` 未 invoke `onDelta`）。共 5 個。

### 手動場景對應

- **短輸出（max_tokens=150）空 content**：第一個 attempt 空 → `onEmptyContent` 即刻 fire → client 收 error chunk + [DONE]（唔懸空）；background retry 用 bumped `max_tokens=1024` 再跑，累計 `paidUsd` 照入 billing log。
- **空 content + retry 成功**：client 已收到明確 error（唔等 30–90s），retry 成功 content 唔再補發——以「快 + 明確」換「可能等到嘅 content」。
- **finish_reason=tool_calls 空 tool_calls**：adapter 轉發為 `stop`，Hermes 唔會 re-prompt 成 loop。
- 連續 5 輪：空 content 輪次即時終止（遠低於 60s），有 content 輪次正常到 [DONE]。
