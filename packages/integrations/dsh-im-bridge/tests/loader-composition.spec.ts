import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { afterEach, describe, expect, it } from 'vitest'
import * as ImBridgePlugin from '../src/index.ts'
import { ImBridge } from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('bundle patch composition', () => {
  it('the shipped cordis.patch.yml inserts exactly this package as its plugin row', async () => {
    const patchYaml = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    expect(patchYaml).toContain('- id: im-bridge')
    expect(patchYaml).toContain("name: '@deepseek-ai/dsh-im-bridge'")
  })

  it('the patch row loads the Service under a real Loader', { timeout: 60_000 }, async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-im-bridge-loader-'))
    // The entry the patch's insert row expands to, beside a fixture
    // providing the bridge's service dependencies.
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      '- name: fixture-dependencies',
      "- name: '@deepseek-ai/dsh-im-bridge'",
      '',
    ].join('\n'))

    const dependencies = {
      name: 'fixture-dependencies',
      apply(ctx: Context) {
        ctx.provide('settings', {
          register: () => ({
            get: () => ({ workspaces: [] }),
            watch: () => () => {},
            update: async () => {},
          }),
        } as never)
        for (const service of ['agents', 'agentPresets', 'sessionQuery', 'sessions', 'workspaceRegistry']) {
          ctx.provide(service as never, {} as never)
        }
      },
    }

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['fixture-dependencies', dependencies],
      ['@deepseek-ai/dsh-im-bridge', ImBridgePlugin],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await context.loader.await()
    expect([...context.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
    expect(context.imBridge).toBeInstanceOf(ImBridge)
  })
})
