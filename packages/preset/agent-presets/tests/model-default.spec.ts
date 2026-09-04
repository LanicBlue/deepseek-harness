import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentPreset } from '@deepseek-ai/dsh-agent-presets'
import { firstUsableCandidate, installPresetModelFallback, presetModelCandidates } from '@deepseek-ai/dsh-agent-presets'

let context: Context | undefined

afterEach(() => {
  context?.fiber.dispose()
  context = undefined
})

/** A preset carrying only the model fields the chain reads. */
function preset(model: AgentPreset['model'], modelFallbacks?: AgentPreset['modelFallbacks']): AgentPreset {
  return {
    id: 'fixture',
    trust: 'user',
    path: '/unused',
    ...(model === undefined ? {} : { model }),
    ...(modelFallbacks === undefined ? {} : { modelFallbacks }),
  } as AgentPreset
}

describe('presetModelCandidates', () => {
  it('orders the default before its fallbacks', () => {
    const chain = presetModelCandidates(preset(
      { provider: 'a', model: 'm1' },
      [{ provider: 'b', model: 'm2' }, { provider: 'c', model: 'm3' }],
    ))
    expect(chain.map(c => c.provider)).toEqual(['a', 'b', 'c'])
  })

  it('is empty for a preset that published nothing', () => {
    expect(presetModelCandidates(preset(undefined))).toEqual([])
  })
})

describe('firstUsableCandidate', () => {
  const chain = [
    { provider: 'a', model: 'm1' },
    { provider: 'b', model: 'm2' },
  ]

  it('trusts the authored order when no registry is in scope', () => {
    expect(firstUsableCandidate(chain, undefined)).toBe(chain[0])
  })

  it('skips candidates whose provider route is not registered', () => {
    const llm = { listProviders: () => [{ id: 'b', name: 'B' }] }
    expect(firstUsableCandidate(chain, llm as never)?.provider).toBe('b')
    expect(firstUsableCandidate(chain, { listProviders: () => [] } as never)).toBeUndefined()
  })
})

describe('installPresetModelFallback', () => {
  /** Capture the agent/request listener installed on a fresh context. */
  function capturedListener(
    setup: (ctx: Context) => void,
  ): (payload: unknown, next: () => Promise<unknown>) => Promise<unknown> {
    const ctx = new Context()
    context = ctx
    const calls: Array<(payload: unknown, next: () => Promise<unknown>) => Promise<unknown>> = []
    const original = ctx.on.bind(ctx)
    vi.spyOn(ctx, 'on').mockImplementation(((name: string, listener: never) => {
      if (name === 'agent/request') calls.push(listener as never)
      return original(name as never, listener)
    }) as never)
    setup(ctx)
    expect(calls).toHaveLength(1)
    return calls[0]!
  }

  it('fills an empty seed with the preset chain, then the host default', () => {
    const listener = capturedListener((ctx) => {
      ctx.provide('agentDefaultModel', {
        currentSelection: () => ({ provider: 'global', model: 'g1' }),
      } as never)
      Object.assign(ctx, { agent: { session: { requestHeader: () => undefined } } } as never)
      installPresetModelFallback(ctx, preset({ provider: 'p', model: 'm' }))
    })
    void expect(listener({}, async () => ({ provider: '', model: '' })))
      .resolves.toEqual({ provider: 'p', model: 'm' })
    // No preset chain at all: the global default answers.
    const bare = capturedListener((ctx) => {
      ctx.provide('agentDefaultModel', {
        currentSelection: () => ({ provider: 'global', model: 'g1' }),
      } as never)
      Object.assign(ctx, { agent: { session: { requestHeader: () => undefined } } } as never)
      installPresetModelFallback(ctx, preset(undefined))
    })
    void expect(bare({}, async () => ({ provider: '', model: '' })))
      .resolves.toEqual({ provider: 'global', model: 'g1' })
  })

  it('passes through a config another listener already resolved', () => {
    const resolved = { provider: 'picked', model: 'p1', reasoningEffort: 'low' as const }
    const listener = capturedListener((ctx) => {
      Object.assign(ctx, { agent: { session: { requestHeader: () => undefined } } } as never)
      installPresetModelFallback(ctx, preset({ provider: 'preset', model: 'm' }))
    })
    void expect(listener({}, async () => ({ ...resolved }))).resolves.toEqual(resolved)
  })

  it('restores the logged request header before any authored default', () => {
    const listener = capturedListener((ctx) => {
      Object.assign(ctx, {
        agent: {
          session: {
            requestHeader: () => ({
              config: { provider: 'switched', model: 's1', reasoningEffort: 'medium' },
              adapterDefaults: { reasoningEffort: false },
            }),
          },
        },
      } as never)
      installPresetModelFallback(ctx, preset({ provider: 'preset', model: 'm' }))
    })
    void expect(listener({}, async () => ({ provider: '', model: '' })))
      .resolves.toEqual({ provider: 'switched', model: 's1', reasoningEffort: 'medium' })
  })

  it('skips authored providers no registry vouches for', () => {
    const listener = capturedListener((ctx) => {
      ctx.provide('llm', {
        listProviders: () => [{ id: 'registered', name: 'R' }],
      } as never)
      Object.assign(ctx, { agent: { session: { requestHeader: () => undefined } } } as never)
      installPresetModelFallback(ctx, preset(
        { provider: 'absent', model: 'm1' },
        [{ provider: 'registered', model: 'm2' }],
      ))
    })
    void expect(listener({}, async () => ({ provider: '', model: '' })))
      .resolves.toEqual({ provider: 'registered', model: 'm2' })
  })
})
