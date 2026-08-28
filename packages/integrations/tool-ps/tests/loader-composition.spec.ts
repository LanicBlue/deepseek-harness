// Boots the plugin through the real Loader against a PS-shaped stub server:
// proves the tools register from cordis.yml config and execute end to end.
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
import * as ToolPs from '@deepseek-ai/dsh-tool-ps'

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
  const session = Session.create(SessionId('ps-loader-agent'))
  return {
    id: SessionId('ps-loader-agent'), options: {}, session,
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
 * Boot one PS stub plus a cordis.yml carrying the given tool-ps config block.
 * @param configLines - YAML lines nested under the tool's `config:` key.
 * @param stub - url → response body (200 unless it has `status`).
 */
async function boot(
  configLines: readonly string[],
  stub: Record<string, { status?: number; body: unknown }>,
): Promise<Context> {
  server = createServer((req, res) => {
    const fixture = stub[req.url ?? '']
    const status = fixture?.status ?? 200
    const body = fixture?.body ?? { ok: true, result: null }
    const text = JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
    res.end(text)
  })
  const listening = server
  await new Promise<void>(resolve => listening.listen(0, '127.0.0.1', resolve))
  const port = listening.address()
  if (port === null || typeof port === 'string') throw new Error('stub: no port')

  root = await mkdtemp(join(tmpdir(), 'dsh-ps-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-tool-ps'",
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
    ['@deepseek-ai/dsh-tool-ps', ToolPs],
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

describe('tool-ps real Loader composition through cordis.yml', () => {
  it('registers the four tools and executes ps_projects end to end', async () => {
    const ctx = await boot([
      '    baseUrl: "http://127.0.0.1:<port>"',
      '    apiKey: psk_test',
    ], {
      '/project/v1/': {
        body: { ok: true, result: [{ projectId: 'p1', projectName: 'alpha' }] },
      },
    })
    const names = ctx.tools.schemas().map(schema => schema.name)
    expect(names).toEqual(expect.arrayContaining(['ps_projects', 'ps_project', 'ps_missions', 'ps_inbox']))

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('ps-projects'),
      name: 'ps_projects',
      arguments: {},
      agent: agent(ctx),
    })
    expect(result.isError).toBe(false)
    expect(resultText(result)).toContain('p1')
    expect(resultText(result)).toContain('alpha')
  }, 30_000)

  it('reads one project and its missions through the same endpoint', async () => {
    const ctx = await boot([
      '    baseUrl: "http://127.0.0.1:<port>"',
    ], {
      '/project/v1/p1': {
        body: { ok: true, result: { projectId: 'p1', projectName: 'alpha' } },
      },
      '/project/v1/p1/missions': {
        body: { ok: true, result: [{ missionId: 'm1', objective: 'ship it' }] },
      },
    })
    const project = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('ps-project'),
      name: 'ps_project',
      arguments: { project_id: 'p1' },
      agent: agent(ctx),
    })
    expect(project.isError).toBe(false)
    expect(resultText(project)).toContain('"projectName":"alpha"')

    const missions = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('ps-missions'),
      name: 'ps_missions',
      arguments: { project_id: 'p1' },
      agent: agent(ctx),
    })
    expect(missions.isError).toBe(false)
    expect(resultText(missions)).toContain('m1')
  }, 30_000)

  it('surfaces the unauthenticated teaching error instead of crashing', async () => {
    const ctx = await boot([
      '    baseUrl: "http://127.0.0.1:<port>"',
    ], {
      '/project/v1/': {
        status: 401,
        body: { ok: false, error: { code: 'PROJECT_AUTHENTICATION_REQUIRED', message: 'no bearer' } },
      },
    })
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('ps-auth'),
      name: 'ps_projects',
      arguments: {},
      agent: agent(ctx),
    })
    expect(result.isError).toBe(true)
    expect(resultText(result)).toContain('Mint a DSH service client')
  }, 30_000)
})
