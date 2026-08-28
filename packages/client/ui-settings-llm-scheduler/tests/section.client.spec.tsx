// @vitest-environment jsdom
/** Section behavior: configuration writes over the scope stub and the observation tables. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type { SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SchedulerSection } from '../src/client/SchedulerSection.tsx'
import type { SchedulerSectionProps, Translate } from '../src/client/SchedulerSection.tsx'
import {
  availabilityLabel,
  callStateLabel,
  categoryLabel,
  formatAge,
} from '../src/client/SchedulerObservation.tsx'
import {
  SchedulerPanelStore,
  type SchedulerSettings,
  type SchedulerSettingsScope,
  type SchedulerStatusView,
  type SchedulerWire,
} from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t: Translate = (key, params) => {
  let text: string = en[key]
  for (const [name, value] of Object.entries(params ?? {})) {
    text = text.replaceAll(`{${name}}`, String(value))
  }
  return text
}

const DIRECTORY = [
  { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [], active: true },
  { provider: 'openai', displayName: 'openai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'], active: true },
]

const SETTINGS: SchedulerSettings = {
  priorityByPurpose: { conversation: 'P1', compaction: 'P0', 'session-title': 'P4' },
  lanes: { openai: { enabled: true, maxConcurrency: 3 } },
  recovery: { initialCooldownMs: 5_000, maxCooldownMs: 300_000 },
  statusDebounceMs: 250,
}

function statusView(overrides: Partial<SchedulerStatusView> = {}): SchedulerStatusView {
  return {
    lanes: [{
      id: 'lane-deepseek-official' as SchedulerStatusView['lanes'][number]['id'],
      key: 'deepseek-official',
      enabled: true,
      status: 'healthy' as SchedulerStatusView['lanes'][number]['status'],
      maxConcurrency: 2,
      inFlight: 1,
      queued: 2,
    }],
    recentFailures: [{
      atMs: Date.parse('2026-08-27T10:00:00Z'),
      lane: 'deepseek-official',
      code: 'RATE_LIMIT',
      category: 'rate_limited' as SchedulerStatusView['recentFailures'][number]['category'],
      message: 'Provider rate window exhausted.',
    }],
    totalInFlight: 1,
    totalQueued: 2,
    ...overrides,
  }
}

type StatusResult = { ok: true; value: SchedulerStatusView } | { ok: false; error: { code: string; message: string } }

function api(status: () => Promise<StatusResult>): SchedulerWire {
  return {
    llm: {
      listConfigurableProviders: () => Promise.resolve({ ok: true as const, value: DIRECTORY }),
    },
    llmScheduler: {
      status,
    },
  }
}

const okStatus = (view: SchedulerStatusView) => Promise.resolve({ ok: true as const, value: view })

function scopeStub(
  section: SchedulerSettings | undefined,
  options: { writable?: boolean; status?: SettingsScopeSnapshot<SchedulerSettings>['status'] } = {},
) {
  const store = createSnapshotStore<SettingsScopeSnapshot<SchedulerSettings>>({
    status: options.status ?? 'ready',
    value: section,
    base: undefined,
    user: undefined,
    revision: 0,
    writable: options.writable ?? true,
    mode: 'host',
  })
  const writes: Array<{ field: string; value: unknown }> = []
  const scope = {
    getSnapshot: () => store.getSnapshot(),
    subscribe: (listener: () => void) => store.subscribe(listener),
    set: (field: string, value: unknown) => {
      writes.push({ field, value })
      return Promise.resolve()
    },
    unset: () => Promise.resolve(),
  } as unknown as SchedulerSettingsScope
  return { scope, writes, store }
}

async function mount(
  section: SchedulerSettings | undefined = SETTINGS,
  options: {
    scope?: ReturnType<typeof scopeStub>
    status?: SchedulerStatusView
    providers?: () => Promise<{ ok: true; value: typeof DIRECTORY } | { ok: false; error: { code: string; message: string } }>
  } = {},
) {
  const controller = new SchedulerPanelStore({
    llm: {
      listConfigurableProviders: options.providers ?? (() => Promise.resolve({
        ok: true as const,
        value: DIRECTORY,
      })),
    },
    llmScheduler: {
      status: () => okStatus(options.status ?? statusView()),
    },
  })
  await controller.load()
  const scoped = options.scope ?? scopeStub(section)
  const props: SchedulerSectionProps = {
    controller,
    scope: scoped.scope,
    usePanel: bindSnapshotSelector(controller.store),
    useConfig: bindSnapshotSelector(scoped.scope),
    t,
  }
  const view = render(<SchedulerSection {...props} />)
  return { view, controller, ...scoped }
}

describe('configuration area', () => {
  it('renders one row per directory provider plus lane-only keys', async () => {
    const { view } = await mount({
      ...SETTINGS,
      lanes: { ...SETTINGS.lanes, 'ghost-route': { enabled: false, maxConcurrency: 1 } },
    })
    expect(view.getByText('DeepSeek')).toBeDefined()
    // The openai row shows its display name and its route id, which coincide.
    expect(view.getAllByText('openai').length).toBeGreaterThan(0)
    expect(view.getAllByText('ghost-route').length).toBeGreaterThan(0)
  })

  it('toggling a lane switch writes the whole next lanes value', async () => {
    const { writes } = await mount()
    fireEvent.click(screen.getByLabelText(t('laneEnabledLabel', { provider: 'openai' })))
    expect(writes).toEqual([{
      field: 'lanes',
      value: { openai: { enabled: false, maxConcurrency: 3 } },
    }])
  })

  it('committing a concurrency limit writes the bounded entry', async () => {
    const { writes } = await mount()
    const field = screen.getByLabelText(t('laneLimitLabel', { provider: 'DeepSeek' }))
    fireEvent.change(field, { target: { value: '2' } })
    fireEvent.blur(field)
    expect(writes).toEqual([{
      field: 'lanes',
      value: {
        openai: { enabled: true, maxConcurrency: 3 },
        'deepseek-official': { enabled: true, maxConcurrency: 2 },
      },
    }])
  })

  it('an invalid limit explains itself and writes nothing', async () => {
    const { writes } = await mount()
    const field = screen.getByLabelText(t('laneLimitLabel', { provider: 'DeepSeek' }))
    fireEvent.change(field, { target: { value: 'x' } })
    // A non-Enter key is inert; only the commit paths write.
    fireEvent.keyDown(field, { key: 'Tab' })
    fireEvent.blur(field)
    expect(screen.getByRole('alert').textContent).toBe(en.concurrencyInvalid)
    expect(writes).toEqual([])
  })

  it('clearing the limit drops the row entry', async () => {
    const { writes } = await mount()
    const field = screen.getByLabelText(t('laneLimitLabel', { provider: 'openai' }))
    fireEvent.change(field, { target: { value: '' } })
    fireEvent.blur(field)
    expect(writes).toEqual([{ field: 'lanes', value: {} }])
  })

  it('an unlimited lane shows an empty field, never the sentinel number', async () => {
    // The DeepSeek row has no stored entry, so its limit is unlimited; the
    // field must spell that as empty-with-placeholder, not the settings
    // plane's Number.MAX_SAFE_INTEGER sentinel.
    await mount()
    const field = screen.getByLabelText<HTMLInputElement>(t('laneLimitLabel', { provider: 'DeepSeek' }))
    expect(field.value).toBe('')
    expect(field.value).not.toBe('9007199254740991')
    expect(field.placeholder).toBe(en.concurrencyPlaceholder)
  })

  it('a committed external value reseeds the draft', async () => {
    const { store } = await mount()
    const field = screen.getByLabelText<HTMLInputElement>(t('laneLimitLabel', { provider: 'openai' }))
    expect(field.value).toBe('3')
    act(() => {
      store.update((draft) => {
        draft.value = { ...SETTINGS, lanes: { openai: { enabled: true, maxConcurrency: 6 } } }
      })
    })
    expect(field.value).toBe('6')
  })

  it('a purpose select writes the whole priority map', async () => {
    const { writes } = await mount()
    fireEvent.change(screen.getByLabelText(en.purposeConversation), { target: { value: 'P0' } })
    expect(writes).toEqual([{
      field: 'priorityByPurpose',
      value: { conversation: 'P0', compaction: 'P0', 'session-title': 'P4' },
    }])
  })

  it('a recovery edit writes the whole recovery object', async () => {
    const { writes } = await mount()
    const field = screen.getByLabelText(en.initialCooldownLabel)
    fireEvent.change(field, { target: { value: '200' } })
    fireEvent.blur(field)
    expect(writes).toEqual([{
      field: 'recovery',
      value: { initialCooldownMs: 200, maxCooldownMs: 300_000 },
    }])
  })

  it('a maximum-cooldown edit carries the initial value along', async () => {
    const { writes } = await mount()
    const field = screen.getByLabelText(en.maxCooldownLabel)
    fireEvent.change(field, { target: { value: '600000' } })
    fireEvent.blur(field)
    expect(writes).toEqual([{
      field: 'recovery',
      value: { initialCooldownMs: 5_000, maxCooldownMs: 600_000 },
    }])
  })

  it('Enter commits a typed limit without waiting for the blur', async () => {
    const { writes } = await mount()
    const field = screen.getByLabelText(t('laneLimitLabel', { provider: 'DeepSeek' }))
    fireEvent.change(field, { target: { value: '5' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(writes).toEqual([{
      field: 'lanes',
      value: {
        openai: { enabled: true, maxConcurrency: 3 },
        'deepseek-official': { enabled: true, maxConcurrency: 5 },
      },
    }])
  })

  it('an emptied recovery field explains itself and writes nothing', async () => {
    const { writes } = await mount()
    const field = screen.getByLabelText(en.initialCooldownLabel)
    fireEvent.change(field, { target: { value: '' } })
    fireEvent.blur(field)
    expect(screen.getByRole('alert').textContent).toBe(en.recoveryInvalidInitial)
    expect(writes).toEqual([])
  })

  it('a directory failure surfaces beside the rows the section still has', async () => {
    const { view } = await mount(SETTINGS, {
      providers: () => Promise.resolve({
        ok: false as const,
        error: { code: 'internal', message: 'no directory' },
      }),
    })
    expect(view.getByText(`${en.directoryLoadFailed}: no directory`)).toBeDefined()
    // The lane-only openai row survives without the directory.
    expect(view.getAllByText('openai').length).toBeGreaterThan(0)
  })

  it('a below-minimum cooldown explains itself and writes nothing', async () => {
    const { writes } = await mount()
    const field = screen.getByLabelText(en.maxCooldownLabel)
    fireEvent.change(field, { target: { value: '500' } })
    fireEvent.blur(field)
    expect(screen.getByRole('alert').textContent).toBe(en.recoveryInvalidMax)
    expect(writes).toEqual([])
  })

  it('a read-only document disables every control and says so', async () => {
    const { view } = await mount(SETTINGS, { scope: scopeStub(SETTINGS, { writable: false }) })
    expect(view.getByText(en.readOnly)).toBeDefined()
    const controls = [
      screen.getByLabelText<HTMLInputElement>(t('laneEnabledLabel', { provider: 'openai' })),
      screen.getByLabelText<HTMLInputElement>(t('laneLimitLabel', { provider: 'DeepSeek' })),
      screen.getByLabelText<HTMLSelectElement>(en.purposeConversation),
      screen.getByLabelText<HTMLInputElement>(en.initialCooldownLabel),
    ]
    expect(controls.map(control => control.disabled)).toEqual([true, true, true, true])
  })

  it('a loading scope shows the loading line and no controls', async () => {
    const { view } = await mount(undefined, { scope: scopeStub(undefined, { status: 'loading' }) })
    expect(view.getByText(en.loading)).toBeDefined()
    expect(view.queryByLabelText(en.purposeConversation)).toBeNull()
  })

  it('an unavailable namespace degrades to the plugin-absent note', async () => {
    const { view } = await mount(undefined, { scope: scopeStub(undefined, { status: 'unavailable' }) })
    expect(view.getByText(en.pluginNotLoaded)).toBeDefined()
  })
})

describe('observation area', () => {
  it('renders lanes and failures from the accepted view', async () => {
    const { view } = await mount()
    expect(view.getByText(`${en.colActive}: 1 · ${en.colRunnable}: 2`)).toBeDefined()
    expect(view.getByText(en.availabilityHealthy)).toBeDefined()
    expect(view.getByText(en.categoryRateWindow)).toBeDefined()
    expect(view.getByText('Provider rate window exhausted.')).toBeDefined()
  })

  it('an unlimited lane limit reads as Unlimited', async () => {
    const configured = statusView().lanes[0]
    if (configured === undefined) throw new Error('expected a lane')
    const { maxConcurrency: _omit, ...unlimited } = configured
    const { view } = await mount(SETTINGS, {
      status: statusView({
        lanes: [unlimited],
      }),
    })
    expect(view.getAllByText(en.unlimited).length).toBeGreaterThan(0)
  })

  it('an unknown availability and category render verbatim without a state color', async () => {
    const { view } = await mount(SETTINGS, {
      status: statusView({
        lanes: [{ ...statusView().lanes[0]!, status: 'warp_bubble' as SchedulerStatusView['lanes'][number]['status'] }],
        recentFailures: [{
          atMs: Date.now(),
          lane: 'openai',
          code: 'UNKNOWN',
          category: 'cosmic_rays' as SchedulerStatusView['recentFailures'][number]['category'],
          message: 'Unexplained.',
        }],
      }),
    })
    expect(view.getByText('warp_bubble')).toBeDefined()
    expect(view.getByText('cosmic_rays')).toBeDefined()
    expect(view.getByText('Unexplained.')).toBeDefined()
  })

  it('a refresh in flight over a held view keeps the tables standing', async () => {
    const { view, controller } = await mount()
    act(() => {
      controller.store.update((draft) => { draft.observation = 'loading' })
    })
    expect(view.queryByText(en.loading)).toBeNull()
    expect(view.getByText(en.availabilityHealthy)).toBeDefined()
  })

  it('a disabled lane carries the admissions-off tag', async () => {
    const { view } = await mount(SETTINGS, {
      status: statusView({ lanes: [{ ...statusView().lanes[0]!, enabled: false }] }),
    })
    expect(view.getByText(en.laneDisabled)).toBeDefined()
  })

  it('empty failure tables say so', async () => {
    const { view } = await mount(SETTINGS, { status: statusView({ recentFailures: [] }) })
    expect(view.getByText(en.failuresEmpty)).toBeDefined()
  })

  it('a failed observation offers retry, which refetches', async () => {
    const { controller, view } = await mount()
    act(() => {
      controller.store.update((draft) => {
        draft.observation = 'error'
        draft.observationError = 'wire down'
      })
    })
    expect(view.getByText(`${en.obsLoadFailed}: wire down`)).toBeDefined()
    const refetch = vi.spyOn(controller, 'refreshObservation').mockResolvedValue()
    fireEvent.click(view.getByText(en.retry))
    expect(refetch).toHaveBeenCalledTimes(1)
  })

  it('a first mount with an idle panel loads both halves', async () => {
    const controller = new SchedulerPanelStore(api(() => okStatus(statusView())))
    const scoped = scopeStub(SETTINGS)
    const view = render(<SchedulerSection {...{
      controller,
      scope: scoped.scope,
      usePanel: bindSnapshotSelector(controller.store),
      useConfig: bindSnapshotSelector(scoped.scope),
      t,
    }} />)
    await act(async () => { await vi.waitFor(() => {
      expect(controller.store.getSnapshot().observation).toBe('ready')
    }) })
    expect(view.getByText(en.availabilityHealthy)).toBeDefined()
  })
})

describe('wire-vocabulary labels', () => {
  it('localizes the known vocabularies and passes unknown values through', () => {
    expect(availabilityLabel('circuit_open', t)).toBe(en.availabilityCircuitOpen)
    expect(availabilityLabel('mega_new_state', t)).toBe('mega_new_state')
    expect(callStateLabel('awaiting_disposition', t)).toBe(en.callStateAwaitingDisposition)
    expect(callStateLabel('teleported', t)).toBe('teleported')
    expect(categoryLabel('rate_limited', t)).toBe(en.categoryRateWindow)
    expect(categoryLabel('cosmic', t)).toBe('cosmic')
  })

  it('formats waiting time in milliseconds, then two adjacent units', () => {
    expect(formatAge(42, t)).toBe('42ms')
    expect(formatAge(1_500, t)).toBe(t('durationSeconds', { seconds: 1 }))
    expect(formatAge(65_000, t)).toBe(t('durationMinutes', { minutes: 1, seconds: 5 }))
    expect(formatAge(3_600_000, t)).toBe(t('durationHours', { hours: 1, minutes: 0 }))
  })
})
