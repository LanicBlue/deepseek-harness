/**
 * Zero-dependency HTTP client for the local Wiki Server (WK) contract API.
 *
 * WK is a separate local service (default data root `~/.wiki-service`); this
 * module speaks its wire envelope — `POST /wiki/v1/{family}/{method}` with
 * `{ctx, args}` and `{ok, result}` / `{ok, error}` responses — without
 * importing WK source, per WK's consumers-use-HTTP-only rule. Bearer
 * credentials come from a consumer-side key file shaped `{clientKey,
 * baseUrl}` (the same convention as WK's other integrations), so the dynamic
 * port travels with the key. Deadlines fuse the tool-call signal with the
 * configured timeout through `dsh-timeout`.
 *
 * @module @deepseek-ai/dsh-tool-wk/client
 */

import { randomUUID } from 'node:crypto'
import { deadline, TimeoutReason } from '@deepseek-ai/dsh-timeout'

/** Consumer identity WK records per request. */
export const WK_CONSUMER_ID = 'dsh-tool-wk'

/** Default request timeout. */
export const WK_DEFAULT_TIMEOUT_MS = 10_000

/** Consumer-side credential file shape (plain JSON, mode 0600 by convention). */
export interface WkCredential {
  readonly clientKey: string
  readonly baseUrl: string
}

/** Typed failure carrying the WK error code for dispatch-friendly messages. */
export class WkClientError extends Error {
  /** WK provider-neutral error code (`NOT_FOUND`, `WIKI_CLIENT_AUTHENTICATION_REQUIRED`, …). */
  readonly code: string
  /** HTTP status of the failing response, when one arrived. */
  readonly status: number | undefined

  constructor(message: string, code: string, status?: number) {
    super(message)
    this.name = 'WkClientError'
    this.code = code
    this.status = status
  }
}

/**
 *  Decode one fetch failure into the teaching message the model should see.
 * @param error - the caught failure.
 * @param baseUrl - endpoint addressed, for the unreachable message.
 * @returns the teaching message the model should see.
*/
export function wkFailureMessage(error: unknown, baseUrl: string | undefined): string {
  if (error instanceof WkClientError) {
    if (error.code === 'WIKI_CLIENT_AUTHENTICATION_REQUIRED' || error.code === 'WIKI_CLIENT_AUTHENTICATION_INVALID') {
      return `WK rejected the credential (${error.code}): mint a DSH client key on the wiki server and write it to the configured credential file. ${error.message}`
    }
    return `WK request failed (${error.code}): ${error.message}`
  }
  if (error instanceof TimeoutReason) {
    return `WK request timed out after ${error.timeoutMs}ms (${error.code}). Narrow the query, raise timeoutMs, or check whether the wiki server is busy.`
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return 'WK request cancelled.'
  }
  if (error instanceof TypeError) {
    return `Cannot reach the wiki server${baseUrl !== undefined ? ` at ${baseUrl}` : ''}. Start it (wiki-server start) or point baseUrl/credentialFile at a live instance.`
  }
  return `WK request failed: ${error instanceof Error ? error.message : String(error)}`
}

/** Options for {@link WkContractClient}. */
export interface WkContractClientOptions {
  readonly baseUrl: string
  readonly apiKey: string | undefined
  readonly timeoutMs: number
  /** Injection seam for tests; defaults to global fetch. */
  readonly fetch?: typeof fetch
}

/**
 * Minimal typed client over the WK contract API. Instances are cheap and
 * stateless; callers construct one per request so credential-file changes
 * (minted keys, restarted server, rotated port) apply without a remount.
 */
export class WkContractClient {
  /** Sanitized endpoint this client addresses; public for error reporting. */
  readonly baseUrl: string
  private readonly apiKey: string | undefined
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(options: WkContractClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.apiKey = options.apiKey
    this.timeoutMs = options.timeoutMs
    this.fetchImpl = options.fetch ?? fetch
  }

  /**
   * Invoke one contract route.
   * @param family - route family (`search`, `nodes`, `roots`, `projectTrees`, …).
   * @param method - route method (`fts`, `get`, `list`, …).
   * @param args - positional arguments array per the route descriptor.
   * @param signal - caller cancellation (the tool-call signal).
   * @returns the route's `result` payload.
   */
  async call(
    family: string,
    method: string,
    args: readonly unknown[],
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    using dl = deadline(signal, this.timeoutMs, 'WK_TIMEOUT')
    const response = await this.fetchImpl(`${this.baseUrl}/wiki/v1/${family}/${method}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...this.apiKey !== undefined ? { authorization: `Bearer ${this.apiKey}` } : {},
      },
      body: JSON.stringify({ ctx: { consumerId: WK_CONSUMER_ID, requestId: randomUUID() }, args }),
      signal: dl.signal,
      redirect: 'error',
    })
    return unwrap(await readJson(response), response.status)
  }

  /**
   * The instance's server id (public metadata route, no credential needed).
   * @param signal - caller cancellation.
   * @returns the serverId string.
   */
  async serverId(signal: AbortSignal | undefined): Promise<string> {
    using dl = deadline(signal, this.timeoutMs, 'WK_TIMEOUT')
    const response = await this.fetchImpl(`${this.baseUrl}/wiki/v1/metadata/serverId`, {
      signal: dl.signal,
      redirect: 'error',
    })
    const body = await readJson(response)
    if (body !== undefined && body !== null && typeof body === 'object' && 'serverId' in body) {
      const serverId = (body as { serverId?: unknown }).serverId
      if (typeof serverId === 'string' && serverId.length > 0) return serverId
    }
    throw new WkClientError(`unexpected WK metadata response (HTTP ${response.status})`, 'WK_PROTOCOL', response.status)
  }
}

/** Unwrap one `{ok, result|error}` envelope, tolerating non-JSON bodies. */
function unwrap(body: unknown, status: number): unknown {
  if (body !== undefined && body !== null && typeof body === 'object' && 'ok' in body) {
    const envelope = body as { ok: boolean; result?: unknown; error?: { code?: unknown; message?: unknown } }
    if (envelope.ok) return envelope.result
    const code = typeof envelope.error?.code === 'string' ? envelope.error.code : 'WK_ERROR'
    const message = typeof envelope.error?.message === 'string' ? envelope.error.message : 'unknown WK error'
    throw new WkClientError(message, code, status)
  }
  throw new WkClientError(`unexpected WK response (HTTP ${status})`, 'WK_PROTOCOL', status)
}

/** Read and parse one JSON response body, tolerating empty bodies. */
async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (text.length === 0) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}
