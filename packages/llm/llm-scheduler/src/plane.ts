/**
 * Pure synchronous admission plane for the model-call scheduler.
 *
 * The plane owns per-lane availability, the priority-FIFO queue, and the
 * circuit-breaker state machine. It is intentionally I/O-free: callers
 * (notably the {@link Coordinator}) drive the timing of cooldown expiration,
 * probe dispatch, and waiter resolution, and observe transitions through
 * {@link Plane.advanceClock} and {@link Plane.status}.
 *
 * Concurrency model. All mutations are synchronous and atomic from the
 * perspective of the single Node.js thread: a sequence of
 * {@link Plane.admit} / {@link Plane.release} / {@link Plane.applyDecision}
 * calls interleaves only at `await` boundaries in the caller. No internal
 * locks are required.
 *
 * Probe selection. When {@link Plane.advanceClock} reports a lane whose
 * cooldown elapsed, the plane transitions the lane to {@link LaneStatus.PROBING}
 * and {@link Plane.peekProbe} returns the highest-priority queued waiter. The
 * caller dispatches that waiter as the probe attempt; on success the lane
 * returns to {@link LaneStatus.HEALTHY}, on failure the cooldown doubles.
 *
 * @module @deepseek-ai/dsh-llm-scheduler/plane
 */

import { laneId as toLaneId, reservationId as toReservationId } from './brand.ts'
import type { LaneId, ReservationId } from './brand.ts'
import type {
  AdmissionRejection,
  FailureDecision,
  LaneConfig,
  LaneCounters,
  LaneKey,
  LaneStatus,
  LaneView,
  RecoveryConfig,
  RedactedFailure,
  Reservation,
  SchedulerConfig,
  SchedulerStatus,
} from './types.ts'
import { FailureCategory, LaneStatus as LaneStatusEnum, Priority } from './types.ts'

/** Internal record of one queued waiter (priority + arrival order). */
interface QueuedWaiter {
  readonly id: ReservationId
  readonly lane: LaneKey
  readonly priority: Priority
  readonly enqueuedAt: number
  /** Sequence number for FIFO ordering within the same priority. */
  readonly sequence: number
}

/** Internal lane record. */
interface LaneRecord {
  readonly id: LaneId
  readonly key: LaneKey
  config: LaneConfig
  status: LaneStatus
  cooldownUntilMs: number
  /** Active reservations. */
  inFlight: Set<ReservationId>
  /** Waiters in priority-FIFO order. */
  queue: QueuedWaiter[]
  /** Last failure category for diagnostics. */
  lastCategory: FailureCategory | undefined
  /** Current cooldown ceiling after consecutive probe failures. */
  currentCooldownMs: number
  /** Consecutive probe-failure count for exponential backoff. */
  consecutiveProbeFailures: number
  /** Sequence counter for FIFO ordering. */
  sequence: number
}

/** Outcome of {@link Plane.admit}. */
export type AdmitOutcome =
  | { readonly kind: 'admitted'; readonly reservation: Reservation }
  | { readonly kind: 'queued'; readonly waiterId: ReservationId; readonly position: number }
  | { readonly kind: 'rejected'; readonly reason: AdmissionRejection }

/** Outcome of {@link Plane.release}. */
export interface ReleaseOutcome {
  /** Next waiter that should be promoted into the freed slot, if any. */
  readonly promote: QueuedWaiter | undefined
}

/** Outcome of {@link Plane.applyDecision}. */
export type DecisionOutcome =
  | { readonly kind: 'opened'; readonly untilMs: number }
  | { readonly kind: 'blocked'; readonly untilMs: number }
  | { readonly kind: 'blocked_config'; readonly status: LaneStatus }
  | { readonly kind: 'failed_call' }
  | { readonly kind: 'noop' }

/** Default recovery bounds when the plugin config omits `recovery`. */
const DEFAULT_RECOVERY: RecoveryConfig = { initialCooldownMs: 5_000, maxCooldownMs: 300_000 }

/** Build a stable lane id from a lane key. */
function makeLaneId(key: LaneKey): LaneId {
  return toLaneId(key)
}

/** Build a unique reservation id. */
function makeReservationId(): ReservationId {
  return toReservationId(`r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`)
}

/** Status of an unregistered lane. Used by {@link Plane.admit} when a key is unknown. */
function unregisteredRejection(key: LaneKey): AdmissionRejection {
  return { kind: 'lane_blocked', lane: key, category: FailureCategory.BLOCKED_MANUAL }
}

/**
 * Pure admission plane. Holds no timers, no async work, and no listeners: all
 * state is read through {@link Plane.status} or mutated through the public
 * methods, and the caller decides when to advance time.
 */
export class Plane {
  private readonly lanes = new Map<LaneId, LaneRecord>()
  private readonly byKey = new Map<LaneKey, LaneId>()
  private readonly recovery: RecoveryConfig
  private readonly recentFailures: RedactedFailure[]
  private readonly recentFailureCapacity: number
  private statusListeners = new Set<(status: SchedulerStatus) => void>()

  constructor(config: SchedulerConfig) {
    this.recovery = config.recovery ?? DEFAULT_RECOVERY
    this.recentFailureCapacity = config.recentFailureCapacity ?? 32
    this.recentFailures = []
    // Register any pre-configured lanes up front.
    if (config.lanes) {
      for (const [key, laneConfig] of Object.entries(config.lanes)) {
        if (laneConfig !== undefined) this.registerLane(key, laneConfig)
      }
    }
  }

  /**
 *  Register one lane. Existing registrations are replaced.
 * @param key - lane key the policy applies to.
 * @param config - enabled flag and concurrency bound.
 * @returns the lane id.
*/
  registerLane(key: LaneKey, config: LaneConfig): LaneId {
    const id = makeLaneId(key)
    const existing = this.lanes.get(id)
    if (existing) {
      existing.config = config
      if (config.enabled && existing.status === LaneStatusEnum.BLOCKED_CONFIG) {
        existing.status = LaneStatusEnum.HEALTHY
        existing.lastCategory = undefined
        existing.cooldownUntilMs = 0
      }
      this.publish()
      return id
    }
    const record: LaneRecord = {
      id,
      key,
      config,
      status: LaneStatusEnum.HEALTHY,
      cooldownUntilMs: 0,
      inFlight: new Set(),
      queue: [],
      lastCategory: undefined,
      currentCooldownMs: this.recovery.initialCooldownMs,
      consecutiveProbeFailures: 0,
      sequence: 0,
    }
    this.lanes.set(id, record)
    this.byKey.set(key, id)
    this.publish()
    return id
  }

  /**
   * Register an enabled unlimited lane when the key is unknown; otherwise
   * return the existing id without changing its policy.
    * @param key - lane key to look up or register.
 * @returns the existing or freshly minted lane id.
*/
  ensureLane(key: LaneKey): LaneId {
    const existing = this.byKey.get(key)
    if (existing !== undefined) return existing
    return this.registerLane(key, { enabled: true })
  }

  /**
 *  Unregister one lane, dropping its queue and refusing further admissions.
 * @param id - lane id to remove.
*/
  unregisterLane(id: LaneId): void {
    const record = this.lanes.get(id)
    if (!record) return
    this.lanes.delete(id)
    this.byKey.delete(record.key)
    this.publish()
  }

  /**
 *  Get the lane id for a key, or `undefined` when unknown.
 * @param key - lane key to look up.
 * @returns the lane id, or `undefined` when unknown.
*/
  laneIdFor(key: LaneKey): LaneId | undefined {
    return this.byKey.get(key)
  }

  /**
   * Try to admit one reservation. Returns `admitted` when the lane has a free
   * slot, `queued` when the lane is at capacity but healthy, `rejected` when
   * the lane is disabled, blocked, or unknown.
   *
   * @param key - lane key (provider route id).
   * @param priority - caller's priority class.
   * @returns the admission outcome; see {@link AdmitOutcome}.
    * @param nowMs - monotonic timestamp anchoring the cooldown check.
*/
  admit(key: LaneKey, priority: Priority, nowMs: number): AdmitOutcome {
    const id = this.byKey.get(key)
    if (!id) {
      return { kind: 'rejected', reason: unregisteredRejection(key) }
    }
    const lane = this.lanes.get(id)
    if (!lane) {
      return { kind: 'rejected', reason: unregisteredRejection(key) }
    }
    if (!lane.config.enabled) {
      return { kind: 'rejected', reason: { kind: 'lane_disabled', lane: key } }
    }
    if (lane.status === LaneStatusEnum.BLOCKED_CONFIG) {
      return {
        kind: 'rejected',
        reason: {
          kind: 'lane_blocked',
          lane: key,
          category: lane.lastCategory ?? FailureCategory.BLOCKED_MANUAL,
        },
      }
    }
    if (lane.status === LaneStatusEnum.CIRCUIT_OPEN && nowMs < lane.cooldownUntilMs) {
      return {
        kind: 'queued',
        waiterId: this.enqueueWaiter(lane, priority),
        position: lane.queue.length,
      }
    }
    // Healthy lane with cooldown elapsed (or never opened) or a probing lane:
    // both can accept one admission if there is capacity.
    if (lane.config.maxConcurrency === undefined || lane.inFlight.size < lane.config.maxConcurrency) {
      return { kind: 'admitted', reservation: this.grantReservation(lane, priority) }
    }
    return {
      kind: 'queued',
      waiterId: this.enqueueWaiter(lane, priority),
      position: lane.queue.length,
    }
  }

  /**
   * Release one reservation. The returned {@link ReleaseOutcome.promote}
   * names the highest-priority queued waiter that should now run, when one
   * exists; the caller (the {@link Coordinator}) is responsible for resolving
   * that waiter's pending promise.
   *
   * @param reservation - the reservation returned by {@link Plane.admit}.
   * @returns release outcome; `promote` is non-null when the lane had waiters.
   */
  release(reservation: Reservation): ReleaseOutcome {
    const id = this.byKey.get(reservation.lane)
    const lane = id ? this.lanes.get(id) : undefined
    if (!lane) return { promote: undefined }
    lane.inFlight.delete(reservation.id)
    const promote = this.popHighestPriority(lane)
    this.publish()
    return { promote }
  }

  /**
   * Apply a {@link FailureDecision} to one lane. Updates status, cooldown,
   * and recent-failures ring; the returned {@link DecisionOutcome} reports the
   * resulting transition so it can be forwarded to listeners.
   *
   * @param decision - the failure disposition.
   * @param key - the lane that experienced the failure.
   * @param failure - the source {@link import('@deepseek-ai/dsh-llm').LlmFailure}.
   * @param nowMs - monotonic timestamp anchoring the decision.
   * @param redactedMessage - already-redacted human-readable summary.
    * @returns the transition the caller should forward to listeners.
*/
  applyDecision(
    decision: FailureDecision,
    key: LaneKey,
    failure: { readonly code: string; readonly message: string },
    nowMs: number,
    redactedMessage: string,
  ): DecisionOutcome {
    const id = this.byKey.get(key)
    const lane = id ? this.lanes.get(id) : undefined
    if (!lane) return { kind: 'noop' }

    this.recordFailure(key, failure.code, decision.category, nowMs, redactedMessage)

    switch (decision.kind) {
      // A retarget that reaches the plane is one the gate chose not to execute
      // (hop budget exhausted, or target equals source): record the failure,
      // leave lane health as the gate's circuit hint already shaped it.
      case 'fail_call':
      case 'retarget':
        this.publish()
        return { kind: 'failed_call' }
      case 'open_circuit': {
        const next = Math.min(decision.cooldownMs, this.recovery.maxCooldownMs)
        lane.status = LaneStatusEnum.CIRCUIT_OPEN
        lane.cooldownUntilMs = nowMs + next
        lane.currentCooldownMs = next
        lane.lastCategory = decision.category
        this.publish()
        return { kind: 'opened', untilMs: lane.cooldownUntilMs }
      }
      case 'block_until_time':
        lane.status = LaneStatusEnum.CIRCUIT_OPEN
        lane.cooldownUntilMs = decision.untilMs
        lane.lastCategory = decision.category
        this.publish()
        return { kind: 'blocked', untilMs: lane.cooldownUntilMs }
      case 'block_config':
        lane.status = LaneStatusEnum.BLOCKED_CONFIG
        lane.lastCategory = decision.category
        this.publish()
        return { kind: 'blocked_config', status: lane.status }
    }
  }

  /**
   * Advance the plane's clock. Returns the list of lane ids whose cooldown
   * just elapsed; the caller should consult {@link Plane.peekProbe} for each
   * and promote the highest-priority waiter as the probe.
   *
   * @param nowMs - the new wall-clock ms.
   * @returns lane ids transitioned from `circuit-open` to `probing`.
   */
  advanceClock(nowMs: number): LaneId[] {
    const transitioned: LaneId[] = []
    for (const lane of this.lanes.values()) {
      if (lane.status === LaneStatusEnum.CIRCUIT_OPEN && nowMs >= lane.cooldownUntilMs) {
        lane.status = LaneStatusEnum.PROBING
        transitioned.push(lane.id)
      }
    }
    if (transitioned.length > 0) this.publish()
    return transitioned
  }

  /**
   * Remove one queued waiter (a caller whose signal aborted while parked).
   * Without this the queue keeps ghost entries: {@link Plane.status} would
   * over-report `queued`, and a later {@link Plane.release} could pop the
   * ghost as the promote candidate, silently dropping the freed slot.
   *
   * @param key - lane key holding the waiter.
   * @param waiterId - the waiter id returned by the queuing {@link Plane.admit}.
   * @returns whether a waiter was removed.
   */
  removeWaiter(key: LaneKey, waiterId: ReservationId): boolean {
    const id = this.byKey.get(key)
    const lane = id ? this.lanes.get(id) : undefined
    if (!lane) return false
    const index = lane.queue.findIndex(waiter => waiter.id === waiterId)
    if (index === -1) return false
    lane.queue.splice(index, 1)
    this.publish()
    return true
  }

  /**
   * Peek the highest-priority queued waiter without removing them, for probe
   * dispatch. The caller is responsible for {@link Plane.takeProbe} after the
   * probe is actually issued.
    * @param key - lane key whose head waiter to peek.
 * @returns the highest-priority queued waiter, when one exists.
*/
  peekProbe(key: LaneKey): QueuedWaiter | undefined {
    const id = this.byKey.get(key)
    const lane = id ? this.lanes.get(id) : undefined
    if (!lane || lane.queue.length === 0) return undefined
    return lane.queue[0]
  }

  /**
   * Consume one queued waiter as a probe reservation. The probe is admitted
   * with the highest priority of the queue; the caller is responsible for
   * calling {@link Plane.completeProbe} with the outcome.
   *
   * @param key - lane key whose probe should be issued.
   * @returns the probe reservation, or `undefined` when no waiter was queued.
   */
  takeProbe(key: LaneKey): Reservation | undefined {
    const id = this.byKey.get(key)
    const lane = id ? this.lanes.get(id) : undefined
    if (!lane || lane.queue.length === 0) return undefined
    const waiter = lane.queue.shift()
    if (!waiter) return undefined
    return this.grantReservationFromWaiter(lane, waiter)
  }

  /**
   * Record the outcome of a probe attempt. A successful probe transitions the
   * lane back to {@link LaneStatus.HEALTHY}; a failed probe doubles the
   * cooldown (capped at {@link RecoveryConfig.maxCooldownMs}) and re-opens
   * the circuit.
   *
   * @param key - lane key whose probe completed.
   * @param success - `true` when the probe attempt succeeded.
   * @param nowMs - monotonic timestamp anchoring the next cooldown.
   */
  completeProbe(key: LaneKey, success: boolean, nowMs: number): void {
    const id = this.byKey.get(key)
    const lane = id ? this.lanes.get(id) : undefined
    if (!lane) return
    if (lane.status !== LaneStatusEnum.PROBING) return
    if (success) {
      lane.status = LaneStatusEnum.HEALTHY
      lane.cooldownUntilMs = 0
      lane.consecutiveProbeFailures = 0
      lane.currentCooldownMs = this.recovery.initialCooldownMs
      this.publish()
      return
    }
    lane.consecutiveProbeFailures += 1
    const doubled = Math.min(lane.currentCooldownMs * 2, this.recovery.maxCooldownMs)
    lane.status = LaneStatusEnum.CIRCUIT_OPEN
    lane.cooldownUntilMs = nowMs + doubled
    lane.currentCooldownMs = doubled
    this.publish()
  }

  /**
   * Apply a manual block (e.g., owner disabled the lane). The lane enters
   * {@link LaneStatus.BLOCKED_CONFIG} with the given category. Configuration
   * blocks never auto-recover; only {@link Plane.registerLane} with `enabled:
   * true` resets the lane.
    * @param key - lane key to block.
 * @param nowMs - monotonic timestamp anchoring the block.
*/
  blockManually(key: LaneKey, nowMs: number): void {
    const id = this.byKey.get(key)
    const lane = id ? this.lanes.get(id) : undefined
    if (!lane) return
    lane.status = LaneStatusEnum.BLOCKED_CONFIG
    lane.lastCategory = FailureCategory.BLOCKED_MANUAL
    lane.cooldownUntilMs = nowMs
    this.publish()
  }

  /**
 *  Counter snapshot for one lane (used for instrumentation).
 * @param id - lane id to read.
 * @returns the lane counter snapshot, or `undefined` when unknown.
*/
  countersFor(id: LaneId): LaneCounters | undefined {
    const lane = this.lanes.get(id)
    if (!lane) return undefined
    return { inFlight: lane.inFlight.size, queued: lane.queue.length }
  }

  /**
 *  Subscribe to status changes; returns a disposer.
 * @param listener - called with every published snapshot.
 * @returns a disposer removing the listener.
*/
  onStatusChange(listener: (status: SchedulerStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => {
      this.statusListeners.delete(listener)
    }
  }

  /**
 *  Compute the current snapshot.
 * @returns the current snapshot.
*/
  status(): SchedulerStatus {
    const lanes: LaneView[] = []
    let totalInFlight = 0
    let totalQueued = 0
    for (const lane of this.lanes.values()) {
      totalInFlight += lane.inFlight.size
      totalQueued += lane.queue.length
      const view: LaneView = {
        id: lane.id,
        key: lane.key,
        enabled: lane.config.enabled,
        status: lane.status,
        inFlight: lane.inFlight.size,
        queued: lane.queue.length,
        ...lane.config.maxConcurrency !== undefined ? { maxConcurrency: lane.config.maxConcurrency } : {},
        ...lane.cooldownUntilMs > 0 ? { cooldownUntilMs: lane.cooldownUntilMs } : {},
        ...lane.lastCategory !== undefined ? { lastCategory: lane.lastCategory } : {},
      }
      lanes.push(view)
    }
    return {
      lanes,
      recentFailures: [...this.recentFailures],
      totalInFlight,
      totalQueued,
    }
  }

  /** Push one entry to the recent-failures ring, evicting the oldest when full. */
  private recordFailure(
    key: LaneKey,
    code: string,
    category: FailureCategory,
    nowMs: number,
    redactedMessage: string,
  ): void {
    this.recentFailures.unshift({ code, category, lane: key, atMs: nowMs, message: redactedMessage })
    if (this.recentFailures.length > this.recentFailureCapacity) {
      this.recentFailures.length = this.recentFailureCapacity
    }
  }

  /** Append one waiter to the lane queue in priority-FIFO position. */
  private enqueueWaiter(lane: LaneRecord, priority: Priority): ReservationId {
    lane.sequence += 1
    const waiter: QueuedWaiter = {
      id: makeReservationId(),
      lane: lane.key,
      priority,
      enqueuedAt: Date.now(),
      sequence: lane.sequence,
    }
    this.insertByPriority(lane, waiter)
    this.publish()
    return waiter.id
  }

  /**
   * Insert one waiter in priority order, breaking ties by FIFO sequence.
   * Implemented with a linear scan because lane queues are short under steady
   * load (one waiter per slot of headroom).
   */
  private insertByPriority(lane: LaneRecord, waiter: QueuedWaiter): void {
    let insertAt = lane.queue.length
    for (let i = 0; i < lane.queue.length; i += 1) {
      const current = lane.queue[i]
      if (current === undefined) continue
      if (waiter.priority < current.priority
        || (waiter.priority === current.priority && waiter.sequence < current.sequence)) {
        insertAt = i
        break
      }
    }
    lane.queue.splice(insertAt, 0, waiter)
  }

  /** Pop the highest-priority waiter. */
  private popHighestPriority(lane: LaneRecord): QueuedWaiter | undefined {
    return lane.queue.shift()
  }

  /** Notify {@link Plane.onStatusChange} listeners of the current snapshot. */
  private publish(): void {
    const status = this.status()
    for (const listener of this.statusListeners) listener(status)
  }

  private grantReservation(lane: LaneRecord, priority: Priority): Reservation {
    const reservation: Reservation = {
      id: makeReservationId(),
      lane: lane.key,
      priority,
      admittedAt: Date.now(),
    }
    lane.inFlight.add(reservation.id)
    this.publish()
    return reservation
  }

  /** Convert a queued waiter into an admitted reservation, preserving priority. */
  private grantReservationFromWaiter(lane: LaneRecord, waiter: QueuedWaiter): Reservation {
    const reservation: Reservation = {
      id: waiter.id,
      lane: lane.key,
      priority: waiter.priority,
      admittedAt: Date.now(),
    }
    lane.inFlight.add(reservation.id)
    this.publish()
    return reservation
  }
}
