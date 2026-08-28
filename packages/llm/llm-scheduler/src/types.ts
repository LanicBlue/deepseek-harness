/**
 * Type-only declarations for the model-call scheduler. No runtime code lives here.
 *
 * @module @deepseek-ai/dsh-llm-scheduler/types
 */

import type { LaneId, ReservationId } from './brand.ts'

/** Stable provider route key (`deepseek-official`, `openai`, `acme-gateway`, …). */
export type LaneKey = string

/** Per-lane configuration. `maxConcurrency` of `undefined` means unlimited. */
export interface LaneConfig {
  /** Whether the lane accepts new admissions. Disabled lanes short-circuit to `BLOCKED_MANUAL`. */
  enabled: boolean
  /** Maximum concurrent in-flight reservations on this lane. Omit for unbounded. */
  maxConcurrency?: number
}

/**
 * Numeric priority class for one reservation, lower is higher priority.
 * `P0` is force-compression / hard-shutdown; `P1` is interactive conversation;
 * `P4` is best-effort background.
 */
export const enum Priority {
  P0 = 0,
  P1 = 1,
  P2 = 2,
  P3 = 3,
  P4 = 4,
}

/**
 * Categorical shape of a provider failure used by the plane's disposition policy.
 * Derived from {@link LlmFailure.code} plus, where the code alone is ambiguous,
 * the failure `message` and `status`.
 */
export const enum FailureCategory {
  /** Transient transport-level failure: open the lane circuit. */
  TRANSIENT = 'transient',
  /** Rate-limited by the provider with a known retry time: block until then. */
  RATE_LIMITED = 'rate_limited',
  /** Authentication or invalid credential: block the lane configuration. */
  AUTH = 'auth',
  /** Configuration owner set the lane to blocked: refuse until reconfigured. */
  BLOCKED_MANUAL = 'blocked_manual',
  /** Per-call malformed input: fail this call, leave lane health untouched. */
  INVALID_CALL = 'invalid_call',
  /** Empty response from provider: safe to retry, fail this single call. */
  EMPTY_RESPONSE = 'empty_response',
}

/** Lane availability state surfaced by {@link SchedulerStatus}. */
export const enum LaneStatus {
  /** Lane accepts admissions at full concurrency. */
  HEALTHY = 'healthy',
  /** Lane accepts admissions but probe recovery is in progress (circuit cooling). */
  PROBING = 'probing',
  /** Lane circuit is open after a transient failure; new admissions queue or wait. */
  CIRCUIT_OPEN = 'circuit_open',
  /** Lane is blocked by configuration (auth, manual disable). No auto-recovery. */
  BLOCKED_CONFIG = 'blocked_config',
}

/** Decision the plane applies to a single failed reservation. */
export type FailureDecision =
  | { readonly kind: 'fail_call'; readonly category: FailureCategory }
  | { readonly kind: 'open_circuit'; readonly category: FailureCategory; readonly cooldownMs: number }
  | { readonly kind: 'block_until_time'; readonly category: FailureCategory; readonly untilMs: number }
  | { readonly kind: 'block_config'; readonly category: FailureCategory }

/** Active reservation held by one caller. */
export interface Reservation {
  /** Unique reservation id, branded opaque. */
  readonly id: ReservationId
  /** Lane this reservation targets. */
  readonly lane: LaneKey
  /** Priority class assigned at admission. */
  readonly priority: Priority
  /** `ctx.clock`-style monotonic ms when the reservation was granted. */
  readonly admittedAt: number
}

/** Snapshot of one lane for {@link SchedulerStatus}. */
export interface LaneView {
  /** Stable lane id assigned at registration. */
  readonly id: LaneId
  /** Provider route key. */
  readonly key: LaneKey
  /** Whether the lane currently accepts new admissions. */
  readonly enabled: boolean
  /** Current availability state. */
  readonly status: LaneStatus
  /** Configured maximum concurrency. Omit for unbounded. */
  readonly maxConcurrency?: number
  /** Reservations currently in flight. */
  readonly inFlight: number
  /** Callers queued behind the lane's concurrency limit. */
  readonly queued: number
  /** Wall-clock millisecond timestamp at which the circuit re-arms, when known. */
  readonly cooldownUntilMs?: number
  /** Most recent decision category for diagnostics. */
  readonly lastCategory?: FailureCategory
}

/** Redacted failure fact safe to surface to UI and session events. */
export interface RedactedFailure {
  /** Stable provider-neutral code from {@link LlmFailure.code}. */
  readonly code: string
  /** Categorical mapping consumed by the plane. */
  readonly category: FailureCategory
  /** Lane this failure applied to. */
  readonly lane: LaneKey
  /** Wall-clock millisecond timestamp when the failure was recorded. */
  readonly atMs: number
  /** Sanitized human-readable summary (no secrets, no raw URLs). */
  readonly message: string
}

/** Snapshot consumed by `ctx.llmScheduler.status()` and forwarded to the UI. */
export interface SchedulerStatus {
  /** Per-lane availability snapshot. */
  readonly lanes: readonly LaneView[]
  /** Most recent failures, newest first; bounded to the configured ring size. */
  readonly recentFailures: readonly RedactedFailure[]
  /** Total active reservations across every lane. */
  readonly totalInFlight: number
  /** Total queued waiters across every lane. */
  readonly totalQueued: number
}

/** Configurable mapping from call purpose to priority class. */
export interface PriorityByPurpose {
  /** Priority applied to ordinary conversation calls (purpose unset). */
  conversation?: Priority
  /** Priority applied to compaction-purpose calls. */
  compaction?: Priority
  /** Priority applied to session-title-purpose calls. */
  'session-title'?: Priority
  /** Fallback priority when purpose is absent or unconfigured. */
  fallback?: Priority
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Forwarded snapshot of {@link SchedulerStatus} after every status change.
     * @mode emit
     * @param status - the latest snapshot, replaced atomically with each emission.
     */
    'llm/scheduler-updated'(status: SchedulerStatus): void
  }
}

/** Cooldown recovery parameters. */
export interface RecoveryConfig {
  /** Initial cooldown after the first transient failure. */
  initialCooldownMs: number
  /** Hard cap on the exponential backoff. */
  maxCooldownMs: number
}

/** Top-level scheduler plugin configuration. */
export interface SchedulerConfig {
  /** Per-lane policy. Lanes absent from the map use the implicit default (enabled, unlimited). */
  lanes?: Readonly<Partial<Record<LaneKey, LaneConfig>>>
  /** Purpose-to-priority mapping. Unconfigured purposes fall through to {@link PriorityByPurpose.fallback}. */
  priorityByPurpose?: PriorityByPurpose
  /** Recovery cooldown bounds. */
  recovery?: RecoveryConfig
  /** Maximum number of failures retained for the recent-failures ring. */
  recentFailureCapacity?: number
}

/** Internal counter snapshot the plane publishes through `ctx.effect` listeners. */
export interface LaneCounters {
  readonly inFlight: number
  readonly queued: number
}

/** Reason a reservation request was rejected at admission. */
export type AdmissionRejection =
  | { readonly kind: 'lane_disabled'; readonly lane: LaneKey }
  | { readonly kind: 'lane_blocked'; readonly lane: LaneKey; readonly category: FailureCategory }
  | { readonly kind: 'cancelled' }
