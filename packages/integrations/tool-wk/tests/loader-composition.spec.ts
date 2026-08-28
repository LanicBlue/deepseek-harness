// Boots the plugin through the real Loader against a WK-shaped stub server:
// proves the tools register from cordis.yml config, calls execute end to end,
// and surfaces the credential-missing teaching error instead of crashing.
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolWk from '@deepseek-ai/dsh-tool-wk'

let root: string | undefined
let context: Context | undefined
let server: Server | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  await new Promise<void>(resolve => server?.close(() => resolve()))
  server = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** A minimal agent identity for tool executions that do not consume it. */
function agent(ctx: Context): Agent {
  const scope = ctx.plugin(() => {})
  const session = Session.create(SessionId('wk-loader-agent'))
  return {
    id: SessionId('wk-loader-agent'), options: {}, session,
    inbox: { insert: () => {}, discard: () => {}, claimed: () => {} } as unknown as Agent['inbox'],
    status: 'idle', ctx: scope.ctx,
    followup: () => {}, steer: () => {}, inject: () => {}, send: () => {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

function resultText(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/**
 * Boot one WK stub plus a cordis.yml carrying the given tool-wk config block.
 * @param configLines - YAML lines nested under the tool's `config:` key.
 * @param stub - contract fixtures: url → response body (200 unless it has `status`).
 */
async function boot(
  configLines: readonly string[],
  stub: Record<string, { status?: number; body: unknown }>,
): Promise<Context> {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => { chunks.push(chunk as Buffer) })
    req.on('end', () => {
      void chunks
      const fixture = stub[req.url ?? '']
      const status = fixture?.status ?? 200
      const body = fixture?.body ?? { ok: true, result: null }
      const text = JSON.stringify(body)
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
      res.end(text)
    })
  })
  const listening = server
  await new Promise<void>(resolve => listening.listen(0, '127.0.0.1', resolve))
  const port = listening.address()
  if (port === null || typeof port === 'string') throw new Error('stub: no port')

  root = await mkdtemp(join(tmpdir(), 'dsh-wk-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-tool-wk'",
    '  config:',
    ...configLines.map(line => line.replace('<port>', String(port.port))),
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-tool-wk', ToolWk],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

describe('tool-wk real Loader composition through cordis.yml', () => {
  it('registers the five tools and executes wk_search end to end', async () => {
    const ctx = await boot([
      '    baseUrl: "http://127.0.0.1:<port>"',
      '    apiKey: wsk_test',
    ], {
      '/wiki/v1/search/fts': {
        body: {
          ok: true,
          result: {
            items: [{
              nodeRef: { serverId: 's', nodeId: 'n1' },
              rootRef: { serverId: 's', rootId: 'r1' },
              name: 'auth.md',
              path: '/design/auth.md',
              snippet: 'OAuth flow',
            }],
            hasMore: false,
          },
        },
      },
    })
    const names = ctx.tools.schemas().map(schema => schema.name)
    expect(names).toEqual(expect.arrayContaining(['wk_search', 'wk_read_nodes', 'wk_roots', 'wk_source_search', 'wk_source_read']))

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('wk-search'),
      name: 'wk_search',
      arguments: { query: 'oauth' },
      agent: agent(ctx),
    })
    expect(resultText(result), resultText(result)).toContain('/design/auth.md')
    expect(result.isError).toBe(false)
    expect(resultText(result)).toContain('[root r1 node n1]')
  }, 30_000)

  it('defaults server_id from the metadata route and fans node reads out', async () => {
    const ctx = await boot([
      '    baseUrl: "http://127.0.0.1:<port>"',
      '    apiKey: wsk_test',
    ], {
      '/wiki/v1/metadata/serverId': { body: { status: 'ok', serverId: 'srv-9' } },
      '/wiki/v1/nodes/get': {
        body: {
          ok: true,
          result: { nodeRef: { serverId: 'srv-9', nodeId: 'n1' }, rootRef: { rootId: 'r1' }, path: '/a.md', content: '# A' },
        },
      },
    })
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('wk-read'),
      name: 'wk_read_nodes',
      arguments: { node_ids: ['n1'] },
      agent: agent(ctx),
    })
    expect(result.isError).toBe(false)
    expect(resultText(result)).toContain('# /a.md')
    expect(resultText(result)).toContain('# A')
  }, 30_000)

  it('surfaces the credential-missing teaching error from a dataRoot without a key', async () => {
    const ctx = await boot(['    dataRoot: ' + JSON.stringify(join(tmpdir(), 'dsh-wk-no-such-root'))], {
      '/wiki/v1/roots/list': { body: { ok: true, result: [] } },
    })
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('wk-roots'),
      name: 'wk_roots',
      arguments: {},
      agent: agent(ctx),
    })
    expect(result.isError).toBe(true)
    expect(resultText(result)).toContain('credential file not found')
    expect(resultText(result)).toContain('Mint a DSH client key')
  }, 30_000)
})
