import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'
import {
  type CompositionForm, ENTRY_SCHEMA, formRepresents, isJsExprNode, isKeyMap, parseCompositionForm,
  parseConfigSnippet, parseMetadataForm, renderCompositionForm, renderConfigSnippet, renderMetadataForm,
} from '../src/client/preset-forms.ts'

describe('value-shape helpers for the per-key widgets', () => {
  it('isKeyMap accepts plain maps only — arrays, js nodes, scalars, null answer false', () => {
    expect(isKeyMap({ timeoutMs: 300000 })).toBe(true)
    expect(isKeyMap([])).toBe(false)
    expect(isKeyMap({ __jsExpr: 'process.cwd()' })).toBe(false)
    expect(isKeyMap('text')).toBe(false)
    expect(isKeyMap(300000)).toBe(false)
    expect(isKeyMap(null)).toBe(false)
    expect(isKeyMap(undefined)).toBe(false)
  })

  it('isJsExprNode accepts a single-key __jsExpr node only', () => {
    expect(isJsExprNode({ __jsExpr: 'process.platform === "win32"' })).toBe(true)
    expect(isJsExprNode({ __jsExpr: 'x', extra: 1 })).toBe(false)
    expect(isJsExprNode({ __jsExpr: 3 })).toBe(false)
    expect(isJsExprNode(null)).toBe(false)
  })

  it('a !!js config value survives the snippet pipeline as an expression node', () => {
    const parsed = parseConfigSnippet('cwd: !!js process.env.DSH_CWD ?? process.cwd()')
    expect(isKeyMap(parsed)).toBe(true)
    expect(isJsExprNode((parsed as Record<string, unknown>).cwd)).toBe(true)
    expect(renderConfigSnippet(parsed)).toContain('cwd: !!js process.env.DSH_CWD ?? process.cwd()')
  })
})

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

  it('represents group rows, isolate declarations, and expression gates', () => {
    const group = parseCompositionForm(
      '- id: g\n  name: cordis:group\n  group: true\n  isolate:\n    terminals: true\n  config:\n    - id: c\n      name: n\n      disabled: !!js process.platform === \'win32\'\n',
    )
    expect(group).toEqual({
      rows: [{
        id: 'g',
        name: 'cordis:group',
        group: true,
        isolate: { terminals: true },
        children: [{ id: 'c', name: 'n', disabled: { js: "process.platform === 'win32'" } }],
      }],
    })
    expect(parseCompositionForm(renderCompositionForm(group!))).toEqual(group)
    // Nested maps inside a plain row's config stay plain config.
    expect(parseCompositionForm('- id: r\n  name: n\n  config:\n    rows:\n      - nested: true\n')).toBeDefined()
  })

  it('round-trips freshly added, still-empty draft rows', () => {
    // An added row (id/name not filled yet) must not collapse the form to YAML.
    const draft = { rows: [{ id: '', name: '' }] }
    expect(parseCompositionForm(renderCompositionForm(draft))).toEqual(draft)
    const groupDraft: CompositionForm = {
      rows: [{ id: '', name: '', group: true, children: [{ id: '', name: '' }] }],
    }
    expect(parseCompositionForm(renderCompositionForm(groupDraft))).toEqual(groupDraft)
  })

  it('refuses shapes the form would drop', () => {
    expect(parseCompositionForm('- id: r\n  name: n\n  unknown: 1\n')).toBeUndefined()
    expect(parseCompositionForm('- id: r\n  name: n\n  disabled: 123\n')).toBeUndefined()
    expect(parseCompositionForm('- id: r\n  name: n\n  disabled: [true]\n')).toBeUndefined()
    expect(parseCompositionForm('- id: g\n  name: n\n  group: true\n')).toBeUndefined()
    expect(parseCompositionForm('- id: g\n  name: n\n  group: true\n  config: not-a-list\n')).toBeUndefined()
    expect(parseCompositionForm('- id: g\n  name: n\n  group: yes\n')).toBeUndefined()
    expect(parseCompositionForm('- id: g\n  name: n\n  group: true\n  config:\n    - noIdHere: true\n')).toBeUndefined()
    expect(parseCompositionForm('- noIdHere: true\n')).toBeUndefined()
    expect(parseCompositionForm('just: a mapping\n')).toBeUndefined()
  })
})

describe('imsmoke composition fragments', () => {
  // Real fragments of ~/.dsh/.agent-presets/imsmoke/agent.cordis.yml, trimmed
  // to the structural surface (specs must not read $HOME): two group rows with
  // isolate realms, nested children, boolean and `!!js` disabled gates, a
  // block-scalar config, and a `!!js` expression inside a config value.
  const IMSMOKE = [
    '- id: persona',
    "  name: '@deepseek-ai/dsh-persona'",
    '  config:',
    '    text: You are a helpful software engineer assistant.',
    '    complete: true',
    '- id: persistent-shell',
    '  name: cordis:group',
    '  group: true',
    '  isolate:',
    '    terminals: true',
    '  config:',
    '    - id: pty',
    "      name: '@deepseek-ai/dsh-terminal'",
    '    - id: terminal-bash',
    "      name: '@deepseek-ai/dsh-terminal-bash'",
    "      disabled: !!js process.platform === 'win32'",
    '      config:',
    '        timeoutMs: 300000',
    '    - id: persistent-bash',
    "      name: '@deepseek-ai/dsh-tool-bash-persistent'",
    "      disabled: !!js process.platform === 'win32'",
    '      config:',
    '        timeoutMs: 300000',
    '        description: |-',
    '          Run commands in a bash shell',
    '          * State is persistent across command calls and discussions with the user.',
    '    - id: terminal-pwsh',
    "      name: '@deepseek-ai/dsh-terminal-bash'",
    "      disabled: !!js process.platform !== 'win32'",
    '      config:',
    '        shellDialect: pwsh',
    '        timeoutMs: 300000',
    '    - id: persistent-pwsh',
    "      name: '@deepseek-ai/dsh-tool-pwsh-persistent'",
    "      disabled: !!js process.platform !== 'win32'",
    '      config:',
    '        timeoutMs: 300000',
    '- id: filesystem',
    '  name: cordis:group',
    '  group: true',
    '  isolate:',
    '    fs: true',
    '  config:',
    '    - id: fs-local',
    "      name: '@deepseek-ai/dsh-fs-local'",
    '      config:',
    '        cwd: !!js process.env.DSH_CWD ?? process.cwd()',
    '    - id: str-replace-editor',
    "      name: '@deepseek-ai/dsh-tool-str-replace-editor'",
    '      config:',
    '        maxOutputChars: 16000',
  ].join('\n') + '\n'

  it('parse∘render is the identity on the real fragment set', () => {
    const form = parseCompositionForm(IMSMOKE)!
    expect(form).toBeDefined()
    expect(form.rows).toHaveLength(3)
    const shell = form.rows[1]!
    expect(shell.group).toBe(true)
    expect(shell.isolate).toEqual({ terminals: true })
    expect(shell.children).toHaveLength(5)
    expect(shell.children![1]!.disabled).toEqual({ js: "process.platform === 'win32'" })
    expect(form.rows[2]!.children![0]!.config)
      .toEqual({ cwd: { __jsExpr: 'process.env.DSH_CWD ?? process.cwd()' } })
    expect(parseCompositionForm(renderCompositionForm(form))).toEqual(form)
  })

  it('the rendered text reloads under the entry dialect structure-equal to the first parse', () => {
    const form = parseCompositionForm(IMSMOKE)!
    const rendered = renderCompositionForm(form)
    const reloaded = load(rendered, { schema: ENTRY_SCHEMA })
    // The stored shape: children under `config`, `!!js` gates as expression nodes.
    const direct = load(IMSMOKE, { schema: ENTRY_SCHEMA })
    expect(reloaded).toEqual(direct)
    // And the `!!js` tag survives the round trip literally in the text.
    expect(rendered).toContain("disabled: !!js process.platform === 'win32'")
    expect(rendered).toContain('cwd: !!js process.env.DSH_CWD ?? process.cwd()')
  })
})

describe('formRepresents', () => {
  it('needs BOTH documents representable', () => {
    const metadata = 'name: x\n'
    expect(formRepresents(metadata, '- id: a\n  name: n\n')).toBe(true)
    expect(formRepresents(metadata, '- id: a\n  name: n\n  group: true\n  config: []\n')).toBe(true)
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

  it('round-trips `!!js` expression values in the entry dialect', () => {
    const value = parseConfigSnippet('cwd: !!js process.env.X ?? process.cwd()\n')
    expect(value).toEqual({ cwd: { __jsExpr: 'process.env.X ?? process.cwd()' } })
    expect(renderConfigSnippet(value)).toContain('cwd: !!js process.env.X ?? process.cwd()')
  })
})
