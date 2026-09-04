/**
 * @deepseek-ai/dsh-im-bridge — the InfiniteMission bridge plugin. Presets
 * whose `preset.yml` sets `im: true` become `dsh-<preset>` members in every
 * workspace the `im-bridge` settings namespace lists; the bridge owns one
 * `im receive` loop per member and routes mission arrivals into one
 * deterministic, workspace-cwd DSH Session per (workspace, preset).
 * @module @deepseek-ai/dsh-im-bridge
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: each import resolves the Context service declaration the static
// inject list names, so this package type-checks without runtime imports.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-session'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-workspace'
import { ImBridgeSettingsSchema, SETTINGS_NAMESPACE, type ImBridgeSettings } from './config.ts'
import { ProcessImRunner, rosterHasMember, type ImRunner } from './im-cli.ts'
import { parseReceiveStdout } from './notes.ts'
import { route } from './routing.ts'
import { bridgeSessionId, deliverBrief } from './sessions.ts'

/** Cordis plugin name. */
export const name = 'im-bridge'
/** Services the bridge composes over; the Loader waits for their providers. */
export const inject = ['agents', 'agentPresets', 'sessionQuery', 'sessions', 'settings', 'workspaceRegistry']

/** Plugin config: how the bridge reaches `im` and paces its loops. */
export interface Config {
  /**
   * Executable or path used to run the `im` CLI. Every IM command runs with
   * the workspace as its cwd; this field only names the binary.
   */
  imBin: string
  /**
   * Member id prefix: preset `plan` becomes the member `dsh-plan`. Im ids are
   * self-reported, so the prefix is what keeps bridge-owned members readable
   * apart from human-joined ones.
   */
  memberPrefix: string
  /**
   * `--timeout` passed to each `im receive --wait` cycle. One child per
   * (workspace, member) runs for this long, exits 0, and is re-hung — the
   * cycle length trades process churn against lock-release latency.
   */
  receiveTimeoutSec: number
  /**
   * Reconcile cadence: how often the bridge re-reads the preset roster for
   * the `im` flag. Settings changes reconcile immediately; preset-directory
   * edits have no watcher, so this interval is their path into the bridge.
   */
  rescanSec: number
}

/** Runtime schema resolving {@link Config}. */
export const Config = z.object({
  imBin: z.string().default('im'),
  memberPrefix: z.string().default('dsh'),
  receiveTimeoutSec: z.number().default(600),
  rescanSec: z.number().default(60),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    imBridge: ImBridge
  }
}

/** One running receive loop and its abort handle. */
interface LoopEntry {
  readonly controller: AbortController
  /** The loop's run promise, drained on teardown. */
  readonly running: Promise<void>
}

/** The InfiniteMission bridge service (`ctx.imBridge`). */
export class ImBridge extends Service {
  static inject = ['agents', 'agentPresets', 'sessionQuery', 'sessions', 'settings', 'workspaceRegistry']

  private readonly selfCtx: Context
  private readonly runner: ImRunner
  private settings: SettingsScope<ImBridgeSettings> | undefined
  private readonly loops = new Map<string, LoopEntry>()
  /** (workspace ␀ member) → the session id the pair's briefs deliver into. */
  private readonly bindings = new Map<string, string>()
  private reconcileQueued: Promise<void> = Promise.resolve()
  private stopped = false

  /**
   * @param ctx - runtime context providing the static inject list.
   * @param config - validated plugin config.
   * @param runner - IM command surface; production uses {@link ProcessImRunner},
   *   tests substitute a stub. Cordis passes plugins `(ctx, config)`, so the
   *   default parameter is the production wiring.
   */
  constructor(ctx: Context, config: Config, runner: ImRunner = new ProcessImRunner(config)) {
    super(ctx, 'imBridge')
    this.selfCtx = ctx
    this.runner = runner
    this.settings = ctx.settings.register(SETTINGS_NAMESPACE, ImBridgeSettingsSchema)
    const scope = this.settings
    ctx.effect(() => {
      const unwatch = scope.watch(() => { void this.queueReconcile() })
      this.stopped = false
      void this.queueReconcile()
      const rescan = setInterval(() => { void this.queueReconcile() }, Math.max(1, config.rescanSec) * 1000)
      return async () => {
        this.stopped = true
        clearInterval(rescan)
        unwatch()
        this.settings = undefined
        for (const entry of this.loops.values()) entry.controller.abort()
        await Promise.allSettled([...this.loops.values()].map(entry => entry.running))
        this.loops.clear()
      }
    }, 'imBridge.lifecycle()')
  }

  /**
   * Coalesce reconcile triggers (settings watch, rescan tick, startup) into
   * one serialized pass.
   */
  private queueReconcile(): Promise<void> {
    this.reconcileQueued = this.reconcileQueued.then(async () => {
      if (this.stopped) return
      try {
        await this.reconcile()
      } catch (error: unknown) {
        this.selfCtx.logger.warn(`im-bridge: reconcile failed: ${String(error)}`)
      }
    })
    return this.reconcileQueued
  }

  /**
   * Align running loops with (workspaces × IM-enabled presets).
   *
   * Pairs that dropped out — a workspace removed from settings, a preset
   * whose `im` flag went away — lose their loop but keep their member: the
   * bridge never leaves on the member's behalf. Pairs that joined in get a
   * guard-joined member and their first loop.
   */
  private async reconcile(): Promise<void> {
    const settings = this.settingsValue()
    const presets = (await this.selfCtx.agentPresets.list())
      .filter(preset => preset.im === true && preset.broken === undefined)
    const wanted = new Set<string>()
    for (const workspace of settings.workspaces) {
      for (const preset of presets) wanted.add(this.loopKey(workspace, preset.id))
    }
    for (const [key, entry] of this.loops) {
      if (wanted.has(key)) continue
      entry.controller.abort()
      await entry.running.catch(() => {})
      this.loops.delete(key)
      this.bindings.delete(key)
    }
    for (const workspace of settings.workspaces) {
      for (const preset of presets) {
        const key = this.loopKey(workspace, preset.id)
        if (this.loops.has(key)) continue
        const memberId = await this.ensureMember(workspace, preset.id)
        if (memberId === undefined) continue
        this.startLoop(workspace, preset.id, memberId)
      }
    }
  }

  /** The registered settings section, read per pass so edits apply live. */
  private settingsValue(): ImBridgeSettings {
    return this.settings?.get() ?? { workspaces: [] }
  }

  /**
   * Guard-join the member id: roster first, join only when the exact id is
   * absent, and re-roster afterwards so an auto-suffix race (another active
   * member took the id between the two calls) is reported instead of
   * silently listened on the wrong id.
   * @returns the member id when the exact id is on the roster, else undefined.
   */
  private async ensureMember(workspace: string, presetId: string): Promise<string | undefined> {
    const memberId = `dsh-${presetId}`
    if (!rosterHasMember(await this.runner.roster(workspace), memberId)) {
      await this.runner.join(workspace, memberId)
      if (!rosterHasMember(await this.runner.roster(workspace), memberId)) {
        this.selfCtx.logger.warn(
          `im-bridge: joining "${memberId}" in ${workspace} did not land on that exact id (auto-suffix?); loop skipped`,
        )
        return undefined
      }
    }
    return memberId
  }

  private loopKey(workspace: string, presetId: string): string {
    return `${workspace} ${presetId}`
  }

  /** Start one member's receive loop inside the service lifecycle effect. */
  private startLoop(workspace: string, presetId: string, memberId: string): void {
    const key = this.loopKey(workspace, presetId)
    const controller = new AbortController()
    const running = this.runLoop(workspace, presetId, memberId, controller.signal)
      .catch((error: unknown) => {
        this.selfCtx.logger.warn(`im-bridge: receive loop for "${memberId}" in ${workspace} failed: ${String(error)}`)
      })
      .finally(() => {
        if (this.loops.get(key)?.controller === controller) this.loops.delete(key)
      })
    this.loops.set(key, { controller, running })
  }

  /**
   * One member's receive cycles until aborted or dismissed.
   *
   * Every cycle feeds its notes through the routing core; a spawn
   * re-verifies the arrival by fetching the rendered brief first (a stale
   * note for a mission already moved on fails `mission show` and is
   * dropped), and a membership end returns without re-hanging.
   */
  private async runLoop(workspace: string, presetId: string, memberId: string, signal: AbortSignal): Promise<void> {
    const key = this.loopKey(workspace, presetId)
    const sessionId = bridgeSessionId(workspace, presetId)
    const deliverable = (candidate: string): boolean =>
      (this.selfCtx.agents.get(sessionId) !== undefined || this.selfCtx.sessions.get(sessionId) !== undefined)
      && candidate === sessionId
    for (;;) {
      if (signal.aborted) return
      const cycle = await this.runner.receive(workspace, memberId, signal)
      for (const note of parseReceiveStdout(cycle.stdout)) {
        const decision = route(note, this.bindings.get(key), deliverable)
        if (decision.action === 'stop-loop') return
        if (decision.action === 'none') continue
        let opening: string
        try {
          opening = await this.runner.missionShow(workspace, memberId, decision.missionId)
        } catch (error: unknown) {
          // The arrival raced the mission moving on; the next cycle carries
          // wherever it actually is.
          this.selfCtx.logger.debug(
            `im-bridge: brief fetch for ${decision.missionId} failed, skipping: ${String(error)}`,
          )
          continue
        }
        const target = decision.action === 'inject' ? decision.sessionId : sessionId
        try {
          await deliverBrief(this.selfCtx, {
            workspacePath: workspace,
            presetId,
            sessionId: bridgeSessionId(workspace, presetId),
            missionId: decision.missionId,
            opening,
          })
        } catch (error: unknown) {
          // The note was consumed exactly-once, so this mission's next
          // movement re-notifies; the loop must survive to hear it.
          this.selfCtx.logger.error(
            `im-bridge: delivering ${decision.missionId} to ${target} failed: ${String(error)}`,
          )
          continue
        }
        this.bindings.set(key, target)
      }
    }
  }

  /**
   * Read-only view of the live loops, for tests and diagnostics.
   * @returns the number of receive loops currently running.
   */
  loopCount(): number {
    return this.loops.size
  }

  /**
   * Wait for every queued reconcile pass to settle (tests, diagnostics).
   * @returns when no reconcile pass is in flight.
   */
  async settle(): Promise<void> {
    await this.reconcileQueued
  }
}



/** Start the bridge Service with the validated config. */
export function apply(ctx: Context, config: Config): void {
  ctx.plugin(ImBridge, config)
}

export { ImBridgeSettingsSchema, SETTINGS_NAMESPACE, type ImBridgeSettings } from './config.ts'
export {
  ProcessImRunner, rosterHasMember,
  type ImRunner, type ReceiveCycle,
} from './im-cli.ts'
export {
  type ArrivalNote, type ImNote, type MembershipEndNote,
  type MissionEndedNote, parseReceiveStdout, type TimeoutNote,
} from './notes.ts'
export { route, type LivenessProbe, type RouteDecision } from './routing.ts'
export { bridgeSessionId, deliverBrief } from './sessions.ts'
