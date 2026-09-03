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
 * `llm/scheduler-updated` event. The same snapshot is a Typert Remote
 * (`llmScheduler.status`) and the `llm-scheduler` settings section is the
 * live policy document.
 *
 * @module @deepseek-ai/dsh-llm-scheduler
 */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import z from '@deepseek-ai/schemastery'
import type {} from 'zod'
import { Coordinator } from './coordinator.ts'
import { Plane } from './plane.ts'
import {
  DEFAULT_SCHEDULER_SETTINGS,
  laneConfigFromEntry,
  PRIORITY_CLASS,
  prioritiesFromSettings,
  SCHEDULER_SETTINGS_NAMESPACE,
  UNLIMITED_CONCURRENCY,
  type SchedulerSettings,
} from './settings.ts'
import { installStreamGate, type StreamGateConfig } from './stream-gate.ts'
import type {
  LaneConfig,
  LaneKey,
  SchedulerStatus,
} from './types.ts'
import type {} from '@deepseek-ai/dsh-settings'

/** Whether the consumer's own fiber is tearing down (not just losing the settings service). */
function isFiberUnloading(ctx: Context): boolean {
  const state: number = ctx.fiber.state
  return state === 5 || state === 4
}

export { Plane } from './plane.ts'
export { Coordinator } from './coordinator.ts'
export { ReservationError } from './coordinator.ts'
export type { AdmitOutcome, DecisionOutcome, ReleaseOutcome } from './plane.ts'
export { classifyFailure, decideFailure, redactFailureMessage } from './failure.ts'
export { FailureCategory, LaneStatus, Priority } from './types.ts'
export type {
  AdmissionRejection,
  DecideFacts,
  FailureDecision,
  LaneConfig,
  LaneCounters,
  LaneKey,
  LaneView,
  PriorityByPurpose,
  RecoveryConfig,
  RedactedFailure,
  Reservation,
  RouteFacts,
  SchedulerConfig,
  SchedulerStatus,
} from './types.ts'
export { laneId, reservationId } from './brand.ts'
export type { LaneId, ReservationId } from './brand.ts'
export {
  DEFAULT_SCHEDULER_SETTINGS,
  SCHEDULER_SETTINGS_NAMESPACE,
  UNLIMITED_CONCURRENCY,
  laneConfigFromEntry,
  prioritiesFromSettings,
  priorityFromClass,
} from './settings.ts'
export type { PriorityClass, SchedulerLaneEntry, SchedulerPurpose, SchedulerSettings } from './settings.ts'

/** Schema of the `llm-scheduler` settings section and the plugin Config. */
export const Config: z<SchedulerSettings> = z.object({
  lanes: z.dict(z.object({
    enabled: z.boolean().default(true),
    maxConcurrency: z.number().step(1).min(1).default(UNLIMITED_CONCURRENCY),
  })).default({}),
  priorityByPurpose: z.object({
    conversation: PRIORITY_CLASS.default('P1'),
    compaction: PRIORITY_CLASS.default('P0'),
    'session-title': PRIORITY_CLASS.default('P4'),
  }).default(DEFAULT_SCHEDULER_SETTINGS.priorityByPurpose),
  recovery: z.object({
    initialCooldownMs: z.number().step(1).min(100).default(5_000),
    maxCooldownMs: z.number().step(1).min(1_000).default(300_000),
  }).default(DEFAULT_SCHEDULER_SETTINGS.recovery),
  statusDebounceMs: z.number().step(1).min(0).default(250),
})

/**
 * Default-exported Service plugin: `ctx.llmScheduler.status()` is the public
 * surface for queries; the `llm/scheduler-updated` event is the public surface
 * for transitions.
 */
export class LlmSchedulerService extends TypertRemoteService {
  static Config = Config
  static inject = ['llm']

  private readonly plane: Plane
  private readonly coordinator: Coordinator
  private readonly gateConfig: StreamGateConfig
  private statusListeners = new Set<(status: SchedulerStatus) => void>()
  private streamGateDisposer: (() => void) | undefined
  private source: () => SchedulerSettings
  private debounceTimer: ReturnType<typeof setTimeout> | undefined

  /** Construct the scheduler service; the loader calls this with `ctx` and the resolved config. */
  constructor(ctx: Context, config: SchedulerSettings) {
    super(ctx, 'llmScheduler')
    const resolved = { ...DEFAULT_SCHEDULER_SETTINGS, ...config }
    this.source = () => resolved
    this.plane = new Plane({
      recovery: resolved.recovery,
      recentFailureCapacity: 32,
    })
    this.coordinator = new Coordinator(this.plane)
    this.gateConfig = {
      priorityByPurpose: prioritiesFromSettings(resolved),
      recovery: { ...resolved.recovery },
    }
    const unsubscribe = this.plane.onStatusChange(status => this.notify(status))
    this.streamGateDisposer = installStreamGate(ctx, this.coordinator, this.plane, this.gateConfig)
    this.applySettings()
    // The settings package's installSettingsSection helper was folded into
    // service APIs upstream; this is the same wiring over the public scope.
    ctx.inject(['settings'], (sctx) => {
      const scope = sctx.settings.register(SCHEDULER_SETTINGS_NAMESPACE, Config, { base: resolved })
      this.source = () => scope.get()
      sctx.effect(() => () => {
        if (isFiberUnloading(ctx)) return
        this.source = () => resolved
        this.applySettings()
      })
      this.applySettings()
      scope.watch(() => {
        if (isFiberUnloading(ctx)) return
        this.applySettings()
      })
    })
    ctx.on('llm/adapters-updated', () => { this.applySettings() })
    ctx.effect(() => async () => {
      if (this.debounceTimer !== undefined) clearTimeout(this.debounceTimer)
      this.debounceTimer = undefined
      unsubscribe()
      this.streamGateDisposer?.()
      this.streamGateDisposer = undefined
      this.coordinator.disposeAll('llm-scheduler service disposed')
      this.statusListeners.clear()
    }, 'llm-scheduler: dispose plane, coordinator, and stream gate')
  }

  /**
   * Configure one lane at runtime.
   * @param key - provider route the lane admission policy applies to.
   * @param config - enabled flag and concurrency bound for the lane.
   */
  registerLane(key: LaneKey, config: LaneConfig): void {
    this.plane.registerLane(key, config)
  }

  /**
   * Snapshot the scheduler's state.
   * @returns the current per-lane availability, recent failures, and totals.
   */
  @Remote('status')
  status(): SchedulerStatus {
    return this.plane.status()
  }

  /**
   * Subscribe to status changes.
   * @param listener - called with each debounced {@link SchedulerStatus} snapshot.
   * @returns a disposer removing the listener.
   */
  onStatusChange(listener: (status: SchedulerStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => {
      this.statusListeners.delete(listener)
    }
  }

  /** Re-apply the live settings document onto lanes and stream-gate policy. */
  private applySettings(): void {
    const settings = this.source()
    this.gateConfig.priorityByPurpose = prioritiesFromSettings(settings)
    this.gateConfig.recovery.initialCooldownMs = settings.recovery.initialCooldownMs
    this.gateConfig.recovery.maxCooldownMs = settings.recovery.maxCooldownMs
    const keys = new Set<string>()
    for (const provider of this.ctx.llm.listProviders()) keys.add(provider.id)
    for (const key of Object.keys(settings.lanes)) keys.add(key)
    for (const key of keys) {
      this.plane.registerLane(key, laneConfigFromEntry(settings.lanes[key]))
    }
  }

  /** Notify listeners and dispatch the `llm/scheduler-updated` event. */
  private notify(_status: SchedulerStatus): void {
    const delay = this.source().statusDebounceMs
    const emit = (): void => {
      this.debounceTimer = undefined
      const latest = this.plane.status()
      this.ctx.emit('llm/scheduler-updated', latest)
      for (const listener of this.statusListeners) listener(latest)
    }
    if (delay <= 0) {
      emit()
      return
    }
    if (this.debounceTimer !== undefined) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(emit, delay)
    this.debounceTimer.unref?.()
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Scheduler service installed by the `llm-scheduler` plugin. */
    llmScheduler: LlmSchedulerService
  }
}

export default LlmSchedulerService
