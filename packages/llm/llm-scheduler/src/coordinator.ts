/**
 * Async reservation coordinator: bridges the synchronous {@link Plane} to
 * Promise-based callers awaiting a slot.
 *
 * Each call to {@link Coordinator.reserve} either resolves immediately (when
 * the plane grants the request), parks a pending resolver (when the plane
 * queues the request), or rejects (when the lane is disabled, blocked, or the
 * caller's signal aborts).
 *
 * The coordinator owns only the {@link PendingReservation} map; the plane
 * owns the priority queue, the availability state, and the FIFO ordering.
 *
 * @module @deepseek-ai/dsh-llm-scheduler/coordinator
 */

import type { LaneKey, Reservation } from './types.ts'
import { FailureCategory, Priority } from './types.ts'
import { Plane } from './plane.ts'

/** Pending resolver record for a queued waiter. */
interface PendingReservation {
  readonly id: Reservation['id']
  readonly resolve: (reservation: Reservation) => void
  readonly reject: (reason: Error) => void
  readonly signal: AbortSignal | undefined
}

/** Error thrown when a reservation is denied or cancelled. */
export class ReservationError extends Error {
  readonly lane: LaneKey
  readonly category: FailureCategory | undefined
  constructor(message: string, lane: LaneKey, category: FailureCategory | undefined) {
    super(message)
    this.lane = lane
    this.category = category
    this.name = 'ReservationError'
  }
}

/**
 * Bridge from synchronous plane to async callers. Construct one per
 * {@link Plane} instance.
 */
export class Coordinator {
  /** Pending resolvers keyed by lane. */
  private readonly pending = new Map<LaneKey, PendingReservation[]>()
  /** Reservation id of each lane's in-flight probe attempt, when one runs. */
  private readonly probes = new Map<LaneKey, Reservation['id']>()

  constructor(private readonly plane: Plane) {}

  /**
   * Reserve a slot. Resolves immediately on success, parks in priority FIFO
   * when the lane is at capacity, rejects when the lane is disabled,
   * blocked, or the caller's signal aborts.
   */
  async reserve(lane: LaneKey, priority: Priority, signal?: AbortSignal): Promise<Reservation> {
    if (signal?.aborted) {
      throw new ReservationError(`reservation aborted before admission for lane "${lane}"`, lane, undefined)
    }
    const now = Date.now()
    const outcome = this.plane.admit(lane, priority, now)
    if (outcome.kind === 'admitted') return outcome.reservation
    if (outcome.kind === 'rejected') {
      throw new ReservationError(
        `lane "${lane}" rejected admission: ${outcome.reason.kind}`,
        lane,
        'category' in outcome.reason ? outcome.reason.category : undefined,
      )
    }
    // queued: park a pending resolver and wait for the plane to promote us.
    const waiterId = outcome.waiterId
    return new Promise<Reservation>((resolve, reject) => {
      const entry: PendingReservation = { id: waiterId, resolve, reject, signal }
      const list = this.pending.get(lane) ?? []
      list.push(entry)
      this.pending.set(lane, list)
      if (signal) {
        const onAbort = (): void => this.cancelWaiter(lane, entry)
        if (signal.aborted) {
          onAbort()
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
    })
  }

  /**
   * Release one reservation. When the plane reports a queued waiter promoted
   * into the freed slot, this method resolves that waiter's pending promise.
   *
   * When the released reservation was its lane's probe attempt, its settle
   * outcome completes the probe: success restores the lane to healthy, a
   * failed probe doubles the cooldown and re-opens the circuit (a disposition
   * that already transitioned the lane wins — the plane ignores a probe
   * completion unless the lane is still probing).
   *
   * @param reservation - the reservation returned by {@link Coordinator.reserve}.
   * @param success - whether the physical attempt finished without an error
   *   finish; defaults to `true`.
   */
  release(reservation: Reservation, success = true): void {
    const probeId = this.probes.get(reservation.lane)
    if (probeId === reservation.id) {
      this.probes.delete(reservation.lane)
      this.plane.completeProbe(reservation.lane, success, Date.now())
    }
    const outcome = this.plane.release(reservation)
    if (!outcome.promote) return
    this.deliver(outcome.promote)
  }

  /**
   * Promote the highest-priority waiter as the probe attempt for a lane whose
   * cooldown just elapsed. The waiter's parked promise resolves with the
   * granted reservation so its physical attempt dispatches; the lane stays
   * probing until that attempt settles through {@link Coordinator.release} —
   * recovery requalifies lanes through real traffic only, never a synthetic
   * success.
   *
   * Called by the plugin after the plane reports a cooldown elapse.
   */
  promoteProbeWaiter(lane: LaneKey): void {
    const reservation = this.plane.takeProbe(lane)
    if (!reservation) return
    this.probes.set(lane, reservation.id)
    this.deliver(reservation)
  }

  /**
   * Reject every pending reservation. Used at plugin disposal so no waiter
   * hangs after the fiber is torn down.
   */
  disposeAll(reason: string): void {
    for (const [lane, list] of this.pending.entries()) {
      for (const entry of list) {
        entry.reject(new ReservationError(reason, lane, undefined))
      }
    }
    this.pending.clear()
    this.probes.clear()
  }

  /** Resolve the parked promise for one promoted or probe-granted reservation. */
  private deliver(waiter: { id: Reservation['id']; lane: LaneKey; priority: Priority }): void {
    const list = this.pending.get(waiter.lane)
    if (!list || list.length === 0) return
    const idx = list.findIndex(entry => entry.id === waiter.id)
    if (idx === -1) return
    const removed = list.splice(idx, 1)
    const entry = removed[0]
    if (entry === undefined) return
    const granted: Reservation = {
      id: waiter.id as Reservation['id'],
      lane: waiter.lane,
      priority: waiter.priority,
      admittedAt: Date.now(),
    }
    entry.resolve(granted)
  }

  /**
   * Remove a queued waiter when the caller's signal aborts. The plane's queue
   * entry goes with it; otherwise the ghost waiter would over-report
   * `queued` and could swallow a freed slot as an unmatchable promote.
   */
  private cancelWaiter(lane: LaneKey, entry: PendingReservation): void {
    const list = this.pending.get(lane)
    if (!list) return
    const idx = list.indexOf(entry)
    if (idx === -1) return
    list.splice(idx, 1)
    this.plane.removeWaiter(lane, entry.id)
    entry.reject(new ReservationError(`reservation aborted for lane "${lane}"`, lane, undefined))
  }
}
