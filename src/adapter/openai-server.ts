import http from 'node:http';
import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import path from 'node:path';

import type { PaidChatResult } from '../utils/x402.js';
import { PaymentError } from '../utils/x402.js';
import { paidChatCompletion } from '../utils/x402.js';
import type { LocalWallet } from '../utils/wallet.js';
import { loadLocalWallet } from '../utils/wallet.js';
import { TOKEN4U_API_URL, TOKEN4U_TIMEOUT_MS } from '../config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OpenAIModel {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
}

export interface OpenAIModelList {
  object: 'list';
  data: OpenAIModel[];
}

export interface AdapterDeps {
  paidChat: typeof paidChatCompletion;
  loadWallet: typeof loadLocalWallet;
  apiUrl: string;
}

// ---------------------------------------------------------------------------
// Fallback models (used when /api/pricing is unreachable)
// ---------------------------------------------------------------------------

const FALLBACK_MODELS: OpenAIModel[] = [
  { id: 'deepseek-v3', object: 'model', created: 1735689600, owned_by: 'token4u' },
  { id: 'gpt-4o-mini', object: 'model', created: 1735689600, owned_by: 'token4u' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomId(): string {
  return Math.random().toString(36).substring(2, 15);
}

// ---------------------------------------------------------------------------
// Billing log — call-log.jsonl (reconciliation: INPUT/OUTPUT/CACHE/paidUsd)
// ---------------------------------------------------------------------------

function logCall(entry: Record<string, unknown>): void {
  try {
    const dataDir =
      process.env.TOKEN4U_DATA_DIR ??
      path.join(process.env.HOME ?? '.', '.token4u-mcp');
    appendFileSync(
      path.join(dataDir, 'call-log.jsonl'),
      JSON.stringify(entry) + '\n',
    );
  } catch (logErr) {
    console.error('[token4u-adapter] billing log write failed:', logErr);
  }
}

function shortHash(s: string, len = 12): string {
  return createHash('sha256').update(s.slice(0, 2000)).digest('hex').slice(0, len);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function jsonResponse(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

// ---------------------------------------------------------------------------
// GET /v1/models
// ---------------------------------------------------------------------------

async function fetchModelsFromPricing(apiUrl: string): Promise<OpenAIModel[]> {
  const res = await fetch(`${apiUrl}/api/pricing`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const json: unknown = await res.json();
  if (json === null || typeof json !== 'object') {
    throw new Error('Unexpected pricing response type');
  }

  const obj = json as Record<string, unknown>;

  // Try several known array keys.
  let raw: unknown[] = [];
  if (Array.isArray(obj.data)) raw = obj.data as unknown[];
  else if (Array.isArray(obj.models)) raw = obj.models as unknown[];
  else if (Array.isArray(obj.pricing)) raw = obj.pricing as unknown[];
  else if (Array.isArray(json)) raw = json as unknown[];

  if (raw.length === 0) throw new Error('No model entries found in pricing response');

  return raw.map((item: unknown) => {
    const m = (item ?? {}) as Record<string, unknown>;
    return {
      id: String(m.model_name ?? m.id ?? m.name ?? 'unknown'),
      object: 'model' as const,
      created:
        typeof m.created === 'number'
          ? m.created
          : typeof m.created_at === 'number'
            ? m.created_at
            : nowUnix(),
      owned_by: String(m.owned_by ?? m.provider ?? 'token4u'),
    };
  });
}

// ---------------------------------------------------------------------------
// POST /v1/chat/completions
// ---------------------------------------------------------------------------

interface ChatCompletionRequest {
  model: string;
  messages: unknown[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  frequency_penalty?: number;
  presence_penalty?: number;
  stream?: boolean;
  [key: string]: unknown;
}

function validateChatBody(
  parsed: Record<string, unknown>,
): parsed is ChatCompletionRequest {
  return (
    typeof parsed.model === 'string' &&
    parsed.model.length > 0 &&
    Array.isArray(parsed.messages) &&
    parsed.messages.length > 0
  );
}

function buildChatPayload(body: ChatCompletionRequest): Record<string, unknown> {
  // Forward recognised fields; omit `stream` — paidChatCompletion always
  // streams internally and aggregates.
  const payload: Record<string, unknown> = {
    model: body.model,
    messages: body.messages,
  };
  if (body.max_tokens !== undefined) payload.max_tokens = body.max_tokens;
  if (body.temperature !== undefined) payload.temperature = body.temperature;
  if (body.top_p !== undefined) payload.top_p = body.top_p;
  if (body.stop !== undefined) payload.stop = body.stop;
  if (body.frequency_penalty !== undefined) payload.frequency_penalty = body.frequency_penalty;
  if (body.presence_penalty !== undefined) payload.presence_penalty = body.presence_penalty;

  // Pass through any extra fields the upstream may accept.
  for (const [k, v] of Object.entries(body)) {
    if (!(k in payload) && k !== 'stream') {
      payload[k] = v;
    }
  }

  return payload;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: AdapterDeps,
): Promise<void> {
  const { paidChat, loadWallet, apiUrl } = deps;

  const url = new URL(
    req.url ?? '/',
    `http://${req.headers.host ?? 'localhost'}`,
  );
  const pathname = url.pathname;

  // ---- GET /v1/models -------------------------------------------------------
  if (req.method === 'GET' && pathname === '/v1/models') {
    try {
      const models = await fetchModelsFromPricing(apiUrl);
      const body: OpenAIModelList = { object: 'list', data: models };
      jsonResponse(res, 200, body);
    } catch (err) {
      console.error(
        '[token4u-adapter] Failed to fetch /api/pricing, using fallback models:',
        (err as Error).message,
      );
      const body: OpenAIModelList = { object: 'list', data: FALLBACK_MODELS };
      jsonResponse(res, 200, body);
    }
    return;
  }

  // ---- POST /v1/chat/completions --------------------------------------------
  if (req.method === 'POST' && pathname === '/v1/chat/completions') {
    // -- Auth -----------------------------------------------------------------
    const proxyKey = process.env.TOKEN4U_PROXY_KEY;
    if (proxyKey) {
      const auth = req.headers.authorization;
      if (!auth || auth !== `Bearer ${proxyKey}`) {
        jsonResponse(res, 401, {
          error: {
            message: 'Invalid or missing API key',
            type: 'authentication_error',
            code: 'invalid_api_key',
          },
        });
        return;
      }
    }

    // -- Parse body -----------------------------------------------------------
    let rawBody: string;
    try {
      rawBody = await readBody(req);
    } catch {
      jsonResponse(res, 400, {
        error: { message: 'Failed to read request body', type: 'invalid_request_error' },
      });
      return;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawBody);
      if (parsed === null || typeof parsed !== 'object') {
        throw new SyntaxError('Body must be a JSON object');
      }
    } catch {
      jsonResponse(res, 400, {
        error: { message: 'Invalid JSON body', type: 'invalid_request_error' },
      });
      return;
    }

    if (!validateChatBody(parsed)) {
      jsonResponse(res, 400, {
        error: {
          message: 'Missing or invalid required fields: model, messages',
          type: 'invalid_request_error',
        },
      });
      return;
    }

    const wantsStream = parsed.stream === true;
    const startMs = Date.now();

    // -- Wallet ---------------------------------------------------------------
    let wallet: LocalWallet | null;
    try {
      wallet = await loadWallet();
    } catch (err) {
      jsonResponse(res, 500, {
        error: { message: `Wallet load error: ${(err as Error).message}` },
      });
      return;
    }

    if (!wallet) {
      jsonResponse(res, 500, {
        error: {
          message:
            'No local wallet. Run token4u_wallet action=create or set TOKEN4U_WALLET_KEY.',
          type: 'server_error',
        },
      });
      return;
    }

    // -- Call paidChatCompletion ----------------------------------------------
    const payload = buildChatPayload(parsed);

    // T878: for streaming, establish the SSE connection up-front so deltas can
    // be flushed to the client immediately as they arrive (instead of waiting
    // for the whole upstream stream to complete). For non-streaming we keep
    // headers off until the result is known so PaymentError can still return a
    // plain 402 JSON body.
    const chatId = `chatcmpl-${randomId()}`;
    const created = nowUnix();

    if (wantsStream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
    }

    let result: PaidChatResult;
    try {
      result = await paidChat(apiUrl, payload, wallet.privateKey, {
        // T112: thinking models need a generous upstream window — the old
        // 30s default aborted long reasoning-heavy responses (500 timeout)
        // before reasoning_content could ever be returned to the client.
        timeoutMs: TOKEN4U_TIMEOUT_MS,
        // T878: forward each upstream delta as an SSE chunk. onDelta keeps
        // firing across top-up resumes, so the client never sees a pause.
        onDelta: wantsStream
          ? (delta) => {
              const chunk = {
                id: chatId,
                object: 'chat.completion.chunk',
                created,
                model: parsed.model,
                choices: [
                  {
                    index: 0,
                    delta: {
                      content: delta.content,
                      reasoning_content: delta.reasoningContent,
                    },
                    finish_reason: null,
                  },
                ],
              };
              res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            }
          : undefined,
      });
    } catch (err) {
      const promptText = JSON.stringify(parsed.messages ?? []);
      const errMsg = err instanceof Error ? err.message : String(err);
      logCall({
        ts: new Date().toISOString(),
        tsUnix: Math.floor(Date.now() / 1000),
        durationMs: Date.now() - startMs,
        label: 'hermes-main',
        model: parsed.model,
        paidUsd: 0,
        sessionId: null,
        status: 'error',
        error: errMsg,
        caller: 'hermes-adapter',
        promptChars: promptText.length,
        promptPrefixHash: shortHash(promptText),
        usage: null,
      });
      if (wantsStream) {
        // T878: stream already started — emit a terminal error chunk (empty
        // choices + error) then [DONE] rather than leaving the client hanging.
        const errorChunk = {
          id: chatId,
          object: 'chat.completion.chunk',
          created,
          model: parsed.model,
          choices: [],
          error: {
            message: errMsg,
            type: err instanceof PaymentError
              ? 'payment_required'
              : 'server_error',
            code: err instanceof PaymentError
              ? 'x402_payment_rejected'
              : undefined,
          },
        };
        res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      if (err instanceof PaymentError) {
        jsonResponse(res, 402, {
          error: {
            message: err.message,
            type: 'payment_required',
            code: 'x402_payment_rejected',
          },
        });
        return;
      }
      jsonResponse(res, 500, {
        error: { message: (err as Error).message },
      });
      return;
    }

    // -- Billing log (ok) -----------------------------------------------------
    const promptText = JSON.stringify(parsed.messages ?? []);
    logCall({
      ts: new Date().toISOString(),
      tsUnix: Math.floor(Date.now() / 1000),
      durationMs: Date.now() - startMs,
      label: 'hermes-main',
      model: parsed.model,
      modelReturned: result.model ?? parsed.model,
      paidUsd: result.paidUsd,
      sessionId: result.sessionId ?? null,
      status: 'ok',
      caller: 'hermes-adapter',
      promptChars: promptText.length,
      promptPrefixHash: shortHash(promptText),
      usage: result.usage
        ? {
            promptTokens: result.usage.promptTokens,
            completionTokens: result.usage.completionTokens,
            totalTokens: result.usage.totalTokens,
            cachedTokens: result.usage.cachedTokens,
            cacheCreationTokens: result.usage.cacheCreationTokens,
          }
        : null,
    });

    // -- Build response -------------------------------------------------------
    const model = result.model ?? parsed.model;

    if (wantsStream) {
      // T878: deltas were already streamed to the client during the await —
      // just terminate the SSE stream. The billing log above still uses the
      // aggregated result (content/paidUsd/sessionId) from the full await.
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    // Non-streaming response.
    const message: Record<string, unknown> = {
      role: 'assistant',
      content: result.content,
    };
    // T112: pass reasoning_content through (thinking model trace).
    const reasoningContent = (
      result as PaidChatResult & { reasoningContent?: string }
    ).reasoningContent;
    if (reasoningContent) {
      message.reasoning_content = reasoningContent;
    }
    const response: Record<string, unknown> = {
      id: chatId,
      object: 'chat.completion',
      created,
      model,
      choices: [
        {
          index: 0,
          message,
          finish_reason: 'stop',
        },
      ],
    };

    if (result.usage) {
      response.usage = {
        prompt_tokens: result.usage.promptTokens,
        completion_tokens: result.usage.completionTokens,
        total_tokens: result.usage.totalTokens,
      };
    }

    jsonResponse(res, 200, response);
    return;
  }

  // ---- 404 ------------------------------------------------------------------
  jsonResponse(res, 404, {
    error: { message: `Not found: ${req.method} ${pathname}`, type: 'invalid_request_error' },
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const DEFAULT_DEPS: AdapterDeps = {
  paidChat: paidChatCompletion,
  loadWallet: loadLocalWallet,
  apiUrl: TOKEN4U_API_URL,
};

/**
 * Start the OpenAI-compatible HTTP adapter on the given port.
 *
 * If `port` is 0 the OS assigns a free port. The returned server's
 * `.address()` will report the actual port once listening.
 *
 * Dependencies are injected for testability — omit to use the real
 * `paidChatCompletion`, `loadLocalWallet`, and `TOKEN4U_API_URL`.
 */
export function startOpenAIAdapter(
  port: number,
  deps: Partial<AdapterDeps> = {},
): Promise<http.Server> {
  const resolved: AdapterDeps = { ...DEFAULT_DEPS, ...deps };

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      handleRequest(req, res, resolved).catch((err) => {
        if (!res.headersSent) {
          jsonResponse(res, 500, {
            error: { message: `Internal server error: ${(err as Error).message}` },
          });
        } else {
          res.end();
        }
        console.error('[token4u-adapter] Unhandled error:', err);
      });
    });

    server.on('error', reject);

    server.listen(port, () => {
      resolve(server);
    });
  });
}
