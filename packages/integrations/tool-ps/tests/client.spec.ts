import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { psRowOf, readPsCredential, withPs, type PsCallContext } from '../src/index.ts'
import { PsClientError, PsRestClient, psFailureMessage } from '../src/client.ts'
import { TimeoutReason } from '@deepseek-ai/dsh-timeout'

let servers: Server[] = []
let roots: string[] = []

afterEach(async () => {
  await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  servers = []
  for (const root of roots) await rm(root, { recursive: true, force: true })
  roots = []
})

/** Boot one PS-shaped stub on 127.0.0.1:0; returns its base URL. */
async function stubPs(
  handle: (url: string, headers: import('node:http').IncomingHttpHeaders) => { status: number; body: unknown },
): Promise<string> {
  const server = createServer((req, res) => {
    const routed = handle(req.url ?? '', req.headers)
    const text = JSON.stringify(routed.body)
    res.writeHead(routed.status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
    res.end(text)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('stub: no port')
  return `http://127.0.0.1:${address.port}`
}

function client(baseUrl: string): PsRestClient {
  return new PsRestClient({ baseUrl, apiKey: 'psk_test', timeoutMs: 2_000 })
}

describe('PsRestClient', () => {
  it('GETs the route and unwraps {ok, result}', async () => {
    let seen: { url: string; auth: string | undefined } | undefined
    const baseUrl = await stubPs((url, headers) => {
      seen = { url, auth: headers.authorization }
      return { status: 200, body: { ok: true, result: [{ projectId: 'p1' }] } }
    })
    const result = await client(baseUrl).get('/project/v1/', undefined)
    expect(result).toEqual([{ projectId: 'p1' }])
    expect(seen?.url).toBe('/project/v1/')
    expect(seen?.auth).toBe('Bearer psk_test')
  })

  it('omits the bearer header when no key is configured', async () => {
    let auth: string | undefined = 'sentinel'
    const baseUrl = await stubPs((_url, headers) => {
      auth = headers.authorization
      return { status: 200, body: { ok: true, result: null } }
    })
    await new PsRestClient({ baseUrl, apiKey: undefined, timeoutMs: 2_000 }).get('/project/v1/', undefined)
    expect(auth).toBeUndefined()
  })

  it('maps {ok: false} to PsClientError with code and status', async () => {
    const baseUrl = await stubPs(() => ({
      status: 403,
      body: { ok: false, error: { code: 'PROJECT_OPERATOR_REQUIRED', message: 'operator only' } },
    }))
    await expect(client(baseUrl).get('/project/v1/x/missions', undefined)).rejects.toMatchObject({
      name: 'PsClientError',
      code: 'PROJECT_OPERATOR_REQUIRED',
      status: 403,
    })
  })

  it('treats a non-JSON body as a protocol failure', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('boom')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    servers.push(server)
    const address = server.address()
    const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`
    await expect(client(baseUrl).get('/project/v1/', undefined)).rejects.toMatchObject({ code: 'PS_PROTOCOL' })
  })

  it('times out through the configured deadline', async () => {
    const server = createServer((_req, res) => {
      setTimeout(() => {
        const text = JSON.stringify({ ok: true, result: null })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(text)
      }, 500)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    servers.push(server)
    const address = server.address()
    const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`
    const slow = new PsRestClient({ baseUrl, apiKey: undefined, timeoutMs: 50 })
    await expect(slow.get('/project/v1/', undefined)).rejects.toBeInstanceOf(TimeoutReason)
  })
})

describe('psFailureMessage', () => {
  it('teaches the mint step for 401 and the operator requirement for 403', () => {
    expect(psFailureMessage(new PsClientError('no bearer', 'PROJECT_AUTHENTICATION_REQUIRED', 401), 'http://x'))
      .toContain('Mint a DSH service client')
    expect(psFailureMessage(new PsClientError('operator only', 'PROJECT_OPERATOR_REQUIRED', 403), 'http://x'))
      .toContain('operator-role credential')
  })

  it('names the timeout and the unreachable service', () => {
    expect(psFailureMessage(new TimeoutReason('PS_TIMEOUT', 250), undefined)).toContain('timed out after 250ms')
    expect(psFailureMessage(new TypeError('fetch failed'), 'http://127.0.0.1:9')).toContain('Cannot reach the Project Service at http://127.0.0.1:9')
  })

  it('reports cancellation, ordinary codes, and unknown failures', () => {
    const cancelled = new Error('cancelled')
    cancelled.name = 'AbortError'
    expect(psFailureMessage(cancelled, undefined)).toBe('Project Service request cancelled.')
    expect(psFailureMessage(new PsClientError('gone', 'PROJECT_NOT_FOUND', 404), undefined)).toContain('PROJECT_NOT_FOUND')
    expect(psFailureMessage('odd', undefined)).toContain('odd')
  })
})

describe('readPsCredential', () => {
  it('returns undefined for a missing file (bootstrap window is legal)', async () => {
    expect(await readPsCredential(join(tmpdir(), 'definitely-missing-ps.json'))).toBeUndefined()
  })

  it('rejects malformed or incomplete files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ps-cred-'))
    roots.push(root)
    const bad = join(root, 'bad.json')
    await writeFile(bad, '{nope', 'utf8')
    await expect(readPsCredential(bad)).rejects.toMatchObject({ code: 'PS_CREDENTIAL_INVALID' })
    const partial = join(root, 'partial.json')
    await writeFile(partial, JSON.stringify({ baseUrl: 'http://x' }), 'utf8')
    await expect(readPsCredential(partial)).rejects.toMatchObject({ code: 'PS_CREDENTIAL_INVALID' })
  })

  it('returns the pair when valid', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ps-cred-'))
    roots.push(root)
    const file = join(root, 'dsh.json')
    await writeFile(file, JSON.stringify({ clientKey: 'psk_x', baseUrl: 'http://127.0.0.1:1' }), 'utf8')
    expect(await readPsCredential(file)).toEqual({ clientKey: 'psk_x', baseUrl: 'http://127.0.0.1:1' })
  })
})

describe('withPs', () => {
  it('uses the credential file\'s baseUrl and key when config omits them', async () => {
    const baseUrl = await stubPs(() => ({ status: 200, body: { ok: true, result: 5 } }))
    const root = await mkdtemp(join(tmpdir(), 'ps-with-'))
    roots.push(root)
    const file = join(root, 'dsh.json')
    await writeFile(file, JSON.stringify({ clientKey: 'psk_x', baseUrl }), 'utf8')
    const call: PsCallContext = { baseUrl: undefined, credentialFile: file, apiKey: undefined, timeoutMs: 2_000 }
    await expect(withPs(call, c => c.get('/project/v1/', undefined))).resolves.toBe(5)
  })

  it('falls back to the default endpoint without a credential file and maps failures', async () => {
    const call: PsCallContext = {
      baseUrl: undefined,
      credentialFile: join(tmpdir(), 'definitely-missing-ps.json'),
      apiKey: undefined,
      timeoutMs: 100,
    }
    // Port 7600 is not this test's stub; the failure must name the default endpoint.
    await expect(withPs(call, c => c.get('/project/v1/', undefined))).rejects.toMatchObject({
      code: 'PS_TOOL_FAILURE',
    })
  })
})

describe('psRowOf', () => {
  it('extracts the first recognized identity column and keeps the payload verbatim', () => {
    expect(psRowOf({ projectId: 'p1', extra: 1 }, ['projectId', 'id'])).toEqual({
      id: 'p1',
      json: '{"projectId":"p1","extra":1}',
    })
    expect(psRowOf({ id: 'x' }, ['projectId', 'id']).id).toBe('x')
    expect(psRowOf('scalar', ['projectId', 'id']).id).toBe('(row)')
    expect(psRowOf(null, ['projectId', 'id']).json).toBe('null')
  })
})
