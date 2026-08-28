/**
 * Model-scheduling settings plugin, browser half. It registers the
 * Scheduling page: a configuration area over the `llm-scheduler` settings
 * namespace (written through the bound scope) and a read-only runtime area
 * fed by `ctx.remote.llmScheduler.status()`, refreshed on the forwarded
 * `llm/scheduler-updated` notification.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-llm-scheduler/types'
import { SchedulerSection } from './SchedulerSection.tsx'
import type { SchedulerSectionInjected, Translate } from './SchedulerSection.tsx'
import {
  reloadIfLoaded,
  refreshIfLoaded,
  SCHEDULER_SETTINGS_NAMESPACE,
  SchedulerPanelStore,
  type SchedulerSettings,
} from './store.ts'
import { en, zh, type SchedulerLocaleKey } from './locales.ts'

export type {
  SchedulerSectionInjected, SchedulerSectionProps, Translate,
} from './SchedulerSection.tsx'
export type { SchedulerLocaleKey } from './locales.ts'
export type {
  ConfigRow, LaneEdit, SchedulerFailureView, SchedulerLaneView,
  SchedulerPanelState, SchedulerPanelStore, SchedulerPriorityClass, SchedulerPurpose,
  SchedulerSettings, SchedulerSettingsScope, SchedulerStatusView,
} from './store.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Model-scheduling settings page copy. */
    'settings.scheduler': SchedulerLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.scheduler'

/**
 * Required services (cordis fiber inject). The target slot is declared by
 * ui-settings' apply, whose activation order relative to this one is NOT
 * constrained; registration depends on the slot through `slots.inject()`.
 */
export const inject = ['slots', 'locale', 'remote', 'remote.llm', 'remote.llmScheduler', 'settingsScope']

/**
 * Register the Scheduling section once the `settings.section` declaration is
 * on the ledger, bind the namespace scope, and keep the runtime view fresh on
 * every pushed scheduler notification.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-llm-scheduler: copy dictionaries')

  const controller = new SchedulerPanelStore({
    llm: ctx.remote.llm,
    llmScheduler: ctx.remote.llmScheduler,
  })
  const scope = ctx.settingsScope.bind<SchedulerSettings>({ namespace: SCHEDULER_SETTINGS_NAMESPACE })
  const t = ctx.locale.bind(NS) as Translate
  const injected = (): SchedulerSectionInjected => ({
    controller,
    scope,
    hooks: { panel: controller.store, config: scope },
    t,
  })

  ctx.effect(() => {
    const disposers = [
      ctx.remote.$on('llm/scheduler-updated', () => { refreshIfLoaded(controller) }),
      ctx.remote.$on('llm/adapters-updated', () => { reloadIfLoaded(controller) }),
      ctx.on('connection/reset', () => { reloadIfLoaded(controller) }),
    ]
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'ui-settings-llm-scheduler: pushed refreshes')

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'scheduler',
    order: 12,
    label: () => t('nav'),
    inject: injected,
  }, SchedulerSection))
}
