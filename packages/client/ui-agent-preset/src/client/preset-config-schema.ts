/**
 * Package-aware config schemas for the composition form.
 *
 * The form's promise is still losslessness: this catalog only decides how a
 * known key is EDITED, never what is kept. Classification splits a row's
 * config into widget fields (booleans, enums, numbers, prompt text, `!!js`
 * expressions) and an `advanced` record holding everything else — unknown
 * keys, values whose type does not match the catalog, and keys deliberately
 * kept out of the friendly face (long tool descriptions). The advanced record
 * round-trips verbatim through the YAML escape hatch.
 * @module @deepseek-ai/dsh-client-ui-agent-preset/preset-config-schema
 */

import { isJsExprNode, isKeyMap } from './preset-forms.ts'

/** One known config key and the control it is edited with. */
export type ConfigField =
  | { key: string; kind: 'boolean' }
  | { key: string; kind: 'number' }
  | { key: string; kind: 'enum'; options: readonly string[] }
  | { key: string; kind: 'text' }
  /** A long prompt text (persona, plan-mode section) — the allowed free text. */
  | { key: string; kind: 'prompt' }
  /** A `!!js` expression node. */
  | { key: string; kind: 'js' }
  /** Kept verbatim, edited only through the advanced fold. */
  | { key: string; kind: 'advanced' }

/** The catalog entry for one plugin package. */
export interface PackageSchema {
  fields: readonly ConfigField[]
}

/**
 * Config schemas for the packages the bundled presets compose. A package
 * missing here is not a error — its whole config simply edits through the
 * generic key lines and the advanced fold.
 */
export const PACKAGE_SCHEMAS: Readonly<Record<string, PackageSchema>> = {
  '@deepseek-ai/dsh-persona': {
    fields: [
      { key: 'text', kind: 'prompt' },
      { key: 'complete', kind: 'boolean' },
      { key: 'includeRuntimeContext', kind: 'boolean' },
    ],
  },
  '@deepseek-ai/dsh-terminal': { fields: [] },
  '@deepseek-ai/dsh-terminal-bash': {
    fields: [
      { key: 'shellDialect', kind: 'enum', options: ['bash', 'pwsh'] },
      { key: 'timeoutMs', kind: 'number' },
      { key: 'description', kind: 'advanced' },
    ],
  },
  '@deepseek-ai/dsh-tool-bash-persistent': {
    fields: [
      { key: 'timeoutMs', kind: 'number' },
      { key: 'description', kind: 'advanced' },
    ],
  },
  '@deepseek-ai/dsh-tool-pwsh-persistent': {
    fields: [
      { key: 'timeoutMs', kind: 'number' },
      { key: 'description', kind: 'advanced' },
    ],
  },
  '@deepseek-ai/dsh-fs-local': {
    fields: [{ key: 'cwd', kind: 'js' }],
  },
  '@deepseek-ai/dsh-tool-str-replace-editor': {
    fields: [{ key: 'maxOutputChars', kind: 'number' }],
  },
  '@deepseek-ai/dsh-tool-subagent': {
    fields: [
      { key: 'provider', kind: 'enum', options: ['spawn', 'fork', 'codex', 'claude-code'] },
      { key: 'toolName', kind: 'text' },
      { key: 'modelSelectionSettings', kind: 'boolean' },
      { key: 'backgroundMode', kind: 'enum', options: ['one-shot', 'continuable'] },
      { key: 'maxDepth', kind: 'advanced' },
    ],
  },
  '@deepseek-ai/dsh-tool-todo': {
    fields: [{ key: 'allowParallelInProgress', kind: 'boolean' }],
  },
  '@deepseek-ai/dsh-tool-web': {
    fields: [
      { key: 'fetch', kind: 'boolean' },
      { key: 'searchTimeoutMs', kind: 'number' },
    ],
  },
  '@deepseek-ai/dsh-tool-fs-search': {
    fields: [{ key: 'sampleOverCapGlobResults', kind: 'boolean' }],
  },
  '@deepseek-ai/dsh-tool-ralph': {
    fields: [
      { key: 'subagentProvider', kind: 'enum', options: ['spawn', 'fork'] },
      { key: 'maxRounds', kind: 'number' },
    ],
  },
  '@deepseek-ai/dsh-workflow-worker-thread': {
    fields: [{ key: 'provider', kind: 'enum', options: ['spawn', 'fork'] }],
  },
  '@deepseek-ai/dsh-agent-tool-presentation': {
    fields: [{ key: 'mode', kind: 'enum', options: ['native', 'ptc', 'both'] }],
  },
  '@deepseek-ai/dsh-compaction-tool-result-pruner': {
    fields: [
      { key: 'thresholdChars', kind: 'number' },
      { key: 'headChars', kind: 'number' },
      { key: 'tailChars', kind: 'number' },
    ],
  },
  '@deepseek-ai/dsh-agent-instructions': {
    fields: [{ key: 'maxBytes', kind: 'number' }],
  },
  '@deepseek-ai/dsh-plan-mode': {
    fields: [{ key: 'section', kind: 'prompt' }],
  },
  '@deepseek-ai/dsh-skill-filesystem': {
    fields: [{ key: 'customSkillDirs', kind: 'advanced' }],
  },
}

/** The package names every composition's picker offers, sorted. */
export const KNOWN_PACKAGES: readonly string[] =
  Object.keys(PACKAGE_SCHEMAS).sort()

/**
 * The schema for one package name, or undefined when the form does not know
 * it (custom packages edit generically).
 */
export function packageSchema(name: string): PackageSchema | undefined {
  return PACKAGE_SCHEMAS[name]
}

/** A row id suggested from a package name (`…/dsh-tool-todo` → `tool-todo`). */
export function shortPackageId(name: string): string {
  const marker = name.lastIndexOf('/')
  const tail = marker === -1 ? name : name.slice(marker + 1)
  return tail.startsWith('dsh-') ? tail.slice(4) : tail
}

/** One widget field as classification hands it to the form. */
export interface ClassifiedField {
  field: ConfigField
  value: unknown
}

/** A row config split into widget fields and the verbatim advanced rest. */
export interface ClassifiedConfig {
  fields: ClassifiedField[]
  /** Everything the friendly face does not edit directly. */
  advanced: Record<string, unknown>
  /** False when the config is not a plain key map at all (snippet fallback). */
  mapped: boolean
}

/** Whether a value can be edited by a field of this kind. */
function matchesKind(value: unknown, field: ConfigField): boolean {
  switch (field.kind) {
    case 'boolean': return typeof value === 'boolean'
    case 'number': return typeof value === 'number'
    case 'enum': case 'text': case 'prompt': return typeof value === 'string'
    case 'js': return isJsExprNode(value)
    case 'advanced': return false
  }
}

/**
 * Split one row's config for the form.
 * @param name - the row's plugin package name.
 * @param config - the stored config value.
 * @returns the widget fields in schema order plus the advanced rest; a
 * config that is not a key map answers `mapped: false`.
 */
export function classifyConfig(name: string, config: unknown): ClassifiedConfig {
  if (config === undefined) return { fields: [], advanced: {}, mapped: true }
  if (!isKeyMap(config)) return { fields: [], advanced: {}, mapped: false }
  const schema = packageSchema(name)
  const fields: ClassifiedField[] = []
  const advanced: Record<string, unknown> = {}
  if (schema === undefined) {
    Object.assign(advanced, config)
    return { fields, advanced, mapped: true }
  }
  const covered = new Set(schema.fields.map(field => field.key))
  for (const field of schema.fields) {
    if (field.key in config) {
      const value = config[field.key]
      if (matchesKind(value, field)) fields.push({ field, value })
      else advanced[field.key] = value
    }
  }
  for (const key of Object.keys(config)) {
    if (!covered.has(key)) advanced[key] = config[key]
  }
  return { fields, advanced, mapped: true }
}
