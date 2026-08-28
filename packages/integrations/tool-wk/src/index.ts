/**
 * Model-facing read-only tools over the local Wiki Server (WK): full-text
 * wiki search, node reads, the root directory, and indexed project-tree
 * source search/read. Endpoint and Bearer credential resolve per call from
 * explicit config or WK's consumer credential file (`{clientKey, baseUrl}`),
 * so a restarted WK (rotated dynamic port) is picked up without a remount.
 * Every failure maps to a teaching message naming the recovery step.
 *
 * @module @deepseek-ai/dsh-tool-wk
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
import { WkClientError, WkContractClient, WK_DEFAULT_TIMEOUT_MS, wkFailureMessage, type WkCredential } from './client.ts'
import { nodeViewOf, rootViewOf, searchHitOf, str } from './types.ts'
import type { WkNodeView, WkRootView, WkSearchHitView, WkSourceHitView, WkSourceReadView } from './types.ts'

export { WkClientError, WkContractClient, WK_CONSUMER_ID, WK_DEFAULT_TIMEOUT_MS, wkFailureMessage } from './client.ts'
export type { WkCredential } from './client.ts'
export {
  int, nodeViewOf, rootViewOf, searchHitOf, str,
} from './types.ts'
export type {
  WkNodeView, WkRootView, WkSearchHitView, WkSourceHitView, WkSourceReadView,
} from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-wk'

/** Services required before the tools can register. */
export const inject = ['tools', 'systemPrompt']

/** Maximum nodes one `wk_read_nodes` call may fetch (bounds fan-out cost). */
export const WK_MAX_READ_NODES = 5

/** Plugin config — every field optional; `apply` fills env and file defaults. */
export interface Config {
  /** WK data root holding `config/`. Defaults to `~/.wiki-service`, then `$WIKI_SERVER_DATA_ROOT`. */
  dataRoot?: string
  /** Consumer credential file (`{clientKey, baseUrl}`). Defaults to `<dataRoot>/config/dsh.json`. */
  credentialFile?: string
  /** Explicit base URL override; skips credential-file discovery for the address. */
  baseUrl?: string
  /** Explicit Bearer key override; falls back to the credential file, then `$DSH_WK_API_KEY`. */
  apiKey?: string
  /** Per-request timeout. Defaults to 10,000 ms. */
  timeoutMs?: number
}

export const Config: z<Config> = z.object({
  dataRoot: z.string(),
  credentialFile: z.string(),
  baseUrl: z.string(),
  apiKey: z.string(),
  timeoutMs: z.number().step(1).min(100),
})

/**
 *  Read the credential file, mapping absence and corruption to teaching errors.
 * @param credentialFile - path to the JSON credential file.
 * @returns the parsed `{clientKey, baseUrl}` pair.
*/
export async function readWkCredential(credentialFile: string): Promise<WkCredential> {
  let text: string
  try {
    text = await readFile(credentialFile, 'utf8')
  } catch {
    throw new WkClientError(
      `WK credential file not found at ${credentialFile}. Mint a DSH client key on the wiki server `
      + '(wiki-server client administration) and write {"clientKey": "...", "baseUrl": "http://127.0.0.1:<port>"} there, '
      + 'or set baseUrl/apiKey in this plugin\'s config.',
      'WK_CREDENTIAL_MISSING',
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    throw new WkClientError(`WK credential file at ${credentialFile} is not valid JSON.`, 'WK_CREDENTIAL_INVALID')
  }
  const clientKey = str(parsed !== undefined && typeof parsed === 'object' ? (parsed as { clientKey?: unknown }).clientKey : undefined)
  const baseUrl = str(parsed !== undefined && typeof parsed === 'object' ? (parsed as { baseUrl?: unknown }).baseUrl : undefined)
  if (clientKey === undefined || clientKey.length === 0 || baseUrl === undefined || baseUrl.length === 0) {
    throw new WkClientError(
      `WK credential file at ${credentialFile} must carry non-empty "clientKey" and "baseUrl" strings.`,
      'WK_CREDENTIAL_INVALID',
    )
  }
  return { clientKey, baseUrl }
}

/** Per-call endpoint: fresh from config/env/file so WK restarts heal without a remount. */
export interface WkCallContext {
  /** Explicit base URL override; `undefined` means discover from the credential file. */
  readonly baseUrl: string | undefined
  readonly credentialFile: string
  readonly apiKey: string | undefined
  readonly timeoutMs: number
}

/**
 * Run one WK call against the resolved endpoint, mapping every failure to a
 * teaching message before it reaches the model.
 * @param call - endpoint facts resolved by `apply`.
 * @param invoke - one client operation.
 * @returns the operation's payload.
 */
export async function withWk<T>(call: WkCallContext, invoke: (client: WkContractClient) => Promise<T>): Promise<T> {
  let credential: WkCredential | undefined
  if (call.apiKey === undefined || call.baseUrl === undefined) {
    credential = await readWkCredential(call.credentialFile)
  }
  const client = new WkContractClient({
    baseUrl: call.baseUrl ?? credential?.baseUrl ?? '',
    apiKey: call.apiKey ?? credential?.clientKey,
    timeoutMs: call.timeoutMs,
  })
  try {
    return await invoke(client)
  } catch (error) {
    throw new WkClientError(wkFailureMessage(error, client.baseUrl), 'WK_TOOL_FAILURE')
  }
}

/** Present one read-only WK call as a generic card. */
function present(title: string, kind: NonNullable<GenericCallView['kind']>, rawInput: string): GenericCallView {
  return { card: 'generic', title, kind, rawInput }
}

/** Register the five read-only WK tools and the prompt section. */
export function apply(ctx: Context, config: Config): void {
  const dataRoot = config.dataRoot
    ?? launchEnvironmentOf(ctx).get('WIKI_SERVER_DATA_ROOT')?.value
    ?? join(homedir(), '.wiki-service')
  const call: WkCallContext = {
    baseUrl: config.baseUrl,
    credentialFile: config.credentialFile ?? join(dataRoot, 'config', 'dsh.json'),
    apiKey: config.apiKey ?? launchEnvironmentOf(ctx).get('DSH_WK_API_KEY')?.value,
    timeoutMs: config.timeoutMs ?? WK_DEFAULT_TIMEOUT_MS,
  }

  ctx.systemPrompt.section({
    name: 'tool:wk',
    order: FIRST_PARTY_SECTION_ORDER.TOOL_WK,
    text: 'A local Wiki Server (WK) may hold durable knowledge for this workspace: wiki pages plus per-repository project trees with indexed source. Before re-deriving facts from scratch, wk_search the wiki and wk_source_search the project trees; read exact pages with wk_read_nodes and indexed source with wk_source_read; wk_roots lists the available trees. When a WK tool reports the server as unreachable or unauthenticated, treat that as missing tooling and fall back to other sources — not as absence of the knowledge.',
  })

  ctx.tools.register(defineTool({
    name: 'wk_search',
    description: 'Full-text search the local Wiki Server\'s knowledge pages. Returns node id, tree, path, '
      + 'score, and a snippet per hit. Use wk_roots first when you need the tree ids a hit belongs to.',
    parameters: {
      query: { type: 'string', required: true, description: 'FTS query (1-1000 chars).' },
      limit: { type: 'number', description: 'Maximum hits (default 20).' },
    },
    presentCall: args => present('Search the wiki', 'search', String(args.query)),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          hits: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                nodeId: { type: 'string', required: true },
                rootId: { type: 'string', required: true },
                name: { type: 'string' },
                path: { type: 'string', required: true },
                score: { type: 'number' },
                snippet: { type: 'string' },
              },
            },
          },
          hasMore: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.hits.length === 0
          ? '(no wiki hits)'
          : value.hits.map((hit) => {
            const name = hit.name !== undefined ? ` "${hit.name}"` : ''
            const score = hit.score !== undefined ? ` score=${hit.score}` : ''
            const snippet = hit.snippet !== undefined ? `\n  ${hit.snippet}` : ''
            return `${hit.path}${name} [root ${hit.rootId} node ${hit.nodeId}]${score}${snippet}`
          }).join('\n') + (value.hasMore ? '\n(more hits available — raise limit or narrow the query)' : ''),
      }],
    },
    async execute(args, exec) {
      const result = await withWk(call, client => client.call('search', 'fts', [
        undefined,
        { query: args.query, limit: args.limit ?? 20, deadlineMs: call.timeoutMs },
      ], exec.signal))
      const page = result !== undefined && typeof result === 'object' ? result as { items?: unknown; hasMore?: unknown } : {}
      const hits = Array.isArray(page.items) ? page.items.map(searchHitOf) : []
      return {
        hits: hits.filter((hit): hit is WkSearchHitView => hit !== undefined),
        hasMore: page.hasMore === true,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'wk_read_nodes',
    description: 'Read up to 5 wiki pages by node id (from wk_search hits) with their content. '
      + 'server_id defaults to the single local server.',
    parameters: {
      node_ids: { type: 'array', required: true, items: { type: 'string' }, description: 'Node ids from wk_search (1-5).' },
      server_id: { type: 'string', description: 'Omit to use the local server\'s own id.' },
    },
    presentCall: args => present('Read wiki pages', 'read', (args.node_ids ?? []).join(', ')),
    output: {
      schema: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            nodeId: { type: 'string', required: true },
            rootId: { type: 'string', required: true },
            name: { type: 'string' },
            path: { type: 'string' },
            contentType: { type: 'string' },
            content: { type: 'string' },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.length === 0
          ? '(no nodes)'
          : value.map((node) => {
            const header = node.path ?? node.name ?? node.nodeId
            return `# ${header}\n${node.content ?? '(no content)'}`
          }).join('\n\n'),
      }],
    },
    async execute(args, exec) {
      const ids = args.node_ids.slice(0, WK_MAX_READ_NODES)
      const serverId = args.server_id ?? await withWk(call, client => client.serverId(exec.signal))
      const nodes: WkNodeView[] = []
      for (const nodeId of ids) {
        const raw = await withWk(call, client => client.call('nodes', 'get', [{ serverId, nodeId }], exec.signal))
        const view = nodeViewOf(raw)
        if (view !== undefined) nodes.push(view)
      }
      return nodes
    },
  }))

  ctx.tools.register(defineTool({
    name: 'wk_roots',
    description: 'List the Wiki Server\'s knowledge roots (trees): id, name, path, and whether retired. '
      + 'Tree ids feed wk_search context and project-tree tools.',
    parameters: {
      include_retired: { type: 'boolean', description: 'Also list retired roots (default false).' },
    },
    presentCall: () => present('List wiki roots', 'read', ''),
    output: {
      schema: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            rootId: { type: 'string', required: true },
            name: { type: 'string', required: true },
            path: { type: 'string' },
            retired: { type: 'boolean', required: true },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.length === 0
          ? '(no roots)'
          : value.map(root => `${root.rootId} — ${root.name}${root.path !== undefined ? ` (${root.path})` : ''}${root.retired ? ' [retired]' : ''}`).join('\n'),
      }],
    },
    async execute(args, exec) {
      const result = await withWk(call, client => client.call('roots', 'list', [
        args.include_retired === true ? { includeRetired: true } : {},
      ], exec.signal))
      const roots = Array.isArray(result) ? result.map(rootViewOf) : []
      return roots.filter((root): root is WkRootView => root !== undefined)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'wk_source_search',
    description: 'Search the source files of a registered project tree (an indexed git repository): '
      + 'pattern with mode exact/substring/glob/regex, optional scope and file globs.',
    parameters: {
      tree: { type: 'string', required: true, description: 'Project tree name (slug, from wk_roots or the deployment).' },
      pattern: { type: 'string', required: true, description: 'Pattern to search for.' },
      mode: { type: 'string', description: 'Match mode: exact | substring | glob | regex (default substring).' },
      scope: { type: 'string', description: 'Restrict to a subdirectory path.' },
      file_globs: { type: 'array', items: { type: 'string' }, description: 'File glob filters, e.g. ["*.ts"].' },
      limit: { type: 'number', description: 'Maximum hits (default 20).' },
    },
    presentCall: args => present('Search project-tree source', 'search', `${args.tree}: ${String(args.pattern)}`),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          hits: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                line: { type: 'integer' },
                excerpt: { type: 'string' },
              },
            },
          },
          hasMore: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.hits.length === 0
          ? '(no source hits)'
          : value.hits.map((hit) => {
            const at = hit.line !== undefined ? `:${hit.line}` : ''
            const excerpt = hit.excerpt !== undefined ? `\n  ${hit.excerpt}` : ''
            return `${hit.path}${at}${excerpt}`
          }).join('\n') + (value.hasMore ? '\n(more hits available)' : ''),
      }],
    },
    async execute(args, exec) {
      const result = await withWk(call, client => client.call('projectTrees', 'searchSource', [{
        pattern: args.pattern,
        ...args.mode !== undefined ? { mode: args.mode } : {},
        ...args.scope !== undefined ? { scope: args.scope } : {},
        ...args.file_globs !== undefined && args.file_globs.length > 0 ? { fileGlobs: args.file_globs } : {},
        limit: args.limit ?? 20,
      }], exec.signal))
      const outcome = result !== undefined && typeof result === 'object'
        ? result as { hits?: unknown; items?: unknown; matches?: unknown; hasMore?: unknown }
        : {}
      const rawHits = outcome.hits ?? outcome.items ?? outcome.matches
      const hits: WkSourceHitView[] = []
      if (Array.isArray(rawHits)) {
        for (const raw of rawHits) {
          if (raw === undefined || typeof raw !== 'object') continue
          const path = str((raw as { path?: unknown }).path)
          if (path === undefined) continue
          const line = (raw as { line?: unknown }).line
          const excerpt = str((raw as { excerpt?: unknown }).excerpt) ?? str((raw as { preview?: unknown }).preview)
          hits.push({
            path,
            ...(typeof line === 'number' && Number.isSafeInteger(line)) ? { line } : {},
            ...excerpt !== undefined ? { excerpt } : {},
          })
        }
      }
      return { hits, hasMore: outcome.hasMore === true }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'wk_source_read',
    description: 'Read a file of a registered project tree by repo-relative path, optionally a '
      + '1-based inclusive line range.',
    parameters: {
      tree: { type: 'string', required: true, description: 'Project tree name (slug).' },
      path: { type: 'string', required: true, description: 'Repo-relative file path.' },
      start_line: { type: 'number', description: '1-based first line (default 1).' },
      end_line: { type: 'number', description: '1-based last line (default end of file).' },
    },
    presentCall: args => present('Read project-tree source', 'read', `${args.tree}:${String(args.path)}`),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          treeName: { type: 'string', required: true },
          path: { type: 'string', required: true },
          startLine: { type: 'integer' },
          endLine: { type: 'integer' },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.text.length === 0 ? '(empty range)' : value.text,
      }],
    },
    async execute(args, exec) {
      const result = await withWk(call, client => client.call('projectTrees', 'readSourceFile', [
        args.tree,
        args.path,
        {
          ...args.start_line !== undefined ? { lineStart: args.start_line } : {},
          ...args.end_line !== undefined ? { lineEnd: args.end_line } : {},
        },
      ], exec.signal))
      const view = result !== undefined && typeof result === 'object'
        ? result as { text?: unknown; content?: unknown; lines?: unknown; startLine?: unknown; endLine?: unknown; path?: unknown }
        : {}
      const text = str(view.text) ?? str(view.content)
      const startLine = typeof view.startLine === 'number' && Number.isSafeInteger(view.startLine) ? view.startLine : undefined
      const endLine = typeof view.endLine === 'number' && Number.isSafeInteger(view.endLine) ? view.endLine : undefined
      const read: WkSourceReadView = {
        treeName: args.tree,
        path: str(view.path) ?? args.path,
        ...startLine !== undefined ? { startLine } : {},
        ...endLine !== undefined ? { endLine } : {},
        text: text ?? (typeof view.lines === 'string' ? view.lines : ''),
      }
      return read
    },
  }))
}
