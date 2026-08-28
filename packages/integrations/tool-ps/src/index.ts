/**
 * Model-facing read-only tools over the local Project Service (PS): the
 * project directory, one project's detail, its missions, and its attention
 * inbox. Endpoint and Bearer credential resolve per call from explicit
 * config, environment, or PS's consumer credential file (`{clientKey,
 * baseUrl}` — optional, since PS has a default port and a bootstrap window).
 * Row payloads are projected verbatim as JSON strings: PS owns the shapes,
 * these tools never guess fields beyond the identity columns. Every failure
 * maps to a teaching message naming the recovery step.
 *
 * @module @deepseek-ai/dsh-tool-ps
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { FIRST_PARTY_SECTION_ORDER } from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { PsClientError, PsRestClient, PS_DEFAULT_BASE_URL, PS_DEFAULT_TIMEOUT_MS, psFailureMessage } from './client.ts'

export {
  PsClientError, PsRestClient, PS_DEFAULT_BASE_URL, PS_DEFAULT_TIMEOUT_MS, psFailureMessage,
} from './client.ts'
export type { PsCredential } from './client.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-ps'

/** Services required before the tools can register. */
export const inject = ['tools', 'systemPrompt']

/** Plugin config — every field optional; `apply` fills env and file defaults. */
export interface Config {
  /** PS base URL. Defaults to `$PS_BASE_URL`, then the credential file, then `http://127.0.0.1:7600`. */
  baseUrl?: string
  /** Explicit Bearer key override; falls back to the credential file, then `$DSH_PS_API_KEY`. */
  apiKey?: string
  /** Consumer credential file (`{clientKey, baseUrl}`). Defaults to `~/.project-service/config/dsh.json`; optional. */
  credentialFile?: string
  /** Per-request timeout. Defaults to 10,000 ms. */
  timeoutMs?: number
}

export const Config: z<Config> = z.object({
  baseUrl: z.string(),
  apiKey: z.string(),
  credentialFile: z.string(),
  timeoutMs: z.number().step(1).min(100),
})

/**
 * Read the optional credential file. Unlike WK, absence is not an error (PS
 * has a default port and an unauthenticated bootstrap window); corruption
 * still fails loudly.
 * @param credentialFile - path to the JSON credential file.
 * @returns the pair, or `undefined` when the file does not exist.
 */
export async function readPsCredential(credentialFile: string): Promise<{ clientKey: string; baseUrl: string } | undefined> {
  let text: string
  try {
    text = await readFile(credentialFile, 'utf8')
  } catch {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    throw new PsClientError(`Project Service credential file at ${credentialFile} is not valid JSON.`, 'PS_CREDENTIAL_INVALID')
  }
  const clientKey = typeof parsed === 'object' && parsed !== null ? (parsed as { clientKey?: unknown }).clientKey : undefined
  const baseUrl = typeof parsed === 'object' && parsed !== null ? (parsed as { baseUrl?: unknown }).baseUrl : undefined
  if (typeof clientKey !== 'string' || clientKey.length === 0 || typeof baseUrl !== 'string' || baseUrl.length === 0) {
    throw new PsClientError(
      `Project Service credential file at ${credentialFile} must carry non-empty "clientKey" and "baseUrl" strings.`,
      'PS_CREDENTIAL_INVALID',
    )
  }
  return { clientKey, baseUrl }
}

/** Per-call endpoint facts resolved by `apply`. */
export interface PsCallContext {
  readonly baseUrl: string | undefined
  readonly credentialFile: string
  readonly apiKey: string | undefined
  readonly timeoutMs: number
}

/**
 * Run one PS call against the resolved endpoint, mapping every failure to a
 * teaching message before it reaches the model.
 * @param call - endpoint facts resolved by `apply`.
 * @param invoke - one client operation.
 * @returns the operation's payload.
 */
export async function withPs<T>(call: PsCallContext, invoke: (client: PsRestClient, baseUrl: string) => Promise<T>): Promise<T> {
  const credential = await readPsCredential(call.credentialFile)
  const baseUrl = call.baseUrl ?? credential?.baseUrl ?? PS_DEFAULT_BASE_URL
  const client = new PsRestClient({
    baseUrl,
    apiKey: call.apiKey ?? credential?.clientKey,
    timeoutMs: call.timeoutMs,
  })
  try {
    return await invoke(client, baseUrl)
  } catch (error) {
    throw new PsClientError(psFailureMessage(error, baseUrl), 'PS_TOOL_FAILURE')
  }
}

/** One listed PS row: identity columns when recognizable, payload verbatim. */
export interface PsRowView {
  readonly id: string
  readonly json: string
}

/**
 * Project one PS list row onto the model-facing view.
 * @param raw - one wire row.
 * @param idFields - field names tried in order for the identity column.
 * @returns the row view.
 */
export function psRowOf(raw: unknown, idFields: readonly string[]): PsRowView {
  const json = JSON.stringify(raw ?? null)
  if (raw === null || typeof raw !== 'object') return { id: '(row)', json }
  for (const field of idFields) {
    const value = (raw as Record<string, unknown>)[field]
    if (typeof value === 'string' && value.length > 0) return { id: value, json }
  }
  return { id: '(row)', json }
}

/** Present one read-only PS call as a generic card. */
function present(title: string, rawInput: string): GenericCallView {
  return { card: 'generic', title, kind: 'read', rawInput }
}

/** Register the four read-only PS tools and the prompt section. */
export function apply(ctx: Context, config: Config): void {
  const call: PsCallContext = {
    baseUrl: config.baseUrl ?? launchEnvironmentOf(ctx).get('PS_BASE_URL')?.value,
    credentialFile: config.credentialFile
      ?? join(homedir(), '.project-service', 'config', 'dsh.json'),
    apiKey: config.apiKey ?? launchEnvironmentOf(ctx).get('DSH_PS_API_KEY')?.value,
    timeoutMs: config.timeoutMs ?? PS_DEFAULT_TIMEOUT_MS,
  }

  ctx.systemPrompt.section({
    name: 'tool:ps',
    order: FIRST_PARTY_SECTION_ORDER.TOOL_PS,
    text: 'A local Project Service (PS) may own the project/work state for this workspace: the project directory, each project\'s missions, and its attention inbox. When a task references PS-owned state, read it with ps_projects, ps_project, ps_missions, and ps_inbox instead of guessing. These tools are read-only; acting on work (execute, ack, delegate) stays with the service\'s own consumers. When a PS tool reports the service as unreachable or unauthenticated, treat that as missing tooling and ask the user rather than assuming an empty project list.',
  })

  ctx.tools.register(defineTool({
    name: 'ps_projects',
    description: 'List the Project Service\'s projects. Each row carries the recognized identity column '
      + '(projectId) and the full record verbatim as JSON.',
    parameters: {},
    presentCall: () => present('List projects', ''),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          rows: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                json: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.rows.length === 0
          ? '(no projects)'
          : value.rows.map(row => `${row.id} — ${row.json}`).join('\n'),
      }],
    },
    async execute(_args, exec) {
      const result = await withPs(call, client => client.get('/project/v1/', exec.signal))
      const rows = Array.isArray(result) ? result.map(row => psRowOf(row, ['projectId', 'id'])) : []
      return { rows }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ps_project',
    description: 'Read one project\'s full record by projectId, verbatim as JSON.',
    parameters: {
      project_id: { type: 'string', required: true, description: 'projectId from ps_projects.' },
    },
    presentCall: args => present('Read project', String(args.project_id ?? '')),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          projectId: { type: 'string', required: true },
          json: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.json }],
    },
    async execute(args, exec) {
      const result = await withPs(call, client => client.get(`/project/v1/${encodeURIComponent(args.project_id)}`, exec.signal))
      const row = psRowOf(result, ['projectId', 'id'])
      return { projectId: row.id === '(row)' ? args.project_id : row.id, json: row.json }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ps_missions',
    description: 'List one project\'s missions (one-shot task contracts) with each record verbatim as JSON.',
    parameters: {
      project_id: { type: 'string', required: true, description: 'projectId from ps_projects.' },
    },
    presentCall: args => present('List missions', String(args.project_id ?? '')),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          rows: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                json: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.rows.length === 0
          ? '(no missions)'
          : value.rows.map(row => `${row.id} — ${row.json}`).join('\n'),
      }],
    },
    async execute(args, exec) {
      const result = await withPs(call, client => client.get(`/project/v1/${encodeURIComponent(args.project_id)}/missions`, exec.signal))
      const list = result !== undefined && typeof result === 'object' && !Array.isArray(result)
        ? ((result as { missions?: unknown }).missions ?? (result as { items?: unknown }).items ?? [])
        : result
      const rows = (Array.isArray(list) ? list : []).map(row => psRowOf(row, ['missionId', 'id']))
      return { rows }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ps_inbox',
    description: 'Read one project\'s attention inbox: claims waiting for acknowledgment, each verbatim as JSON.',
    parameters: {
      project_id: { type: 'string', required: true, description: 'projectId from ps_projects.' },
    },
    presentCall: args => present('Read attention inbox', String(args.project_id ?? '')),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          rows: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                json: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.rows.length === 0
          ? '(inbox empty)'
          : value.rows.map(row => `${row.id} — ${row.json}`).join('\n'),
      }],
    },
    async execute(args, exec) {
      const result = await withPs(call, client => client.get(`/project/v1/${encodeURIComponent(args.project_id)}/inbox`, exec.signal))
      const claims = result !== undefined && typeof result === 'object'
        ? ((result as { claims?: unknown; items?: unknown }).claims ?? (result as { items?: unknown }).items ?? result)
        : result
      const rows = Array.isArray(claims)
        ? claims.map(row => psRowOf(row, ['claimId', 'id']))
        : [psRowOf(claims, ['claimId', 'id'])]
      return { rows }
    },
  }))
}
