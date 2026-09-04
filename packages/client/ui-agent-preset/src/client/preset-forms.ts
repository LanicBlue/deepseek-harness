/**
 * Lossless form models for a preset's two files.
 *
 * The form is the friendly face; YAML stays the storage and the escape
 * hatch. That split only works when the form NEVER silently drops content:
 * parsing refuses (returns undefined) any document whose shape the form
 * cannot round-trip exactly — unknown metadata keys, group rows, `!!js`
 * gates, nested children all force the YAML mode — and rendering is the
 * inverse of parsing for everything it accepts. The editor keeps the two
 * file texts as its single source of truth and re-serializes on every form
 * change, so switching modes can never fork state.
 * @module @deepseek-ai/dsh-client-ui-agent-preset/preset-forms
 */

import { load, dump } from 'js-yaml'

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

/** One composition row as a form can edit it: a plain plugin row. */
export interface RowFields {
  id: string
  name: string
  /** The row's config exactly as stored, re-dumped verbatim on render. */
  config?: unknown
  disabled?: boolean
}

/** The composition file as a form can edit it: flat plugin rows only. */
export interface CompositionForm {
  rows: RowFields[]
}

const MODEL_KEYS: ReadonlySet<string> = new Set(['provider', 'model', 'reasoningEffort'])
const METADATA_KEYS: ReadonlySet<string> = new Set([
  'name', 'description', 'order', 'im', 'model', 'modelFallbacks',
])
const ROW_KEYS: ReadonlySet<string> = new Set(['id', 'name', 'config', 'disabled'])

/** Coerce one parsed node into selection fields, or undefined when unusable. */
function selectionFields(value: unknown): ModelSelectionFields | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!MODEL_KEYS.has(key)) return undefined
  }
  const { provider, model, reasoningEffort } = record
  if (typeof provider !== 'string' || typeof model !== 'string') return undefined
  if (provider === '' || model === '') return undefined
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
  return Object.keys(document).length === 0 ? '' : `${dump(document, { lineWidth: -1 })}`
}

/**
 * Parse composition text into the form model.
 * @param text - the stored agent.cordis.yml contents.
 * @returns the form model, or undefined when any row uses a shape the form
 * would drop (group/isolate rows, nested children, `!!js` disabled gates).
 */
export function parseCompositionForm(text: string): CompositionForm | undefined {
  let parsed: unknown
  try {
    parsed = load(text)
  } catch {
    return undefined
  }
  if (parsed === undefined || parsed === null) return { rows: [] }
  if (!Array.isArray(parsed)) return undefined
  const rows: RowFields[] = []
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined
    const record = entry as Record<string, unknown>
    for (const key of Object.keys(record)) {
      if (!ROW_KEYS.has(key)) return undefined
    }
    const { id, name, config, disabled } = record
    if (typeof id !== 'string' || id === '') return undefined
    if (typeof name !== 'string' || name === '') return undefined
    if (disabled !== undefined && typeof disabled !== 'boolean') return undefined
    rows.push({
      id,
      name,
      ...config === undefined ? {} : { config },
      ...disabled === true ? { disabled: true } : {},
    })
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
  return `${dump(form.rows.map(row => ({
    id: row.id,
    name: row.name,
    ...row.config === undefined ? {} : { config: row.config },
    ...row.disabled === true ? { disabled: true } : {},
  })), { lineWidth: -1 })}`
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
  const parsed: unknown = load(text)
  if (parsed === undefined) throw new Error('empty snippet')
  return parsed
}

/**
 * Render one row's config back to snippet text.
 * @param config - the stored config value.
 * @returns the snippet text to edit.
 */
export function renderConfigSnippet(config: unknown): string {
  return `${dump(config, { lineWidth: -1, indent: 2 })}`
}
