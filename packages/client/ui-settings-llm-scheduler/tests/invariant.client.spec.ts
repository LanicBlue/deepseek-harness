import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as SchedulerInvariant from '@deepseek-ai/dsh-client-ui-settings-llm-scheduler/invariant'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { SchedulerSection } from '../src/client/SchedulerSection.tsx'

describe('invariant companion', () => {
  it('registers under the package name with an empty installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(SchedulerInvariant).await()).resolves.toBeDefined()
  })

  it('node-half apply is a no-op host placeholder', async () => {
    const { apply } = await import('@deepseek-ai/dsh-client-ui-settings-llm-scheduler')
    apply()
    expect(true).toBe(true) // reaching here without throw is the contract
  })

  it('renders null until the shell injects the section dependencies', () => {
    expect(SchedulerSection({})).toBeNull()
  })
})
