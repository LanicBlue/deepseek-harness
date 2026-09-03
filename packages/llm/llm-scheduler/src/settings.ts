/**
 * Settings-namespace schema for the scheduler plugin. The composition Config
 * is the same document the settings file section stores, so the UI and Host
 * share one field vocabulary (`P0`–`P4` strings, unlimited concurrency as
 * {@link UNLIMITED_CONCURRENCY}).
 *
 * @module @deepseek-ai/dsh-llm-scheduler/settings
 */

import z from '@deepseek-ai/schemastery'
import type { LaneConfig, PriorityByPurpose } from './types.ts'
import { Priority } from './types.ts'

/** Settings namespace registered by the llm-scheduler plugin. */
export const SCHEDULER_SETTINGS_NAMESPACE = 'llm-scheduler'

/** Scheduling priority classes, in admission order. */
export type PriorityClass = 'P0' | 'P1' | 'P2' | 'P3' | 'P4'

/** The concurrency value that means unlimited in the stored section. */
export const UNLIMITED_CONCURRENCY = Number.MAX_SAFE_INTEGER

/** Provider-neutral request purposes the scheduler assigns priorities to. */
export type SchedulerPurpose = 'conversation' | 'compaction' | 'session-title'

/** One provider lane override as stored in the settings section. */
export interface SchedulerLaneEntry {
  /** Whether the lane accepts new admissions. */
  enabled: boolean
  /** Maximum concurrent in-flight calls; `UNLIMITED_CONCURRENCY` means unbounded. */
  maxConcurrency: number
}

/** User-settings and composition document for the scheduler plugin. */
export interface SchedulerSettings {
  /** Purpose-to-priority mapping applied at admission. */
  priorityByPurpose: Record<SchedulerPurpose, PriorityClass>
  /** Per-provider lane overrides; absent keys use the enabled unlimited default. */
  lanes: Record<string, SchedulerLaneEntry>
  /** Cooldown recovery bounds. */
  recovery: {
    /** Initial cooldown after the first transient failure. */
    initialCooldownMs: number
    /** Hard cap on the exponential backoff. */
    maxCooldownMs: number
  }
  /** Debounce window for `llm/scheduler-updated` emissions; 0 emits immediately. */
  statusDebounceMs: number
}

/** Schema of one `P0`–`P4` scheduling class. */
export const PRIORITY_CLASS = z.union(['P0', 'P1', 'P2', 'P3', 'P4'] as const)

/** Defaults applied when composition or the stored section omits a field. */
export const DEFAULT_SCHEDULER_SETTINGS: SchedulerSettings = {
  priorityByPurpose: { conversation: 'P1', compaction: 'P0', 'session-title': 'P4' },
  lanes: {},
  recovery: { initialCooldownMs: 5_000, maxCooldownMs: 300_000 },
  statusDebounceMs: 250,
}

/**
 *  Map a stored `P0`–`P4` class onto the plane's numeric priority.
 * @param value - the stored `P0`–`P4` class.
 * @returns the plane numeric priority.
*/
export function priorityFromClass(value: PriorityClass): Priority {
  switch (value) {
    case 'P0': return Priority.P0
    case 'P1': return Priority.P1
    case 'P2': return Priority.P2
    case 'P3': return Priority.P3
    case 'P4': return Priority.P4
  }
}

/**
 *  Project settings priorities onto the stream-gate mapping.
 * @param settings - the stored settings document.
 * @returns the stream-gate priority mapping.
*/
export function prioritiesFromSettings(settings: SchedulerSettings): PriorityByPurpose {
  return {
    conversation: priorityFromClass(settings.priorityByPurpose.conversation),
    compaction: priorityFromClass(settings.priorityByPurpose.compaction),
    'session-title': priorityFromClass(settings.priorityByPurpose['session-title']),
    fallback: priorityFromClass(settings.priorityByPurpose.conversation),
  }
}

/**
 * Project one stored lane entry onto plane config. An absent entry is an
 * enabled unlimited lane; `UNLIMITED_CONCURRENCY` becomes unbounded.
  * @param entry - the stored lane entry, when present.
 * @returns the plane lane config.
*/
export function laneConfigFromEntry(entry: SchedulerLaneEntry | undefined): LaneConfig {
  if (entry === undefined) return { enabled: true }
  return {
    enabled: entry.enabled,
    ...entry.maxConcurrency >= UNLIMITED_CONCURRENCY ? {} : { maxConcurrency: entry.maxConcurrency },
  }
}
