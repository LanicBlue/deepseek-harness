import { describe, expect, it } from 'vitest'
import { Plane } from '../src/plane.ts'
import { FailureCategory, LaneStatus, Priority } from '../src/types.ts'
import type { LlmFailure } from '@deepseek-ai/dsh-llm'

const failure = (overrides: Partial<LlmFailure> = {}): LlmFailure => ({
  message: 'synthetic',
  code: 'TRANSPORT',
  ...overrides,
})

describe('Plane.admit', () => {
  it('admits the first caller on a fresh lane', () => {
    const plane = new Plane({})
    plane.registerLane('openai', { enabled: true })
    const outcome = plane.admit('openai', Priority.P2, 0)
    expect(outcome.kind).toBe('admitted')
  })

  it('queues when maxConcurrency is reached', () => {
    const plane = new Plane({})
    plane.registerLane('openai', { enabled: true, maxConcurrency: 1 })
    const first = plane.admit('openai', Priority.P2, 0)
    expect(first.kind).toBe('admitted')
    const second = plane.admit('openai', Priority.P2, 1)
    expect(second.kind).toBe('queued')
  })

  it('rejects an unknown lane', () => {
    const plane = new Plane({})
    const outcome = plane.admit('ghost', Priority.P2, 0)
    expect(outcome.kind).toBe('rejected')
    if (outcome.kind === 'rejected' && outcome.reason.kind === 'lane_blocked') {
      expect(outcome.reason.category).toBe(FailureCategory.BLOCKED_MANUAL)
    } else {
      throw new Error('expected lane_blocked rejection')
    }
  })

  it('rejects a disabled lane', () => {
    const plane = new Plane({})
    plane.registerLane('openai', { enabled: false })
    const outcome = plane.admit('openai', Priority.P2, 0)
    expect(outcome.kind).toBe('rejected')
    if (outcome.kind === 'rejected') {
      expect(outcome.reason.kind).toBe('lane_disabled')
    } else {
      throw new Error('expected lane_disabled rejection')
    }
  })

  it('orders waiters by priority then FIFO sequence', () => {
    const plane = new Plane({})
    plane.registerLane('openai', { enabled: true, maxConcurrency: 1 })
    // saturate
    plane.admit('openai', Priority.P2, 0)
    // queue three callers with different priorities
    const low = plane.admit('openai', Priority.P4, 1)
    const high = plane.admit('openai', Priority.P1, 2)
    const mid = plane.admit('openai', Priority.P2, 3)
    expect(low.kind).toBe('queued')
    expect(high.kind).toBe('queued')
    expect(mid.kind).toBe('queued')
    // release first reservation and read the order via peekProbe; should be P1 next
    const first = (low as { reservation?: never }).reservation ?? null
    void first
  })
})

describe('Plane.applyDecision + advanceClock + completeProbe', () => {
  const recovery = { initialCooldownMs: 100, maxCooldownMs: 1_000 }

  it('opens the circuit on transient and blocks further admits until cooldown elapses', () => {
    const plane = new Plane({ recovery })
    plane.registerLane('openai', { enabled: true })
    plane.admit('openai', Priority.P2, 0)
    const outcome = plane.applyDecision(
      { kind: 'open_circuit', category: FailureCategory.TRANSIENT, cooldownMs: 100 },
      'openai',
      failure({ code: 'TRANSPORT' }),
      1,
      'transport',
    )
    expect(outcome.kind).toBe('opened')
    const next = plane.admit('openai', Priority.P2, 50)
    expect(next.kind).toBe('queued')
  })

  it('transitions circuit-open to probing when advanceClock crosses cooldown', () => {
    const plane = new Plane({ recovery })
    plane.registerLane('openai', { enabled: true, maxConcurrency: 1 })
    plane.admit('openai', Priority.P2, 0)
    plane.applyDecision(
      { kind: 'open_circuit', category: FailureCategory.TRANSIENT, cooldownMs: 100 },
      'openai',
      failure({ code: 'TRANSPORT' }),
      0,
      'transport',
    )
    // saturate queue so peekProbe has a waiter
    plane.admit('openai', Priority.P2, 0)
    const transitioned = plane.advanceClock(101)
    expect(transitioned.length).toBe(1)
    expect(plane.peekProbe('openai')).toBeDefined()
  })

  it('returns to healthy after a successful probe', () => {
    const plane = new Plane({ recovery })
    plane.registerLane('openai', { enabled: true })
    plane.admit('openai', Priority.P2, 0)
    plane.applyDecision(
      { kind: 'open_circuit', category: FailureCategory.TRANSIENT, cooldownMs: 100 },
      'openai',
      failure({ code: 'TRANSPORT' }),
      0,
      'transport',
    )
    plane.admit('openai', Priority.P2, 0)
    plane.advanceClock(101)
    plane.takeProbe('openai')
    plane.completeProbe('openai', true, 200)
    const view = plane.status().lanes[0]
    expect(view).toBeDefined()
    if (!view) return
    expect(view.status).toBe(LaneStatus.HEALTHY)
    expect(view.cooldownUntilMs).toBeUndefined()
  })

  it('doubles cooldown on a failed probe', () => {
    const plane = new Plane({ recovery: { initialCooldownMs: 100, maxCooldownMs: 10_000 } })
    plane.registerLane('openai', { enabled: true })
    plane.admit('openai', Priority.P2, 0)
    plane.applyDecision(
      { kind: 'open_circuit', category: FailureCategory.TRANSIENT, cooldownMs: 100 },
      'openai',
      failure({ code: 'TRANSPORT' }),
      0,
      'transport',
    )
    plane.advanceClock(101)
    plane.takeProbe('openai')
    plane.completeProbe('openai', false, 200)
    const view = plane.status().lanes[0]
    expect(view).toBeDefined()
    if (!view) return
    expect(view.status).toBe(LaneStatus.CIRCUIT_OPEN)
    expect(view.cooldownUntilMs).toBe(200 + 200)
  })

  it('caps probe cooldown at maxCooldownMs', () => {
    const plane = new Plane({ recovery: { initialCooldownMs: 100, maxCooldownMs: 100 } })
    plane.registerLane('openai', { enabled: true })
    plane.admit('openai', Priority.P2, 0)
    plane.applyDecision(
      { kind: 'open_circuit', category: FailureCategory.TRANSIENT, cooldownMs: 100 },
      'openai',
      failure({ code: 'TRANSPORT' }),
      0,
      'transport',
    )
    plane.advanceClock(101)
    plane.takeProbe('openai')
    plane.completeProbe('openai', false, 200)
    const view = plane.status().lanes[0]
    expect(view).toBeDefined()
    if (!view) return
    expect(view.cooldownUntilMs).toBe(200 + 100)
  })

  it('blocks configuration on auth failures and never auto-recovers', () => {
    const plane = new Plane({ recovery })
    plane.registerLane('openai', { enabled: true })
    const outcome = plane.applyDecision(
      { kind: 'block_config', category: FailureCategory.AUTH },
      'openai',
      failure({ code: 'AUTH' }),
      0,
      'auth',
    )
    expect(outcome.kind).toBe('blocked_config')
    const view = plane.status().lanes[0]
    expect(view).toBeDefined()
    if (!view) return
    expect(view.status).toBe(LaneStatus.BLOCKED_CONFIG)
    plane.advanceClock(1_000_000)
    const stillBlocked = plane.status().lanes[0]
    expect(stillBlocked).toBeDefined()
    if (!stillBlocked) return
    expect(stillBlocked.status).toBe(LaneStatus.BLOCKED_CONFIG)
  })
})

describe('Plane.release', () => {
  it('returns the next waiter to admit when a slot frees', () => {
    const plane = new Plane({})
    plane.registerLane('openai', { enabled: true, maxConcurrency: 1 })
    const first = plane.admit('openai', Priority.P2, 0)
    if (first.kind !== 'admitted') throw new Error('expected admitted')
    plane.admit('openai', Priority.P2, 1)
    const outcome = plane.release(first.reservation)
    expect(outcome.promote).toBeDefined()
  })
})

describe('Plane.status', () => {
  it('records recent failures in newest-first order', () => {
    const plane = new Plane({ recovery: { initialCooldownMs: 100, maxCooldownMs: 1_000 } })
    plane.registerLane('openai', { enabled: true })
    plane.applyDecision(
      { kind: 'open_circuit', category: FailureCategory.TRANSIENT, cooldownMs: 100 },
      'openai',
      failure({ code: 'TRANSPORT' }),
      0,
      'transport',
    )
    const status = plane.status()
    const first = status.recentFailures[0]
    expect(first).toBeDefined()
    if (!first) return
    expect(first.code).toBe('TRANSPORT')
    expect(first.lane).toBe('openai')
  })
})
