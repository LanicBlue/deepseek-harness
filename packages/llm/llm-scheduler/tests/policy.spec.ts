import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Coordinator } from '../src/coordinator.ts'
import { Plane } from '../src/plane.ts'
import { MAX_RETARGET_HOPS, installStreamGate, type StreamGateConfig } from '../src/stream-gate.ts'
import type { DecideFacts, FailureDecision, RouteFacts } from '../src/types.ts'
import { FailureCategory, LaneStatus } from '../src/types.ts'

type RouteListener = (facts: RouteFacts) => string | undefined
type DecideListener = (facts: DecideFacts) => FailureDecision | undefined
type StreamListener = (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => AsyncIterable<StreamChunk>

interface Harness {
  ctx: Context
  plane: Plane
  coordinator: Coordinator
  providers: string[]
  warnings: unknown[][]
  onRoute(listener: RouteListener): void
  onDecide(listener: DecideListener): void
  dispatch(options: GenerateOptions): Promise<StreamChunk[]>
  dispose(): void
}

const DEFAULT_GATE_CONFIG: StreamGateConfig = {
  priorityByPurpose: {},
  recovery: { initialCooldownMs: 5_000, maxCooldownMs: 300_000 },
}

/**
 * Build the gate around hand-rolled event plumbing that mirrors the vendored
 * cordis semantics the gate relies on: `bail` stops at the first
 * non-null/non-false/non-undefined return, and waterfall `next()` hands the
 * same options object to the rest of the chain.
 */
function makeHarness(
  adapter: (call: number, options: GenerateOptions) => AsyncIterable<StreamChunk>,
  gateConfig: StreamGateConfig = DEFAULT_GATE_CONFIG,
): Harness {
  const plane = new Plane({})
  const coordinator = new Coordinator(plane)
  const streamListeners: StreamListener[] = []
  const routeListeners: RouteListener[] = []
  const decideListeners: DecideListener[] = []
  const warnings: unknown[][] = []
  const providers: string[] = []
  let calls = 0
  // Adapter-invocation-time recording + fresh chain per call, mirroring how
  // the real runtime resolves the adapter at the innermost waterfall step.
  const dispatch = (options: GenerateOptions): AsyncIterable<StreamChunk> => {
    const call = calls
    calls += 1
    const chain = [...streamListeners]
    const inner = (): AsyncIterable<StreamChunk> => {
      providers.push(options.provider)
      return adapter(call, options)
    }
    const next = (): AsyncIterable<StreamChunk> => {
      const cb = chain.shift() ?? inner
      return cb(options, next)
    }
    return next()
  }
  const ctx = {
    on: (name: string, listener: StreamListener) => {
      if (name === 'llm/stream') streamListeners.push(listener)
      return () => true
    },
    bail: (name: string, facts: RouteFacts | DecideFacts) => {
      const listeners = name === 'llm/scheduler-route' ? routeListeners : decideListeners
      for (const listener of listeners) {
        const result = listener(facts as RouteFacts & DecideFacts)
        if (result !== null && result !== false && result !== undefined) return result
      }
      return undefined
    },
    logger: { warn: (...args: unknown[]) => { warnings.push(args) } },
    llm: { stream: (options: GenerateOptions) => dispatch(options) },
  } as unknown as Context
  const disposeGate = installStreamGate(ctx, coordinator, plane, gateConfig)
  return {
    ctx,
    plane,
    coordinator,
    providers,
    warnings,
    onRoute: (listener) => { routeListeners.push(listener) },
    onDecide: (listener) => { decideListeners.push(listener) },
    dispatch: async (options) => {
      const out: StreamChunk[] = []
      for await (const chunk of dispatch(options)) out.push(chunk)
      return out
    },
    dispose: disposeGate,
  }
}

function makeOptions(provider: string): GenerateOptions {
  return { provider, model: 'test-model', messages: [] }
}

const stopFinish: StreamChunk = { type: 'finish', reason: { kind: 'stop' } }

function errorFinish(code: string): StreamChunk {
  return { type: 'finish', reason: { kind: 'error', failure: { message: `boom ${code}`, code } } }
}

async function* single(chunk: StreamChunk): AsyncIterable<StreamChunk> {
  yield chunk
}

const disposers: Array<() => void> = []

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.()
})

describe('policy events', () => {
  it('releases on a clean stop finish with no listeners', async () => {
    const harness = makeHarness(() => single(stopFinish))
    disposers.push(harness.dispose)
    const chunks = await harness.dispatch(makeOptions('openai'))
    expect(chunks).toEqual([stopFinish])
    expect(harness.plane.status().totalInFlight).toBe(0)
    expect(harness.plane.status().recentFailures).toEqual([])
  })

  it('routes a call onto another lane and the adapter sees the rewrite', async () => {
    const facts: RouteFacts[] = []
    const harness = makeHarness(() => single(stopFinish))
    disposers.push(harness.dispose)
    harness.onRoute((f) => {
      facts.push(f)
      return f.provider === 'openai' ? 'backup' : undefined
    })
    const options = makeOptions('openai')
    await harness.dispatch(options)
    expect(facts.map(f => f.provider)).toEqual(['openai'])
    expect(facts[0]?.model).toBe('test-model')
    // In-place rewrite: caller, reservation, and physical dispatch agree.
    expect(options.provider).toBe('backup')
    expect(harness.providers).toEqual(['backup'])
    expect(harness.plane.status().lanes.map(l => l.key)).toContain('backup')
    expect(harness.plane.status().totalInFlight).toBe(0)
  })

  it('keeps the call provider when the route listener throws', async () => {
    const harness = makeHarness(() => single(stopFinish))
    disposers.push(harness.dispose)
    harness.onRoute(() => { throw new Error('policy bug') })
    const options = makeOptions('openai')
    const chunks = await harness.dispatch(options)
    expect(chunks).toEqual([stopFinish])
    expect(options.provider).toBe('openai')
    expect(harness.providers).toEqual(['openai'])
    expect(harness.warnings.length).toBe(1)
  })

  it('executes a decide retarget: source circuit opens, call re-dispatches on the target', async () => {
    const harness = makeHarness(call =>
      call === 0 ? single(errorFinish('TRANSPORT')) : single(stopFinish))
    disposers.push(harness.dispose)
    const seen: DecideFacts[] = []
    harness.onDecide((facts) => {
      seen.push(facts)
      return {
        kind: 'retarget',
        category: FailureCategory.TRANSIENT,
        to: 'backup',
        openCircuitMs: 60_000,
      }
    })
    const chunks = await harness.dispatch(makeOptions('openai'))
    // The failed attempt's error finish never surfaces; the consumer sees the
    // target lane's clean finish.
    expect(chunks).toEqual([stopFinish])
    expect(harness.providers).toEqual(['openai', 'backup'])
    expect(seen.map(f => f.failure.lane)).toEqual(['openai'])
    expect(seen[0]?.failure.category).toBe(FailureCategory.TRANSIENT)
    const source = harness.plane.status().lanes.find(l => l.key === 'openai')
    expect(source?.status).toBe(LaneStatus.CIRCUIT_OPEN)
    expect(harness.plane.status().totalInFlight).toBe(0)
  })

  it('caps retarget hops and surfaces the error once the budget is spent', async () => {
    const harness = makeHarness(() => single(errorFinish('TRANSPORT')))
    disposers.push(harness.dispose)
    // openai -> backup -> openai -> budget spent on the third dispatch.
    harness.onDecide(facts => ({
      kind: 'retarget',
      category: FailureCategory.TRANSIENT,
      to: facts.failure.lane === 'openai' ? 'backup' : 'openai',
    }))
    const chunks = await harness.dispatch(makeOptions('openai'))
    expect(harness.providers).toEqual(['openai', 'backup', 'openai'])
    expect(chunks).toEqual([errorFinish('TRANSPORT')])
    expect(harness.plane.status().totalInFlight).toBe(0)
    expect(MAX_RETARGET_HOPS).toBe(2)
  })

  it('treats a retarget onto the same lane as a plain failed call', async () => {
    const harness = makeHarness(() => single(errorFinish('TRANSPORT')))
    disposers.push(harness.dispose)
    harness.onDecide(facts => ({
      kind: 'retarget',
      category: FailureCategory.TRANSIENT,
      to: facts.failure.lane,
    }))
    const chunks = await harness.dispatch(makeOptions('openai'))
    expect(harness.providers).toEqual(['openai'])
    expect(chunks).toEqual([errorFinish('TRANSPORT')])
    // fail_call semantics: the failure is recorded, lane health untouched.
    const lane = harness.plane.status().lanes.find(l => l.key === 'openai')
    expect(lane?.status).toBe(LaneStatus.HEALTHY)
    expect(harness.plane.status().recentFailures.length).toBe(1)
  })

  it('lets a decide listener override the built-in disposition', async () => {
    const harness = makeHarness(() => single(errorFinish('TRANSPORT')))
    disposers.push(harness.dispose)
    harness.onDecide(facts => ({
      kind: 'open_circuit',
      category: facts.failure.category,
      cooldownMs: 12_345,
    }))
    const before = Date.now()
    await harness.dispatch(makeOptions('openai'))
    const after = Date.now()
    const lane = harness.plane.status().lanes.find(l => l.key === 'openai')
    expect(lane?.status).toBe(LaneStatus.CIRCUIT_OPEN)
    expect(lane?.cooldownUntilMs).toBeGreaterThanOrEqual(before + 12_345)
    expect(lane?.cooldownUntilMs).toBeLessThanOrEqual(after + 12_345)
  })

  it('falls back to the built-in table when a decide listener throws', async () => {
    const harness = makeHarness(() => single(errorFinish('TRANSPORT')))
    disposers.push(harness.dispose)
    harness.onDecide(() => { throw new Error('policy bug') })
    const chunks = await harness.dispatch(makeOptions('openai'))
    expect(chunks).toEqual([errorFinish('TRANSPORT')])
    expect(harness.warnings.length).toBe(1)
    // Default TRANSIENT table: open_circuit at the configured initial cooldown.
    const lane = harness.plane.status().lanes.find(l => l.key === 'openai')
    expect(lane?.status).toBe(LaneStatus.CIRCUIT_OPEN)
    expect(lane?.cooldownUntilMs).toBeGreaterThan(Date.now())
  })
})
