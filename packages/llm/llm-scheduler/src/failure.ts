/**
 * Map a harness {@link LlmFailure} into the categorical decisions the plane
 * applies, plus the dispose-policy table.
 *
 * Categories collapse the upstream code taxonomy into the few scheduler-level
 * states:
 *
 * - `TRANSIENT` — open the lane circuit (exponential cooldown, probe recovery).
 * - `RATE_LIMITED` — block until the provider's suggested retry time when valid.
 * - `AUTH` — block the lane configuration; never auto-recover.
 * - `INVALID_CALL` / `EMPTY_RESPONSE` — fail this call, leave lane health alone.
 *
 * @module @deepseek-ai/dsh-llm-scheduler/failure
 */

import type { LlmFailure } from '@deepseek-ai/dsh-llm'
import { FailureCategory, type FailureDecision, type RecoveryConfig } from './types.ts'

/**
 * Provider-neutral codes that map to {@link FailureCategory.TRANSIENT}.
 * Transport-level errors, server overload, and library fallbacks all open the
 * lane circuit so a burst of identical failures does not multiply through
 * independent callers.
 */
const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  'TRANSPORT',
  'TIMEOUT',
  'SERVER',
  'PI_AI_ERROR',
])

/**
 * Provider-neutral codes that map to {@link FailureCategory.RATE_LIMITED}.
 * Includes account-level quota exhaustion: a quota block returns no useful
 * body and the provider often omits `providerRetryAfterMs`, so we still treat
 * it as time-bounded rather than as an authentication problem.
 */
const RATE_LIMITED_CODES: ReadonlySet<string> = new Set([
  'RATE_LIMIT',
  'QUOTA',
])

/**
 * Provider-neutral codes that map to {@link FailureCategory.AUTH}.
 * `AUTH` and `INVALID_CREDENTIAL` both block retry: `AUTH` because the next
 * attempt will fail identically with the same key, `INVALID_CREDENTIAL`
 * because the key is structurally unusable and re-sending cannot help.
 */
const AUTH_CODES: ReadonlySet<string> = new Set([
  'AUTH',
  'INVALID_CREDENTIAL',
])

/** Codes that map to {@link FailureCategory.INVALID_CALL}: per-call malformations. */
const INVALID_CALL_CODES: ReadonlySet<string> = new Set([
  'INVALID_REQUEST',
  'CONTEXT_WINDOW_EXCEEDED',
])

/**
 * Categorize one {@link LlmFailure} into a scheduler-level category. Unknown
 * codes fall through to {@link FailureCategory.INVALID_CALL} so the lane is
 * never silently blacklisted by an unrecognized taxonomy entry; the failure is
 * logged through {@link SchedulerStatus.recentFailures} for diagnosis.
 *
 * @param failure - immutable provider-neutral failure facts.
 * @returns the categorical mapping consumed by {@link decideFailure}.
 */
export function classifyFailure(failure: LlmFailure): FailureCategory {
  if (TRANSIENT_CODES.has(failure.code)) return FailureCategory.TRANSIENT
  if (RATE_LIMITED_CODES.has(failure.code)) return FailureCategory.RATE_LIMITED
  if (AUTH_CODES.has(failure.code)) return FailureCategory.AUTH
  if (INVALID_CALL_CODES.has(failure.code)) return FailureCategory.INVALID_CALL
  if (failure.code === 'EMPTY_RESPONSE') return FailureCategory.EMPTY_RESPONSE
  return FailureCategory.INVALID_CALL
}

/**
 * Compute the disposition for one categorized failure. The policy table is a
 * pure function of (category, recovery bounds, optional provider-suggested
 * delay); callers receive identical decisions for identical state.
 *
 * @param category - result of {@link classifyFailure} for one failure.
 * @param failure - the source failure; supplies `providerRetryAfterMs` when
 *   the provider suggested a retry window.
 * @param recovery - cooldown bounds; consumed only by {@link FailureCategory.TRANSIENT}.
 * @param nowMs - monotonic wall-clock millisecond timestamp used to anchor the
 *   `block_until_time` decision.
 * @returns the {@link FailureDecision} the plane applies to the lane.
 */
export function decideFailure(
  category: FailureCategory,
  failure: LlmFailure,
  recovery: RecoveryConfig,
  nowMs: number,
): FailureDecision {
  switch (category) {
    case FailureCategory.TRANSIENT: {
      const capped = Math.min(recovery.initialCooldownMs, recovery.maxCooldownMs)
      return { kind: 'open_circuit', category, cooldownMs: capped }
    }
    case FailureCategory.RATE_LIMITED: {
      const provider = failure.providerRetryAfterMs
      if (typeof provider === 'number' && Number.isFinite(provider) && provider > 0) {
        return { kind: 'block_until_time', category, untilMs: nowMs + provider }
      }
      return { kind: 'block_until_time', category, untilMs: nowMs + recovery.initialCooldownMs }
    }
    case FailureCategory.AUTH:
      return { kind: 'block_config', category }
    case FailureCategory.INVALID_CALL:
    case FailureCategory.EMPTY_RESPONSE:
      return { kind: 'fail_call', category }
    case FailureCategory.BLOCKED_MANUAL:
      return { kind: 'block_config', category }
  }
}

/**
 *  Stable redaction helper for {@link LlmFailure.message}: trims and clamps length, strips nothing else.
 * @param failure - immutable provider-neutral failure facts.
 * @returns the trimmed, length-clamped summary.
*/
export function redactFailureMessage(failure: LlmFailure): string {
  const trimmed = failure.message.trim()
  if (trimmed.length <= 200) return trimmed
  return `${trimmed.slice(0, 197)}...`
}
