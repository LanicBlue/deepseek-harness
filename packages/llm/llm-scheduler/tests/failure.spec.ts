import { describe, expect, it } from 'vitest'
import { classifyFailure, decideFailure, redactFailureMessage } from '../src/failure.ts'
import { FailureCategory } from '../src/types.ts'
import type { LlmFailure } from '@deepseek-ai/dsh-llm'

const failure = (overrides: Partial<LlmFailure> = {}): LlmFailure => ({
  message: 'synthetic',
  code: 'TRANSPORT',
  ...overrides,
})

describe('classifyFailure', () => {
  it('maps transient codes to TRANSIENT', () => {
    expect(classifyFailure(failure({ code: 'TRANSPORT' }))).toBe(FailureCategory.TRANSIENT)
    expect(classifyFailure(failure({ code: 'TIMEOUT' }))).toBe(FailureCategory.TRANSIENT)
    expect(classifyFailure(failure({ code: 'SERVER' }))).toBe(FailureCategory.TRANSIENT)
    expect(classifyFailure(failure({ code: 'PI_AI_ERROR' }))).toBe(FailureCategory.TRANSIENT)
  })

  it('maps rate-limited codes to RATE_LIMITED', () => {
    expect(classifyFailure(failure({ code: 'RATE_LIMIT' }))).toBe(FailureCategory.RATE_LIMITED)
    expect(classifyFailure(failure({ code: 'QUOTA' }))).toBe(FailureCategory.RATE_LIMITED)
  })

  it('maps auth codes to AUTH', () => {
    expect(classifyFailure(failure({ code: 'AUTH' }))).toBe(FailureCategory.AUTH)
    expect(classifyFailure(failure({ code: 'INVALID_CREDENTIAL' }))).toBe(FailureCategory.AUTH)
  })

  it('maps per-call malformations to INVALID_CALL', () => {
    expect(classifyFailure(failure({ code: 'INVALID_REQUEST' }))).toBe(FailureCategory.INVALID_CALL)
    expect(classifyFailure(failure({ code: 'CONTEXT_WINDOW_EXCEEDED' }))).toBe(FailureCategory.INVALID_CALL)
  })

  it('maps empty response to EMPTY_RESPONSE', () => {
    expect(classifyFailure(failure({ code: 'EMPTY_RESPONSE' }))).toBe(FailureCategory.EMPTY_RESPONSE)
  })

  it('falls through to INVALID_CALL on unknown codes', () => {
    expect(classifyFailure(failure({ code: 'NO_ADAPTER' }))).toBe(FailureCategory.INVALID_CALL)
    expect(classifyFailure(failure({ code: 'SOMETHING_NEW' }))).toBe(FailureCategory.INVALID_CALL)
  })
})

describe('decideFailure', () => {
  const recovery = { initialCooldownMs: 100, maxCooldownMs: 10_000 }
  const now = 1_000_000

  it('opens the circuit for transient failures using initialCooldownMs', () => {
    const decision = decideFailure(FailureCategory.TRANSIENT, failure({ code: 'TRANSPORT' }), recovery, now)
    expect(decision.kind).toBe('open_circuit')
    if (decision.kind === 'open_circuit') {
      expect(decision.cooldownMs).toBe(100)
      expect(decision.category).toBe(FailureCategory.TRANSIENT)
    }
  })

  it('caps transient cooldown at maxCooldownMs', () => {
    const decision = decideFailure(
      FailureCategory.TRANSIENT,
      failure({ code: 'TRANSPORT' }),
      { initialCooldownMs: 100, maxCooldownMs: 50 },
      now,
    )
    expect(decision.kind === 'open_circuit' && decision.cooldownMs).toBe(50)
  })

  it('uses providerRetryAfterMs when present', () => {
    const decision = decideFailure(
      FailureCategory.RATE_LIMITED,
      failure({ code: 'RATE_LIMIT', providerRetryAfterMs: 5_000 }),
      recovery,
      now,
    )
    expect(decision.kind === 'block_until_time' && decision.untilMs).toBe(now + 5_000)
  })

  it('falls back to initialCooldownMs when no providerRetryAfterMs', () => {
    const decision = decideFailure(FailureCategory.RATE_LIMITED, failure({ code: 'RATE_LIMIT' }), recovery, now)
    expect(decision.kind === 'block_until_time' && decision.untilMs).toBe(now + 100)
  })

  it('blocks configuration on auth failures', () => {
    const decision = decideFailure(FailureCategory.AUTH, failure({ code: 'AUTH' }), recovery, now)
    expect(decision.kind).toBe('block_config')
  })

  it('fails the single call on per-call malformations', () => {
    const decision = decideFailure(
      FailureCategory.INVALID_CALL,
      failure({ code: 'INVALID_REQUEST' }),
      recovery,
      now,
    )
    expect(decision.kind).toBe('fail_call')
    const emptyDecision = decideFailure(
      FailureCategory.EMPTY_RESPONSE,
      failure({ code: 'EMPTY_RESPONSE' }),
      recovery,
      now,
    )
    expect(emptyDecision.kind).toBe('fail_call')
  })
})

describe('redactFailureMessage', () => {
  it('trims whitespace', () => {
    expect(redactFailureMessage(failure({ message: '  oops  ' }))).toBe('oops')
  })

  it('clamps very long messages to 200 chars with ellipsis', () => {
    const long = 'x'.repeat(500)
    const redacted = redactFailureMessage(failure({ message: long }))
    expect(redacted.length).toBe(200)
    expect(redacted.endsWith('...')).toBe(true)
  })
})
