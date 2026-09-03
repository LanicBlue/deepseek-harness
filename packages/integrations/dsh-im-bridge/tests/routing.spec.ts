import { describe, expect, it } from 'vitest'
import { parseReceiveStdout } from '../src/notes.ts'
import { route } from '../src/routing.ts'

const ARRIVAL_STDOUT = [
  '[station build] [ms_7f3fec7b3eac218b3fd5e5b68c42e1b4] plan → build (round: goal-ready)',
  '  → Run: im mission show ms_7f3fec7b3eac218b3fd5e5b68c42e1b4 --for dsh-build (then im missions dsh-build)',
  '  → After processing, run `im receive dsh-build --wait` to continue listening.',
].join('\n')

describe('parseReceiveStdout', () => {
  it('parses a station arrival and drops guidance lines', () => {
    expect(parseReceiveStdout(ARRIVAL_STDOUT)).toEqual([
      { kind: 'arrival', station: 'build', missionId: 'ms_7f3fec7b3eac218b3fd5e5b68c42e1b4' },
    ])
  })

  it('parses the membership-end farewell, mission-ended notices, and the idle line', () => {
    expect(parseReceiveStdout(
      '[membership] you are no longer an active member (removed or archived) — stopping the listener.',
    )).toEqual([{ kind: 'membership-end' }])
    expect(parseReceiveStdout(
      '[from workspace] [ms_7f3fec7b] mission ended: completed (accept)',
    )).toEqual([{ kind: 'mission-ended', missionId: 'ms_7f3fec7b' }])
    expect(parseReceiveStdout('No new messages (timed out after 21600s).')).toEqual([{ kind: 'timeout' }])
  })

  it('yields nothing for empty or unrecognized output', () => {
    expect(parseReceiveStdout('')).toEqual([])
    expect(parseReceiveStdout('some future im format\n')).toEqual([])
  })

  it('member ids do not leak in as station arrivals from other shapes', () => {
    // The dsh-plan / dsh-plan-2 distinction lives in roster parsing; here an
    // unrelated bracketed line must not parse as an arrival.
    expect(parseReceiveStdout('[from dsh-plan] [membership] your tier was set to manage.')).toEqual([])
  })
})

describe('route decision table', () => {
  const missionId = 'ms_7f3fec7b3eac218b3fd5e5b68c42e1b4'
  const arrival = { kind: 'arrival', station: 'build', missionId } as const
  const alwaysLive = () => true
  const neverLive = () => false

  it('first arrival with no binding spawns', () => {
    expect(route({ ...arrival }, undefined, alwaysLive)).toEqual({ action: 'spawn', missionId })
  })

  it('second arrival with a live binding injects into the same session', () => {
    expect(route({ ...arrival }, 'im-abc-plan', alwaysLive))
      .toEqual({ action: 'inject', sessionId: 'im-abc-plan', missionId })
  })

  it('a binding whose session is gone (archived/deleted) spawns instead of injecting', () => {
    expect(route({ ...arrival }, 'im-abc-plan', neverLive)).toEqual({ action: 'spawn', missionId })
  })

  it('mission-ended and timeout notes never touch sessions', () => {
    expect(route({ kind: 'mission-ended', missionId }, 'im-abc-plan', alwaysLive))
      .toEqual({ action: 'none' })
    expect(route({ kind: 'timeout' }, 'im-abc-plan', alwaysLive)).toEqual({ action: 'none' })
  })

  it('membership end stops the loop regardless of any binding', () => {
    expect(route({ kind: 'membership-end' }, 'im-abc-plan', alwaysLive))
      .toEqual({ action: 'stop-loop' })
    expect(route({ kind: 'membership-end' }, undefined, neverLive)).toEqual({ action: 'stop-loop' })
  })
})
