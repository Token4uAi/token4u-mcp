import type { Usage } from '../types.js';

// ---------------------------------------------------------------------------
// Top-up event (x402 mid-stream payment resume)
// ---------------------------------------------------------------------------

/** Data carried by a server-sent x402_top_up_required SSE event. */
export interface X402TopUpEvent {
  /** Opaque session token the server uses to resume the chat. */
  resumeSession: string;
  /** Cumulative tokens consumed so far (across all segments). */
  consumedTokens: number;
  /** Cumulative USDC amount consumed so far, in 6-decimal fixed-point. */
  consumedAmount: string;
  /** Additional USDC amount to authorise for the next segment (6-decimal). */
  topUpAmount: string;
}

/**
 * A single `choices[0].delta.tool_calls[]` element in an OpenAI streaming
 * chunk. Streaming providers split one tool call across chunks: the first
 * carries `id` + `function.name` (+ the first `arguments` fragment), later
 * chunks carry only `index` + further `function.arguments` fragments.
 * `mergeToolCalls` reassembles these into one entry per `index`.
 */
export interface ToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: {
    name?: string;
    /** JSON string — concatenated across streaming chunks. */
    arguments?: string;
  };
}

export interface StreamResult {
  content: string;
  /** Accumulated reasoning_content from GLM/DeepSeek-style deltas. */
  reasoningContent?: string;
  /** Aggregated tool calls (streaming `delta.tool_calls` merged by index). */
  toolCalls?: ToolCallDelta[];
  usage?: Usage;
  sessionId?: string;
  model?: string;
  /**
   * If set, the stream was interrupted by an x402 top-up event.
   * The caller should resume with a new payment and `X-402-RESUME` header.
   */
  topUp?: X402TopUpEvent;
}

export type DeltaCallback = (delta: {
  content: string;
  reasoning?: string;
  reasoningContent?: string;
  finishReason?: string;
  /** Raw per-chunk `delta.tool_calls` fragments (not yet merged). */
  toolCalls?: ToolCallDelta[];
}) => void;

export interface StreamChatOptions {
  /**
   * Activity-based idle timeout in ms. The timer is (re)armed before every
   * `reader.read()` and cleared as soon as a chunk arrives, so a stream that
   * keeps producing data is never cut. Only when no chunk lands for this long
   * is the read aborted. `0`/`undefined` disables the idle timeout.
   */
  idleTimeoutMs?: number;
  /**
   * External abort signal (e.g. a total-duration safety net). If it aborts the
   * in-flight read is interrupted with the signal's reason.
   */
  signal?: AbortSignal;
}

/** Reject with `signal.reason` (or a generic abort error) once it aborts. */
function abortPromise(signal: AbortSignal): Promise<never> {
  const reason = (): unknown =>
    signal.reason ?? new Error('The operation was aborted');
  if (signal.aborted) {
    return Promise.reject(reason());
  }
  return new Promise((_, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(reason());
    };
    signal.addEventListener('abort', onAbort);
  });
}

/**
 * Validate + copy a raw `delta.tool_calls` value into a `ToolCallDelta[]`.
 * Returns `undefined` when the value is not an array.
 */
export function normalizeToolCalls(raw: unknown): ToolCallDelta[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ToolCallDelta[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const tc = item as Record<string, unknown>;
    const fn = tc.function as Record<string, unknown> | undefined;
    out.push({
      index: typeof tc.index === 'number' ? tc.index : undefined,
      id: typeof tc.id === 'string' ? tc.id : undefined,
      type: typeof tc.type === 'string' ? tc.type : undefined,
      function:
        fn && typeof fn === 'object'
          ? {
              name: typeof fn.name === 'string' ? fn.name : undefined,
              arguments:
                typeof fn.arguments === 'string' ? fn.arguments : undefined,
            }
          : undefined,
    });
  }
  return out;
}

/**
 * Merge streaming tool-call fragments by `index`, concatenating
 * `function.arguments` across chunks (T122). The result is a fresh array in
 * ascending index order — never mutates its inputs.
 */
export function mergeToolCalls(
  accumulated: ToolCallDelta[],
  incoming: ToolCallDelta[],
): ToolCallDelta[] {
  const byIndex = new Map<number, ToolCallDelta>();

  const put = (tc: ToolCallDelta): void => {
    const idx = typeof tc.index === 'number' ? tc.index : 0;
    const existing = byIndex.get(idx);
    if (!existing) {
      byIndex.set(idx, {
        index: tc.index,
        id: tc.id,
        type: tc.type,
        function: tc.function
          ? { name: tc.function.name, arguments: tc.function.arguments }
          : undefined,
      });
      return;
    }
    if (tc.id !== undefined) existing.id = tc.id;
    if (tc.type !== undefined) existing.type = tc.type;
    if (tc.function) {
      const ef = (existing.function ??= {});
      if (tc.function.name !== undefined) ef.name = tc.function.name;
      if (tc.function.arguments !== undefined) {
        ef.arguments = (ef.arguments ?? '') + tc.function.arguments;
      }
    }
  };

  for (const tc of accumulated) put(tc);
  for (const tc of incoming) put(tc);

  return [...byIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v);
}

/**
 * Read an SSE text/event-stream response line by line,
 * accumulate `choices[0].delta.content`, and stop on `data: [DONE]`.
 *
 * Lines prefixed with `data: ` are JSON-parsed. Non-JSON lines and
 * comment lines (starting with `:`) are silently ignored.
 *
 * If a delta contains `reasoning` (choices[0].delta.reasoning) or an
 * `error` field it is forwarded via `onDelta` but does not interrupt
 * accumulation.
 */
export async function streamChatCompletion(
  res: Response,
  onDelta?: DeltaCallback,
  opts?: StreamChatOptions,
): Promise<StreamResult> {
  if (!res.body) {
    throw new Error('Response has no readable body');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  // T117: activity-based idle timeout. A one-shot total-duration signal was
  // aborted even when chunks kept flowing (long thinking-model streams); now
  // each chunk resets the idle timer, and only a genuine stall aborts.
  const idleTimeoutMs =
    opts?.idleTimeoutMs && opts.idleTimeoutMs > 0 ? opts.idleTimeoutMs : 0;
  const externalSignal = opts?.signal;

  const idleController = idleTimeoutMs > 0 ? new AbortController() : null;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const clearIdleTimer = (): void => {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  };

  const armIdleTimer = (): void => {
    if (!idleController) return;
    clearIdleTimer();
    idleTimer = setTimeout(() => {
      idleController.abort(
        new Error(
          `Stream idle timeout: no chunk received for ${idleTimeoutMs}ms`,
        ),
      );
    }, idleTimeoutMs);
    // Never keep the event loop alive just to enforce an idle timeout.
    idleTimer.unref?.();
  };

  type ReadResult = Awaited<ReturnType<typeof reader.read>>;

  /** Interruptible read: races the body read against idle + external aborts. */
  const readChunk = (): Promise<ReadResult> => {
    if (externalSignal?.aborted) {
      return Promise.reject(
        externalSignal.reason ?? new Error('The operation was aborted'),
      );
    }
    if (idleController?.signal.aborted) {
      return Promise.reject(
        idleController.signal.reason ?? new Error('The operation was aborted'),
      );
    }
    const races: Promise<ReadResult>[] = [reader.read()];
    if (idleController) races.push(abortPromise(idleController.signal));
    if (externalSignal) races.push(abortPromise(externalSignal));
    return races.length === 1 ? races[0] : Promise.race(races);
  };

  let content = '';
  let reasoningContent = '';
  let toolCalls: ToolCallDelta[] | undefined;
  let usage: StreamResult['usage'] | undefined;
  let sessionId: string | undefined;
  let model: string | undefined;

  let buffer = '';

  try {
    while (true) {
      armIdleTimer();
      let readResult: ReadResult;
      try {
        readResult = await readChunk();
      } finally {
        clearIdleTimer();
      }
      if (readResult.done) break;

      buffer += decoder.decode(readResult.value, { stream: true });

      const lines = buffer.split('\n');
      // The last element may be incomplete; keep it in the buffer.
      buffer = lines.pop() ?? '';

      // T119: set once the upstream signals completion — either the [DONE]
      // sentinel or a non-null `finish_reason`. We stop the read loop before
      // [DONE] so callers never hang waiting for a [DONE] the provider may
      // not send after `finish_reason`.
      let reachedEnd = false;

      for (const line of lines) {
        const trimmed = line.trimEnd();

        // Skip empty lines, comment lines (SSE comments), and non-data lines.
        if (trimmed === '' || trimmed.startsWith(':')) {
          continue;
        }

        if (!trimmed.startsWith('data: ')) {
          continue;
        }

        const payload = trimmed.slice(6); // strip "data: "

        // Terminal sentinel.
        if (payload === '[DONE]') {
          // Drain any remaining buffer and exit.
          buffer = '';
          reachedEnd = true;
          break;
        }

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(payload);
        } catch {
          // Non-JSON data line — ignore.
          continue;
        }

        // Extract model from top-level if present.
        if (typeof parsed.model === 'string' && !model) {
          model = parsed.model;
        }

        // Extract sessionId from top-level or nested.
        if (typeof parsed.session_id === 'string' && !sessionId) {
          sessionId = parsed.session_id;
        }

        // Check for x402 top-up event first — not a real error.
        if (parsed.error) {
          const err = parsed.error as Record<string, unknown>;
          if (err.type === 'x402_top_up_required') {
            const topUpData = parsed.x402_top_up as
              | Record<string, unknown>
              | undefined;
            if (topUpData) {
              return {
                content,
                reasoningContent: reasoningContent || undefined,
                toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
                usage,
                sessionId,
                model,
                topUp: {
                  resumeSession: String(topUpData.resume_session ?? ''),
                  consumedTokens: Number(topUpData.consumed_tokens ?? 0),
                  consumedAmount: String(topUpData.consumed_amount ?? '0'),
                  topUpAmount: String(topUpData.top_up_amount ?? '0'),
                },
              };
            }
          }
          // Real error — throw.
          const msg =
            typeof err.message === 'string'
              ? err.message
              : JSON.stringify(err);
          throw new Error(`Stream error: ${msg}`);
        }

        const choices = parsed.choices as
          | Array<{ delta?: Record<string, unknown>; finish_reason?: string }>
          | undefined;

        if (!choices || choices.length === 0) {
          // Usage may come in a standalone chunk (OpenAI format).
          if (parsed.usage) {
            usage = normalizeUsage(parsed.usage as Record<string, unknown>);
          }
          continue;
        }

        const choice = choices[0];
        const delta = choice?.delta;

        const text =
          typeof delta?.content === 'string' ? delta.content : '';
        const reasoning =
          typeof delta?.reasoning === 'string' ? delta.reasoning : undefined;
        const reasoningContentDelta =
          typeof delta?.reasoning_content === 'string'
            ? delta.reasoning_content
            : undefined;
        // T119: read finish_reason at the choice level (not only inside a
        // `delta`) — a completion chunk may carry `finish_reason` with an
        // empty or absent `delta`.
        const finishReason =
          typeof choice.finish_reason === 'string' && choice.finish_reason
            ? choice.finish_reason
            : undefined;

        // T122: read `delta.tool_calls` (a model may answer entirely via a
        // tool call — `content` stays empty but the tool call is the answer).
        const toolCallsDelta = normalizeToolCalls(delta?.tool_calls);

        if (text) {
          content += text;
        }

        if (reasoningContentDelta) {
          reasoningContent += reasoningContentDelta;
        }

        if (toolCallsDelta && toolCallsDelta.length > 0) {
          toolCalls = mergeToolCalls(toolCalls ?? [], toolCallsDelta);
        }

        // Forward the delta when it carries content/reasoning/tool_calls, or
        // when a finish_reason arrived (the caller needs the completion
        // signal even if there is no accompanying delta).
        if (onDelta && (delta || finishReason)) {
          onDelta({
            content: text,
            reasoning,
            reasoningContent: reasoningContentDelta,
            finishReason,
            toolCalls: toolCallsDelta,
          });
        }

        // Usage may appear in the final choice chunk.
        if (parsed.usage) {
          usage = normalizeUsage(parsed.usage as Record<string, unknown>);
        }

        // T119: upstream declared completion (e.g. "stop"/"length"). Stop the
        // read loop now — the adapter writes its own [DONE] — rather than
        // waiting for a [DONE] that may never arrive.
        if (finishReason) {
          reachedEnd = true;
          break;
        }
      }

      if (reachedEnd) {
        break;
      }
    }
  } catch (err) {
    // Release the underlying connection on abort/stream errors.
    await reader.cancel().catch(() => {});
    throw err;
  } finally {
    clearIdleTimer();
  }

  // Flush any remaining buffer content.
  if (buffer.length > 0) {
    const trimmed = buffer.trimEnd();
    if (trimmed.startsWith('data: ') && trimmed.slice(6) !== '[DONE]') {
      const payload = trimmed.slice(6);
      try {
        const parsed = JSON.parse(payload);
        if (parsed.usage) {
          usage = normalizeUsage(parsed.usage as Record<string, unknown>);
        }
        if (typeof parsed.session_id === 'string' && !sessionId) {
          sessionId = parsed.session_id;
        }
      } catch {
        // ignore
      }
    }
  }

  return {
    content,
    reasoningContent: reasoningContent || undefined,
    toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
    usage,
    sessionId,
    model,
  };
}

export function normalizeUsage(raw: Record<string, unknown>): Usage | undefined {
  const promptTokens =
    typeof raw.prompt_tokens === 'number' ? raw.prompt_tokens : undefined;
  const completionTokens =
    typeof raw.completion_tokens === 'number'
      ? raw.completion_tokens
      : undefined;
  const totalTokens =
    typeof raw.total_tokens === 'number' ? raw.total_tokens : undefined;

  // Extract cache fields from prompt_tokens_details (OpenAI/GLM/DeepSeek).
  const details = raw.prompt_tokens_details as
    | Record<string, unknown>
    | undefined;
  const cachedTokens =
    typeof details?.cached_tokens === 'number'
      ? details.cached_tokens
      : undefined;
  const cacheCreationTokens =
    typeof details?.cached_creation_tokens === 'number'
      ? details.cached_creation_tokens
      : undefined;

  if (
    promptTokens === undefined &&
    completionTokens === undefined &&
    totalTokens === undefined &&
    cachedTokens === undefined &&
    cacheCreationTokens === undefined
  ) {
    return undefined;
  }

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cachedTokens,
    cacheCreationTokens,
  };
}
