/**
 * Model-scheduling settings panel store: one snapshot joining the scheduler
 * observation Remote (`llmScheduler.status`) with the configurable-provider
 * directory (`llm.listConfigurableProviders`). Configuration writes do not
 * pass through here — they go through the bound `llm-scheduler` settings
 * scope; this store owns only the fetched directory and the read-only
 * runtime view.
 */

import type {
  LlmConfigurableProvider,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { SchedulerStatus } from '@deepseek-ai/dsh-llm-scheduler/types'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'

/** Full scheduler snapshot as the status Remote answers it. */
export type SchedulerStatusView = SchedulerStatus
/** One provider lane row. */
export type SchedulerLaneView = SchedulerStatusView['lanes'][number]
/** One redacted recent-failure fact. */
export type SchedulerFailureView = SchedulerStatusView['recentFailures'][number]

/** Settings namespace the llm-scheduler plugin registers its section under. */
export const SCHEDULER_SETTINGS_NAMESPACE = 'llm-scheduler'

/** Scheduling priority classes, in admission order. */
export type SchedulerPriorityClass = 'P0' | 'P1' | 'P2' | 'P3' | 'P4'

/** Provider-neutral request purposes the scheduler assigns priorities to. */
export type SchedulerPurpose = 'conversation' | 'compaction' | 'session-title'

/** Every purpose, in the configuration area's display order. */
export const SCHEDULER_PURPOSES: readonly SchedulerPurpose[] = ['conversation', 'compaction', 'session-title']

/** Every priority class, in select order. */
export const SCHEDULER_PRIORITY_CLASSES: readonly SchedulerPriorityClass[] = ['P0', 'P1', 'P2', 'P3', 'P4']

/** One provider lane override as stored in the settings section. */
export interface SchedulerLaneEntry {
  enabled: boolean
  maxConcurrency: number
}

/**
 * Client mirror of the `llm-scheduler` settings section. The Host resolves
 * every field through the section's own schema before this plane sees it.
 */
export interface SchedulerSettings {
  priorityByPurpose: Record<SchedulerPurpose, SchedulerPriorityClass>
  lanes: Record<string, SchedulerLaneEntry>
  recovery: { initialCooldownMs: number; maxCooldownMs: number }
  statusDebounceMs: number
}

/**
 * The concurrency value that means "unlimited" on the wire — the same bound
 * the scheduler itself uses for an unconfigured lane.
 */
export const UNLIMITED_CONCURRENCY = Number.MAX_SAFE_INTEGER

/** Schema minimum for `recovery.initialCooldownMs`, mirrored for field validation. */
export const MIN_INITIAL_COOLDOWN_MS = 100
/** Schema minimum for `recovery.maxCooldownMs`, mirrored for field validation. */
export const MIN_MAX_COOLDOWN_MS = 1_000

/**
 * Effective lane values one configuration row shows: an absent entry is an
 * enabled lane with unlimited concurrency.
  * @param settings - stored section, when loaded.
 * @param providerId - lane key the row edits.
 * @returns the effective enabled/concurrency pair for the row.
*/
export function effectiveLane(
  settings: SchedulerSettings | undefined,
  providerId: string,
): { enabled: boolean; maxConcurrency: number } {
  const entry = settings?.lanes[providerId]
  return {
    enabled: entry?.enabled ?? true,
    maxConcurrency: entry?.maxConcurrency ?? UNLIMITED_CONCURRENCY,
  }
}

/** One lane-row edit; `maxConcurrency: 'unlimited'` names the empty field. */
export interface LaneEdit {
  enabled?: boolean
  maxConcurrency?: number | 'unlimited'
}

/**
 * Next `lanes` value after one row edit. A row whose effective values match
 * the absent-route defaults drops its entry entirely.
  * @param settings - stored section, when loaded.
 * @param providerId - lane key the edit applies to.
 * @param edit - the row edit; `unlimited` names the empty concurrency field.
 * @returns the next `lanes` value with the edit applied.
*/
export function nextLanes(
  settings: SchedulerSettings | undefined,
  providerId: string,
  edit: LaneEdit,
): Record<string, SchedulerLaneEntry> {
  const current = effectiveLane(settings, providerId)
  const enabled = edit.enabled ?? current.enabled
  const maxConcurrency = edit.maxConcurrency === 'unlimited'
    ? UNLIMITED_CONCURRENCY
    : edit.maxConcurrency ?? current.maxConcurrency
  const lanes: Record<string, SchedulerLaneEntry> = {}
  const carriesDefault = enabled && maxConcurrency === UNLIMITED_CONCURRENCY
  for (const [key, entry] of Object.entries(settings?.lanes ?? {})) {
    if (key === providerId) continue
    lanes[key] = entry
  }
  if (!carriesDefault) lanes[providerId] = { enabled, maxConcurrency }
  return lanes
}

/** Panel snapshot: two independent loads, one stable reference per change. */
export interface SchedulerPanelState {
  /** Provider-directory load (the configuration area's row universe). */
  directory: 'idle' | 'loading' | 'ready' | 'error'
  /** Directory failure text. */
  directoryError: string | null
  /** Configurable providers in directory order. */
  providers: readonly LlmConfigurableProvider[]
  /** Scheduler-observation load. */
  observation: 'idle' | 'loading' | 'ready' | 'error'
  /** Observation failure text. */
  observationError: string | null
  /** Latest accepted status view. */
  view: SchedulerStatusView | undefined
}

/**
 *  Human text for a rejected wire call.
 * @param error - a rejected wire call.
 * @returns human text for the rejection.
*/
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** LLM Remote methods used by the scheduling panel. */
export type SchedulerLlm = {
  listConfigurableProviders(): Promise<
    { ok: true; value: readonly LlmConfigurableProvider[] } | { ok: false; error: { message: string } }
  >
}

/** Scheduler Remote methods used by the scheduling panel. */
export type SchedulerRemote = {
  status(): Promise<{ ok: true; value: SchedulerStatus } | { ok: false; error: { message: string } }>
}

/** Every Remote wire face the scheduling panel reaches. */
export interface SchedulerWire {
  llm: SchedulerLlm
  llmScheduler: SchedulerRemote
}

/** The scheduling panel controller (one per settings surface). */
export class SchedulerPanelStore {
  /** The snapshot the section renders from (uSES-safe store). */
  readonly store: SnapshotStore<SchedulerPanelState> = createSnapshotStore<SchedulerPanelState>({
    directory: 'idle',
    directoryError: null,
    providers: [],
    observation: 'idle',
    observationError: null,
    view: undefined,
  })

  /** Latest load wins; an older response never overwrites a newer one. */
  private generation = 0

  /**
   * @param wire - the wire faces (provider directory and scheduler status).
   */
  constructor(private readonly wire: SchedulerWire) {}

  /** First-open load: the provider directory and the scheduler status in parallel. */
  async load(): Promise<void> {
    const generation = ++this.generation
    this.store.update((s) => {
      s.directory = 'loading'
      s.directoryError = null
      s.observation = 'loading'
      s.observationError = null
    })
    await Promise.all([this.loadDirectory(generation), this.loadObservation(generation)])
  }

  /** Refetch the scheduler status alone. */
  async refreshObservation(): Promise<void> {
    await this.loadObservation(++this.generation)
  }

  private async loadDirectory(generation: number): Promise<void> {
    let providers: readonly LlmConfigurableProvider[]
    try {
      const result = await this.wire.llm.listConfigurableProviders()
      if (!result.ok) throw new Error(result.error.message)
      providers = result.value
    } catch (error) {
      if (generation !== this.generation) return
      this.store.update((s) => {
        s.directory = 'error'
        s.directoryError = messageOf(error)
      })
      return
    }
    if (generation !== this.generation) return
    this.store.update((s) => {
      s.directory = 'ready'
      s.directoryError = null
      s.providers = providers
    })
  }

  private async loadObservation(generation: number): Promise<void> {
    let view: SchedulerStatusView
    try {
      const result = await this.wire.llmScheduler.status()
      if (!result.ok) throw new Error(result.error.message)
      view = result.value
    } catch (error) {
      if (generation !== this.generation) return
      this.store.update((s) => {
        s.observation = 'error'
        s.observationError = messageOf(error)
      })
      return
    }
    if (generation !== this.generation) return
    this.store.update((s) => {
      s.observation = 'ready'
      s.observationError = null
      s.view = view
    })
  }
}

/**
 *  Refetch the runtime view only after its first load.
 * @param controller - the panel store to refresh.
*/
export function refreshIfLoaded(controller: SchedulerPanelStore): void {
  if (controller.store.getSnapshot().observation === 'idle') return
  void controller.refreshObservation()
}

/**
 *  Reload the whole panel only after its first load.
 * @param controller - the panel store to reload.
*/
export function reloadIfLoaded(controller: SchedulerPanelStore): void {
  if (controller.store.getSnapshot().observation === 'idle') return
  void controller.load()
}

/** One provider row of the configuration area. */
export interface ConfigRow {
  /** Provider route key. */
  providerId: string
  /** Human-facing name; the route key when the directory has no entry. */
  displayName: string
}

/**
 * The configuration area's row universe: the provider directory plus any
 * lane key the stored section still carries. A route the adapter marks
 * `declared: false` is catalog possibility and appears only once a stored
 * lane entry names it.
  * @param providers - the configurable-provider directory.
 * @param settings - stored section, when loaded.
 * @returns the configuration area row universe.
*/
export function configRows(
  providers: readonly LlmConfigurableProvider[],
  settings: SchedulerSettings | undefined,
): ConfigRow[] {
  const rows: ConfigRow[] = []
  const known = new Set<string>()
  for (const entry of providers) {
    if (entry.declared === false) continue
    rows.push({ providerId: entry.provider, displayName: entry.displayName })
    known.add(entry.provider)
  }
  for (const providerId of Object.keys(settings?.lanes ?? {})) {
    if (known.has(providerId)) continue
    rows.push({ providerId, displayName: providerId })
  }
  return rows
}

/** The scope face the configuration area reads and writes through. */
export type SchedulerSettingsScope = SettingsScope<SchedulerSettings>
