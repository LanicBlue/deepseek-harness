import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ImBridge } from '../src/index.ts'
import type { ImRunner, ReceiveCycle } from '../src/im-cli.ts'
import { rosterHasMember } from '../src/im-cli.ts'

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

/**
 * Scripted IM surface: the roster is plain state, joins are recorded, and
 * receive cycles resolve only when the test pushes them (or the loop's
 * signal aborts the wait), so loop timing is fully test-driven.
 */
class ScriptedRunner implements ImRunner {
  rosterLines: string[] = []
  readonly joins: string[] = []
  receiveCalls = 0
  private readonly waiting: { resolve: (cycle: ReceiveCycle) => void; signal: AbortSignal }[] = []
  private readonly queued: string[] = []

  roster(): Promise<string> {
    return Promise.resolve(this.rosterLines.join('\n'))
  }

  join(_workspace: string, memberId: string): Promise<void> {
    this.joins.push(memberId)
    this.rosterLines.push(`  ${memberId} — active (1s ago) [execute]`)
    return Promise.resolve()
  }

  receive(_workspace: string, _memberId: string, signal: AbortSignal): Promise<ReceiveCycle> {
    this.receiveCalls += 1
    const pushed = this.queued.shift()
    if (pushed !== undefined && !signal.aborted) return Promise.resolve({ stdout: pushed, code: 0 })
    return new Promise<ReceiveCycle>((resolve) => {
      const entry = { resolve, signal }
      this.waiting.push(entry)
      const aborted = () => {
        const index = this.waiting.indexOf(entry)
        if (index >= 0) this.waiting.splice(index, 1)
        resolve({ stdout: '', code: -1 })
      }
      signal.addEventListener('abort', aborted, { once: true })
    })
  }

  missionShow(): Promise<string> {
    return Promise.resolve('[mission ms_x] rendered charter')
  }

  /** Hand the running loops one receive cycle's stdout. */
  pushCycle(stdout: string): void {
    const entry = this.waiting.shift()
    if (entry === undefined) {
      this.queued.push(stdout)
      return
    }
    entry.resolve({ stdout, code: 0 })
  }

  /** Cycles currently parked inside an active receive call. */
  pendingCount(): number {
    return this.waiting.length
  }
}

/** Mutable preset roster the scripted bridge reconciles against. */
interface StubPreset {
  readonly id: string
  readonly im: boolean
}

/** One context with the settings/preset/agent surfaces stubbed for the bridge. */
async function bridgeRuntime(presets: readonly StubPreset[]) {
  const ctx = new Context()
  context = ctx
  const workspacePath = await mkdtemp(join(tmpdir(), 'dsh-im-bridge-ws-'))
  const settingsState = { workspaces: [workspacePath] }
  ctx.provide('settings', {
    register: () => ({
      get: () => settingsState,
      watch: () => () => {},
      update: async () => {},
    }),
  } as never)
  const followup = vi.fn()
  const followupAgent = { followup }
  ctx.provide('agents', {
    get: () => followupAgent,
    create: async () => ({ agent: followupAgent, dispose: async () => {} }),
    resume: async () => ({ agent: followupAgent, dispose: async () => {} }),
  } as never)
  ctx.provide('agentPresets', {
    list: async () => presets.map(preset => ({
      id: preset.id,
      trust: 'user' as const,
      path: `/presets/${preset.id}/agent.cordis.yml`,
      ...preset.im ? { im: true } : {},
    })),
    mount: async () => {},
  } as never)
  ctx.provide('systemPrompt', { section: () => () => {} } as never)
  ctx.provide('sessions', { get: () => undefined, list: () => [] } as never)
  const workspaceRegistryStub = { create: async (path: string) => ({ path, attachSession: () => {} }) }
  ctx.provide('workspaceRegistry', workspaceRegistryStub as never)
  const runner = new ScriptedRunner()
  const bridge = new ImBridge(ctx, {
    imBin: 'im',
    memberPrefix: 'dsh',
    receiveTimeoutSec: 600,
    rescanSec: 3_600,
  }, runner)
  return { ctx, bridge, runner, settingsState, workspacePath, followup }
}

describe('member reconcile', () => {
  it('an im-flagged preset joins dsh-<preset> in each configured workspace; an unflagged one does not', async () => {
    const { bridge, runner } = await bridgeRuntime([
      { id: 'plan', im: true },
      { id: 'review', im: false },
    ])
    await bridge.settle()
    expect(runner.joins).toEqual(['dsh-plan'])
    expect(bridge.loopCount()).toBe(1)
  })

  it('an existing exact member id never triggers a join (no auto-suffix risk)', async () => {
    const { bridge, runner } = await bridgeRuntime([{ id: 'plan', im: true }])
    runner.rosterLines = [
      '  boss — active (1s ago) [manage]',
      '  dsh-plan — active (1s ago) [execute]',
      '  dsh-plan-2 — active (1s ago) [execute]',
    ]
    await bridge.settle()
    expect(runner.joins).toEqual([])
    expect(bridge.loopCount()).toBe(1)
  })

  it('a join that lands on a suffixed id starts no loop and warns', async () => {
    const { bridge, runner } = await bridgeRuntime([{ id: 'plan', im: true }])
    // The roster keeps showing only the suffixed twin after the join.
    runner.rosterLines = ['  dsh-plan-2 — active (1s ago) [execute]']
    const originalJoin = runner.join.bind(runner)
    runner.join = (_ws: string, memberId: string) => {
      void originalJoin(_ws, memberId)
      // Undo the roster line the base stub adds: the id stays suffixed-only.
      runner.rosterLines = runner.rosterLines.filter(line => !line.startsWith(`  ${memberId} — `))
      return Promise.resolve()
    }
    await bridge.settle()
    expect(runner.joins).toEqual(['dsh-plan'])
    expect(bridge.loopCount()).toBe(0)
  })

  it('roster matching is row-anchored: dsh-plan does not match dsh-plan-2', () => {
    const roster = '  dsh-plan-2 — active (1s ago) [execute]'
    expect(rosterHasMember(roster, 'dsh-plan')).toBe(false)
    expect(rosterHasMember(roster, 'dsh-plan-2')).toBe(true)
  })

  it('a dropped preset loses its loop and keeps its member', async () => {
    const { ctx, bridge, runner } = await bridgeRuntime([{ id: 'plan', im: true }])
    await bridge.settle()
    expect(bridge.loopCount()).toBe(1)
    const rosterBefore = [...runner.rosterLines]
    await ctx.fiber.dispose()
    context = undefined
    expect(bridge.loopCount()).toBe(0)
    expect(runner.rosterLines).toEqual(rosterBefore)
    expect(runner.pendingCount()).toBe(0)
  })
})

describe('receive loop routing', () => {
  it('an arrival spawns a session whose opening is the rendered brief', async () => {
    const { bridge, runner, followup } = await bridgeRuntime([{ id: 'plan', im: true }])
    await bridge.settle()
    runner.pushCycle('[station build] [ms_x] plan → build (round: goal-ready)')
    await vi.waitFor(() => { expect(followup).toHaveBeenCalledTimes(1) })
    const message = followup.mock.calls[0]![0] as { content: readonly { text: string }[] }
    expect(message.content[0]!.text).toContain('rendered charter')
  })

  it('a second arrival for the live pair reuses the same session', async () => {
    const { bridge, runner, followup } = await bridgeRuntime([{ id: 'plan', im: true }])
    await bridge.settle()
    runner.pushCycle('[station build] [ms_x] plan → build (round: goal-ready)')
    await vi.waitFor(() => { expect(followup).toHaveBeenCalledTimes(1) })
    runner.pushCycle('[station build] [ms_y] plan → build (round: goal-ready)')
    await vi.waitFor(() => { expect(followup).toHaveBeenCalledTimes(2) })
    // Both briefs went to the one live agent the stub registry serves.
    expect(followup).toHaveBeenCalledTimes(2)
  })

  it('membership end stops the loop: no further receive cycles hang', async () => {
    const { bridge, runner } = await bridgeRuntime([{ id: 'plan', im: true }])
    await bridge.settle()
    runner.pushCycle(
      '[membership] you are no longer an active member (removed or archived) — stopping the listener.',
    )
    await vi.waitFor(() => { expect(bridge.loopCount()).toBe(0) })
    const callsAfterStop = runner.receiveCalls
    runner.pushCycle('[station build] [ms_x] plan → build (round: goal-ready)')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(runner.receiveCalls).toBe(callsAfterStop)
    expect(runner.pendingCount()).toBe(0)
  })
})
