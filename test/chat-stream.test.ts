import { describe, it } from 'node:test';
import assert from 'node:assert';

import { streamChatCompletion } from '../src/utils/chat-stream.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

function sseChunk(deltaContent: string): string {
  return `data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"${deltaContent}"}}]}\n\n`;
}

/** A Response whose body enqueues every given chunk immediately, then closes. */
function immediateResponse(chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

/**
 * A Response whose body enqueues one chunk, then stalls forever (the stream
 * stays open but no further data ever arrives) — simulates a dead upstream.
 */
function stalledResponse(firstChunk: string): Response {
  let sent = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(encoder.encode(firstChunk));
        return;
      }
      // Never resolve — keeps the stream open without a busy pull loop.
      return new Promise<never>(() => {});
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

/**
 * A Response whose body enqueues one chunk every `intervalMs`, closing after
 * the last chunk. Total wall time exceeds a single idle window, but no gap
 * between chunks does.
 */
function intervalResponse(chunks: string[], intervalMs: number): Response {
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const push = (): void => {
        if (i < chunks.length) {
          controller.enqueue(encoder.encode(chunks[i++]));
          setTimeout(push, intervalMs);
        } else {
          controller.close();
        }
      };
      push();
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('streamChatCompletion', () => {
  it('accumulates deltas and stops at [DONE]', async () => {
    const res = immediateResponse([
      sseChunk('Hello'),
      sseChunk(' world'),
      'data: [DONE]\n\n',
    ]);

    const result = await streamChatCompletion(res);

    assert.strictEqual(result.content, 'Hello world');
  });

  it('does not abort while chunks keep arriving (activity resets idle)', async () => {
    // 6 chunks × 20ms = ~120ms total, but every gap is only 20ms.
    const chunks = ['a', 'b', 'c', 'd', 'e', 'f'].map((c) => sseChunk(c));
    chunks.push('data: [DONE]\n\n');
    const res = intervalResponse(chunks, 20);

    const result = await streamChatCompletion(res, undefined, {
      idleTimeoutMs: 60,
    });

    assert.strictEqual(result.content, 'abcdef');
  });

  it('aborts with an idle-timeout error when the stream stalls', async () => {
    const res = stalledResponse(sseChunk('partial'));

    await assert.rejects(
      () => streamChatCompletion(res, undefined, { idleTimeoutMs: 50 }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match((err as Error).message, /idle timeout/i);
        return true;
      },
    );
  });

  it('interrupts a stalled read when the external signal aborts', async () => {
    const res = stalledResponse(sseChunk('partial'));
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error('total safety-net timeout')),
      40,
    );

    try {
      await assert.rejects(
        () =>
          streamChatCompletion(res, undefined, {
            signal: controller.signal,
          }),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.match((err as Error).message, /total safety-net timeout/);
          return true;
        },
      );
    } finally {
      clearTimeout(timer);
    }
  });

  it('forwards finish_reason via onDelta (T119)', async () => {
    const deltas: Array<{ content: string; finishReason?: string }> = [];
    const res = immediateResponse([
      sseChunk('Hello'),
      'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ]);

    const result = await streamChatCompletion(res, (d) => {
      deltas.push({ content: d.content, finishReason: d.finishReason });
    });

    assert.strictEqual(result.content, 'Hello');
    assert.strictEqual(deltas.length, 2);
    assert.strictEqual(deltas[1].content, '');
    assert.strictEqual(deltas[1].finishReason, 'stop');
  });

  it('terminates on finish_reason without waiting for [DONE] or body close (T119)', async () => {
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(encoder.encode(sseChunk('Hello')));
          controller.enqueue(
            encoder.encode(
              'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
            ),
          );
          return;
        }
        // Never resolve — if the loop waits for [DONE]/body close it hangs.
        return new Promise<never>(() => {});
      },
    });
    const res = new Response(body, {
      headers: { 'content-type': 'text/event-stream' },
    });

    const result = await streamChatCompletion(res);

    assert.strictEqual(result.content, 'Hello');
  });

  it('aggregates tool_calls fragments across chunks and forwards them (T122)', async () => {
    const sseData = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;

    const deltas: Array<{ toolCalls?: unknown }> = [];
    const res = immediateResponse([
      sseData({
        id: 'c1',
        object: 'chat.completion.chunk',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'get_weather', arguments: '{"city":' },
                },
              ],
            },
          },
        ],
      }),
      sseData({
        id: 'c1',
        object: 'chat.completion.chunk',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: '"SF"}' } },
              ],
            },
          },
        ],
      }),
      sseData({
        id: 'c1',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      }),
      'data: [DONE]\n\n',
    ]);

    const result = await streamChatCompletion(res, (d) => {
      deltas.push({ toolCalls: d.toolCalls });
    });

    // content stays empty but tool_calls is the answer.
    assert.strictEqual(result.content, '');
    assert.ok(result.toolCalls, 'result.toolCalls should be aggregated');
    assert.strictEqual(result.toolCalls.length, 1);
    const tc = result.toolCalls[0];
    assert.strictEqual(tc.id, 'call_1');
    assert.strictEqual(tc.type, 'function');
    assert.strictEqual(tc.function?.name, 'get_weather');
    assert.strictEqual(tc.function?.arguments, '{"city":"SF"}');

    // Two tool-call deltas + one terminal finish_reason delta forwarded.
    assert.strictEqual(deltas.length, 3);
    assert.ok(Array.isArray(deltas[0].toolCalls));
    assert.strictEqual(
      (deltas[0].toolCalls as Array<Record<string, unknown>>)[0].id,
      'call_1',
    );
  });
});
