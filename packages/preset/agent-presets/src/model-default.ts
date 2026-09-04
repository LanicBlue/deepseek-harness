/**
 * Preset-scoped default model resolution.
 *
 * A preset's metadata may publish a default model plus fallbacks. The chain
 * only ever fills an EMPTY request config: a UI model pick and the session's
 * logged request header both outrank it, so a preset default applies exactly
 * when nothing else chose — the first turn of a fresh session, or a resumed
 * agent whose turn no driver selection covers. Each authored candidate is
 * consulted only while its provider route is actually registered; an absent
 * registry (no `llm` service in scope) trusts the authored order as written,
 * and the host's global default model answers after the whole chain misses.
 * @module @deepseek-ai/dsh-agent-presets/model-default
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
// Type-only: resolves the agent / agentDefaultModel / llm Context service
// declarations this module reads through optional lookups.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { ReasoningEffortId, type LlmCallConfig, type LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { AgentPreset } from './preset.ts'

/** Authoritative selection order for one authored model block. */
function asSelection(block: {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}): ModelSelection {
  return {
    provider: block.provider,
    model: block.model,
    ...block.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: ReasoningEffortId(block.reasoningEffort) },
  }
}

/**
 * The preset's authored model chain: the default first, then its fallbacks.
 * @param preset - the preset whose metadata published the chain.
 * @returns every usable block in authored order, possibly empty.
 */
export function presetModelCandidates(preset: AgentPreset): ModelSelection[] {
  return [
    ...preset.model === undefined ? [] : [preset.model],
    ...preset.modelFallbacks ?? [],
  ].map(block => asSelection(block))
}

/**
 * The first candidate whose provider route is registered.
 *
 * A registry that is absent (no `llm` service in this scope) cannot veto
 * anything, so the first authored candidate answers as written.
 * @param candidates - authored chain in order.
 * @param llm - the adapter registry, when one is in scope.
 * @returns the first usable candidate, or undefined when none is.
 */
export function firstUsableCandidate(
  candidates: readonly ModelSelection[],
  llm: LlmRuntime | undefined,
): ModelSelection | undefined {
  if (llm === undefined) return candidates[0]
  const registered = new Set(llm.listProviders().map(provider => provider.id))
  return candidates.find(candidate => registered.has(candidate.provider))
}

/**
 * Fill the request waterfall's model config for an agent composed from one
 * preset.
 *
 * Deferred-to when another listener already resolved a provider/model (the
 * session controller's selection when the UI drives the turn) and fills
 * otherwise: from the session's logged request header first (a model
 * switched in the UI survives a restart), then the preset's usable chain,
 * then the host's global default model.
 * @param agentCtx - the agent's scoped context, from the mount.
 * @param preset - the preset being mounted.
 */
export function installPresetModelFallback(agentCtx: Context, preset: AgentPreset): void {
  const candidates = presetModelCandidates(preset)
  agentCtx.on('agent/request', async (_payload, next): Promise<LlmCallConfig> => {
    const resolved = await next()
    if (resolved.provider !== '' && resolved.model !== '') return resolved
    const agent = agentCtx.agent
    if (agent === undefined) {
      throw new Error('agent-presets: model fallback has no scoped Agent')
    }
    const logged = agent.session.requestHeader()
    if (logged !== undefined) {
      // An effort the adapter defaulted is not a conversation choice.
      const { reasoningEffort: _inherited, ...rest } = resolved
      return {
        ...rest,
        provider: logged.config.provider,
        model: logged.config.model,
        ...logged.config.reasoningEffort === undefined
          || logged.adapterDefaults?.reasoningEffort === true
          ? {}
          : { reasoningEffort: logged.config.reasoningEffort as ReasoningEffortId },
      }
    }
    const fallback = firstUsableCandidate(candidates, agentCtx.get('llm'))
      ?? agentCtx.get('agentDefaultModel')?.currentSelection()
    if (fallback === undefined) return resolved
    const { reasoningEffort: _inherited, ...rest } = resolved
    return { ...rest, ...fallback }
  })
}
