/**
 * A preset's display metadata: the name and description a picker shows.
 *
 * It lives in its own file because the composition is a top-level list of
 * plugin rows — YAML cannot carry sibling keys beside it, and faking a
 * metadata row would hand the Loader something to load. Keeping it separate
 * also keeps the composition exactly what its name says: a Cordis file the
 * loader owns and the cordis preset can author.
 *
 * The file carries display text ONLY. `id` is the directory name and `trust`
 * comes from the root a preset was discovered under, so neither is writable
 * here — otherwise a locally authored preset could claim to be a shipped one.
 *
 * Every read failure degrades to no metadata. A preset whose display text is
 * missing, malformed, or unreadable still mounts: presentation is not a
 * capability, and a broken name must never become an agent that cannot start.
 * @module @deepseek-ai/dsh-agent-presets/metadata
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import yaml from 'js-yaml'

/** The optional display-metadata file beside a preset's composition. */
export const METADATA_FILE = 'preset.yml'

/** Display text a preset may publish about itself. */
export interface PresetMetadata {
  /** Human-facing name; falls back to the preset id when absent. */
  readonly name?: string
  /** One sentence on what this preset is for. */
  readonly description?: string
  /**
   * Position within its group; lower comes first. A preset that declares
   * none sorts after every preset that does, then by id — so the shipped set
   * can read in capability order while authored ones stay alphabetical.
   */
  readonly order?: number
  /**
   * Opt the preset into the InfiniteMission bridge: the bridge joins one
   * `dsh-<preset>` member per configured IM workspace and routes that
   * member's mission arrivals into a Session composed from this preset.
   * Display text stays optional exactly like the rest — a broken or absent
   * flag never blocks mounting, it just leaves the preset unbridged.
   */
  readonly im?: boolean
  /**
   * Default model for sessions composed from this preset. Applies only when
   * nothing stronger chose first — a UI model pick and the session's logged
   * request header both win — and only while the provider route is actually
   * registered; otherwise the chain falls through {@link modelFallbacks} and
   * finally the host's global default model.
   */
  readonly model?: PresetModelSelection
  /** Additional models tried, in order, when {@link model} is unusable. */
  readonly modelFallbacks?: readonly PresetModelSelection[]
}

/** One provider/model/effort answer a preset may default to. */
export interface PresetModelSelection {
  /** Registered provider route. */
  readonly provider: string
  /** Provider-owned model id. */
  readonly model: string
  /** Adapter-owned reasoning effort, or provider/default behavior when absent. */
  readonly reasoningEffort?: string
}

/**
 * Coerce one untrusted value into a model selection, or undefined.
 * @param value - the parsed YAML node.
 * @returns the validated selection, or undefined for anything unusable.
 */
function modelSelection(value: unknown): PresetModelSelection | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const provider = text(record.provider)
  const model = text(record.model)
  if (provider === undefined || model === undefined) return undefined
  const effort = text(record.reasoningEffort)
  return {
    provider,
    model,
    ...effort === undefined ? {} : { reasoningEffort: effort },
  }
}

/** A non-empty trimmed string, or undefined for anything else. */
function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * Read one preset directory's display metadata.
 *
 * Absent, unparsable, and wrongly-shaped files are all the same answer —
 * empty metadata — because the caller renders a picker, not a diagnostic.
 * @param directory - the preset directory.
 * @returns the display text the preset published, possibly empty.
 */
export async function readPresetMetadata(directory: string): Promise<PresetMetadata> {
  let raw: string
  try {
    raw = await readFile(join(directory, METADATA_FILE), 'utf8')
  } catch {
    // Absent is the common case: metadata is optional and most presets,
    // including every one authored by duplicating another, carry none.
    return {}
  }
  let parsed: unknown
  try {
    parsed = yaml.load(raw)
  } catch {
    // Malformed display text is not worth failing discovery over; the picker
    // falls back to the id, and the composition still mounts.
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  const record = parsed as Record<string, unknown>
  const name = text(record.name)
  const description = text(record.description)
  const order = typeof record.order === 'number' && Number.isFinite(record.order)
    ? record.order
    : undefined
  const im = record.im === true
  const model = modelSelection(record.model)
  const fallbacks = Array.isArray(record.modelFallbacks)
    ? record.modelFallbacks.map(modelSelection).filter((v): v is PresetModelSelection => v !== undefined)
    : undefined
  return {
    ...name === undefined ? {} : { name },
    ...description === undefined ? {} : { description },
    ...order === undefined ? {} : { order },
    ...im ? { im: true } : {},
    ...model === undefined ? {} : { model },
    ...fallbacks === undefined || fallbacks.length === 0 ? {} : { modelFallbacks: fallbacks },
  }
}

/**
 * Render display metadata as the file's contents.
 *
 * Absent fields are omitted rather than written empty, so a preset with no
 * description does not ship a key that reads as an intentional blank.
 * @param metadata - the display text to store.
 * @returns the YAML document, or undefined when there is nothing to store.
 */
export function renderPresetMetadata(metadata: PresetMetadata): string | undefined {
  const name = text(metadata.name)
  const description = text(metadata.description)
  const { order } = metadata
  const model = modelSelection(metadata.model)
  const fallbacks = metadata.modelFallbacks === undefined
    ? undefined
    : metadata.modelFallbacks.map(modelSelection).filter((v): v is PresetModelSelection => v !== undefined)
  if (name === undefined && description === undefined && order === undefined
    && metadata.im !== true && model === undefined && (fallbacks === undefined || fallbacks.length === 0)) {
    return undefined
  }
  return yaml.dump({
    ...name === undefined ? {} : { name },
    ...description === undefined ? {} : { description },
    ...order === undefined ? {} : { order },
    ...metadata.im === true ? { im: true } : {},
    ...model === undefined ? {} : { model },
    ...fallbacks === undefined || fallbacks.length === 0 ? {} : { modelFallbacks: fallbacks },
  }, { lineWidth: -1 })
}
