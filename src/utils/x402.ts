import { randomBytes } from 'node:crypto';

import { privateKeyToAccount } from 'viem/accounts';
import type { PrivateKeyAccount } from 'viem/accounts';
import {
  createPublicClient,
  http,
  encodeFunctionData,
  decodeFunctionResult,
} from 'viem';

import {
  USDC_BASE,
  EIP3009_DOMAIN,
  PERMIT2_DOMAIN,
  PERMIT2_SPENDER,
  PERMIT2_CONTRACT,
  BASE_RPC_URL,
  USDC_EIP2612_DOMAIN,
  EIP2612_PERMIT_TYPES,
  ERC20_ALLOWANCE_ABI,
  USDC_NONCES_ABI,
} from '../config.js';
import type { Permit2Authorization as Permit2Auth } from '../types.js';
import {
  EIP2612_GAS_SPONSORING_KEY,
  ERC20_APPROVAL_GAS_SPONSORING_KEY,
} from '../types.js';
import type { Eip2612PermitInfo } from '../types.js';
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
  /** Gas sponsoring extensions (e.g. EIP-2612 permit for gasless approve). */
  __extensions?: Record<string, unknown>;
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
  /** Gas-sponsoring extensions at paymentPayload level (CDP reads payload.extensions). */
  extensions?: Record<string, unknown>;
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
  /** Max payment attempts for transient permit/allowance failures (default 3). */
  maxPaymentAttempts?: number;
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
      from: from,
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
// 3c. Gas sponsoring extensions — allowance check + EIP-2612 permit + CDP hint
// ---------------------------------------------------------------------------

/** Lazy-initialised viem PublicClient for on-chain eth_call reads. */
let _publicClient: ReturnType<typeof createPublicClient> | null = null;

function getPublicClient(): ReturnType<typeof createPublicClient> {
  if (!_publicClient) {
    _publicClient = createPublicClient({
      transport: http(BASE_RPC_URL),
    });
  }
  return _publicClient;
}

/** Detected gas-sponsoring extensions from a quote accept entry. */
export interface GasSponsoringExtensions {
  eip2612GasSponsoring: boolean;
  erc20ApprovalGasSponsoring: boolean;
}

/**
 * Detect which gas-sponsoring extensions are advertised in the 402 quote.
 *
 * The server declares extensions in `accept.extra` — e.g.
 * `extra.erc20ApprovalGasSponsoring` or `extra.eip2612GasSponsoring`.
 */
export function detectGasSponsoringExtensions(
  accepted: X402Accept,
): GasSponsoringExtensions {
  const extra = accepted.extra ?? {};
  return {
    eip2612GasSponsoring: extra[EIP2612_GAS_SPONSORING_KEY] !== undefined,
    erc20ApprovalGasSponsoring:
      extra[ERC20_APPROVAL_GAS_SPONSORING_KEY] !== undefined,
  };
}

/**
 * Check whether the wallet has sufficient USDC allowance for the Permit2
 * canonical contract via an on-chain `eth_call`.
 *
 * @returns `true` when `allowance(owner, PERMIT2) >= amount`, or when the
 *          RPC call fails (fail-open to avoid blocking legitimate payments).
 */
export async function checkAllowance(
  owner: `0x${string}`,
  amount: string,
): Promise<boolean> {
  try {
    const client = getPublicClient();
    const data = encodeFunctionData({
      abi: ERC20_ALLOWANCE_ABI,
      functionName: 'allowance',
      // T83d-fix: CDP consumes the 0x0000 (Permit2 contract) allowance via
      // settleWithPermit — check against PERMIT2_CONTRACT.
      args: [owner, PERMIT2_CONTRACT as `0x${string}`],
    });

    const result = await client.call({
      to: USDC_BASE as `0x${string}`,
      data,
    });

    if (!result.data) return false;

    const allowance = decodeFunctionResult({
      abi: ERC20_ALLOWANCE_ABI,
      functionName: 'allowance',
      data: result.data,
    });

    return (allowance as bigint) >= BigInt(amount);
  } catch {
    // Fail open: on RPC issues, assume allowance is sufficient to avoid
    // blocking a legitimate payment flow.
    return true;
  }
}

/**
 * Sign an EIP-2612 permit authorising Permit2 to spend USDC on behalf of the
 * wallet owner.  This is the gasless-approve path — the permit signature is
 * attached to the payment payload so the server/facilitator can submit the
 * `permit()` + `settle` atomically.
 */

// Module-level monotonic permit nonce tracker (per process). Prevents
// consecutive gasless permits from reusing a nonce while the chain read is
// stale (e.g. the previous permit's settle tx hasn't been mined yet).
let _lastPermitNonce = -1n;
let _permitNonceLock: Promise<void> | null = null;
// T87b: pending permit nonce — set when we sign+send a permit payment and
// cleared once the chain nonce advances past it (previous settle mined).
let _pendingPermitNonce: bigint | null = null;

function _nextPermitNonce(): bigint {
  return _lastPermitNonce + 1n;
}

async function _withPermitNonceLock<T>(fn: () => Promise<T>): Promise<T> {
  while (_permitNonceLock) {
    await _permitNonceLock;
  }
  let release!: () => void;
  _permitNonceLock = new Promise((res) => (release = res));
  try {
    return await fn();
  } finally {
    _permitNonceLock = null;
    release();
  }
}

/**
 * Read the current on-chain EIP-2612 nonce, waiting (bounded) until any
 * previously signed permit's settle tx has mined — otherwise two permits from
 * the same wallet would reuse the nonce and the second settle would revert
 * (the T87 root cause).
 */
async function readCurrentPermitNonce(from: `0x${string}`): Promise<string> {
  const deadline = Date.now() + 25_000; // wait up to 25s for the prior settle
  for (;;) {
    let chainNonce: bigint;
    try {
      const client = getPublicClient();
      const data = encodeFunctionData({
        abi: USDC_NONCES_ABI,
        functionName: 'nonces',
        args: [from],
      });
      const result = await client.call({
        to: USDC_BASE as `0x${string}`,
        data,
      });
      chainNonce = result.data
        ? BigInt(
            String(
              decodeFunctionResult({
                abi: USDC_NONCES_ABI,
                functionName: 'nonces',
                data: result.data,
              }) as bigint,
            ),
          )
        : 0n;
    } catch {
      chainNonce = _pendingPermitNonce !== null ? _pendingPermitNonce + 1n : 0n;
    }
    if (_pendingPermitNonce === null || chainNonce > _pendingPermitNonce) {
      _pendingPermitNonce = chainNonce;
      _lastPermitNonce = chainNonce;
      return String(chainNonce);
    }
    if (Date.now() > deadline) {
      // Give up waiting — sign with chainNonce+1 as a best effort. The
      // server-side T87 lock should prevent the collision in most cases.
      const fallback = chainNonce + 1n;
      _pendingPermitNonce = fallback;
      _lastPermitNonce = fallback;
      return String(fallback);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

/**
 * Sign an ERC-20 approve(Permit2, MaxUint256) transaction for CDP gas
 * sponsoring (erc20ApprovalGasSponsoring). The signed tx is attached to the
 * payload — CDP broadcasts it (covering gas) so the buyer's allowance becomes
 * permanent and subsequent payments skip the permit entirely.
 */
export async function signErc20ApprovalTransaction(
  privateKey: `0x${string}`,
  from: `0x${string}`,
  chainId = 8453,
): Promise<{
  from: string;
  asset: string;
  spender: string;
  amount: string;
  signedTransaction: `0x${string}`;
  version: string;
}> {
  const account: PrivateKeyAccount = privateKeyToAccount(privateKey);
  const maxUint256 =
    '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

  const nonce = await getPublicClient().getTransactionCount({
    address: from,
  });

  // Use realistic fees — CDP broadcasts this raw tx, so it must be payable
  // at the current Base gas price (a too-low price fails the simulation).
  let maxFeePerGas = 10_000_000_000n; // 10 gwei default
  let maxPriorityFeePerGas = 100_000_000n; // 0.1 gwei tip default
  try {
    const fees = await getPublicClient().estimateFeesPerGas();
    if (fees.maxFeePerGas) maxFeePerGas = fees.maxFeePerGas;
    if (fees.maxPriorityFeePerGas) maxPriorityFeePerGas = fees.maxPriorityFeePerGas;
  } catch {
    // keep defaults
  }

  const tx = {
    to: USDC_BASE as `0x${string}`,
    data: encodeFunctionData({
      abi: [
        {
          type: 'function',
          name: 'approve',
          inputs: [
            { name: 'spender', type: 'address' },
            { name: 'amount', type: 'uint256' },
          ],
          outputs: [{ name: '', type: 'bool' }],
        },
      ] as const,
      functionName: 'approve',
      args: [PERMIT2_CONTRACT as `0x${string}`, BigInt(maxUint256)],
    }),
    nonce,
    gas: 100_000n,
    maxFeePerGas,
    maxPriorityFeePerGas,
    chainId: chainId as number,
  } as const;

  const signed = await account.signTransaction(
    tx as unknown as Parameters<typeof account.signTransaction>[0],
  );

  return {
    from,
    asset: USDC_BASE,
    spender: PERMIT2_CONTRACT,
    amount: maxUint256,
    signedTransaction: signed,
    version: '1',
  };
}

export async function signEip2612Permit(
  privateKey: `0x${string}`,
  accepted: X402Accept,
  from: `0x${string}`,
  opts?: { validForSec?: number },
): Promise<Eip2612PermitInfo> {
  const account: PrivateKeyAccount = privateKeyToAccount(privateKey);
  const validForSec = opts?.validForSec ?? 3600;
  const nowSec = Math.floor(Date.now() / 1000);
  const deadline = String(nowSec + validForSec);

  // Fetch the current EIP-2612 nonce under a lock, waiting for any prior
  // permit's settle to mine first (T87b) — USDC permit requires
  // nonce == current on-chain nonce.
  const nonce = await _withPermitNonceLock(async () => {
    return readCurrentPermitNonce(from);
  });

  const message = {
    owner: from,
    // CDP validates eip2612_info.spender == PERMIT2_ADDRESS (0x0000) and
    // settleWithPermit consumes that allowance. amount must match the
    // settlement amount — max uint256 fails CDP simulation (T83c reverted).
    spender: PERMIT2_CONTRACT as `0x${string}`,
    value: BigInt(accepted.amount),
    nonce: BigInt(nonce),
    deadline: BigInt(deadline),
  };

  const signature = await account.signTypedData({
    domain: USDC_EIP2612_DOMAIN,
    types: EIP2612_PERMIT_TYPES,
    primaryType: 'Permit',
    message,
  });

  return {
    from,
    asset: accepted.asset,
    spender: PERMIT2_CONTRACT,
    amount: accepted.amount,
    nonce,
    deadline,
    signature,
    version: '1',
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
  extensions?: Record<string, unknown>,
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
    extensions,
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
 * 2. Pick an accept entry, detect gas-sponsoring extensions, check allowance.
 * 3. If allowance is insufficient and EIP-2612 is available → sign a gasless
 *    permit; otherwise show a descriptive error (CDP sponsoring / manual approve).
 * 4. Sign the payment authorization (Permit2 or EIP-3009).
 * 5. Re-send the original request with a `PAYMENT-SIGNATURE` header.
 * 6. If the response is still 402 → throw `PaymentError`.
 * 7. If the response is SSE (`text/event-stream`) → stream and accumulate.
 * 8. Otherwise parse as plain JSON.
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
  const maxAttempts = opts?.maxPaymentAttempts ?? 3;
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await _paidChatCompletionOnce(baseUrl, body, privateKey, opts);
    } catch (err) {
      lastErr = err as Error;
      const msg = (err as Error).message || '';
      // PaymentError carries the server 402 body in `body` (third ctor arg).
      const body =
        err instanceof PaymentError && 'body' in err
          ? String((err as unknown as { body?: unknown }).body ?? '')
          : '';
      const combined = msg + ' ' + body;
      // Retry only on transient permit/allowance failures (the previous
      // permit's settle tx may not be mined yet — re-read the nonce).
      const retryable =
        combined.includes('allowance_required') ||
        combined.includes('Permit2') ||
        combined.includes('signature') ||
        combined.includes('simulation');
      if (!retryable || attempt >= maxAttempts) break;
      // Wait for the previous permit's settle tx to be mined (USDC permit
      // nonce must equal the current on-chain nonce — a 10s wait lets the
      // tx confirm so the re-read sees the bumped nonce).
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
  throw lastErr ?? new Error('paidChatCompletion failed');
}

async function _paidChatCompletionOnce(
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

  // Resolve the signer account.
  const account = privateKeyToAccount(privateKey);
  const from = account.address;
  const assetTransferMethod = accepted.extra?.assetTransferMethod;

  // -----------------------------------------------------------------------
  // Step 2b — gasless approve check (Permit2 only).
  //
  // Permit2 requires the user to have approved USDC for the canonical
  // Permit2 contract.  If the allowance is insufficient the server will
  // reject with `permit2_allowance_required`.  We check ahead of time so
  // we can attach a gasless EIP-2612 permit (or show a helpful error).
  // -----------------------------------------------------------------------
  let __extensions: Record<string, unknown> | undefined;

  if (assetTransferMethod === 'permit2') {
    // Detect which gas-sponsoring extensions the server advertises.

    const hasAllowance = await checkAllowance(from, accepted.amount);
    if (!hasAllowance) {
      // T83e: prefer EIP-2612 permit — CDP validates it without requiring
      // server-side extension registration (erc20ApprovalGasSponsoring needs
      // the CDP operator to register the extension, which is not guaranteed).
      // Retry with fresh chain nonce handles the consecutive-permit race.
      try {
        const eip2612Info = await signEip2612Permit(
          privateKey,
          accepted,
          from,
          { validForSec: opts?.validForSec },
        );
        __extensions = {
          [EIP2612_GAS_SPONSORING_KEY]: { info: eip2612Info },
        };
      } catch (permitErr) {
        const gasExtensions = detectGasSponsoringExtensions(accepted);
        if (gasExtensions.erc20ApprovalGasSponsoring) {
          // Fallback: CDP gas-sponsored approve (permanent allowance).
          try {
            const approvalInfo = await signErc20ApprovalTransaction(
              privateKey,
              from,
            );
            __extensions = {
              [ERC20_APPROVAL_GAS_SPONSORING_KEY]: { info: approvalInfo },
            };
          } catch (approvalErr) {
            throw new PaymentError(
              `Insufficient USDC allowance for Permit2 (${PERMIT2_CONTRACT}).\n` +
                `EIP-2612 permit failed: ${(permitErr as Error).message}\n` +
                `CDP approval sponsoring failed: ${(approvalErr as Error).message}\n` +
                `Please manually call USDC.approve(${PERMIT2_CONTRACT}, MaxUint256) on Base.`,
            );
          }
        } else {
          throw new PaymentError(
            `Insufficient USDC allowance for Permit2 (${PERMIT2_CONTRACT}).\n` +
              `EIP-2612 permit failed: ${(permitErr as Error).message}\n` +
              `Please manually call USDC.approve(${PERMIT2_CONTRACT}, amount) on Base.`,
          );
        }
      }
    }
  }

  // Step 3 — sign the authorization.
  // Permit2 (upto scheme) is the only accepted method on token4u live
  // (X402_ASSET_TRANSFER_METHOD=permit2). Sign Permit2; if the server still
  // advertises EIP-3009 (legacy), fall back to it for backward compatibility.
  const payload =
    assetTransferMethod === 'permit2'
      ? await signPermit2(privateKey, accepted, from, {
          validForSec: opts?.validForSec,
        })
      : await signEip3009(privateKey, accepted, from, {
          validForSec: opts?.validForSec,
        });

  // Attach gas-sponsoring extensions at paymentPayload level (CDP reads
  // payload.extensions — e.g. EIP-2612 permit for gasless approve).
  const extensions = __extensions;

  // Step 4 — build the PAYMENT-SIGNATURE header.
  const paymentHeader = buildPaymentHeader(
    accepted,
    payload,
    resourceUrl,
    resourceDescription,
    extensions,
  );

  // Step 5 — re-send the request with payment.
  // T87d: force stream=true so the server's mid-flow token check (top-up 402)
  // can interrupt long outputs. Non-streaming requests bypass the stream
  // handler's token-limit logic, so long GLM/DS outputs were never billed
  // past the floor (revenue loss).
  const requestBody = { ...body, stream: true };
  const signal = AbortSignal.timeout(opts?.timeoutMs ?? 30_000);
  const res = await fetch(resourceUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'PAYMENT-SIGNATURE': paymentHeader,
    },
    body: JSON.stringify(requestBody),
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

  // -----------------------------------------------------------------------
  // Step 7b — top-up loop (auto-resume on x402_top_up_required).
  //
  // Long outputs may exceed the initial payment ceiling.  The server sends
  // an SSE event with error.type = "x402_top_up_required" and an
  // x402_top_up payload.  We sign a new Permit2 covering the consumed +
  // top-up amount, send a new POST with X-402-RESUME, and continue
  // streaming, accumulating across all segments.
  // -----------------------------------------------------------------------
  const MAX_TOP_UPS = 5;
  let topUpCount = 0;
  let accumulatedContent = streamResult.content;
  let accumulatedReasoning = streamResult.reasoningContent;
  let accumulatedUsage = streamResult.usage;
  let totalPaidUsd = Number(accepted.amount) / 1e6;

  while (streamResult.topUp && topUpCount < MAX_TOP_UPS) {
    topUpCount++;
    const topUp = streamResult.topUp;

    // New Permit2 ceiling = consumed so far + additional for next segment.
    const newAmount = String(
      BigInt(topUp.consumedAmount) + BigInt(topUp.topUpAmount),
    );
    const newAccepted: X402Accept = { ...accepted, amount: newAmount };

    // Sign a fresh authorization for the updated ceiling.
    const newPayload =
      assetTransferMethod === 'permit2'
        ? await signPermit2(privateKey, newAccepted, from, {
            validForSec: opts?.validForSec,
          })
        : await signEip3009(privateKey, newAccepted, from, {
            validForSec: opts?.validForSec,
          });

    // T88b: the gas-sponsoring extensions (EIP-2612 permit) must be RE-SIGNED
    // for the top-up too — the original permit's nonce was consumed by the
    // first segment's settle, so reusing it makes CDP reject the resume
    // with allowance_required.
    let resumeExtensions = extensions;
    if (assetTransferMethod === 'permit2' && resumeExtensions) {
      try {
        const eip2612Info = await signEip2612Permit(
          privateKey,
          newAccepted,
          from,
          { validForSec: opts?.validForSec },
        );
        resumeExtensions = {
          [EIP2612_GAS_SPONSORING_KEY]: { info: eip2612Info },
        };
      } catch {
        // If the permit re-sign fails, keep the old extensions — the server
        // may still accept if the allowance is already sufficient.
      }
    }

    // Build a new PAYMENT-SIGNATURE header for the resume request.
    const newPaymentHeader = buildPaymentHeader(
      newAccepted,
      newPayload,
      resourceUrl,
      resourceDescription,
      resumeExtensions,
    );

    // Send the resume request with X-402-RESUME so the server can
    // re-attach to the in-progress chat session.
    const requestBody = { ...body, stream: true };
    const resumeSignal = AbortSignal.timeout(opts?.timeoutMs ?? 60_000);
    const resumeRes = await fetch(resourceUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'PAYMENT-SIGNATURE': newPaymentHeader,
        'X-402-RESUME': topUp.resumeSession,
      },
      body: JSON.stringify(requestBody),
      signal: resumeSignal,
    });

    if (resumeRes.status === 402) {
      const text = await resumeRes.text().catch(() => '');
      throw new PaymentError(
        `Top-up payment rejected on attempt ${topUpCount}. Check USDC balance.`,
        402,
        text,
      );
    }

    if (resumeRes.status !== 200) {
      const text = await resumeRes.text().catch(() => '');
      throw new PaymentError(
        `Top-up resume failed with HTTP ${resumeRes.status} on attempt ${topUpCount}: ${text}`,
        resumeRes.status,
        text,
      );
    }

    // Stream the resumed response segment.
    const nextStream = await streamChatCompletion(resumeRes);

    // Accumulate across segments.
    accumulatedContent += nextStream.content;
    if (nextStream.reasoningContent) {
      accumulatedReasoning =
        (accumulatedReasoning ?? '') + nextStream.reasoningContent;
    }
    // The final segment's usage carries the cumulative totals.
    if (nextStream.usage) {
      accumulatedUsage = nextStream.usage;
    }
    totalPaidUsd += Number(topUp.topUpAmount) / 1e6;

    // Preserve model from earlier segments if later ones don't have it.
    const mergedModel = nextStream.model ?? streamResult.model;
    streamResult = { ...nextStream, model: mergedModel };
  }

  // Step 8 — extract sessionId from response headers as fallback.
  const sessionId =
    streamResult.sessionId ??
    res.headers.get('X-402-SESSION') ??
    undefined;

  return {
    content: accumulatedContent,
    reasoningContent: accumulatedReasoning || undefined,
    model: streamResult.model,
    paidUsd: totalPaidUsd,
    sessionId,
    usage: accumulatedUsage,
  };
}
