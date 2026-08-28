/**
 * Model-facing view types for the WK tools: tolerant projections of WK wire
 * payloads. Extractors keep unknown JSON at the boundary so a WK field
 * addition never breaks a tool call.
 *
 * @module @deepseek-ai/dsh-tool-wk/types
 */

/** One full-text search hit. */
export interface WkSearchHitView {
  readonly nodeId: string
  readonly rootId: string
  readonly name?: string
  readonly path: string
  readonly score?: number
  readonly snippet?: string
}

/** One knowledge root (tree). */
export interface WkRootView {
  readonly rootId: string
  readonly name: string
  readonly path?: string
  readonly retired: boolean
}

/** One wiki node with content. */
export interface WkNodeView {
  readonly nodeId: string
  readonly rootId: string
  readonly name?: string
  readonly path?: string
  readonly contentType?: string
  readonly content?: string
}

/** One project-tree source-search hit. */
export interface WkSourceHitView {
  readonly path: string
  readonly line?: number
  readonly excerpt?: string
}

/** One project-tree source file read. */
export interface WkSourceReadView {
  readonly treeName: string
  readonly path: string
  readonly startLine?: number
  readonly endLine?: number
  readonly text: string
}

/**
 *  Read a string field, or `undefined` for anything else.
 * @param value - a wire field.
 * @returns the string, or `undefined` for anything else.
*/
export function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 *  Read a finite number field, or `undefined` for anything else.
 * @param value - a wire field.
 * @returns the finite number, or `undefined` for anything else.
*/
export function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 *  Read a positive-integer field, or `undefined` for anything else.
 * @param value - a wire field.
 * @returns the non-negative safe integer, or `undefined` for anything else.
*/
export function int(value: unknown): number | undefined {
  const parsed = num(value)
  return parsed !== undefined && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined
}

/**
 *  Project one raw search hit onto the model-facing view (lossless-JSON safe).
 * @param raw - one raw wire hit.
 * @returns the projected view, or `undefined` when malformed.
*/
export function searchHitOf(raw: unknown): WkSearchHitView | undefined {
  if (raw === undefined || typeof raw !== 'object') return undefined
  const nodeRef = (raw as { nodeRef?: unknown }).nodeRef
  const rootRef = (raw as { rootRef?: unknown }).rootRef
  const nodeId = str(nodeRef !== undefined && typeof nodeRef === 'object' ? (nodeRef as { nodeId?: unknown }).nodeId : undefined)
  const rootId = str(rootRef !== undefined && typeof rootRef === 'object' ? (rootRef as { rootId?: unknown }).rootId : undefined)
  const path = str((raw as { path?: unknown }).path)
  if (nodeId === undefined || rootId === undefined || path === undefined) return undefined
  const name = str((raw as { name?: unknown }).name)
  const score = num((raw as { score?: unknown }).score)
  const snippet = str((raw as { snippet?: unknown }).snippet)
  return {
    nodeId,
    rootId,
    ...name !== undefined ? { name } : {},
    path,
    ...score !== undefined ? { score } : {},
    ...snippet !== undefined ? { snippet } : {},
  }
}

/**
 *  Project one raw root record onto the model-facing view (lossless-JSON safe).
 * @param raw - one raw wire root record.
 * @returns the projected view, or `undefined` when malformed.
*/
export function rootViewOf(raw: unknown): WkRootView | undefined {
  if (raw === undefined || typeof raw !== 'object') return undefined
  const rootRef = (raw as { rootRef?: unknown }).rootRef
  const rootId = str(rootRef !== undefined && typeof rootRef === 'object' ? (rootRef as { rootId?: unknown }).rootId : undefined)
  const name = str((raw as { name?: unknown }).name) ?? str((raw as { displayName?: unknown }).displayName)
  if (rootId === undefined || name === undefined) return undefined
  const path = str((raw as { path?: unknown }).path)
  return {
    rootId,
    name,
    ...path !== undefined ? { path } : {},
    retired: (raw as { retired?: unknown }).retired === true,
  }
}

/**
 *  Project one raw node view onto the model-facing view (lossless-JSON safe).
 * @param raw - one raw wire node view.
 * @returns the projected view, or `undefined` when malformed.
*/
export function nodeViewOf(raw: unknown): WkNodeView | undefined {
  if (raw === undefined || typeof raw !== 'object') return undefined
  const nodeRef = (raw as { nodeRef?: unknown }).nodeRef
  const rootRef = (raw as { rootRef?: unknown }).rootRef
  const nodeId = str(nodeRef !== undefined && typeof nodeRef === 'object' ? (nodeRef as { nodeId?: unknown }).nodeId : undefined)
  const rootId = str(rootRef !== undefined && typeof rootRef === 'object' ? (rootRef as { rootId?: unknown }).rootId : undefined)
  if (nodeId === undefined || rootId === undefined) return undefined
  const name = str((raw as { name?: unknown }).name)
  const path = str((raw as { path?: unknown }).path)
  const contentType = str((raw as { contentType?: unknown }).contentType)
  const content = str((raw as { content?: unknown }).content)
  return {
    nodeId,
    rootId,
    ...name !== undefined ? { name } : {},
    ...path !== undefined ? { path } : {},
    ...contentType !== undefined ? { contentType } : {},
    ...content !== undefined ? { content } : {},
  }
}
