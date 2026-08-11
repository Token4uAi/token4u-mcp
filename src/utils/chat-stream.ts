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

export interface StreamResult {
  content: string;
  /** Accumulated reasoning_content from GLM/DeepSeek-style deltas. */
  reasoningContent?: string;
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
}) => void;

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
): Promise<StreamResult> {
  if (!res.body) {
    throw new Error('Response has no readable body');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let content = '';
  let reasoningContent = '';
  let usage: StreamResult['usage'] | undefined;
  let sessionId: string | undefined;
  let model: string | undefined;

  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    // The last element may be incomplete; keep it in the buffer.
    buffer = lines.pop() ?? '';

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

      if (delta) {
        const text =
          typeof delta.content === 'string' ? delta.content : '';
        const reasoning =
          typeof delta.reasoning === 'string'
            ? delta.reasoning
            : undefined;
        const reasoningContentDelta =
          typeof delta.reasoning_content === 'string'
            ? delta.reasoning_content
            : undefined;
        const finishReason =
          typeof choice.finish_reason === 'string'
            ? choice.finish_reason
            : undefined;

        if (text) {
          content += text;
        }

        if (reasoningContentDelta) {
          reasoningContent += reasoningContentDelta;
        }

        if (onDelta) {
          onDelta({
            content: text,
            reasoning,
            reasoningContent: reasoningContentDelta,
            finishReason,
          });
        }
      }

      // Usage may appear in the final choice chunk.
      if (parsed.usage) {
        usage = normalizeUsage(parsed.usage as Record<string, unknown>);
      }
    }
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
