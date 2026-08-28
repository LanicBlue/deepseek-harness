/**
 * Zero-dependency HTTP client for the local Project Service (PS) read API.
 *
 * PS is a separate local service (default `http://127.0.0.1:7600`, data root
 * `~/.project-service`); this module speaks its REST envelope — `GET
 * /project/v1/...` with `{ok, result}` / `{ok, error}` responses and optional
 * Bearer `psk_` credentials — without importing PS source, per PS's
 * consumers-use-HTTP-only rule. Deadlines fuse the tool-call signal with the
 * configured timeout through `dsh-timeout`.
 *
 * @module @deepseek-ai/dsh-tool-ps/client
 */

import { deadline, TimeoutReason } from '@deepseek-ai/dsh-timeout'

/** Default PS endpoint: loopback, PS's documented default port. */
export const PS_DEFAULT_BASE_URL = 'http://127.0.0.1:7600'

/** Default request timeout. */
export const PS_DEFAULT_TIMEOUT_MS = 10_000

/** Consumer-side credential file shape (plain JSON, `{clientKey, baseUrl}`). */
export interface PsCredential {
  readonly clientKey: string
  readonly baseUrl: string
}

/** Typed failure carrying the PS error code for dispatch-friendly messages. */
export class PsClientError extends Error {
  /** PS error code (`PROJECT_OPERATOR_REQUIRED`, `PROJECT_NOT_FOUND`, …). */
  readonly code: string
  /** HTTP status of the failing response, when one arrived. */
  readonly status: number | undefined

  constructor(message: string, code: string, status?: number) {
    super(message)
    this.name = 'PsClientError'
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
export function psFailureMessage(error: unknown, baseUrl: string | undefined): string {
  if (error instanceof PsClientError) {
    if (error.status === 401 || error.code === 'PROJECT_AUTHENTICATION_REQUIRED') {
      return `Project Service rejected the request as unauthenticated (${error.code}). Mint a DSH service client (POST ${baseUrl ?? PS_DEFAULT_BASE_URL}/project/v1/_clients during the bootstrap window, or with an operator key) and configure apiKey/credentialFile. ${error.message}`
    }
    if (error.status === 403 || error.code === 'PROJECT_OPERATOR_REQUIRED') {
      return `Project Service refused the request (${error.code}); an operator-role credential is required. ${error.message}`
    }
    return `Project Service request failed (${error.code}): ${error.message}`
  }
  if (error instanceof TimeoutReason) {
    return `Project Service request timed out after ${error.timeoutMs}ms (${error.code}). Retry or check whether the service is busy.`
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return 'Project Service request cancelled.'
  }
  if (error instanceof TypeError) {
    return `Cannot reach the Project Service${baseUrl !== undefined ? ` at ${baseUrl}` : ''}. Start it (npm start in the project-service checkout) or point baseUrl/credentialFile at a live instance.`
  }
  return `Project Service request failed: ${error instanceof Error ? error.message : String(error)}`
}

/** Options for {@link PsRestClient}. */
export interface PsRestClientOptions {
  readonly baseUrl: string
  readonly apiKey: string | undefined
  readonly timeoutMs: number
  /** Injection seam for tests; defaults to global fetch. */
  readonly fetch?: typeof fetch
}

/**
 * Minimal typed client over the PS read API. Instances are cheap and
 * stateless; callers construct one per request so credential-file changes
 * apply without a remount.
 */
export class PsRestClient {
  private readonly baseUrl: string
  private readonly apiKey: string | undefined
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(options: PsRestClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.apiKey = options.apiKey
    this.timeoutMs = options.timeoutMs
    this.fetchImpl = options.fetch ?? fetch
  }

  /**
   * GET one PS route and unwrap its envelope.
   * @param path - route path starting with `/project/v1`.
   * @param signal - caller cancellation (the tool-call signal).
   * @returns the route's `result` payload.
   */
  async get(path: string, signal: AbortSignal | undefined): Promise<unknown> {
    using dl = deadline(signal, this.timeoutMs, 'PS_TIMEOUT')
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: {
        ...this.apiKey !== undefined ? { authorization: `Bearer ${this.apiKey}` } : {},
      },
      signal: dl.signal,
      redirect: 'error',
    })
    const body = await readJson(response)
    if (body !== undefined && body !== null && typeof body === 'object' && 'ok' in body) {
      const envelope = body as { ok: boolean; result?: unknown; error?: { code?: unknown; message?: unknown } }
      if (envelope.ok) return envelope.result
      const code = typeof envelope.error?.code === 'string' ? envelope.error.code : 'PROJECT_ERROR'
      const message = typeof envelope.error?.message === 'string' ? envelope.error.message : 'unknown Project Service error'
      throw new PsClientError(message, code, response.status)
    }
    throw new PsClientError(`unexpected Project Service response (HTTP ${response.status})`, 'PS_PROTOCOL', response.status)
  }
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
