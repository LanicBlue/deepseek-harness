/**
 * Agent-preset management controller: the roster as a list, a copy dialog as
 * the only way a preset is created, and a read-only viewer over the shipped
 * compositions.
 *
 * The browser edits no composition text. A new preset is a host-side copy of
 * an existing one (`{ from, id, name? }` is all that crosses the wire), and
 * everything after creation happens in the preset's own files — which is why
 * the page's other job is getting the user TO those files: open the directory
 * where the host has a desktop, show its path where it does not.
 *
 * The host stays the single fact source. Every mutation writes through the
 * wire and the page re-reads the roster afterwards, because a copy changes
 * more than the row it targeted.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.remote merge into this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { beginRosterRead, writeDefaultPreset } from './settings-store.ts'
import {
  parseCompositionForm, parseMetadataForm, renderCompositionForm, renderMetadataForm,
  type CompositionForm, type MetadataForm,
} from './preset-forms.ts'

/** Ids a preset directory may be named, mirroring the host's own rule. */
const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/

/** One preset row the page renders. */
export interface PresetRow {
  /** Preset id and directory name; the display name falls back to it. */
  id: string
  /** Display name the preset published, absent when it published none. */
  name?: string
  /** One sentence on what the preset is for. */
  description?: string
  /** Whether the preset ships with the deployment or was authored locally. */
  trust: 'system' | 'user'
  /** Whether a session that names no preset gets this one. */
  isDefault: boolean
  /**
   * Why the preset cannot compose a session, absent when it can. A broken
   * row renders marked and unselectable — its directory still occupies the
   * id, so deleting it (or fixing the files) is the way out, and this page
   * is where both of those live.
   */
  broken?: string
}

/** The copy dialog: a new id and optional display name over a fixed source. */
export interface CopyDraft {
  /** The preset being copied. */
  from: string
  /** Display name of the source, for the dialog title. */
  fromTitle: string
  /** New preset id being typed; the directory name, so it is required. */
  id: string
  /** Display name being typed; empty falls back to the id. */
  name: string
  /** Whether the copy is in flight. */
  saving: boolean
  /** The last copy failure, cleared by the next edit. */
  error: string | null
}

/** The read-only viewer over one preset's files. */
export interface PresetView {
  /** The preset whose files are shown. */
  id: string
  /** Display name, for the dialog title. */
  title: string
  /** Composition text exactly as stored. */
  content: string
  /** Metadata text exactly as stored, empty when the preset ships none. */
  metadata: string
  /** Trust of the root the preset was discovered under. */
  trust: 'system' | 'user'
}

/** The open editor over one user-authored preset's two files. */
export interface EditDraft {
  /** The preset being edited. */
  id: string
  /** Metadata text — the single source of truth both modes edit. */
  metadata: string
  /** Composition text — the single source of truth both modes edit. */
  composition: string
  /** Which face each file shows; the two files decide independently. */
  metadataMode: 'form' | 'yaml'
  compositionMode: 'form' | 'yaml'
  /** Whether the save is in flight. */
  saving: boolean
  /** Save failure text, on the dialog. */
  error: string | null
}

/** The metadata form for a draft, or null when the text is not representable. */
function metadataFormOf(draft: EditDraft): MetadataForm | null {
  return parseMetadataForm(draft.metadata) ?? null
}

/** The composition form for a draft, or null when the text is not representable. */
function compositionFormOf(draft: EditDraft): CompositionForm | null {
  return parseCompositionForm(draft.composition) ?? null
}

/** Page snapshot. */
export interface AgentPresetSectionState {
  status: 'idle' | 'loading' | 'ready' | 'unavailable' | 'error'
  /** Whole-load failure text; a copy failure stays on the dialog. */
  error: string | null
  /** Whether the deployment configures a root new presets can be written to. */
  authorable: boolean
  /** Whether the host can open a preset directory on a native desktop. */
  hasDocument: boolean
  /** Every preset the deployment currently supplies. */
  rows: readonly PresetRow[]
  /** The open copy dialog, or null. */
  copy: CopyDraft | null
  /** The open read-only viewer, or null. */
  view: PresetView | null
  /** The open editor over one user-authored preset, or null. */
  edit: EditDraft | null
  /** The preset awaiting delete confirmation. */
  pendingDelete: string | null
  /** Whether a delete is in flight. */
  deleting: boolean
  /**
   * Preset directories shown as text because the host has no desktop opener
   * — the answer `openDocument` gives instead of opening.
   */
  revealedPaths: Readonly<Record<string, string>>
}

const INITIAL: AgentPresetSectionState = {
  status: 'idle',
  error: null,
  authorable: false,
  hasDocument: false,
  rows: [],
  copy: null,
  view: null,
  edit: null,
  pendingDelete: null,
  deleting: false,
  revealedPaths: {},
}

/**
 * Why this copy cannot be submitted yet, as a locale key, or undefined when
 * it can. Client-side only: the host re-checks the id and its answer is what
 * the dialog reports on failure.
 * @param draft - the open copy dialog.
 * @param rows - the roster, for the collision check.
 * @returns the blocking reason's locale key, or undefined when submittable.
 */
export function draftBlocker(
  draft: CopyDraft,
  rows: readonly PresetRow[],
): 'idRequired' | 'idInvalid' | 'idTaken' | undefined {
  if (draft.id === '') return 'idRequired'
  if (!PRESET_ID.test(draft.id)) return 'idInvalid'
  // A copy never overwrites: landing on a name already in use would replace
  // something the user did not open.
  if (rows.some(row => row.id === draft.id)) return 'idTaken'
  return undefined
}

/** Reads the roster and drives the copy dialog, viewer, and location reveals. */
export class AgentPresetSectionController {
  /** Page snapshot the renderer subscribes to. */
  readonly store: SnapshotStore<AgentPresetSectionState> = createSnapshotStore(INITIAL)

  constructor(
    private readonly ctx: ClientContext,
    /**
     * Called after this page changes the roster DIRECTORY, so the other
     * surfaces reading the same roster re-read it. A settings field moving is
     * already announced by the host through the forwarded
     * `settings/document-updated`; a directory copied or deleted here is not,
     * and the new-session chip has no other way to learn a preset it should
     * offer now exists.
     */
    private readonly rosterChanged: () => void = () => {},
  ) {}


  private set(patch: Partial<AgentPresetSectionState>): void {
    this.store.set({ ...this.store.getSnapshot(), ...patch })
  }

  private patchCopy(patch: Partial<CopyDraft>): void {
    const { copy } = this.store.getSnapshot()
    if (copy === null) return
    this.set({ copy: { ...copy, ...patch } })
  }

  /**
   * Load the roster. An empty roster means the deployment composes no
   * presets, which is a valid deployment rather than a failure — the section
   * reports `unavailable` and renders nothing.
   * @returns once the snapshot reflects the host.
   */
  async load(): Promise<void> {
    // Whether a preset's directory can be opened is the Host's opener
    // capability rather than a roster property, so the page joins the two.
    // Issued together: one round trip decides the page, and a load that waited
    // for them in turn would hold the section in `loading` twice as long,
    // where a concurrent reload silently returns instead of refreshing.
    const opener = this.ctx.remote.settings.canOpenAgentPresetDirectory()
    const roster = await beginRosterRead(this.ctx, this.store)
    // A refused describe leaves the reveal-the-path path, which needs no opener.
    const described = await opener
    if (roster === undefined) return
    const { presets, authorable } = roster
    const hasDocument = described.ok && described.value
    if (presets.length === 0) {
      // Nothing to manage leaves nothing to keep a dialog open over.
      this.set({ status: 'unavailable', rows: [], authorable, hasDocument, copy: null, view: null, edit: null })
      return
    }
    // A reveal outlives a reload but not its preset: a path for a row the
    // roster no longer lists would be a claim about a directory that is gone.
    const revealed = this.store.getSnapshot().revealedPaths
    const kept = Object.fromEntries(
      Object.entries(revealed).filter(([id]) => presets.some(preset => preset.id === id)))
    this.set({
      status: 'ready',
      error: null,
      authorable,
      hasDocument,
      rows: presets.map(preset => ({ ...preset })),
      revealedPaths: kept,
    })
  }

  /**
   * Open one shipped preset's composition in the read-only viewer.
   * @param id - the preset to view.
   * @returns once the composition loaded or the failure is on the page.
   */
  async view(id: string): Promise<void> {
    this.set({ error: null })
    const result = await this.ctx.remote.agentPresets.read(id)
    if (!result.ok) {
      this.set({ error: result.error.message })
      return
    }
    const { name, content, metadata, trust } = result.value
    this.set({ view: { id, title: name ?? id, content, metadata, trust } })
  }

  /** Close the read-only viewer. */
  closeView(): void {
    this.set({ view: null })
  }

  /**
   * Open the editor over the preset the viewer is showing.
   *
   * Only a user-authored preset edits in the browser: the shipped set is the
   * known-good baseline a copy starts from, so it stays read-only and its
   * route to change is duplicating it first.
   * @returns once the drafts reflect the stored files.
   */
  beginEdit(): void {
    const view = this.store.getSnapshot().view
    if (view === null || view.trust !== 'user') return
    this.set({
      edit: {
        id: view.id,
        metadata: view.metadata,
        composition: view.content,
        metadataMode: parseMetadataForm(view.metadata) !== undefined ? 'form' : 'yaml',
        compositionMode: parseCompositionForm(view.content) !== undefined ? 'form' : 'yaml',
        saving: false,
        error: null,
      },
    })
  }

  /** Close the editor, discarding whatever was typed. */
  cancelEdit(): void {
    if (this.store.getSnapshot().edit?.saving === true) return
    this.set({ edit: null })
  }

  /**
   * Update the metadata draft.
   * @param metadata - the metadata text as typed.
   */
  setEditMetadata(metadata: string): void {
    const { edit } = this.store.getSnapshot()
    if (edit === null || edit.saving) return
    this.set({ edit: { ...edit, metadata, error: null } })
  }

  /**
   * Update the composition draft.
   * @param composition - the composition text as typed.
   */
  setEditComposition(composition: string): void {
    const { edit } = this.store.getSnapshot()
    if (edit === null || edit.saving) return
    this.set({ edit: { ...edit, composition, error: null } })
  }

  /**
   * Switch the editor between the form and the raw text.
   *
   * Switching to the form re-parses the current texts and refuses when
   * either document carries a shape the form would drop; switching to the
   * text just shows what the form has been serializing all along.
   * @param mode - the mode to show.
   */
  setEditMode(file: 'metadata' | 'composition', mode: 'form' | 'yaml'): void {
    const { edit } = this.store.getSnapshot()
    if (edit === null || edit.saving) return
    const current = file === 'metadata' ? edit.metadataMode : edit.compositionMode
    if (current === mode) return
    if (mode === 'form'
      && (file === 'metadata' ? metadataFormOf(edit) : compositionFormOf(edit)) === null) return
    this.set({
      edit: {
        ...edit,
        ...(file === 'metadata' ? { metadataMode: mode } : { compositionMode: mode }),
        error: null,
      },
    })
  }

  /**
   * Patch the metadata form and re-serialize it into the draft text.
   * @param patch - the metadata form fields to replace; an explicit
   * undefined clears the field.
   */
  patchMetadataForm(patch: { [K in keyof MetadataForm]?: MetadataForm[K] | undefined }): void {
    const { edit } = this.store.getSnapshot()
    if (edit === null || edit.saving || edit.metadataMode !== 'form') return
    const current = metadataFormOf(edit)
    if (current === null) return
    // A copy under Record-typed keys with omitted-absent spread, rather
    // than dynamic deletes: renderMetadataForm only reads present fields.
    const patchKeys = new Set(Object.keys(patch))
    const next: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(current)) {
      if (!patchKeys.has(key) && value !== undefined) next[key] = value
    }
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) next[key] = value
    }
    this.set({
      edit: { ...edit, metadata: renderMetadataForm(next as MetadataForm), error: null },
    })
  }

  /**
   * Patch the composition form and re-serialize it into the draft text.
   * @param patch - the composition form fields to replace.
   */
  patchCompositionForm(patch: Partial<CompositionForm>): void {
    const { edit } = this.store.getSnapshot()
    if (edit === null || edit.saving || edit.compositionMode !== 'form') return
    const current = compositionFormOf(edit)
    if (current === null) return
    this.set({
      edit: { ...edit, composition: renderCompositionForm({ ...current, ...patch }), error: null },
    })
  }

  /**
   * Save the drafts to the preset's files, then re-read the roster and the
   * stored view so the page converges on what the host now holds.
   * @returns once the save settled and the page reflects it.
   */
  async saveEdit(): Promise<void> {
    const { edit } = this.store.getSnapshot()
    if (edit === null || edit.saving) return
    this.set({ edit: { ...edit, saving: true, error: null } })
    const result = await this.ctx.remote.agentPresets.write(edit.id, edit.metadata, edit.composition)
    if (!result.ok) {
      this.set({ edit: { ...edit, saving: false, error: result.error.message } })
      return
    }
    this.set({ edit: null })
    await this.load()
    this.rosterChanged()
    await this.view(edit.id)
  }

  /**
   * Open the copy dialog over one preset.
   * @param from - the preset the copy will start from.
   */
  beginCopy(from: string): void {
    const row = this.store.getSnapshot().rows.find(candidate => candidate.id === from)
    this.set({
      error: null,
      copy: { from, fromTitle: row?.name ?? from, id: '', name: '', saving: false, error: null },
    })
  }

  /** Close the copy dialog, discarding whatever was typed. */
  cancelCopy(): void {
    this.set({ copy: null })
  }

  /**
   * Name the preset the copy creates.
   * @param id - the id typed into the dialog.
   */
  setCopyId(id: string): void {
    this.patchCopy({ id, error: null })
  }

  /**
   * Name the copy's display name.
   * @param name - the display name typed into the dialog.
   */
  setCopyName(name: string): void {
    this.patchCopy({ name, error: null })
  }

  /**
   * Submit the copy, re-read the roster, then take the user to the new
   * preset's files — the directory opens where the host has a desktop, and
   * its path appears on the new row where it does not.
   * @returns once the copy settled and the page reflects it.
   */
  async confirmCopy(): Promise<void> {
    const draft = this.store.getSnapshot().copy
    if (draft === null || draft.saving) return
    if (draftBlocker(draft, this.store.getSnapshot().rows) !== undefined) return
    this.patchCopy({ saving: true, error: null })
    const name = draft.name.trim()
    // Every declared parameter is passed even when optional: the Remote face
    // checks arity against the declaration and rejects a short call. An
    // empty display name goes as `undefined` — absent rather than empty, so
    // the host falls back to the id instead of labelling the row with ''.
    const result = await this.ctx.remote.agentPresets.copy(
      draft.from, draft.id, name === '' ? undefined : name)
    if (!result.ok) {
      this.patchCopy({ saving: false, error: result.error.message })
      return
    }
    this.set({ copy: null })
    await this.load()
    this.rosterChanged()
    // A preset is its files from here on (the dialog collected nothing
    // else), so landing in them is the completion, not a follow-up.
    await this.openLocation(draft.id)
  }

  /**
   * Open one preset's directory on the host desktop, or reveal its path on
   * the row where the deployment has no opener to hand it to.
   * @param id - the preset whose files the user wants.
   * @returns once the host answered and the page reflects it.
   */
  async openLocation(id: string): Promise<void> {
    const result = await this.ctx.remote.settings.openAgentPresetDirectory(id)
    if (!result.ok) {
      this.set({ error: result.error.message })
      return
    }
    if (result.value.opened) return
    const { path } = result.value
    this.set({ revealedPaths: { ...this.store.getSnapshot().revealedPaths, [id]: path } })
  }

  /**
   * Ask for confirmation before deleting one preset.
   * @param id - the preset to delete, or null to dismiss the confirmation.
   */
  confirmDelete(id: string | null): void {
    if (this.store.getSnapshot().deleting) return
    this.set({ pendingDelete: id })
  }

  /**
   * Delete the preset awaiting confirmation, then re-read the roster.
   *
   * A session already composed from it keeps running: its composition was
   * mounted at creation and nothing re-reads the file.
   * @returns once the delete settled and the page reflects it.
   */
  async remove(): Promise<void> {
    const { pendingDelete, deleting } = this.store.getSnapshot()
    if (pendingDelete === null || deleting) return
    this.set({ deleting: true, error: null })
    const result = await this.ctx.remote.agentPresets.deletePreset(pendingDelete)
    if (!result.ok) {
      this.set({ deleting: false, pendingDelete: null, error: result.error.message })
      return
    }
    this.set({ deleting: false, pendingDelete: null })
    await this.load()
    this.rosterChanged()
  }

  /**
   * Make one preset the default for sessions created later. Running sessions
   * keep the composition they began with, so this never disturbs work.
   * @param id - the preset to make default.
   * @returns once the write settled and the roster was re-read.
   */
  async makeDefault(id: string): Promise<void> {
    const failure = await writeDefaultPreset(this.ctx, id)
    if (failure !== undefined) {
      this.set({ error: failure })
      return
    }
    await this.load()
  }
}
