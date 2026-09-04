import { describe, expect, it } from 'vitest'
import {
  formRepresents, parseCompositionForm, parseConfigSnippet, parseMetadataForm,
  renderCompositionForm, renderConfigSnippet, renderMetadataForm,
} from '../src/client/preset-forms.ts'

describe('metadata form round-trips', () => {
  it('parses the full shape and renders it back losslessly', () => {
    const text = [
      "name: '冒烟'",
      'description: 端到端用。',
      'order: 90',
      'im: true',
      'model:',
      '  provider: minimax-cn',
      '  model: MiniMax-M3',
      '  reasoningEffort: high',
      'modelFallbacks:',
      '  - provider: zai-coding-cn',
      '    model: glm-5.3',
    ].join('\n')
    const form = parseMetadataForm(text)!

    expect(form).toEqual({
      name: '冒烟',
      description: '端到端用。',
      order: 90,
      im: true,
      model: { provider: 'minimax-cn', model: 'MiniMax-M3', reasoningEffort: 'high' },
      modelFallbacks: [{ provider: 'zai-coding-cn', model: 'glm-5.3' }],
    })
    expect(parseMetadataForm(renderMetadataForm(form))).toEqual(form)
  })

  it('accepts empty and absent documents as the empty form', () => {
    expect(parseMetadataForm('')).toEqual({})
    expect(parseMetadataForm('# only a comment\n')).toEqual({})
    expect(renderMetadataForm({})).toBe('')
  })

  it('refuses documents the form would drop', () => {
    expect(parseMetadataForm('unknown-key: 1\n')).toBeUndefined()
    expect(parseMetadataForm('name: [not, a, string]\n')).toBeUndefined()
    expect(parseMetadataForm('model: plain-string\n')).toBeUndefined()
    expect(parseMetadataForm('model:\n  provider: p\n  extra: 1\n')).toBeUndefined()
    expect(parseMetadataForm('modelFallbacks: not-a-list\n')).toBeUndefined()
  })

  it('round-trips a freshly added, still-empty selection row', () => {
    // The editor re-parses the text on every render, so a just-added fallback
    // (provider/model not filled yet) must not collapse the form back to YAML.
    const draft = { modelFallbacks: [{ provider: '', model: '' }] }
    expect(parseMetadataForm(renderMetadataForm(draft))).toEqual(draft)
    const model = { model: { provider: '', model: '' } }
    expect(parseMetadataForm(renderMetadataForm(model))).toEqual(model)
  })
})

describe('composition form round-trips', () => {
  it('parses flat plugin rows and renders them back losslessly', () => {
    const text = [
      '- id: persona',
      "  name: '@deepseek-ai/dsh-persona'",
      '  config:',
      '    text: You are helpful.',
      '    complete: true',
      '- id: optional',
      "  name: '@deepseek-ai/dsh-tool-bash'",
      '  disabled: true',
    ].join('\n')
    const form = parseCompositionForm(text)!

    expect(form.rows).toHaveLength(2)
    expect(form.rows[0]).toMatchObject({ id: 'persona', name: '@deepseek-ai/dsh-persona' })
    expect(form.rows[0]!.config).toEqual({ text: 'You are helpful.', complete: true })
    expect(form.rows[1]!.disabled).toBe(true)
    expect(parseCompositionForm(renderCompositionForm(form))).toEqual(form)
  })

  it('refuses group rows, nested children, and expression gates', () => {
    expect(parseCompositionForm('- id: g\n  name: cordis:group\n  group: true\n')).toBeUndefined()
    expect(parseCompositionForm('- id: g\n  name: n\n  isolate:\n    terminals: true\n')).toBeUndefined()
    expect(parseCompositionForm('- id: r\n  name: n\n  config:\n    rows:\n      - nested: true\n')).toBeDefined()
    expect(parseCompositionForm('- noIdHere: true\n')).toBeUndefined()
    expect(parseCompositionForm('just: a mapping\n')).toBeUndefined()
  })
})

describe('formRepresents', () => {
  it('needs BOTH documents representable', () => {
    const metadata = 'name: x\n'
    expect(formRepresents(metadata, '- id: a\n  name: n\n')).toBe(true)
    expect(formRepresents(metadata, '- id: a\n  name: n\n  group: true\n')).toBe(false)
    expect(formRepresents('unknown: 1\n', '- id: a\n  name: n\n')).toBe(false)
  })
})

describe('config snippets', () => {
  it('parses and renders row config verbatim', () => {
    const value = parseConfigSnippet('text: hello\nlimit: 3\n')
    expect(value).toEqual({ text: 'hello', limit: 3 })
    expect(parseConfigSnippet(renderConfigSnippet(value))).toEqual(value)
    expect(() => parseConfigSnippet('broken: [')).toThrow()
  })
})
