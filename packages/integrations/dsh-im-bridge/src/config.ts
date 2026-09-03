/**
 * The user settings surface for the InfiniteMission bridge: the bridged
 * workspace list is user state and lives in the `im-bridge` settings
 * namespace. Deployment-varying plugin fields (im binary, loop pacing) are
 * entry-owned `Config` fields settable from a `cordis.yml` row.
 * @module @deepseek-ai/dsh-im-bridge/config
 */

import z from '@deepseek-ai/schemastery'

/** Settings namespace holding the bridged InfiniteMission workspaces. */
export const SETTINGS_NAMESPACE = 'im-bridge'

/** User settings: absolute paths of the IM workspaces this deployment bridges. */
export interface ImBridgeSettings {
  /** Absolute workspace paths; each must contain an `.im/` directory. */
  workspaces: string[]
}

/** Schema resolving {@link ImBridgeSettings}. */
export const ImBridgeSettingsSchema: z<ImBridgeSettings> = z.object({
  workspaces: z.array(z.string()).default([]),
})
