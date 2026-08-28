/**
 * Branded ids owned by the scheduler.
 *
 * @module @deepseek-ai/dsh-llm-scheduler/brand
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Stable identifier for one lane, assigned at lane registration. */
export type LaneId = Branded<'LlmSchedulerLaneId'>

/** Unique identifier for one admitted reservation. */
export type ReservationId = Branded<'LlmSchedulerReservationId'>

/** Cast a string into a {@link LaneId}. Construction only — comparison is plain string equality. */
export function laneId(value: string): LaneId {
  return value as LaneId
}

/** Cast a string into a {@link ReservationId}. Construction only. */
export function reservationId(value: string): ReservationId {
  return value as ReservationId
}
