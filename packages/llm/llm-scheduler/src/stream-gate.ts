/**
 * Stream gate: bridges {@link Coordinator} reservations onto the upstream
 * `llm/stream` waterfall.
 *
 * Every streaming model call goes through `ctx.llm.stream(options)`; the
 * runtime emits `llm/stream` as a waterfall around each one. The stream gate
 * consults `llm/scheduler-route` listeners before admission (they may rewrite
 * the provider in place), reserves a lane slot before the call dispatches, and
 * releases it (or applies a failure disposition) once a finish chunk resolves;
 * `llm/scheduler-decide` listeners may override that disposition, including
 * re-dispatching the call on another lane. The physical attempt is the
 * waterfall's `next()`; settle keys off the stream protocol's finish chunk
 * kind.
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
import type { DecideFacts, FailureDecision, LaneKey, PriorityByPurpose, RecoveryConfig, RouteFacts } from './types.ts'
import { FailureCategory, Priority } from './types.ts'

/** Stream gate configuration. */
export interface StreamGateConfig {
  priorityByPurpose: PriorityByPurpose
  recovery: RecoveryConfig
}

/**
 * Maximum provider hops one logical call may take through decide-listener
 * `retarget` decisions before the error stands. Guards against policy loops
 * (A degrades to B while B degrades back to A).
 */
export const MAX_RETARGET_HOPS = 2

/**
 * Per-options-object retarget hop count. Only hops the gate itself launches
 * are tracked; a fresh options object from any other source starts at zero.
 */
const retargetHops = new WeakMap<object, number>()

/**
 * Consult `llm/scheduler-route` listeners for one call. A listener that
 * throws voids the consultation: the call keeps its own provider.
 */
function consultRoute(ctx: Context, options: GenerateOptions): LaneKey | undefined {
  const facts: RouteFacts = {
    provider: options.provider,
    model: options.model,
    purpose: options.purpose,
    now: Date.now(),
  }
  try {
    return ctx.bail('llm/scheduler-route', facts)
  } catch (error) {
    ctx.logger.warn('llm-scheduler: an llm/scheduler-route listener failed; keeping the call\'s own provider', error)
    return undefined
  }
}

/**
 * Consult `llm/scheduler-decide` listeners for one error finish. A listener
 * that throws voids the consultation: the built-in disposition table applies.
 */
function consultDecide(ctx: Context, facts: DecideFacts): FailureDecision | undefined {
  try {
    return ctx.bail('llm/scheduler-decide', facts)
  } catch (error) {
    ctx.logger.warn('llm-scheduler: an llm/scheduler-decide listener failed; applying the built-in disposition', error)
    return undefined
  }
}

/** Resolve the priority class for one call from its declared purpose. */
function priorityForPurpose(
  purpose: GenerateOptions['purpose'],
  config: PriorityByPurpose,
): Priority {
  if (purpose === 'compaction' && config.compaction !== undefined) return config.compaction
  if (purpose === 'session-title' && config['session-title'] !== undefined) return config['session-title']
  if (config.conversation !== undefined) return config.conversation
  return config.fallback ?? Priority.P1
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
  * @returns a disposer that detaches the listener, stops the ticker, and rejects pending reservations.
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
    const routed = consultRoute(ctx, options)
    if (routed !== undefined && routed !== options.provider) {
      // Waterfall args flow by reference; the in-place rewrite is the only way
      // downstream listeners and the adapter see the routed provider.
      options.provider = routed
    }
    const lane = routed ?? laneKeyFor(options)
    const priority = priorityForPurpose(options.purpose, config.priorityByPurpose)
    plane.ensureLane(lane)
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
              const redacted = redactFailureMessage(failure)
              const facts: DecideFacts = {
                failure: { code: failure.code, category, lane, atMs: nowMs, message: redacted },
                now: nowMs,
              }
              const decision = consultDecide(ctx, facts)
                ?? decideFailure(category, failure, config.recovery, nowMs)
              const hops = retargetHops.get(options) ?? 0
              if (decision.kind === 'retarget' && hops < MAX_RETARGET_HOPS && decision.to !== lane) {
                // The source-lane record rides the circuit hint; the call
                // itself moves on without surfacing this error finish.
                plane.applyDecision(
                  decision.openCircuitMs === undefined
                    ? { kind: 'fail_call', category: decision.category }
                    : { kind: 'open_circuit', category: decision.category, cooldownMs: decision.openCircuitMs },
                  lane,
                  failure,
                  nowMs,
                  redacted,
                )
                coordinator.release(reservation, false)
                const nextOptions: GenerateOptions = { ...options, provider: decision.to }
                retargetHops.set(nextOptions, hops + 1)
                // Re-enters the llm/stream waterfall from the top: a fresh
                // gate admission runs on the target lane.
                yield* ctx.llm.stream(nextOptions)
                return
              }
              plane.applyDecision(decision, lane, failure, nowMs, redacted)
              coordinator.release(reservation, false)
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
  interval.unref()

  return () => {
    disposeListener()
    clearInterval(interval)
    coordinator.disposeAll('llm-scheduler disposed')
  }
}
