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
// Type-only: resolves the agentDefaultModel / agentPresets / sessions /
// workspaceRegistry Context service declarations this module calls.
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-session'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
// Type-only: resolves the sessionQuery Context service declaration the
// persisted-session probe calls.
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-settings'
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


/**
 * The member-discipline instructions prepended to every delivered brief.
 *
 * Carried in the message, not a system-prompt section, because a preset's
 * persona may mark the assembled prompt complete (`complete: true`) and
 * silently drop every later section — the smoke run proved exactly that with
 * the minimal preset. A message preamble reaches the model under any preset.
 */
const DUTY_PREAMBLE = [
  '[IM bridge duty — you are the InfiniteMission member named in the brief.]',
  'Only the newest brief is current; earlier briefs in your history are',
  'finished business. Work each brief inside this workspace with the `im` CLI.',
  'Submitting IS the deliverable: close every round by actually running',
  '`im mission submit <member> <mission> --revision N --outcome <o>',
  '--reason <text>` with the revision and a permitted outcome from the brief.',
  'A turn that ends without that child process has delivered nothing, and',
  'prose that merely announces an outcome is a false report. Read and write',
  'documents with `im mission doc` and attach the receipts they minted.',
  'Never run `im join` or `im receive`: the bridge owns your membership and',
  'listening, and joining again would fork your identity with a suffixed id.',
  'Never register, wait, or hold stations: the next brief arrives in this',
  'same session when the mission moves on.',
].join('\n')
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
 * Whether persistence holds a session with this id.
 *
 * The live SessionStore only contains sessions created or restored in this
 * process, so probing it says nothing across a bridge restart; the
 * observation reader reads the durable record instead. The lease is
 * caller-owned, so it is released the moment the header answers the question.
 * @param ctx - runtime context with `sessionQuery`.
 * @param sessionId - the deterministic bridge session id.
 * @returns true when persistence holds the session.
 */
async function sessionExistsOnDisk(ctx: Context, sessionId: SessionId): Promise<boolean> {
  try {
    const observation = await ctx.sessionQuery.observeSession(sessionId)
    observation[Symbol.dispose]?.()
    return true
  } catch (error: unknown) {
    if (error instanceof SessionQueryError && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
      return false
    }
    throw error
  }
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
      // The mount installs the preset-scoped model fallback (logged header,
      // then the preset's authored model chain, then the host default), so a
      // bridged agent always carries a provider/model without bridge help.
      await ctx.agentPresets.mount(agentCtx, presetId)
    }
    const persisted = await sessionExistsOnDisk(ctx, sessionId)
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
    content: [{ type: 'text', text: `${DUTY_PREAMBLE}\n\n${opening}` }],
    source: { kind: 'im-bridge', workspace: workspacePath, missionId },
  }))
  return agent
}
