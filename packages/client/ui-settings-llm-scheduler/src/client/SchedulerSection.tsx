/**
 * Model-scheduling settings section. The configuration area writes the
 * `llm-scheduler` settings namespace through the bound scope (each edit one
 * whole top-level field, revision-fenced and queued by the scope itself), and
 * renders one lane row per directory provider plus any lane key the stored
 * section still carries. An empty concurrency field means unlimited and drops
 * the row's entry entirely; a disabled lane persists an explicit entry so the
 * switch survives. The read-only runtime area lives in
 * `SchedulerObservation.tsx`.
 */

import { useEffect, useId, useState, type ReactNode } from 'react'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { SchedulerObservation } from './SchedulerObservation.tsx'
import {
  configRows,
  effectiveLane,
  MIN_INITIAL_COOLDOWN_MS,
  MIN_MAX_COOLDOWN_MS,
  nextLanes,
  SCHEDULER_PRIORITY_CLASSES,
  SCHEDULER_PURPOSES,
  SchedulerPanelStore,
  UNLIMITED_CONCURRENCY,
  type SchedulerPanelState,
  type SchedulerPurpose,
  type SchedulerSettings,
  type SchedulerSettingsScope,
} from './store.ts'
import type { SchedulerLocaleKey } from './locales.ts'
import styles from './SchedulerSection.module.css'

/** Panel copy translator: template keys plus `{name}` interpolation params. */
export type Translate = (key: SchedulerLocaleKey, params?: Record<string, unknown>) => string

/** Injected dependencies of {@link SchedulerSection} (slot `inject`). */
export interface SchedulerSectionInjected {
  /** The panel store (loaded on mount, refreshed on pushed invalidations). */
  controller: SchedulerPanelStore
  /** The `llm-scheduler` settings scope the configuration area writes through. */
  scope: SchedulerSettingsScope
  hooks: {
    /** Panel snapshot bound by the UI renderer as usePanel. */
    panel: SchedulerPanelStore['store']
    /** Scope snapshot bound by the UI renderer as useConfig. */
    config: SchedulerSettingsScope
  }
  /** Section copy. */
  t: Translate
}

/**
 * Props delivered by the slot outlet: the inject face spread flat (the
 * renderer erases the share boundary at the render call).
 */
export type SchedulerSectionProps = Partial<InjectFace<SchedulerSectionInjected>>

type SchedulerSectionFace = InjectFace<SchedulerSectionInjected>

/**
 * Render the scheduling section content column.
 * @param props - slot-delivered injected dependencies.
 * @returns the section, or null while the shell has not injected yet.
 */
export function SchedulerSection(props: SchedulerSectionProps): ReactNode {
  const { controller, scope, usePanel, useConfig, t } = props
  if (
    controller === undefined || scope === undefined || usePanel === undefined
    || useConfig === undefined || t === undefined
  ) return null
  return <Loaded injected={{ controller, scope, usePanel, useConfig, t }} />
}

function Loaded({ injected }: { injected: SchedulerSectionFace }): ReactNode {
  const { controller, scope, t } = injected
  const panel = injected.usePanel(snapshot => snapshot)
  const config = injected.useConfig(snapshot => snapshot)

  // First mount pulls both halves once; later refreshes ride the pushed
  // invalidations the plugin body subscribed to.
  if (panel.observation === 'idle') void controller.load()

  return (
    <div className={styles['section']}>
      <h2 className={styles['title']}>{t('title')}</h2>
      <p className={styles['intro']}>{t('intro')}</p>
      <ConfigArea scope={scope} config={config} panel={panel} t={t} />
      <SchedulerObservation panel={panel} t={t} onRetry={() => { void controller.refreshObservation() }} />
    </div>
  )
}

/** Configuration area: lanes, priorities, and recovery over the bound scope. */
function ConfigArea({ scope, config, panel, t }: {
  scope: SchedulerSettingsScope
  config: SettingsScopeSnapshot<SchedulerSettings>
  panel: SchedulerPanelState
  t: Translate
}): ReactNode {
  const headingId = useId()
  if (config.status === 'loading') return <p className={styles['meta']}>{t('loading')}</p>
  if (config.status === 'unavailable') {
    return (
      <section aria-labelledby={headingId}>
        <h3 id={headingId} className={styles['blockTitle']}>{t('configTitle')}</h3>
        <p className={styles['notice']}>{t('pluginNotLoaded')}</p>
      </section>
    )
  }
  const settings = config.value
  const writable = config.writable
  const rows = configRows(panel.providers, settings)
  /* v8 ignore next -- an error status always carries text; the fallback satisfies the nullable type */
  const directoryErrorText = panel.directory === 'error' ? `${t('directoryLoadFailed')}: ${panel.directoryError ?? ''}` : null
  return (
    <section aria-labelledby={headingId} aria-busy={panel.directory === 'loading'}>
      <h3 id={headingId} className={styles['blockTitle']}>{t('configTitle')}</h3>
      {!writable ? <p className={styles['notice']}>{t('readOnly')}</p> : null}
      {directoryErrorText === null ? null : <p className={styles['error']}>{directoryErrorText}</p>}
      <table className={styles['table']}>
        <caption className={styles['tableCaption']}>{t('lanesHeading')}</caption>
        <thead className={styles['visuallyHidden']}>
          <tr>
            <th scope="col">{t('colProvider')}</th>
            <th scope="col">{t('colEnabled')}</th>
            <th scope="col">{t('colLimit')}</th>
          </tr>
        </thead>
        <tbody className={styles['tableBody']}>
          {rows.map((row) => {
            const lane = effectiveLane(settings, row.providerId)
            return (
              <tr key={row.providerId} className={styles['laneRow']}>
                <th scope="row" className={styles['laneNameCell']}>
                  <span className={styles['laneName']}>{row.displayName}</span>
                  <span className={styles['laneId']}>{row.providerId}</span>
                </th>
                <td className={styles['laneCell']}>
                  <input
                    type="checkbox"
                    className={styles['checkbox']}
                    checked={lane.enabled}
                    disabled={!writable}
                    aria-label={t('laneEnabledLabel', { provider: row.displayName })}
                    onChange={(event) => {
                      void scope.set('lanes', nextLanes(settings, row.providerId, { enabled: event.currentTarget.checked }))
                    }}
                  />
                </td>
                <td className={styles['laneCell']}>
                  <NumberField
                    label={t('laneLimitLabel', { provider: row.displayName })}
                    value={lane.maxConcurrency === UNLIMITED_CONCURRENCY ? undefined : lane.maxConcurrency}
                    min={1}
                    allowEmpty
                    placeholder={t('concurrencyPlaceholder')}
                    invalidText={t('concurrencyInvalid')}
                    disabled={!writable}
                    external={lane.maxConcurrency === UNLIMITED_CONCURRENCY ? undefined : lane.maxConcurrency}
                    onCommit={(value) => {
                      void scope.set('lanes', nextLanes(settings, row.providerId,
                        value === undefined ? { maxConcurrency: 'unlimited' } : { maxConcurrency: value }))
                    }}
                  />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <p className={styles['meta']}>{t('lanesIntro')}</p>
      <h4 className={styles['subTitle']}>{t('prioritiesHeading')}</h4>
      <div className={styles['fieldGrid']}>
        {SCHEDULER_PURPOSES.map(purpose => (
          <PurposeSelect
            key={purpose}
            purpose={purpose}
            settings={settings}
            writable={writable}
            scope={scope}
            t={t}
          />
        ))}
      </div>
      <p className={styles['meta']}>{t('prioritiesIntro')}</p>
      <h4 className={styles['subTitle']}>{t('recoveryHeading')}</h4>
      <div className={styles['fieldGrid']}>
        <NumberField
          label={t('initialCooldownLabel')}
          showLabel
          value={settings?.recovery.initialCooldownMs}
          external={settings?.recovery.initialCooldownMs}
          min={MIN_INITIAL_COOLDOWN_MS}
          allowEmpty={false}
          invalidText={t('recoveryInvalidInitial')}
          disabled={!writable}
          onCommit={(value) => {
            /* v8 ignore next -- the field commits only valid numbers over a ready scope; both guards are type narrowing only */
            if (settings === undefined || value === undefined) return
            void scope.set('recovery', {
              initialCooldownMs: value,
              maxCooldownMs: settings.recovery.maxCooldownMs,
            })
          }}
        />
        <NumberField
          label={t('maxCooldownLabel')}
          showLabel
          value={settings?.recovery.maxCooldownMs}
          external={settings?.recovery.maxCooldownMs}
          min={MIN_MAX_COOLDOWN_MS}
          allowEmpty={false}
          invalidText={t('recoveryInvalidMax')}
          disabled={!writable}
          onCommit={(value) => {
            /* v8 ignore next -- the field commits only valid numbers over a ready scope; both guards are type narrowing only */
            if (settings === undefined || value === undefined) return
            void scope.set('recovery', {
              initialCooldownMs: settings.recovery.initialCooldownMs,
              maxCooldownMs: value,
            })
          }}
        />
      </div>
    </section>
  )
}

const PURPOSE_LABEL_KEYS = {
  conversation: 'purposeConversation',
  compaction: 'purposeCompaction',
  'session-title': 'purposeSessionTitle',
} as const satisfies Record<SchedulerPurpose, SchedulerLocaleKey>

/** One purpose's priority select, writing the whole `priorityByPurpose` map. */
function PurposeSelect({ purpose, settings, writable, scope, t }: {
  purpose: SchedulerPurpose
  settings: SchedulerSettings | undefined
  writable: boolean
  scope: SchedulerSettingsScope
  t: Translate
}): ReactNode {
  const label = t(PURPOSE_LABEL_KEYS[purpose])
  /* v8 ignore next -- the P1 fallback satisfies the nullable type; the grid renders only over a ready scope, whose value always stands */
  const current = settings?.priorityByPurpose[purpose] ?? 'P1'
  return (
    <label className={styles['field']}>
      <span className={styles['fieldLabel']}>{label}</span>
      <select
        className={`${styles['input']} ${styles['selectInput']}`}
        value={current}
        disabled={!writable || settings === undefined}
        onChange={(event) => {
          /* v8 ignore next -- the select is disabled while no section stands, so the guard is type narrowing only */
          if (settings === undefined) return
          void scope.set('priorityByPurpose', {
            ...settings.priorityByPurpose,
            [purpose]: event.currentTarget.value,
          })
        }}
      >
        {SCHEDULER_PRIORITY_CLASSES.map(clazz => <option key={clazz} value={clazz}>{clazz}</option>)}
      </select>
    </label>
  )
}

/**
 * Whole-number field with a local draft: nothing is written until the field
 * holds a valid value and the user commits it (blur or Enter). An empty field
 * commits `undefined` only where {@link allowEmpty} permits it, standing for
 * the field's unlimited meaning at the call site.
 */
function NumberField({ label, showLabel, value, external, min, allowEmpty, placeholder, invalidText, disabled, onCommit }: {
  /** Accessible name; also the visible label when {@link showLabel} is set. */
  label: string
  /** Whether the label renders as a visible caption above the field. */
  showLabel?: boolean
  /** Draft seed: the field's current committed value, undefined renders empty. */
  value: number | undefined
  /** Latest committed external value; a change away from the draft reseeds it. */
  external: number | undefined
  /** Inclusive minimum a committed value must satisfy. */
  min: number
  /** Whether an empty field is a committable value. */
  allowEmpty: boolean
  /** Field placeholder; omitted where the current value or label already says it. */
  placeholder?: string
  invalidText: string
  disabled: boolean
  onCommit: (value: number | undefined) => void
}): ReactNode {
  const [draft, setDraft] = useState(() => value === undefined ? '' : String(value))
  const [invalid, setInvalid] = useState(false)
  // A committed write (here or in another tab) moves the external value; the
  // draft follows it so the field never argues with the accepted section. An
  // unlimited lane carries no external number — the field stays empty, which
  // is its spelling of unlimited.
  useEffect(() => {
    setDraft(external === undefined ? '' : String(external))
    setInvalid(false)
  }, [external])
  const commit = (): void => {
    const text = draft.trim()
    if (text === '') {
      if (allowEmpty) {
        setInvalid(false)
        onCommit(undefined)
        return
      }
      setInvalid(true)
      return
    }
    const parsed = Number(text)
    if (!Number.isInteger(parsed) || parsed < min) {
      setInvalid(true)
      return
    }
    setInvalid(false)
    onCommit(parsed)
  }
  return (
    <span className={showLabel === true ? styles['field'] : styles['numberField']}>
      {showLabel === true ? <span className={styles['fieldLabel']}>{label}</span> : null}
      <input
        type="text"
        inputMode="numeric"
        className={`${styles['input']} ${styles['numberInput']}`}
        value={draft}
        placeholder={placeholder}
        disabled={disabled}
        aria-label={label}
        aria-invalid={invalid || undefined}
        onChange={(event) => { setDraft(event.currentTarget.value) }}
        onBlur={commit}
        onKeyDown={(event) => { if (event.key === 'Enter') commit() }}
      />
      {invalid
        ? <span className={styles['error']} role="alert">{invalidText}</span>
        : null}
    </span>
  )
}
