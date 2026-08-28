/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-settings-llm-scheduler`.
 * @module @deepseek-ai/dsh-client-ui-settings-llm-scheduler/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-settings-llm-scheduler'

/** Cordis companion plugin name. */
export const name = 'client-ui-settings-llm-scheduler-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: a read-mostly settings-section plugin whose writes
 * already pass through the settings namespace's own revision fencing — it
 * emits no cordis events and owns no cross-plugin mutable relation.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
