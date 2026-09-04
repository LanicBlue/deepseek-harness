/**
 * Lossless form models for a preset's two files.
 *
 * The form is the friendly face; YAML stays the storage and the escape
 * hatch. That split only works when the form NEVER silently drops content:
 * parsing refuses (returns undefined) any document whose shape the form
 * cannot round-trip exactly — unknown keys, malformed disabled gates — and
 * rendering is the inverse of parsing for everything it accepts, group rows
 * and `!!js` expression gates included. The editor keeps the two file texts
 * as its single source of truth and re-serializes on every form change, so
 * switching modes can never fork state.
 * @module @deepseek-ai/dsh-client-ui-agent-preset/preset-forms
 */

import { load, dump, JSON_SCHEMA, Type } from 'js-yaml'

/** Whether a value is an inlined `!!js` expression node. */
export function isJsExprNode(data: unknown): data is { __jsExpr: string } {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return false
  const record = data as { __jsExpr?: unknown }
  const keys = Object.keys(record)
  return keys.length === 1 && typeof record.__jsExpr === 'string'
}

/**
 * The entry-list YAML dialect, inlined from the Loader's include plugin
 * (the client cannot import host packages). `!!js` scalars round-trip as
 * `{ __jsExpr }` nodes; the tag literal is byte-identical to the host's
 * `'tag:yaml.org,2002:js'`, so rendered text reloads under the host schema
 * without a rewrite.
 */
const JS_EXPR = new Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: data => typeof data === 'string',
  construct: data => ({ __jsExpr: data }),
  predicate: data => isJsExprNode(data),
  represent: data => (data as { __jsExpr: string })['__jsExpr'],
})

/** The composition dialect: JSON values plus `!!js` expression scalars. */
export const ENTRY_SCHEMA = JSON_SCHEMA.extend(JS_EXPR)

/**
 * Whether a stored value is a plain key map the per-key widgets can edit.
 * Arrays, scalars, and `!!js` nodes answer false — those render through the
 * whole-snippet YAML editor instead.
 */
export function isKeyMap(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !isJsExprNode(value)
}

/** One provider/model/effort answer, as the metadata file stores it. */
export interface ModelSelectionFields {
  provider: string
  model: string
  reasoningEffort?: string
}

/** The metadata file as a form can edit it. */
export interface MetadataForm {
  name?: string
  description?: string
  order?: number
  im?: boolean
  model?: ModelSelectionFields
  modelFallbacks?: ModelSelectionFields[]
}

/** One composition row as a form can edit it: a plugin row or a group. */
export interface RowFields {
  id: string
  name: string
  /** Group-row marker; the YAML `group: true` key. */
  group?: true
  /** A group row's child rows; the YAML `config` array in the stored file. */
  children?: RowFields[]
  /** The row's config exactly as stored, re-dumped verbatim on render. */
  config?: unknown
  /** The group realm declaration, kept verbatim; group rows in practice. */
  isolate?: unknown
  /** Boolean gate, or the source text of a `!!js` expression gate. */
  disabled?: boolean | { js: string }
}

/** The composition file as a form can edit it: flat and group rows. */
export interface CompositionForm {
  rows: RowFields[]
}

const MODEL_KEYS: ReadonlySet<string> = new Set(['provider', 'model', 'reasoningEffort'])
const METADATA_KEYS: ReadonlySet<string> = new Set([
  'name', 'description', 'order', 'im', 'model', 'modelFallbacks',
])
const ROW_KEYS: ReadonlySet<string> = new Set(['id', 'name', 'group', 'config', 'disabled', 'isolate'])

/** Coerce one parsed node into selection fields, or undefined when unusable. */
function selectionFields(value: unknown): ModelSelectionFields | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!MODEL_KEYS.has(key)) return undefined
  }
  const { provider, model, reasoningEffort } = record
  if (typeof provider !== 'string' || typeof model !== 'string') return undefined
  if (reasoningEffort !== undefined && typeof reasoningEffort !== 'string') return undefined
  return {
    provider,
    model,
    ...reasoningEffort === undefined ? {} : { reasoningEffort },
  }
}

/**
 * Parse metadata text into the form model.
 * @param text - the stored preset.yml contents.
 * @returns the form model, or undefined when the document carries anything
 * the form would drop.
 */
export function parseMetadataForm(text: string): MetadataForm | undefined {
  let parsed: unknown
  try {
    parsed = load(text)
  } catch {
    return undefined
  }
  if (parsed === undefined || parsed === null) return {}
  if (typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!METADATA_KEYS.has(key)) return undefined
  }
  const { name, description, order, im, model, modelFallbacks } = record
  if (name !== undefined && typeof name !== 'string') return undefined
  if (description !== undefined && typeof description !== 'string') return undefined
  if (order !== undefined && (typeof order !== 'number' || !Number.isFinite(order))) return undefined
  if (im !== undefined && typeof im !== 'boolean') return undefined
  const modelFields = model === undefined ? undefined : selectionFields(model)
  if (model !== undefined && modelFields === undefined) return undefined
  let fallbacks: ModelSelectionFields[] | undefined
  if (modelFallbacks !== undefined) {
    if (!Array.isArray(modelFallbacks)) return undefined
    fallbacks = []
    for (const entry of modelFallbacks) {
      const fields = selectionFields(entry)
      if (fields === undefined) return undefined
      fallbacks.push(fields)
    }
  }
  return {
    ...name === undefined || name === '' ? {} : { name },
    ...description === undefined || description === '' ? {} : { description },
    ...order === undefined ? {} : { order },
    ...im === true ? { im: true } : {},
    ...modelFields === undefined ? {} : { model: modelFields },
    ...fallbacks === undefined || fallbacks.length === 0 ? {} : { modelFallbacks: fallbacks },
  }
}

/**
 * Render the form model back to metadata text.
 * @param form - the form's current values.
 * @returns the preset.yml contents to store.
 */
export function renderMetadataForm(form: MetadataForm): string {
  const document: Record<string, unknown> = {
    ...form.name === undefined || form.name === '' ? {} : { name: form.name },
    ...form.description === undefined || form.description === '' ? {} : { description: form.description },
    ...form.order === undefined ? {} : { order: form.order },
    ...form.im === true ? { im: true } : {},
    ...form.model === undefined ? {} : { model: form.model },
    ...form.modelFallbacks === undefined || form.modelFallbacks.length === 0
      ? {}
      : { modelFallbacks: form.modelFallbacks },
  }
  return Object.keys(document).length === 0 ? '' : `${dump(document, { schema: ENTRY_SCHEMA, lineWidth: -1 })}`
}

/** Parse one stored row (and, recursively, its children) into form fields. */
function parseRowFields(entry: unknown): RowFields | undefined {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined
  const record = entry as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!ROW_KEYS.has(key)) return undefined
  }
  const { id, name, group, config, isolate, disabled } = record
  // Draft-row semantics: empty ids and names round-trip, exactly like the
  // metadata form's empty selection rows.
  if (typeof id !== 'string' || typeof name !== 'string') return undefined
  let children: RowFields[] | undefined
  let rowConfig: unknown
  if (group === true) {
    // A group row's config is not plain config: it is the child-row list.
    if (!Array.isArray(config)) return undefined
    children = []
    for (const child of config) {
      const parsed = parseRowFields(child)
      if (parsed === undefined) return undefined
      children.push(parsed)
    }
  } else {
    if (group !== undefined) return undefined
    rowConfig = config
  }
  let disabledField: true | { js: string } | undefined
  if (disabled === undefined || typeof disabled === 'boolean') {
    disabledField = disabled === true ? true : undefined
  } else if (isJsExprNode(disabled)) {
    disabledField = { js: disabled.__jsExpr }
  } else {
    return undefined
  }
  return {
    id,
    name,
    ...group === true ? { group: true } : {},
    ...children === undefined ? {} : { children },
    ...rowConfig === undefined ? {} : { config: rowConfig },
    ...isolate === undefined ? {} : { isolate },
    ...disabledField === undefined ? {} : { disabled: disabledField },
  }
}

/** Render one row's fields back to its stored YAML record. */
function renderRowFields(row: RowFields): Record<string, unknown> {
  const disabled = row.disabled === undefined
    ? {}
    : typeof row.disabled === 'object'
      ? { disabled: { __jsExpr: row.disabled.js } }
      : { disabled: row.disabled }
  if (row.group === true) {
    return {
      id: row.id,
      name: row.name,
      group: true,
      ...row.isolate === undefined ? {} : { isolate: row.isolate },
      config: (row.children ?? []).map(renderRowFields),
      ...disabled,
    }
  }
  return {
    id: row.id,
    name: row.name,
    ...row.isolate === undefined ? {} : { isolate: row.isolate },
    ...row.config === undefined ? {} : { config: row.config },
    ...disabled,
  }
}

/**
 * Parse composition text into the form model.
 * @param text - the stored agent.cordis.yml contents.
 * @returns the form model, or undefined when any row uses a shape the form
 * would drop (an unknown key, a malformed disabled gate, a group row whose
 * config is not a child-row list).
 */
export function parseCompositionForm(text: string): CompositionForm | undefined {
  let parsed: unknown
  try {
    parsed = load(text, { schema: ENTRY_SCHEMA })
  } catch {
    return undefined
  }
  if (parsed === undefined || parsed === null) return { rows: [] }
  if (!Array.isArray(parsed)) return undefined
  const rows: RowFields[] = []
  for (const entry of parsed) {
    const row = parseRowFields(entry)
    if (row === undefined) return undefined
    rows.push(row)
  }
  return { rows }
}

/**
 * Render the form model back to composition text.
 * @param form - the form's current rows.
 * @returns the agent.cordis.yml contents to store.
 */
export function renderCompositionForm(form: CompositionForm): string {
  if (form.rows.length === 0) return ''
  return `${dump(form.rows.map(renderRowFields), { schema: ENTRY_SCHEMA, lineWidth: -1 })}`
}

/**
 * Whether both stored files are form-editable for one preset.
 * @param metadata - the stored preset.yml text.
 * @param composition - the stored agent.cordis.yml text.
 * @returns true when the form can show and round-trip both documents.
 */
export function formRepresents(metadata: string, composition: string): boolean {
  return parseMetadataForm(metadata) !== undefined && parseCompositionForm(composition) !== undefined
}

/**
 * Parse one row's config snippet (the form's per-row YAML editor).
 * @param text - the snippet as typed.
 * @returns the parsed config value.
 * @throws when the snippet is not valid YAML.
 */
export function parseConfigSnippet(text: string): unknown {
  const parsed: unknown = load(text, { schema: ENTRY_SCHEMA })
  if (parsed === undefined) throw new Error('empty snippet')
  return parsed
}

/**
 * Render one row's config back to snippet text.
 * @param config - the stored config value.
 * @returns the snippet text to edit.
 */
export function renderConfigSnippet(config: unknown): string {
  return `${dump(config, { schema: ENTRY_SCHEMA, lineWidth: -1, indent: 2 })}`
}
