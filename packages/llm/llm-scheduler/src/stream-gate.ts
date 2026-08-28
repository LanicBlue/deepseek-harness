/**
 * Stream gate: bridges {@link Coordinator} reservations onto the upstream
 * `llm/stream` waterfall.
 *
 * Every streaming model call goes through `ctx.llm.stream(options)`; the
 * runtime emits `llm/stream` as a waterfall around each one. The stream gate
 * reserves a lane slot before the call dispatches and releases it (or applies
 * a failure disposition) once a finish chunk resolves. The physical attempt is
 * the waterfall's `next()`; settle keys off the stream protocol's finish
 * chunk kind.
 *
 * Cooldown timers tick on a low-frequency unref'd interval (no worker, no
 * leak on shutdown) so a circuit-open lane transitions back to probing as
 * soon as its cooldown elapses.
 *
 * @module @deepseek-ai/dsh-llm-scheduler/stream-gate
 */

import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, LlmFailure, StreamChunk } from '@deepseek-ai/dsh-llm'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { classifyFailure, decideFailure, redactFailureMessage } from './failure.ts'
import { Coordinator, ReservationError } from './coordinator.ts'
import { Plane } from './plane.ts'
import type { LaneKey, PriorityByPurpose, RecoveryConfig } from './types.ts'
import { FailureCategory, Priority } from './types.ts'

/** Stream gate configuration. */
export interface StreamGateConfig {
  readonly priorityByPurpose: PriorityByPurpose
  readonly recovery: RecoveryConfig
}

/** Resolve the priority class for one call from its declared purpose. */
function priorityForPurpose(
  purpose: GenerateOptions['purpose'],
  config: PriorityByPurpose,
): Priority {
  if (purpose === 'compaction' && config.compaction !== undefined) return config.compaction
  if (purpose === 'session-title' && config['session-title'] !== undefined) return config['session-title']
  return config.fallback ?? Priority.P2
}

/** Lane key is the registered provider route id today. */
function laneKeyFor(options: GenerateOptions): LaneKey {
  return options.provider
}

/**
 * Translate a category-only ReservationError into a stable harness `LlmError`
 * with a recognized code so dispatch code can route on `code` rather than on
 * scheduler internals.
 */
function reservationAsLlmError(error: ReservationError): LlmError {
  if (error.category === FailureCategory.BLOCKED_MANUAL || error.category === FailureCategory.AUTH) {
    return new LlmError(error.message, 'INVALID_REQUEST')
  }
  return new LlmError(error.message, 'NO_ADAPTER')
}

/**
 * Install the stream gate on the supplied context. Returns a disposer that
 * detaches the waterfall listener, stops the cooldown ticker, and rejects
 * every pending reservation.
 *
 * @param ctx - the host plugin context.
 * @param coordinator - reservation coordinator backed by `plane`.
 * @param plane - admission state machine (used for failure disposition).
 * @param config - gate configuration.
 */
export function installStreamGate(
  ctx: Context,
  coordinator: Coordinator,
  plane: Plane,
  config: StreamGateConfig,
): () => void {
  async function* streamGateListener(
    options: GenerateOptions,
    next: () => AsyncIterable<StreamChunk>,
  ): AsyncIterable<StreamChunk> {
    const lane = laneKeyFor(options)
    const priority = priorityForPurpose(options.purpose, config.priorityByPurpose)
    let reservation
    try {
      reservation = await coordinator.reserve(lane, priority, options.signal)
    } catch (error) {
      if (error instanceof ReservationError) {
        if (plane.laneIdFor(lane) === undefined) {
          throw new LlmError(`no adapter registered for provider "${lane}"`, 'NO_ADAPTER')
        }
        throw reservationAsLlmError(error)
      }
      throw error
    }
    let iterator: AsyncIterator<StreamChunk>
    try {
      iterator = next()[Symbol.asyncIterator]()
    } catch (error) {
      coordinator.release(reservation)
      throw error
    }
    try {
      while (true) {
        const step = await iterator.next()
        if (step.done) {
          coordinator.release(reservation)
          return
        }
        const chunk = step.value
        if (chunk.type === 'finish') {
          switch (chunk.reason.kind) {
            case 'stop':
            case 'tool-calls':
            case 'max-tokens':
            case 'aborted':
              coordinator.release(reservation)
              yield chunk
              return
            case 'error': {
              const failure: LlmFailure = chunk.reason.failure
              const category = classifyFailure(failure)
              const nowMs = Date.now()
              const decision = decideFailure(category, failure, config.recovery, nowMs)
              plane.applyDecision(
                decision,
                lane,
                failure,
                nowMs,
                redactFailureMessage(failure),
              )
              coordinator.release(reservation)
              yield chunk
              return
            }
          }
        }
        yield chunk
      }
    } catch (error) {
      coordinator.release(reservation)
      throw error
    }
  }
  const disposeListener = ctx.on('llm/stream', streamGateListener)

  // Cooldown ticker: once per 500ms, advance the plane's clock and promote
  // probe waiters for any lane whose cooldown just elapsed. The interval is
  // unref'd so it never keeps the process alive on shutdown.
  const interval = setInterval(() => {
    const transitioned = plane.advanceClock(Date.now())
    if (transitioned.length === 0) return
    const snapshot = plane.status()
    for (const laneId of transitioned) {
      const view = snapshot.lanes.find(entry => entry.id === laneId)
      if (view) coordinator.promoteProbeWaiter(view.key)
    }
  }, 500)
  interval.unref?.()

  return () => {
    disposeListener()
    clearInterval(interval)
    coordinator.disposeAll('llm-scheduler disposed')
  }
}
