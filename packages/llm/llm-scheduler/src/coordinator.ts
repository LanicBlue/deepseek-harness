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
   * Release one reservation. When the plane reports a queued waiter
   * promoted into the freed slot, this method resolves that waiter's pending
   * promise.
   */
  release(reservation: Reservation): void {
    const outcome = this.plane.release(reservation)
    if (!outcome.promote) return
    const list = this.pending.get(outcome.promote.lane)
    if (!list || list.length === 0) return
    const waiter = outcome.promote
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
   * Promote the highest-priority waiter as a probe. Called by the plugin
   * after the plane reports a cooldown elapse. Returns the granted
   * reservation when a waiter was promoted.
   */
  promoteProbeWaiter(lane: LaneKey): Reservation | undefined {
    const reservation = this.plane.takeProbe(lane)
    if (!reservation) return undefined
    this.plane.completeProbe(lane, true, Date.now())
    return reservation
  }

  /** Mark a probe attempt successful or failed at the plane. */
  completeProbe(lane: LaneKey, success: boolean): void {
    this.plane.completeProbe(lane, success, Date.now())
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
  }

  /** Remove a queued waiter when the caller's signal aborts. */
  private cancelWaiter(lane: LaneKey, entry: PendingReservation): void {
    const list = this.pending.get(lane)
    if (!list) return
    const idx = list.indexOf(entry)
    if (idx === -1) return
    list.splice(idx, 1)
    entry.reject(new ReservationError(`reservation aborted for lane "${lane}"`, lane, undefined))
  }
}
