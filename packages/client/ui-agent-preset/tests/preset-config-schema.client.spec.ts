import { describe, expect, it } from 'vitest'
import {
  KNOWN_PACKAGES, classifyConfig, packageSchema, shortPackageId,
} from '../src/client/preset-config-schema.ts'

describe('package config schemas', () => {
  it('classifies a persona config into widget fields in schema order', () => {
    const c = classifyConfig('@deepseek-ai/dsh-persona', {
      text: 'You are a helpful engineer.',
      complete: true,
      includeRuntimeContext: false,
    })
    expect(c.mapped).toBe(true)
    expect(c.fields.map(f => f.field.key)).toEqual(['text', 'complete', 'includeRuntimeContext'])
    expect(c.fields.map(f => f.field.kind)).toEqual(['prompt', 'boolean', 'boolean'])
    expect(c.advanced).toEqual({})
  })

  it('routes unknown keys and type mismatches to the advanced record verbatim', () => {
    const c = classifyConfig('@deepseek-ai/dsh-terminal-bash', { timeoutMs: 'soon', extra: { nested: 1 } })
    expect(c.fields.map(f => f.field.key)).toEqual([])
    expect(c.advanced).toEqual({ timeoutMs: 'soon', extra: { nested: 1 } })
  })

  it('edits a js expression as a widget and keeps advanced keys in config order', () => {
    const c = classifyConfig('@deepseek-ai/dsh-fs-local', {
      description: 'long docs',
      cwd: { __jsExpr: 'process.cwd()' },
    })
    expect(c.fields.map(f => f.field.key)).toEqual(['cwd'])
    expect(c.fields[0]?.value).toEqual({ __jsExpr: 'process.cwd()' })
    expect(Object.keys(c.advanced)).toEqual(['description'])
  })

  it('answers mapped false for non-map configs and routes unknown packages to advanced', () => {
    expect(classifyConfig('@deepseek-ai/dsh-terminal', [1, 2]).mapped).toBe(false)
    expect(classifyConfig('@deepseek-ai/dsh-terminal', undefined).advanced).toEqual({})
    const c = classifyConfig('my-own/pkg', { a: 1 })
    expect(c.fields).toEqual([])
    expect(c.advanced).toEqual({ a: 1 })
  })

  it('suggests row ids from package names and keeps the catalog sorted', () => {
    expect(shortPackageId('@deepseek-ai/dsh-tool-todo')).toBe('tool-todo')
    expect(shortPackageId('@deepseek-ai/dsh-persona')).toBe('persona')
    expect(shortPackageId('cordis:group')).toBe('cordis:group')
    expect([...KNOWN_PACKAGES]).toEqual([...KNOWN_PACKAGES].sort())
    expect(packageSchema('@deepseek-ai/dsh-tool-web')?.fields.map(f => f.key)).toEqual(['fetch', 'searchTimeoutMs'])
    expect(packageSchema('nobody-knows/me')).toBeUndefined()
  })
})
