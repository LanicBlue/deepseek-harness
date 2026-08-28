/** Scheduler section registration: slot declaration injection, the locale-following label thunk, and pushed refreshes. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { TestRemote, scriptedSettingsRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as settingsApply, inject as settingsInject } from '@deepseek-ai/dsh-client-ui-settings/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-settings-llm-scheduler/client'
import { SchedulerSection } from '../src/client/SchedulerSection.tsx'

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  const remote = new TestRemote(ctx, {
    llm: {
      listConfigurableProviders: vi.fn(() => Promise.resolve({ ok: true, value: [] })),
    },
    llmScheduler: {
      status: vi.fn(() => Promise.resolve({
        ok: true,
        value: { lanes: [], recentFailures: [], totalInFlight: 0, totalQueued: 0 },
      })),
    },
    settings: scriptedSettingsRemote().settings,
  })
  ctx.provide('connection', { api: {}, isLoopback: true } as never)
  await ctx.plugin({ inject: [...settingsInject], apply: settingsApply }).await()
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale, remote }
}

function declare(slots: SlotRegistry): () => void {
  return slots.register(
    {
      name: 'root',
      children: { 'settings.section': { kind: 'list', scope: 'root' } },
    } as never,
    () => null,
  )
}

describe('ui-settings-llm-scheduler apply', () => {
  it('declares the services it uses', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.llm', 'remote.llmScheduler', 'settingsScope'])
  })

  it('registers the scheduling nav entry for declarations before or after apply', async () => {
    const before = await bench()
    declare(before.slots)
    await before.ctx.plugin({ inject: [...inject], apply }).await()
    const entry = before.slots.entries('settings.section')[0]!
    expect(entry.component).toBe(SchedulerSection)
    expect(entry.options).toMatchObject({ id: 'scheduler', order: 12 })
    expect(resolveSlotLabel(entry.options.label)).toBe('调度')
    const injected = (entry.inject as unknown as () => import('../src/client/SchedulerSection.tsx').SchedulerSectionInjected)()
    expect(injected.t('nav')).toBe('调度')
    expect(injected.t('title')).toBe('模型调度')
    expect(typeof injected.controller.load).toBe('function')
    expect(injected.hooks.panel).toBe(injected.controller.store)
    expect(injected.scope.getSnapshot().mode).toBe('host')
    expect(injected.scope).toBe(injected.hooks.config)

    const after = await bench()
    await after.ctx.plugin({ inject: [...inject], apply }).await()
    expect(after.slots.entries('settings.section')).toHaveLength(0)
    declare(after.slots)
    await Promise.resolve()
    expect(after.slots.entries('settings.section')[0]!.component).toBe(SchedulerSection)
    expect(after.slots.entries('settings.section')).toHaveLength(1)
  })

  it('the label thunk follows the active locale without re-registration', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    b.locale.setLocale('en')
    expect(resolveSlotLabel(b.slots.entries('settings.section')[0]!.options.label)).toBe('Scheduling')
    b.locale.setLocale('zh')
    expect(resolveSlotLabel(b.slots.entries('settings.section')[0]!.options.label)).toBe('调度')
  })

  it('re-registers after an HMR collapse re-declares the slot', async () => {
    const b = await bench()
    const redeclare = declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    expect(b.slots.entries('settings.section')).toHaveLength(1)
    redeclare()
    expect(b.slots.entries('settings.section')).toHaveLength(0)
    declare(b.slots)
    await Promise.resolve()
    expect(b.slots.entries('settings.section')[0]!.component).toBe(SchedulerSection)
  })

  it('registers the zh/en dictionaries and disposes everything with the fiber', async () => {
    const b = await bench()
    declare(b.slots)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.locale.bind('settings.scheduler')('nav')).toBe('调度')
    await fiber.dispose()
    expect(b.slots.entries('settings.section')).toHaveLength(0)
    expect(() => b.locale.register('settings.scheduler', 'zh', {})).not.toThrow()
    expect(() => b.locale.register('settings.scheduler', 'en', {})).not.toThrow()
  })
})

describe('pushed refreshes', () => {
  async function benchLoaded() {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const entry = b.slots.entries('settings.section')[0]!
    const injected = (entry.inject as unknown as () => import('../src/client/SchedulerSection.tsx').SchedulerSectionInjected)()
    return { b, injected }
  }

  it('ignores pushes before the page ever loaded', async () => {
    const { b } = await benchLoaded()
    b.remote.emit('llm/scheduler-updated', [])
    b.remote.emit('llm/adapters-updated', [])
    b.ctx.emit('connection/reset')
  })

  it('a scheduler push refreshes the observation of a loaded page', async () => {
    const { b, injected } = await benchLoaded()
    injected.controller.store.update((draft) => { draft.observation = 'ready' })
    const refresh = vi.spyOn(injected.controller, 'refreshObservation').mockResolvedValue()
    b.remote.emit('llm/scheduler-updated', [])
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('a topology change or reconnect reloads a loaded page', async () => {
    const { b, injected } = await benchLoaded()
    injected.controller.store.update((draft) => { draft.observation = 'ready' })
    const reload = vi.spyOn(injected.controller, 'load').mockResolvedValue()
    b.remote.emit('llm/adapters-updated', [])
    b.ctx.emit('connection/reset')
    expect(reload).toHaveBeenCalledTimes(2)
  })
})
