/**
 * Opening or reusing the DSH Session one (workspace, preset) pair works IM
 * missions in. Spawn follows the webhook-ingress recipe — canonical
 * Workspace, `agents.create` with `meta.cwd` and `meta.agentPreset`, preset
 * mounted in `setup` — except the session id is deterministic per
 * (workspace, preset) so a bridge restart adopts the persisted session via
 * `agents.resume` instead of forking a new one. The arrival's rendered
 * charter (`im mission show --for` stdout) is the opening message; later
 * arrivals inject into the live agent as follow-ups.
 * @module @deepseek-ai/dsh-im-bridge/sessions
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
// Type-only: resolves the agentPresets / sessions / workspaceRegistry
// Context service declarations this module calls.
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-workspace'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** A rendered IM mission brief delivered by the bridge. */
    'im-bridge': {
      readonly kind: 'im-bridge'
      /** Absolute path of the workspace the mission lives in. */
      readonly workspace: string
      /** The mission the brief renders. */
      readonly missionId: string
    }
  }
}

/** Prompt-section placement: after the persona, before plan policy. */
const DUTY_SECTION_ORDER = 300
/** Scoped section name for the bridge's member-discipline instructions. */
const DUTY_SECTION = 'im-bridge:duty'

/** The standing instructions every bridged session carries. */
const DUTY_SECTION_TEXT = [
  'You are an InfiniteMission member bridged from a DSH agent preset.',
  'Mission briefs arrive as messages containing the rendered station charter.',
  'Work each brief inside this workspace with the `im` CLI:',
  'read and write documents with `im mission doc`, submit rounds with',
  '`im mission submit` carrying the revision from the brief and a permitted',
  'outcome, and attach the receipts your documents minted.',
  'Never run `im join` or `im receive` — the bridge owns your membership and',
  'listening, and joining again would fork your identity with a suffixed id.',
  'Never register, wait, or hold stations: your station prompt is the work',
  'order, and the next brief arrives in this same session when the mission',
  'moves on.',
].join(' ')

/**
 * The deterministic session id one (workspace, preset) pair works in.
 *
 * Stable across bridge restarts (so the persisted session is adoptable) and
 * collision-free between pairs: the workspace slug is a digest, not the path,
 * because a path's punctuation is not a session-id-safe slug.
 * @param workspacePath - absolute IM workspace path.
 * @param presetId - the IM-enabled preset id.
 * @returns the branded session id for the pair.
 */
export function bridgeSessionId(workspacePath: string, presetId: string): SessionId {
  let digest = 0n
  for (const byte of new TextEncoder().encode(workspacePath)) {
    digest = (digest * 31n + BigInt(byte)) & 0xffff_ffff_ffffn
  }
  return brandString<SessionId>(`im-${digest.toString(16)}-${presetId}`)
}

/**
 * Deliver one mission brief into the pair's session, creating, resuming, or
 * reusing it as needed.
 *
 * A live agent is used as-is; a persisted-but-not-live session is resumed
 * with the same preset composition; anything else is created. Only the
 * creation path attaches the Session to its Workspace, and a pre-prompt
 * failure there disposes the unpublished agent rather than leaving a session
 * shell no brief ever reached.
 * @param ctx - runtime context with `agents`, `agentPresets`, `sessions`, `systemPrompt`, `workspaceRegistry`.
 * @param request - the pair's identity, the mission, and the rendered opening brief.
 * @param request.workspacePath - absolute IM workspace path (also the session cwd).
 * @param request.presetId - IM-enabled preset composing the agent.
 * @param request.sessionId - deterministic id from {@link bridgeSessionId}.
 * @param request.missionId - mission the brief renders.
 * @param request.opening - charter stdout to deliver as the opening message.
 * @param request.signal - creation-time cancellation.
 * @returns the agent the brief was queued into.
 */
export async function deliverBrief(
  ctx: Context,
  request: {
    readonly workspacePath: string
    readonly presetId: string
    readonly sessionId: SessionId
    readonly missionId: string
    readonly opening: string
    readonly signal?: AbortSignal
  },
): Promise<Agent> {
  const { workspacePath, presetId, sessionId, missionId, opening, signal } = request
  const live = ctx.agents.get(sessionId)
  let agent: Agent
  if (live !== undefined) {
    agent = live
  } else {
    const compose = async (agentCtx: Context): Promise<void> => {
      await ctx.agentPresets.mount(agentCtx, presetId)
      agentCtx.systemPrompt.section({
        name: DUTY_SECTION,
        order: DUTY_SECTION_ORDER,
        text: DUTY_SECTION_TEXT,
      })
    }
    const persisted = ctx.sessions.get(sessionId) !== undefined
    if (persisted) {
      agent = (await ctx.agents.resume({
        resumeSessionId: sessionId,
        ...signal === undefined ? {} : { signal },
        setup: compose,
      })).agent
    } else {
      const workspace = await ctx.workspaceRegistry.create(workspacePath)
      signal?.throwIfAborted()
      const handle = await ctx.agents.create({
        sessionId,
        ...signal === undefined ? {} : { signal },
        meta: { cwd: workspace.path, agentPreset: presetId },
        setup: compose,
      })
      try {
        await workspace.attachSession(sessionId)
      } catch (error: unknown) {
        try {
          await handle.dispose()
        } catch {
          // The original failure is the actionable one; a rollback that also
          // fails has nothing further to add to it.
        }
        throw error
      }
      agent = handle.agent
    }
  }
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: opening }],
    source: { kind: 'im-bridge', workspace: workspacePath, missionId },
  }))
  return agent
}
