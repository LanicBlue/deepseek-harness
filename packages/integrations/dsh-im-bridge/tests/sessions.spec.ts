import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { bridgeSessionId, deliverBrief, installModelFallback } from '../src/sessions.ts'

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

/** A workspace-grade temp directory every meta.cwd accepts. */
async function tempWorkspace(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'dsh-im-bridge-'))
}

/** One runtime context with the real SessionStore and stubbed agent/preset/workspace services. */
interface StubRuntime {
  readonly ctx: Context
  readonly followup: ReturnType<typeof vi.fn>
  readonly created: ReturnType<typeof vi.fn>
  readonly resumed: ReturnType<typeof vi.fn>
  readonly mounted: ReturnType<typeof vi.fn>
  readonly attached: ReturnType<typeof vi.fn>
  readonly workspacePath: string
}

async function stubRuntime(liveAgent: boolean, persistedOnDisk = false): Promise<StubRuntime> {
  const ctx = new Context()
  context = ctx
  const followup = vi.fn()
  const created = vi.fn()
  const resumed = vi.fn()
  const mounted = vi.fn()
  const attached = vi.fn()
  const workspacePath = await tempWorkspace()
  const fakeAgent = { followup } as unknown as Agent
  await ctx.plugin(SessionStore)
  ctx.provide('agents', {
    get: () => liveAgent ? fakeAgent : undefined,
    create: created,
    resume: resumed,
  } as never)
  ctx.provide('agentPresets', { mount: mounted } as never)
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'stub-provider', model: 'stub-model' }),
  } as never)
  ctx.provide('workspaceRegistry', {
    create: async (path: string) => ({ path, attachSession: attached }),
  } as never)
  // The persisted probe reads persistence through sessionQuery, not the
  // in-memory store: resolvable observation = on disk, NOT_FOUND = absent.
  ctx.provide('sessionQuery', {
    observeSession: async (id: SessionId) => {
      if (!persistedOnDisk) {
        throw new SessionQueryError(`session "${id}" not found`, 'SESSION_QUERY_SESSION_NOT_FOUND')
      }
      return { [Symbol.dispose]: () => {} }
    },
  } as never)
  return { ctx, followup, created, resumed, mounted, attached, workspacePath }
}

describe('deliverBrief', () => {
  it('queues the charter into a live agent without creating or resuming', async () => {
    const runtime = await stubRuntime(true)
    const sessionId = bridgeSessionId(runtime.workspacePath, 'plan')
    const agent = await deliverBrief(runtime.ctx, {
      workspacePath: runtime.workspacePath,
      presetId: 'plan',
      sessionId,
      missionId: 'ms_x',
      opening: '[mission ms_x] rendered charter',
    })
    expect(agent).toBeDefined()
    expect(runtime.followup).toHaveBeenCalledTimes(1)
    expect(runtime.created).not.toHaveBeenCalled()
    expect(runtime.resumed).not.toHaveBeenCalled()
  })

  it('spawns through agents.create with workspace cwd, preset, mounted setup, and the charter opening', async () => {
    const runtime = await stubRuntime(false)
    const sessionId = bridgeSessionId(runtime.workspacePath, 'plan')
    const handle = { agent: { followup: runtime.followup }, dispose: async () => {} }
    runtime.created.mockResolvedValue(handle)
    await deliverBrief(runtime.ctx, {
      workspacePath: runtime.workspacePath,
      presetId: 'plan',
      sessionId,
      missionId: 'ms_x',
      opening: '[mission ms_x] rendered charter',
    })

    expect(runtime.created).toHaveBeenCalledTimes(1)
    const options = runtime.created.mock.calls[0]![0] as {
      sessionId: SessionId
      meta: { cwd: string; agentPreset: string }
      setup: (agentCtx: unknown) => Promise<void>
    }
    expect(options.sessionId).toBe(sessionId)
    expect(options.meta.cwd).toBe(runtime.workspacePath)
    expect(options.meta.agentPreset).toBe('plan')
    // setup composes the agent: the preset mount plus the model fallback.
    const agentCtx = new Context()
    await options.setup(agentCtx)
    expect(runtime.mounted).toHaveBeenCalledWith(agentCtx, 'plan')

    expect(runtime.attached).toHaveBeenCalledWith(sessionId)
    expect(runtime.followup).toHaveBeenCalledTimes(1)
    const message = runtime.followup.mock.calls[0]![0] as {
      content: readonly { type: string; text: string }[]
      source: { kind: string; workspace: string; missionId: string }
    }
    expect(message.content[0]!.text).toContain('[IM bridge duty')
    expect(message.content[0]!.text).toContain('im mission submit')
    expect(message.content[0]!.text.endsWith('[mission ms_x] rendered charter')).toBe(true)
    expect(message.source.kind).toBe('im-bridge')
    expect(message.source.workspace).toBe(runtime.workspacePath)
    expect(message.source.missionId).toBe('ms_x')
  })

  it('adopts a persisted-but-not-live session through agents.resume', async () => {
    // Persistence — not the live store — decides the path: an empty
    // in-memory store with the session on disk still resumes.
    const runtime = await stubRuntime(false, true)
    const sessionId = bridgeSessionId(runtime.workspacePath, 'plan')
    runtime.resumed.mockResolvedValue({ agent: { followup: runtime.followup }, dispose: async () => {} })
    await deliverBrief(runtime.ctx, {
      workspacePath: runtime.workspacePath,
      presetId: 'plan',
      sessionId,
      missionId: 'ms_x',
      opening: 'brief',
    })
    expect(runtime.resumed).toHaveBeenCalledTimes(1)
    expect(runtime.created).not.toHaveBeenCalled()
    expect(runtime.followup).toHaveBeenCalledTimes(1)
  })

  it('a deterministic id per (workspace, preset): same pair reuses, different pairs differ', () => {
    const first = bridgeSessionId('/w/a', 'plan')
    expect(bridgeSessionId('/w/a', 'plan')).toBe(first)
    expect(bridgeSessionId('/w/a', 'build').toString()).not.toBe(first.toString())
    expect(bridgeSessionId('/w/b', 'plan').toString()).not.toBe(first.toString())
    expect(first.toString()).toMatch(/^im-[0-9a-f]+-plan$/)
  })
})

describe('shared-store visibility', () => {
  it('a store create is enumerable through ctx.sessions.list()', async () => {
    // The agent factory creates sessions through this same store in a real
    // profile (shared `dshHomePath('sessions')` root), so enumerability here
    // is the visibility contract bridge sessions rely on.
    const ctx = new Context()
    context = ctx
    await ctx.plugin(SessionStore)
    const cwd = await tempWorkspace()
    const sessionId = bridgeSessionId(cwd, 'plan')
    ctx.sessions.create(sessionId, { meta: { cwd } })
    expect(ctx.sessions.list().map(session => session.id)).toContain(sessionId)
  })
})

describe('installModelFallback', () => {
  /** Capture the agent/request listener a fresh scoped context registered. */
  async function capturedListener(
    header: {
      config: { provider: string; model: string; reasoningEffort?: string }
      adapterDefaults?: { reasoningEffort?: boolean }
    } | undefined,
  ): Promise<(payload: unknown, next: () => Promise<unknown>) => Promise<unknown>> {
    const ctx = new Context()
    context = ctx
    Object.assign(ctx, { agent: { session: { requestHeader: () => header } } } as never)
    const calls: Array<[string, (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>]> = []
    const original = ctx.on.bind(ctx)
    vi.spyOn(ctx, 'on').mockImplementation(((name: string, listener: never) => {
      if (name === 'agent/request') calls.push([name, listener as never])
      return original(name as never, listener)
    }) as never)
    installModelFallback(ctx as never, { provider: 'default-p', model: 'default-m', reasoningEffort: ReasoningEffortId('high') })
    expect(calls).toHaveLength(1)
    return calls[0]![1]
  }

  it('fills an empty seed with the default model selection', async () => {
    const listener = await capturedListener(undefined)
    const filled = await listener({}, async () => ({ provider: '', model: '' }))
    expect(filled).toEqual({ provider: 'default-p', model: 'default-m', reasoningEffort: 'high' })
  })

  it('passes through a config another listener already resolved', async () => {
    const listener = await capturedListener(undefined)
    const resolved = { provider: 'picked-p', model: 'picked-m', reasoningEffort: 'low' as const }
    await expect(listener({}, async () => ({ ...resolved }))).resolves.toEqual(resolved)
  })

  it('restores the logged request header after a restart instead of the default', async () => {
    const listener = await capturedListener({
      config: { provider: 'switched-p', model: 'switched-m', reasoningEffort: 'medium' },
      adapterDefaults: { reasoningEffort: false },
    })
    const filled = await listener({}, async () => ({ provider: '', model: '', reasoningEffort: 'high' }))
    expect(filled).toEqual({ provider: 'switched-p', model: 'switched-m', reasoningEffort: 'medium' })
  })
})
