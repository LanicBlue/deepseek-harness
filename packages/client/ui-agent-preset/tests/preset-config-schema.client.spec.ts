import { describe, expect, it } from 'vitest'
import {
  KNOWN_PACKAGES, MODULE_ORDER, classifyConfig, moduleOf, packageSchema, shortPackageId,
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

describe('module classification', () => {
  it('puts prompt packages under 提示词 and tool packages under 工具', () => {
    expect(moduleOf({ id: 'persona', name: '@deepseek-ai/dsh-persona' })).toBe('prompt')
    expect(moduleOf({ id: 'plan', name: '@deepseek-ai/dsh-plan-mode' })).toBe('prompt')
    expect(moduleOf({ id: 'b', name: '@deepseek-ai/dsh-tool-bash' })).toBe('tools')
    expect(moduleOf({ id: 't', name: '@deepseek-ai/dsh-terminal-bash' })).toBe('tools')
    expect(moduleOf({ id: 'f', name: '@deepseek-ai/dsh-fs-local' })).toBe('tools')
    expect(moduleOf({ id: 's', name: '@deepseek-ai/dsh-skill-filesystem' })).toBe('tools')
  })

  it('puts known non-tool packages under 运行时 and the rest under 高级', () => {
    expect(moduleOf({ id: 'c', name: '@deepseek-ai/dsh-compaction-basic' })).toBe('runtime')
    expect(moduleOf({ id: 'p', name: '@deepseek-ai/dsh-agent-tool-presentation' })).toBe('runtime')
    expect(moduleOf({ id: 'x', name: 'my-own/pkg' })).toBe('advanced')
    expect(moduleOf({ id: '', name: '' })).toBe('advanced')
  })

  it('a group row follows its first meaningful child', () => {
    expect(moduleOf({
      id: 'shell', name: 'cordis:group', group: true,
      children: [{ id: 'pty', name: '@deepseek-ai/dsh-terminal' }],
    })).toBe('tools')
    expect(moduleOf({ id: 'g', name: 'cordis:group', group: true, children: [] })).toBe('tools')
  })

  it('exposes exactly the four modules in display order', () => {
    expect(MODULE_ORDER).toEqual(['prompt', 'tools', 'runtime', 'advanced'])
  })
})
