import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readWkCredential, withWk, type WkCallContext } from '../src/index.ts'
import { WkClientError, WkContractClient, wkFailureMessage } from '../src/client.ts'
import { nodeViewOf, rootViewOf, searchHitOf, str } from '../src/types.ts'
import { TimeoutReason } from '@deepseek-ai/dsh-timeout'

let servers: Server[] = []
let roots: string[] = []

afterEach(async () => {
  await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  servers = []
  for (const root of roots) await rm(root, { recursive: true, force: true })
  roots = []
})

interface StubOptions {
  /** Handler for contract routes; defaults to a search/fts fixture. */
  handle?: (url: string, body: unknown, headers: import('node:http').IncomingHttpHeaders) => { status: number; body: unknown } | undefined
}

/** Boot one WK-shaped stub on 127.0.0.1:0; returns its base URL. */
async function stubWk(options: StubOptions = {}): Promise<string> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => { chunks.push(chunk as Buffer) })
    req.on('end', () => {
      const body: unknown = chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const url = req.url ?? ''
      if (url === '/wiki/v1/metadata/serverId') {
        respond(res, 200, { status: 'ok', serverId: 'srv-1' })
        return
      }
      const routed = options.handle?.(url, body, req.headers)
      if (routed !== undefined) {
        respond(res, routed.status, routed.body)
        return
      }
      respond(res, 200, { ok: true, result: { items: [], hasMore: false } })
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('stub: no port')
  return `http://127.0.0.1:${address.port}`
}

function respond(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

function client(baseUrl: string, overrides: Partial<ConstructorParameters<typeof WkContractClient>[0]> = {}): WkContractClient {
  return new WkContractClient({ baseUrl, apiKey: 'wsk_test', timeoutMs: 2_000, ...overrides })
}

describe('WkContractClient', () => {
  it('posts the {ctx, args} envelope and unwraps {ok, result}', async () => {
    let seen: { url: string; auth: string | undefined; body: unknown } | undefined
    const baseUrl = await stubWk({
      handle: (url, body) => {
        seen = { url, auth: undefined, body }
        return { status: 200, body: { ok: true, result: { pong: true } } }
      },
    })
    const result = await client(baseUrl).call('search', 'fts', [[], { query: 'auth' }], undefined)
    expect(result).toEqual({ pong: true })
    expect(seen?.url).toBe('/wiki/v1/search/fts')
    expect(seen?.body).toMatchObject({ ctx: { consumerId: 'dsh-tool-wk' }, args: [[], { query: 'auth' }] })
  })

  it('sends the bearer key and maps {ok: false} to WkClientError with the code', async () => {
    let auth: string | undefined
    const baseUrl = await stubWk({
      handle: (url, _body, headers) => {
        auth = headers.authorization
        if (url === '/wiki/v1/roots/list') return { status: 403, body: { ok: false, error: { code: 'WIKI_CLIENT_AUTHENTICATION_REQUIRED', message: 'no bearer' } } }
        return undefined
      },
    })
    await expect(client(baseUrl).call('roots', 'list', [{}], undefined)).rejects.toMatchObject({
      name: 'WkClientError',
      code: 'WIKI_CLIENT_AUTHENTICATION_REQUIRED',
      status: 403,
    })
    expect(auth).toBe('Bearer wsk_test')
  })

  it('treats a non-JSON body as a protocol failure', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(502, { 'content-type': 'text/plain' })
      res.end('bad gateway')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    servers.push(server)
    const address = server.address()
    const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`
    await expect(client(baseUrl).call('roots', 'list', [{}], undefined)).rejects.toMatchObject({
      code: 'WK_PROTOCOL',
      status: 502,
    })
  })

  it('times out through the configured deadline', async () => {
    const server = createServer((_req, res) => { setTimeout(() => respond(res, 200, { ok: true, result: null }), 500) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    servers.push(server)
    const address = server.address()
    const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`
    const slow = new WkContractClient({ baseUrl, apiKey: undefined, timeoutMs: 50 })
    await expect(slow.call('roots', 'list', [{}], undefined)).rejects.toBeInstanceOf(TimeoutReason)
  })

  it('reads the public serverId metadata route', async () => {
    const baseUrl = await stubWk()
    expect(await client(baseUrl).serverId(undefined)).toBe('srv-1')
  })

  it('reports a malformed metadata payload as a protocol failure', async () => {
    const server = createServer((_req, res) => respond(res, 200, { unexpected: true }))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    servers.push(server)
    const address = server.address()
    const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`
    await expect(client(baseUrl).serverId(undefined)).rejects.toMatchObject({ code: 'WK_PROTOCOL' })
  })
})

describe('wkFailureMessage', () => {
  it('teaches the mint step for rejected credentials', () => {
    const text = wkFailureMessage(new WkClientError('no bearer', 'WIKI_CLIENT_AUTHENTICATION_REQUIRED', 401), 'http://x')
    expect(text).toContain('mint a DSH client key')
  })

  it('carries the code for ordinary contract failures', () => {
    expect(wkFailureMessage(new WkClientError('gone', 'NOT_FOUND', 404), undefined)).toContain('NOT_FOUND')
  })

  it('names the timeout and the unreachable server', () => {
    expect(wkFailureMessage(new TimeoutReason('WK_TIMEOUT', 250), undefined)).toContain('timed out after 250ms')
    expect(wkFailureMessage(new TypeError('fetch failed'), 'http://127.0.0.1:9')).toContain('Cannot reach the wiki server at http://127.0.0.1:9')
  })

  it('reports cancellation and unknown failures verbatim', () => {
    const cancelled = new Error('cancelled')
    cancelled.name = 'AbortError'
    expect(wkFailureMessage(cancelled, undefined)).toBe('WK request cancelled.')
    expect(wkFailureMessage('odd', undefined)).toContain('odd')
  })
})

describe('readWkCredential', () => {
  it('rejects a missing file with the mint teaching message', async () => {
    await expect(readWkCredential(join(tmpdir(), 'definitely-missing-wk.json'))).rejects.toMatchObject({
      code: 'WK_CREDENTIAL_MISSING',
    })
  })

  it('rejects malformed or incomplete files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wk-cred-'))
    roots.push(root)
    const bad = join(root, 'bad.json')
    await writeFile(bad, '{not json', 'utf8')
    await expect(readWkCredential(bad)).rejects.toMatchObject({ code: 'WK_CREDENTIAL_INVALID' })
    const partial = join(root, 'partial.json')
    await writeFile(partial, JSON.stringify({ clientKey: 'wsk_x' }), 'utf8')
    await expect(readWkCredential(partial)).rejects.toMatchObject({ code: 'WK_CREDENTIAL_INVALID' })
  })

  it('returns the clientKey and baseUrl pair', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wk-cred-'))
    roots.push(root)
    const file = join(root, 'dsh.json')
    await writeFile(file, JSON.stringify({ clientKey: 'wsk_x', baseUrl: 'http://127.0.0.1:1' }), 'utf8')
    expect(await readWkCredential(file)).toEqual({ clientKey: 'wsk_x', baseUrl: 'http://127.0.0.1:1' })
  })
})

describe('withWk', () => {
  it('resolves the endpoint from the credential file and maps failures to teaching text', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wk-wkwith-'))
    roots.push(root)
    const file = join(root, 'dsh.json')
    await writeFile(file, JSON.stringify({ clientKey: 'wsk_x', baseUrl: 'http://127.0.0.1:1' }), 'utf8')
    const call: WkCallContext = { baseUrl: undefined, credentialFile: file, apiKey: undefined, timeoutMs: 100 }
    // Port 1 refuses: the teaching message names the unreachable endpoint.
    await expect(withWk(call, c => c.call('roots', 'list', [{}], undefined))).rejects.toMatchObject({
      code: 'WK_TOOL_FAILURE',
      message: expect.stringContaining('Cannot reach the wiki server') as unknown,
    })
  })

  it('skips the credential file when config supplies baseUrl and apiKey', async () => {
    const baseUrl = await stubWk({
      handle: () => ({ status: 200, body: { ok: true, result: { ok: true } } }),
    })
    const call: WkCallContext = {
      baseUrl,
      credentialFile: join(tmpdir(), 'definitely-missing-wk.json'),
      apiKey: 'wsk_test',
      timeoutMs: 2_000,
    }
    await expect(withWk(call, c => c.call('roots', 'list', [{}], undefined))).resolves.toEqual({ ok: true })
  })

  it('reads only the key from the file when baseUrl is explicit', async () => {
    const baseUrl = await stubWk({
      handle: () => ({ status: 200, body: { ok: true, result: 7 } }),
    })
    const root = await mkdtemp(join(tmpdir(), 'wk-wkwith-'))
    roots.push(root)
    const file = join(root, 'dsh.json')
    await writeFile(file, JSON.stringify({ clientKey: 'wsk_x', baseUrl: 'http://127.0.0.1:1' }), 'utf8')
    const call: WkCallContext = { baseUrl, credentialFile: file, apiKey: undefined, timeoutMs: 2_000 }
    await expect(withWk(call, c => c.call('roots', 'list', [{}], undefined))).resolves.toBe(7)
  })
})

describe('view projections', () => {
  it('projects search hits, roots, and nodes, dropping malformed rows', () => {
    const hit = searchHitOf({
      nodeRef: { serverId: 's', nodeId: 'n1' },
      rootRef: { serverId: 's', rootId: 'r1' },
      name: 'auth.md',
      path: '/design/auth.md',
      score: 1.5,
      snippet: ' OAuth flow',
    })
    expect(hit).toMatchObject({ nodeId: 'n1', rootId: 'r1', path: '/design/auth.md', score: 1.5 })
    expect(searchHitOf({ nodeRef: {} })).toBeUndefined()
    expect(searchHitOf(undefined)).toBeUndefined()
    expect(rootViewOf({ rootRef: { rootId: 'r1' }, name: 'tree', path: '/t', retired: true }))
      .toMatchObject({ rootId: 'r1', name: 'tree', retired: true })
    expect(rootViewOf({ rootRef: { rootId: 'r1' }, displayName: 'fallback' })?.name).toBe('fallback')
    expect(rootViewOf({ name: 'no ref' })).toBeUndefined()
    expect(nodeViewOf({ nodeRef: { nodeId: 'n1' }, rootRef: { rootId: 'r1' }, content: '# hi' }))
      .toMatchObject({ nodeId: 'n1', rootId: 'r1', content: '# hi' })
    expect(nodeViewOf('junk')).toBeUndefined()
    expect(str(3)).toBeUndefined()
    expect(str('x')).toBe('x')
  })
})
