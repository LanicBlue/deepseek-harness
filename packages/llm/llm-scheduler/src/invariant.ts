/**
 * Package-owned runtime invariant companion.
 *
 * No runtime invariant: the scheduler exposes no session-event vocabulary;
 * admission and circuit state are process-live by design and intentionally
 * restart on process boundary (the agent note on this package records the
 * rationale). The invariant host requires durable session events to check
 * against, so the companion registers the manifest name only.
 *
 * @module @deepseek-ai/dsh-llm-scheduler/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-llm-scheduler'

/** Companion plugin name surfaced to the invariants registry. */
export const name = 'llm-scheduler-invariant'

/** Invariants service required before this companion can install. */
export const inject = ['invariants']

/** Empty installer: process-live state has no durable boundary to check. */
const install: InvariantInstaller = (_ctx: Context, _fail: InvariantFailure): void => {
  // No runtime invariant: see file-level doc comment.
}

/** Register the scheduler invariant companion with the invariants service. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
