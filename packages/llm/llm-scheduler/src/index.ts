/**
 * LLM model-call admission scheduler.
 *
 * The scheduler owns per-provider lanes with priority-FIFO ordering and
 * cooldown-probe recovery. It hooks {@link installStreamGate} onto the
 * upstream `llm/stream` waterfall so every model call passes through one
 * admission decision before the adapter dispatches, and settles once a
 * finish chunk resolves: success releases the slot; failure applies a
 * disposition that opens the lane circuit, blocks until a
 * provider-suggested time, blocks the lane configuration, or fails the
 * single call without touching lane health.
 *
 * The {@link LlmSchedulerService} default-export instantiates the plane,
 * the coordinator, and the stream gate; consumers read state through
 * {@link LlmSchedulerService.status} and observe transitions through the
 * `llm/scheduler-updated` event.
 *
 * @module @deepseek-ai/dsh-llm-scheduler
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Coordinator } from './coordinator.ts'
import { Plane } from './plane.ts'
import { installStreamGate } from './stream-gate.ts'
import type {
  LaneConfig,
  LaneKey,
  SchedulerConfig,
  SchedulerStatus,
} from './types.ts'

export { Plane } from './plane.ts'
export { Coordinator } from './coordinator.ts'
export { ReservationError } from './coordinator.ts'
export type { AdmitOutcome, DecisionOutcome, ReleaseOutcome } from './plane.ts'
export { classifyFailure, decideFailure, redactFailureMessage } from './failure.ts'
export { FailureCategory, LaneStatus, Priority } from './types.ts'
export type {
  AdmissionRejection,
  FailureDecision,
  LaneConfig,
  LaneCounters,
  LaneKey,
  LaneView,
  PriorityByPurpose,
  RecoveryConfig,
  RedactedFailure,
  Reservation,
  SchedulerConfig,
  SchedulerStatus,
} from './types.ts'
export { laneId, reservationId } from './brand.ts'
export type { LaneId, ReservationId } from './brand.ts'

/** Service constructor configuration schema. Validated against {@link SchedulerConfig}. */
export const Config = z
  .object({
    lanes: z.dict(
      z.object({
        enabled: z.boolean().default(true),
        maxConcurrency: z.number().step(1).min(0),
      }),
    ),
    priorityByPurpose: z.object({
      compaction: z.number().step(1).min(0).max(4),
      'session-title': z.number().step(1).min(0).max(4),
      fallback: z.number().step(1).min(0).max(4),
    }),
    recovery: z.object({
      initialCooldownMs: z.number().step(1).min(1),
      maxCooldownMs: z.number().step(1).min(1),
    }),
    recentFailureCapacity: z.number().step(1).min(1),
  })
  .loose() as unknown as z<SchedulerConfig>

/** Defaults applied when the plugin config omits optional sections. */
const DEFAULT_RECOVERY = { initialCooldownMs: 5_000, maxCooldownMs: 300_000 }

/**
 * Default-exported Service plugin: `ctx.llmScheduler.status()` is the public
 * surface for queries; the `llm/scheduler-updated` event is the public surface
 * for transitions.
 */
export class LlmSchedulerService extends Service {
  private readonly plane: Plane
  private readonly coordinator: Coordinator
  private statusListeners = new Set<(status: SchedulerStatus) => void>()
  private streamGateDisposer: (() => void) | undefined

  /** Construct the scheduler service; the loader calls this with `ctx` and the resolved config. */
  constructor(ctx: Context, config: SchedulerConfig) {
    super(ctx, 'llmScheduler')
    const recovery = config.recovery ?? DEFAULT_RECOVERY
    this.plane = new Plane(config)
    this.coordinator = new Coordinator(this.plane)
    const unsubscribe = this.plane.onStatusChange(status => this.notify(status))
    this.streamGateDisposer = installStreamGate(ctx, this.coordinator, this.plane, {
      priorityByPurpose: config.priorityByPurpose ?? {},
      recovery,
    })
    ctx.effect(() => async () => {
      unsubscribe()
      this.streamGateDisposer?.()
      this.streamGateDisposer = undefined
      this.coordinator.disposeAll('llm-scheduler service disposed')
      this.statusListeners.clear()
    }, 'llm-scheduler: dispose plane, coordinator, and stream gate')
  }

  /** Configure one lane at runtime. */
  registerLane(key: LaneKey, config: LaneConfig): void {
    this.plane.registerLane(key, config)
  }

  /** Snapshot the scheduler's state. */
  status(): SchedulerStatus {
    return this.plane.status()
  }

  /** Subscribe to status changes; returns a disposer. */
  onStatusChange(listener: (status: SchedulerStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => {
      this.statusListeners.delete(listener)
    }
  }

  /** Notify listeners and dispatch the `llm/scheduler-updated` event. */
  private notify(status: SchedulerStatus): void {
    this.ctx.emit('llm/scheduler-updated', status)
    for (const listener of this.statusListeners) listener(status)
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Scheduler service installed by the `llm-scheduler` plugin. */
    llmScheduler: LlmSchedulerService
  }
  interface Events {
    /**
     * Forwarded snapshot of {@link SchedulerStatus} after every status change.
     * @mode emit
     * @param status - the latest snapshot, replaced atomically with each emission.
     */
    'llm/scheduler-updated'(status: SchedulerStatus): void
  }
}

export default LlmSchedulerService
