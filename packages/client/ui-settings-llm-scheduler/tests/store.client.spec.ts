/** Panel store: lane-value derivation, row universe, and the two-load snapshot. */
import { describe, expect, it } from 'vitest'
import type { LlmConfigurableProvider } from '@deepseek-ai/dsh-api-remotes/client'
import type { SchedulerStatus } from '@deepseek-ai/dsh-llm-scheduler/types'
import {
  configRows,
  effectiveLane,
  nextLanes,
  refreshIfLoaded,
  reloadIfLoaded,
  SchedulerPanelStore,
  UNLIMITED_CONCURRENCY,
  type SchedulerSettings,
  type SchedulerStatusView,
  type SchedulerWire,
} from '../src/client/store.ts'

type RemoteResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }

function ok<T>(value: T): RemoteResult<T> {
  return { ok: true, value }
}
function fail<T>(message: string): RemoteResult<T> {
  return { ok: false, error: { code: 'internal', message } }
}

const DIRECTORY: LlmConfigurableProvider[] = [
  { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [] },
  { provider: 'openai', displayName: 'openai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'] },
  {
    provider: 'amazon-bedrock',
    displayName: 'amazon-bedrock',
    settingsNs: 'llm-pi-ai',
    settingsPath: ['providers', 'amazon-bedrock'],
    declared: false,
  },
]

const STATUS: SchedulerStatusView = {
  lanes: [{
    id: 'lane-deepseek-official' as SchedulerStatus['lanes'][number]['id'],
    key: 'deepseek-official',
    enabled: true,
    status: 'healthy' as SchedulerStatus['lanes'][number]['status'],
    maxConcurrency: 2,
    inFlight: 1,
    queued: 0,
  }],
  recentFailures: [],
  totalInFlight: 1,
  totalQueued: 0,
}

function api(script: {
  providers?: () => Promise<RemoteResult<LlmConfigurableProvider[]>>
  status?: () => Promise<RemoteResult<SchedulerStatusView>>
} = {}) {
  const calls: string[] = []
  const wire: SchedulerWire = {
    llm: {
      listConfigurableProviders: () => {
        calls.push('providers')
        return script.providers?.() ?? Promise.resolve(ok(DIRECTORY))
      },
    },
    llmScheduler: {
      status: () => {
        calls.push('status')
        return script.status?.() ?? Promise.resolve(ok(STATUS))
      },
    },
  }
  return { face: wire, calls }
}

const SETTINGS: SchedulerSettings = {
  priorityByPurpose: { conversation: 'P1', compaction: 'P0', 'session-title': 'P4' },
  lanes: { openai: { enabled: true, maxConcurrency: 3 } },
  recovery: { initialCooldownMs: 5_000, maxCooldownMs: 300_000 },
  statusDebounceMs: 250,
}

describe('effectiveLane', () => {
  it('resolves an absent entry to enabled with unlimited concurrency', () => {
    expect(effectiveLane(undefined, 'any')).toEqual({ enabled: true, maxConcurrency: UNLIMITED_CONCURRENCY })
    expect(effectiveLane(SETTINGS, 'deepseek-official')).toEqual({ enabled: true, maxConcurrency: UNLIMITED_CONCURRENCY })
  })

  it('reads a stored entry as it stands', () => {
    expect(effectiveLane(SETTINGS, 'openai')).toEqual({ enabled: true, maxConcurrency: 3 })
  })
})

describe('nextLanes', () => {
  it('writes an explicit limit onto a default lane and leaves other entries alone', () => {
    expect(nextLanes(SETTINGS, 'deepseek-official', { maxConcurrency: 2 })).toEqual({
      openai: { enabled: true, maxConcurrency: 3 },
      'deepseek-official': { enabled: true, maxConcurrency: 2 },
    })
  })

  it('clearing the limit drops the entry entirely', () => {
    expect(nextLanes(SETTINGS, 'openai', { maxConcurrency: 'unlimited' })).toEqual({})
  })

  it('disabling an unlimited lane persists an explicit unlimited entry so the switch survives', () => {
    expect(nextLanes(SETTINGS, 'deepseek-official', { enabled: false })).toEqual({
      openai: { enabled: true, maxConcurrency: 3 },
      'deepseek-official': { enabled: false, maxConcurrency: UNLIMITED_CONCURRENCY },
    })
  })

  it('re-enabling that lane drops the entry again', () => {
    const disabled = { ...SETTINGS, lanes: { 'deepseek-official': { enabled: false, maxConcurrency: UNLIMITED_CONCURRENCY } } }
    expect(nextLanes(disabled, 'deepseek-official', { enabled: true })).toEqual({})
  })

  it('disabling keeps the stored limit for when the lane returns', () => {
    expect(nextLanes(SETTINGS, 'openai', { enabled: false })).toEqual({
      openai: { enabled: false, maxConcurrency: 3 },
    })
  })

  it('an edit against no section starts from the absent-route defaults', () => {
    expect(nextLanes(undefined, 'openai', { maxConcurrency: 4 })).toEqual({
      openai: { enabled: true, maxConcurrency: 4 },
    })
  })
})

describe('configRows', () => {
  it('appends lane-only keys the directory no longer lists', () => {
    const rows = configRows(DIRECTORY, {
      ...SETTINGS,
      lanes: { ...SETTINGS.lanes, 'ghost-route': { enabled: false, maxConcurrency: 1 } },
    })
    expect(rows.map(row => row.providerId)).toEqual(['deepseek-official', 'openai', 'ghost-route'])
    expect(rows[2]).toEqual({ providerId: 'ghost-route', displayName: 'ghost-route' })
  })

  it('a directory-only universe needs no section at all', () => {
    expect(configRows(DIRECTORY, undefined).map(row => row.displayName)).toEqual(['DeepSeek', 'openai'])
  })

  it('hides routes the directory marks unconfigured, but a stored lane entry names them', () => {
    expect(configRows(DIRECTORY, undefined).map(row => row.providerId))
      .toEqual(['deepseek-official', 'openai'])
    const withLane = configRows(DIRECTORY, {
      ...SETTINGS,
      lanes: { ...SETTINGS.lanes, 'amazon-bedrock': { enabled: true, maxConcurrency: 2 } },
    })
    expect(withLane.map(row => row.providerId)).toEqual(['deepseek-official', 'openai', 'amazon-bedrock'])
  })
})

describe('SchedulerPanelStore', () => {
  it('loads the directory and the runtime view together', async () => {
    const { face, calls } = api()
    const store = new SchedulerPanelStore(face)
    await store.load()
    expect(store.store.getSnapshot()).toMatchObject({
      directory: 'ready',
      observation: 'ready',
      directoryError: null,
      observationError: null,
    })
    expect(store.store.getSnapshot().providers).toHaveLength(3)
    expect(store.store.getSnapshot().view?.totalInFlight).toBe(1)
    expect(calls).toEqual(['providers', 'status'])
  })

  it('a business failure carries the message into the observation half', async () => {
    const { face } = api({ status: () => Promise.resolve(fail('boom')) })
    const store = new SchedulerPanelStore(face)
    await store.load()
    expect(store.store.getSnapshot()).toMatchObject({ observation: 'error', observationError: 'boom' })
  })

  it('a transport rejection settles as an error, not a throw', async () => {
    const { face } = api({ status: () => Promise.reject(new Error('wire down')) })
    const store = new SchedulerPanelStore(face)
    await expect(store.load()).resolves.toBeUndefined()
    expect(store.store.getSnapshot()).toMatchObject({ observation: 'error', observationError: 'wire down' })
  })

  it('a non-Error rejection still renders a message', async () => {
    const { face } = api({
      providers: () => Promise.reject('plain string'),
    })
    const store = new SchedulerPanelStore(face)
    await store.load()
    expect(store.store.getSnapshot()).toMatchObject({ directory: 'error', directoryError: 'plain string' })
  })

  it('a directory failure keeps the runtime view usable', async () => {
    const { face } = api({ providers: () => Promise.resolve(fail('no directory')) })
    const store = new SchedulerPanelStore(face)
    await store.load()
    expect(store.store.getSnapshot()).toMatchObject({
      directory: 'error',
      directoryError: 'no directory',
      observation: 'ready',
    })
  })

  it('refreshObservation refetches the status alone', async () => {
    const { face, calls } = api()
    const store = new SchedulerPanelStore(face)
    await store.load()
    calls.length = 0
    await store.refreshObservation()
    expect(calls).toEqual(['status'])
  })

  it('a newer refresh wins over an older in-flight load', async () => {
    const resolvers: Array<(value: SchedulerStatusView) => void> = []
    const { face } = api({
      status: () => new Promise((resolve) => {
        resolvers.push((value) => { resolve(ok(value)) })
      }),
    })
    const store = new SchedulerPanelStore(face)
    const slow = store.load()
    const quick = store.refreshObservation()
    resolvers[0]!({ ...STATUS, totalInFlight: 9 })
    await slow
    resolvers[1]!({ ...STATUS, totalInFlight: 1 })
    await quick
    expect(store.store.getSnapshot().view?.totalInFlight).toBe(1)
  })
})

describe('refresh guards', () => {
  it('an idle panel never fetches; a loaded one does', () => {
    const attempted: string[] = []
    const loaded = {
      store: { getSnapshot: () => ({ observation: 'ready' }) },
      refreshObservation: () => { attempted.push('status'); return Promise.resolve() },
      load: () => { attempted.push('all'); return Promise.resolve() },
    }
    const idle = {
      store: { getSnapshot: () => ({ observation: 'idle' }) },
      refreshObservation: () => { attempted.push('status'); return Promise.resolve() },
      load: () => { attempted.push('all'); return Promise.resolve() },
    }
    refreshIfLoaded(loaded as unknown as SchedulerPanelStore)
    reloadIfLoaded(loaded as unknown as SchedulerPanelStore)
    refreshIfLoaded(idle as unknown as SchedulerPanelStore)
    reloadIfLoaded(idle as unknown as SchedulerPanelStore)
    expect(attempted).toEqual(['status', 'all'])
  })
})
