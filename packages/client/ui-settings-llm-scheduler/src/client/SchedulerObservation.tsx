/**
 * Read-only scheduler runtime area: lane table and recent failures, rendered
 * from the observation snapshot the panel store holds. Every row value is a
 * wire fact; only chrome copy goes through the locale.
 */

import { useId, type ReactNode } from 'react'
import { StateDot, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  type SchedulerFailureView,
  type SchedulerLaneView,
  type SchedulerPanelState,
  type SchedulerStatusView,
} from './store.ts'
import type { SchedulerLocaleKey } from './locales.ts'
import type { Translate } from './SchedulerSection.tsx'
import styles from './SchedulerSection.module.css'

/** Visual tone of an availability badge, resolved through a `data-tone` rule. */
export type AvailabilityTone = 'healthy' | 'degraded' | 'probing' | 'circuitOpen' | 'blocked'
/** Visual tone of a failure-category badge. */
export type FailureTone = 'hard' | 'transient' | 'plain'

const AVAILABILITY_TONES: Readonly<Record<string, AvailabilityTone>> = {
  healthy: 'healthy',
  probing: 'probing',
  circuit_open: 'circuitOpen',
  blocked_config: 'blocked',
}

const AVAILABILITY_KEYS: Readonly<Record<string, SchedulerLocaleKey>> = {
  healthy: 'availabilityHealthy',
  probing: 'availabilityProbing',
  circuit_open: 'availabilityCircuitOpen',
  blocked_config: 'availabilityBlockedConfig',
}

const FAILURE_TONES: Readonly<Record<string, FailureTone>> = {
  auth: 'hard',
  blocked_manual: 'hard',
  invalid_call: 'hard',
  transient: 'transient',
  rate_limited: 'transient',
  empty_response: 'transient',
}

const FAILURE_KEYS: Readonly<Record<string, SchedulerLocaleKey>> = {
  transient: 'categoryTransport',
  rate_limited: 'categoryRateWindow',
  auth: 'categoryAuth',
  blocked_manual: 'availabilityBlockedManual',
  invalid_call: 'categoryInvalidRequest',
  empty_response: 'categoryEmptyResponse',
}

const CALL_STATE_KEYS: Readonly<Record<string, SchedulerLocaleKey>> = {
  runnable: 'callStateRunnable',
  in_flight: 'callStateInFlight',
  awaiting_disposition: 'callStateAwaitingDisposition',
  awaiting_owner_acceptance: 'callStateAwaitingOwnerAcceptance',
  suspended: 'callStateSuspended',
}

const AVAILABILITY_DOTS: Record<AvailabilityTone, StateDotState> = {
  healthy: 'done',
  degraded: 'warning',
  probing: 'ongoing',
  circuitOpen: 'error',
  blocked: 'error',
}

/** Localized availability label; unknown values render verbatim. */
export function availabilityLabel(availability: string, t: Translate): string {
  const key = AVAILABILITY_KEYS[availability]
  return key === undefined ? availability : t(key)
}

/** Localized call-state label, verbatim for an unknown state. */
export function callStateLabel(state: string, t: Translate): string {
  const key = CALL_STATE_KEYS[state]
  return key === undefined ? state : t(key)
}

/** Localized failure-category label, verbatim for an unknown category. */
export function categoryLabel(category: string, t: Translate): string {
  const key = FAILURE_KEYS[category]
  return key === undefined ? category : t(key)
}

/** Waiting-time text in at most two adjacent units. */
export function formatAge(ageMs: number, t: Translate): string {
  if (ageMs < 1_000) return t('durationMs', { ms: Math.floor(ageMs) })
  const total = Math.floor(ageMs / 1_000)
  const seconds = total % 60
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3_600)
  if (hours > 0) return t('durationHours', { hours, minutes })
  if (minutes > 0) return t('durationMinutes', { minutes, seconds })
  return t('durationSeconds', { seconds })
}

/** Render the runtime observation area. */
export function SchedulerObservation({ panel, t, onRetry }: {
  panel: SchedulerPanelState
  t: Translate
  onRetry: () => void
}): ReactNode {
  const headingId = useId()
  const errorText = panel.observation === 'error' ? `${t('obsLoadFailed')}: ${panel.observationError ?? ''}` : null
  return (
    <section aria-labelledby={headingId}>
      <h3 id={headingId} className={styles['blockTitle']}>{t('observationHeading')}</h3>
      {panel.observation === 'loading' && panel.view === undefined
        ? <p className={styles['meta']}>{t('loading')}</p>
        : null}
      {errorText === null ? null : (
        <div className={styles['failureBlock']}>
          <p className={styles['error']} role="alert">{errorText}</p>
          <button type="button" className={styles['secondaryButton']} onClick={onRetry}>
            {t('retry')}
          </button>
        </div>
      )}
      {panel.view === undefined ? null : <RuntimeView view={panel.view} t={t} />}
    </section>
  )
}

function RuntimeView({ view, t }: { view: SchedulerStatusView; t: Translate }): ReactNode {
  return (
    <div className={styles['observation']}>
      <p className={styles['meta']}>
        {`${t('colActive')}: ${String(view.totalInFlight)} · ${t('colRunnable')}: ${String(view.totalQueued)}`}
      </p>
      <table className={styles['table']}>
        <caption className={styles['tableCaption']}>{t('obsLanesHeading')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('colProvider')}</th>
            <th scope="col">{t('colStatus')}</th>
            <th scope="col">{t('colActive')}</th>
            <th scope="col">{t('colRunnable')}</th>
            <th scope="col">{t('colLimit')}</th>
          </tr>
        </thead>
        <tbody className={styles['tableBody']}>
          {view.lanes.map(lane => <LaneRow key={lane.key} lane={lane} t={t} />)}
        </tbody>
      </table>
      <table className={styles['table']}>
        <caption className={styles['tableCaption']}>{t('obsFailuresHeading')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('colTime')}</th>
            <th scope="col">{t('colProvider')}</th>
            <th scope="col">{t('colCategory')}</th>
            <th scope="col">{t('colMessage')}</th>
          </tr>
        </thead>
        <tbody className={styles['tableBody']}>
          {view.recentFailures.length === 0
            ? (
              <tr>
                <td colSpan={4} className={styles['emptyCell']}>{t('failuresEmpty')}</td>
              </tr>
            )
            : view.recentFailures.map((failure, index) => (
              <FailureRow key={`${String(failure.atMs)}-${String(index)}`} failure={failure} t={t} />
            ))}
        </tbody>
      </table>
    </div>
  )
}

function LaneRow({ lane, t }: { lane: SchedulerLaneView; t: Translate }): ReactNode {
  const tone = AVAILABILITY_TONES[lane.status]
  return (
    <tr>
      <th scope="row" className={styles['cellStrong']}>
        <span className={styles['laneName']}>{lane.key}</span>
      </th>
      <td>
        <span className={styles['badge']} data-tone={tone === undefined ? 'unknown' : tone}>
          {tone === undefined
            ? null
            : <StateDot state={AVAILABILITY_DOTS[tone]} size={8} />}
          {availabilityLabel(lane.status, t)}
        </span>
        {!lane.enabled ? <span className={styles['tag']}>{t('laneDisabled')}</span> : null}
      </td>
      <td className={styles['cellNumber']}>{String(lane.inFlight)}</td>
      <td className={styles['cellNumber']}>{String(lane.queued)}</td>
      <td className={styles['cellNumber']}>
        {lane.maxConcurrency === undefined ? t('unlimited') : String(lane.maxConcurrency)}
      </td>
    </tr>
  )
}

function FailureRow({ failure, t }: { failure: SchedulerFailureView; t: Translate }): ReactNode {
  const tone = FAILURE_TONES[failure.category]
  return (
    <tr>
      <td className={styles['cellNumber']}>
        {new Date(failure.atMs).toLocaleTimeString(undefined, {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })}
      </td>
      <td>
        <span className={styles['laneName']}>{failure.lane}</span>
      </td>
      <td>
        <span className={styles['badge']} data-tone={tone === undefined ? 'plain' : tone}>
          {categoryLabel(failure.category, t)}
        </span>
      </td>
      <td>{failure.message}</td>
    </tr>
  )
}
