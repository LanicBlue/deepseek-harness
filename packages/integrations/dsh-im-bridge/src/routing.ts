/**
 * The routing core: a pure decision function from one parsed note, the
 * session binding a (workspace, preset) pair currently holds, and a liveness
 * probe, to the action the bridge takes. Session spawning, resuming, and
 * follow-up injection stay outside this module so the decision table is
 * testable with an injected probe and no runtime at all.
 * @module @deepseek-ai/dsh-im-bridge/routing
 */

import type { ImNote } from './notes.ts'

/** What the bridge does with one note. */
export type RouteDecision =
  | {
    readonly action: 'inject'
    /** Live (or resumable) session the opening brief is queued into. */
    readonly sessionId: string
    /** Mission the brief must cover. */
    readonly missionId: string
  }
  | {
    readonly action: 'spawn'
    /** Mission the spawned session is opened with. */
    readonly missionId: string
  }
  | { readonly action: 'none' }
  | { readonly action: 'stop-loop' }

/** Whether a session id names something the bridge can deliver into. */
export type LivenessProbe = (sessionId: string) => boolean

/**
 * Decide the action for one note.
 *
 * Table: a mission arrival injects into the bound session while the probe
 * says it is deliverable and spawns otherwise (a bound-but-absent session is
 * the archived/evicted case — the binding is stale and the spawn rebuilds
 * it); a membership end stops that member's receive loop permanently; every
 * other note — mission ended, timeout, unknown shapes already dropped by the
 * parser — needs no session.
 * @param note - one parsed note from a receive cycle.
 * @param binding - the session id the (workspace, preset) pair holds, if any.
 * @param isDeliverable - probe for whether a session id can receive a follow-up.
 * @returns the action to take for this note.
 */
export function route(
  note: ImNote,
  binding: string | undefined,
  isDeliverable: LivenessProbe,
): RouteDecision {
  switch (note.kind) {
    case 'arrival':
      if (binding !== undefined && isDeliverable(binding)) {
        return { action: 'inject', sessionId: binding, missionId: note.missionId }
      }
      return { action: 'spawn', missionId: note.missionId }
    case 'membership-end':
      return { action: 'stop-loop' }
    case 'mission-ended':
    case 'timeout':
      return { action: 'none' }
  }
}
