import { randomBytes } from 'node:crypto';

import { privateKeyToAccount } from 'viem/accounts';
import type { PrivateKeyAccount } from 'viem/accounts';

import {
  USDC_BASE,
  EIP3009_DOMAIN,
  PERMIT2_DOMAIN,
  PERMIT2_SPENDER,
} from '../config.js';
import type { Permit2Authorization as Permit2Auth } from '../types.js';
import { streamChatCompletion, normalizeUsage } from './chat-stream.js';
import type { StreamResult } from './chat-stream.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface X402Accept {
  scheme: string;
  network: string;
  asset: string;
  /** Raw amount string as returned by the server (USDC has 6 decimals). */
  amount: string;
  /** Recipient wallet address. */
  payTo: string;
  extra?: Record<string, unknown>;
}

export interface X402Quote {
  x402Version: number;
  accepts: X402Accept[];
}

export interface Eip3009Authorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

export interface PaymentPayload {
  authorization?: Eip3009Authorization;
  signature?: `0x${string}`;
  permit2Authorization?: Permit2Auth;
}

interface PaymentHeaderObject {
  x402Version: number;
  scheme: string;
  resource: {
    url: string;
    description: string;
    mimeType: string;
  };
  accepted: X402Accept;
  payload: PaymentPayload;
}

export interface PaidChatResult {
  content: string;
  /** Accumulated reasoning_content from GLM/DeepSeek-style deltas. */
  reasoningContent?: string;
  model?: string;
  /** Amount paid in USD (6-decimal USDC amount converted to dollars). */
  paidUsd: number;
  sessionId?: string;
  usage?: StreamResult['usage'];
}

export interface PaidChatOptions {
  timeoutMs?: number;
  validForSec?: number;
  resourceDescription?: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class PaymentError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = 'PaymentError';
  }
}

// ---------------------------------------------------------------------------
// 1. fetchX402Quote — POST without auth; expect HTTP 402
// ---------------------------------------------------------------------------

/**
 * Send a POST request **without** payment headers and expect an HTTP 402
 * Payment Required response containing x402 quote details.
 *
 * The function first tries the `PAYMENT-REQUIRED` header (base64-encoded
 * JSON). If that header is missing it falls back to parsing the JSON body.
 *
 * @returns The parsed quote with `x402Version` and `accepts` array.
 * @throws {PaymentError} If the server does **not** respond with 402.
 */
export async function fetchX402Quote(
  url: string,
  body: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<X402Quote> {
  const signal = AbortSignal.timeout(timeoutMs);

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (res.status !== 402) {
    const text = await res.text().catch(() => '');
    throw new PaymentError(
      `Expected HTTP 402 but got ${res.status}${text ? `: ${text}` : ''}`,
      res.status,
      text,
    );
  }

  // Prefer the PAYMENT-REQUIRED header (base64-encoded JSON).
  const paymentHeader = res.headers.get('PAYMENT-REQUIRED');
  if (paymentHeader) {
    try {
      const decoded = Buffer.from(paymentHeader, 'base64').toString('utf-8');
      const parsed = JSON.parse(decoded) as X402Quote;
      if (parsed.x402Version !== undefined && Array.isArray(parsed.accepts)) {
        return parsed;
      }
    } catch {
      // Fall through to body parsing.
    }
  }

  // Fallback: parse the JSON body.
  let bodyText: string;
  try {
    bodyText = await res.text();
    const parsed = JSON.parse(bodyText) as X402Quote;
    if (parsed.x402Version !== undefined && Array.isArray(parsed.accepts)) {
      return parsed;
    }
    throw new PaymentError(
      '402 response body is not a valid x402 quote',
      402,
      bodyText,
    );
  } catch (err) {
    if (err instanceof PaymentError) throw err;
    throw new PaymentError(
      'Failed to parse 402 response as x402 quote',
      402,
    );
  }
}

// ---------------------------------------------------------------------------
// 2. pickFirstAccept
// ---------------------------------------------------------------------------

export function pickFirstAccept(accepts: X402Accept[]): X402Accept {
  if (!accepts || accepts.length === 0) {
    throw new PaymentError('No payment accept entries in 402 response');
  }
  return accepts[0];
}

// ---------------------------------------------------------------------------
// 3. signEip3009 — EIP-3009 TransferWithAuthorization
// ---------------------------------------------------------------------------

const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

/**
 * Sign an EIP-3009 `TransferWithAuthorization` typed data message using the
 * caller's private key.
 *
 * The signed message authorizes a USDC transfer of `accepted.amount` to
 * `accepted.payTo` from `from`, valid for `validForSec` seconds.
 *
 * @returns The authorization details together with the hex-encoded signature.
 */
export async function signEip3009(
  privateKey: `0x${string}`,
  accepted: X402Accept,
  from: `0x${string}`,
  opts?: { validForSec?: number },
): Promise<PaymentPayload> {
  const account: PrivateKeyAccount = privateKeyToAccount(privateKey);
  const validForSec = opts?.validForSec ?? 3600;
  const nowSec = Math.floor(Date.now() / 1000);

  const nonceBytes = randomBytes(32);
  const nonceHex = `0x${nonceBytes.toString('hex')}` as `0x${string}`;

  const message = {
    from,
    to: accepted.payTo as `0x${string}`,
    value: BigInt(accepted.amount),
    validAfter: 0n,
    validBefore: BigInt(nowSec + validForSec),
    nonce: nonceHex,
  } as const;

  const signature = await account.signTypedData({
    domain: { ...EIP3009_DOMAIN, verifyingContract: USDC_BASE as `0x${string}` },
    types: EIP3009_TYPES,
    primaryType: 'TransferWithAuthorization',
    message,
  });

  return {
    authorization: {
      from,
      to: accepted.payTo,
      value: accepted.amount,
      validAfter: '0',
      validBefore: String(nowSec + validForSec),
      nonce: nonceHex,
    },
    signature,
  };
}

// ---------------------------------------------------------------------------
// 3b. signPermit2 — Permit2 PermitWitnessTransferFrom (upto scheme)
// ---------------------------------------------------------------------------

const PERMIT2_TYPES = {
  TokenPermissions: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
  Witness: [
    { name: 'to', type: 'address' },
    { name: 'facilitator', type: 'address' },
    { name: 'validAfter', type: 'uint256' },
  ],
  PermitWitnessTransferFrom: [
    { name: 'permitted', type: 'TokenPermissions' },
    { name: 'spender', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'witness', type: 'Witness' },
  ],
} as const;

/**
 * Sign a Permit2 `PermitWitnessTransferFrom` typed data message for the upto
 * scheme using the caller's private key.
 *
 * The signed message authorises a USDC transfer of up to `accepted.amount` to
 * `accepted.payTo`, settled by the facilitator specified in the 402 response
 * (`accepted.extra.facilitatorAddress`). The actual settlement amount is
 * determined post-execution and may be ≤ the authorised ceiling.
 *
 * @returns A `PaymentPayload` with `permit2Authorization` (signature included).
 */
export async function signPermit2(
  privateKey: `0x${string}`,
  accepted: X402Accept,
  from: `0x${string}`,
  opts?: { validForSec?: number },
): Promise<PaymentPayload> {
  const account: PrivateKeyAccount = privateKeyToAccount(privateKey);
  const validForSec = opts?.validForSec ?? 3600;
  const nowSec = Math.floor(Date.now() / 1000);

  const facilitatorAddress =
    (accepted.extra?.facilitatorAddress as string) ??
    '0x8f5cb67b49555e614892b7233cfddebfb746e531';

  // Generate a random uint256 nonce (Permit2 uses a bitmap; random avoids
  // collisions across concurrent signers).
  const nonceBytes = randomBytes(32);
  const nonceBigInt = BigInt(`0x${nonceBytes.toString('hex')}`);

  const message = {
    permitted: {
      token: accepted.asset as `0x${string}`,
      amount: BigInt(accepted.amount),
    },
    spender: PERMIT2_SPENDER as `0x${string}`,
    nonce: nonceBigInt,
    deadline: BigInt(nowSec + validForSec),
    witness: {
      to: accepted.payTo as `0x${string}`,
      facilitator: facilitatorAddress as `0x${string}`,
      validAfter: 0n,
    },
  } as const;

  const signature = await account.signTypedData({
    domain: PERMIT2_DOMAIN,
    types: PERMIT2_TYPES,
    primaryType: 'PermitWitnessTransferFrom',
    message,
  });

  return {
    permit2Authorization: {
      permitted: {
        token: accepted.asset,
        amount: accepted.amount,
      },
      spender: PERMIT2_SPENDER,
      nonce: nonceBigInt.toString(),
      deadline: String(nowSec + validForSec),
      witness: {
        to: accepted.payTo,
        facilitator: facilitatorAddress,
        validAfter: '0',
      },
      signature,
    },
  };
}

// ---------------------------------------------------------------------------
// 4. buildPaymentHeader
// ---------------------------------------------------------------------------

/**
 * Build the base64-encoded JSON `PAYMENT-SIGNATURE` header value for the
 * x402 protocol.
 */
export function buildPaymentHeader(
  accepted: X402Accept,
  payload: PaymentPayload,
  resourceUrl: string,
  resourceDescription: string,
): string {
  const obj: PaymentHeaderObject = {
    x402Version: 2,
    scheme: accepted.scheme,
    resource: {
      url: resourceUrl,
      description: resourceDescription,
      mimeType: 'application/json',
    },
    accepted,
    payload,
  };

  return Buffer.from(JSON.stringify(obj)).toString('base64');
}

// ---------------------------------------------------------------------------
// 5. paidChatCompletion — full x402 flow
// ---------------------------------------------------------------------------

/**
 * Execute a complete x402 paid chat completion against a token4u-compatible
 * endpoint.
 *
 * Flow:
 * 1. POST without payment → expect HTTP 402 with quote.
 * 2. Pick an accept entry and sign an authorization (Permit2 or EIP-3009).
 * 3. Re-send the original request with a `PAYMENT-SIGNATURE` header.
 * 4. If the response is still 402 → throw `PaymentError`.
 * 5. If the response is SSE (`text/event-stream`) → stream and accumulate.
 * 6. Otherwise parse as plain JSON.
 *
 * @returns The accumulated content, model name, amount paid in USD, and
 *          optional session / usage metadata.
 */
export async function paidChatCompletion(
  baseUrl: string,
  body: Record<string, unknown>,
  privateKey: `0x${string}`,
  opts?: PaidChatOptions,
): Promise<PaidChatResult> {
  const resourceUrl = `${baseUrl}/v1/chat/completions`;
  const resourceDescription = opts?.resourceDescription ?? 'Chat completion';

  // Step 1 — fetch the x402 quote (expect 402).
  const quote = await fetchX402Quote(resourceUrl, body, opts?.timeoutMs);

  // Step 2 — pick the first accepted payment method.
  const accepted = pickFirstAccept(quote.accepts);

  // Step 3 — sign the authorization.
  // Permit2 (upto scheme) is the only accepted method on token4u live
  // (X402_ASSET_TRANSFER_METHOD=permit2). Sign Permit2; if the server still
  // advertises EIP-3009 (legacy), fall back to it for backward compatibility.
  const account = privateKeyToAccount(privateKey);
  const from = account.address;
  const assetTransferMethod = accepted.extra?.assetTransferMethod;
  const payload =
    assetTransferMethod === 'permit2'
      ? await signPermit2(privateKey, accepted, from, {
          validForSec: opts?.validForSec,
        })
      : await signEip3009(privateKey, accepted, from, {
          validForSec: opts?.validForSec,
        });

  // Step 4 — build the PAYMENT-SIGNATURE header.
  const paymentHeader = buildPaymentHeader(
    accepted,
    payload,
    resourceUrl,
    resourceDescription,
  );

  // Step 5 — re-send the request with payment.
  const signal = AbortSignal.timeout(opts?.timeoutMs ?? 30_000);
  const res = await fetch(resourceUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'PAYMENT-SIGNATURE': paymentHeader,
    },
    body: JSON.stringify(body),
    signal,
  });

  // Step 6 — handle 402 rejection.
  if (res.status === 402) {
    const text = await res.text().catch(() => '');
    throw new PaymentError(
      'Payment rejected. Check your USDC balance.',
      402,
      text,
    );
  }

  // Step 7 — stream SSE or parse JSON.
  const contentType = res.headers.get('content-type') ?? '';

  let streamResult: StreamResult;
  if (contentType.includes('text/event-stream')) {
    streamResult = await streamChatCompletion(res);
  } else {
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const content =
      typeof json.choices === 'object' && json.choices !== null
        ? String(
            (
              (json.choices as Array<{ message?: { content?: string } }>)[0]
                ?.message?.content ?? ''
            ),
          )
        : '';

    streamResult = {
      content,
      reasoningContent: (() => {
        const msg = (json.choices as Array<{ message?: Record<string, unknown> }> | undefined)?.[0]?.message;
        if (msg && typeof msg.reasoning_content === 'string') return msg.reasoning_content;
        if (msg && typeof msg.reasoning === 'string') return msg.reasoning;
        return undefined;
      })(),
      model: typeof json.model === 'string' ? json.model : undefined,
      usage: json.usage
        ? normalizeUsage(json.usage as Record<string, unknown>)
        : undefined,
      sessionId:
        typeof json.session_id === 'string'
          ? json.session_id
          : undefined,
    };
  }

  // Step 8 — extract sessionId from response headers as fallback.
  const sessionId =
    streamResult.sessionId ??
    res.headers.get('X-402-SESSION') ??
    undefined;

  // paidUsd = USDC amount (6 decimals) → dollars.
  const paidUsd = Number(accepted.amount) / 1e6;

  return {
    content: streamResult.content,
    reasoningContent: streamResult.reasoningContent,
    model: streamResult.model,
    paidUsd,
    sessionId,
    usage: streamResult.usage,
  };
}
