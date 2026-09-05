/**
 * Agent-presets settings section: the roster as cards, a copy dialog as the
 * guided way a preset is created, and a two-file viewer over every preset —
 * shipped and custom alike.
 *
 * The browser edits composition text for USER-authored presets only: a
 * shipped preset opens read-only to be READ (it is the known-good
 * composition a copy starts from), and its route to change is duplicating it
 * first. Deleting a preset leaves running sessions alone: a composition is
 * mounted once at session creation and nothing re-reads the file.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Button, IconBrowseOutline16, IconCopyOutline16, IconFolderOpenOutline16, IconPlusOutline16, IconTrashOutline16, Modal, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { draftBlocker, type AgentPresetSectionState } from './section-store.ts'
import {
  isJsExprNode, isKeyMap, parseCompositionForm, parseMetadataForm, parseConfigSnippet, renderConfigSnippet,
  type CompositionForm, type MetadataForm, type ModelSelectionFields, type RowFields,
} from './preset-forms.ts'
import {
  KNOWN_PACKAGES, MODULE_ORDER, classifyConfig, moduleOf, shortPackageId,
  type ConfigField, type RowModule,
} from './preset-config-schema.ts'
import { presetDisplayText, type AgentPresetSettingsKey } from './locales.ts'
import css from './AgentPresetSection.module.css'

/** Registration-side business face for the management section. */
export interface AgentPresetSectionInjected {
  hooks: {
    /** Page snapshot bound by the renderer as useAgentPresetSection. */
    agentPresetSection: SnapshotStore<AgentPresetSectionState>
  }
  /** Read the roster; called once when the section first renders. */
  load: () => Promise<void>
  /** Open one shipped preset's composition in the read-only viewer. */
  view: (id: string) => Promise<void>
  /** Close the read-only viewer. */
  closeView: () => void
  /** Open the editor over the preset the viewer is showing (user trust only). */
  beginEdit: () => void
  /** Close the editor, discarding the drafts. */
  cancelEdit: () => void
  /** Update the metadata draft. */
  setEditMetadata: (metadata: string) => void
  /** Update the composition draft. */
  setEditComposition: (composition: string) => void
  /** Save the drafts, then converge the page on the stored result. */
  saveEdit: () => Promise<void>
  /** Switch one file's face between the form and the raw text. */
  setEditMode: (file: 'metadata' | 'composition', mode: 'form' | 'yaml') => void
  /** Patch the metadata form fields (form mode only); undefined clears. */
  patchMetadataForm: (patch: { [K in keyof MetadataForm]?: MetadataForm[K] | undefined }) => void
  /** Patch the composition form fields (form mode only). */
  patchCompositionForm: (patch: Partial<CompositionForm>) => void
  /** Registered provider routes for the model selects. */
  modelProviders: () => Promise<readonly { id: string; name: string }[]>
  /** Open the copy dialog over one preset. */
  beginCopy: (from: string) => void
  /** Close the copy dialog, discarding the draft. */
  cancelCopy: () => void
  /** Name the preset the copy creates. */
  setCopyId: (id: string) => void
  /** Name the copy's display name. */
  setCopyName: (name: string) => void
  /** Submit the copy. */
  confirmCopy: () => Promise<void>
  /** Open one preset's directory, or reveal its path where there is no desktop. */
  openLocation: (id: string) => Promise<void>
  /**
   * Stage the self-referential preset and start a new session on it — the
   * guided way to author a preset, beside copying. Absent when the surface
   * is composed without the conversation flow to land the session in.
   */
  startCreatorDraft?: () => void
  /** Ask for delete confirmation, or dismiss it with null. */
  confirmDelete: (id: string | null) => void
  /** Delete the preset awaiting confirmation. */
  remove: () => Promise<void>
  /** Make one preset the default for sessions created later. */
  makeDefault: (id: string) => Promise<void>
}

/** Full component props. */
export type AgentPresetSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.agentPreset'>
  & InjectFace<AgentPresetSectionInjected>

/** Copy-dialog sub-view props: the draft plus the actions that mutate it. */
interface CopyDialogProps {
  state: AgentPresetSectionState
  t: (key: AgentPresetSettingsKey) => string
  actions: Pick<AgentPresetSectionInjected,
    'cancelCopy' | 'confirmCopy' | 'setCopyId' | 'setCopyName'>
}

function CopyDialog({ state, t, actions }: CopyDialogProps): ReactNode {
  const draft = state.copy
  const blocker = draft === null ? undefined : draftBlocker(draft, state.rows)
  const message = draft === null ? null : draft.error ?? (blocker === undefined ? null : t(blocker))
  const source = draft === null ? undefined : state.rows.find(row => row.id === draft.from)
  const sourceTitle = source === undefined ? draft?.fromTitle : presetDisplayText(source, t).name
  return (
    <Modal
      open={draft !== null}
      onClose={() => { actions.cancelCopy() }}
      title={draft === null ? t('copyTitle') : `${t('copyTitle')} · ${t('copyOf')} ${sourceTitle}`}
      closeLabel={t('close')}
      description={t('copyIntro')}
      className={css.dialog as string}
      footer={(
        <>
          <Button
            variant="outline"
            disabled={draft?.saving === true}
            onClick={() => { actions.cancelCopy() }}
          >
            {t('cancel')}
          </Button>
          <Button
            disabled={draft === null || draft.saving || blocker !== undefined}
            onClick={() => { void actions.confirmCopy() }}
          >
            {draft?.saving === true ? t('creating') : t('create')}
          </Button>
        </>
      )}
    >
      {draft === null
        ? null
        : (
          <div className={css.dialogFields}>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('presetId')}</span>
              <input
                className={css.input}
                value={draft.id}
                autoFocus
                spellCheck={false}
                placeholder={t('presetIdPlaceholder')}
                onChange={(event) => { actions.setCopyId(event.target.value) }}
              />
            </label>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('displayName')}</span>
              <input
                className={css.input}
                value={draft.name}
                spellCheck={false}
                placeholder={t('displayNamePlaceholder')}
                onChange={(event) => { actions.setCopyName(event.target.value) }}
              />
            </label>
            {message === null ? null : <p className={css.error} role="alert">{message}</p>}
          </div>
        )}
    </Modal>
  )
}

/**
 * Render one card's description, clamped by CSS and offered in full on hover.
 * The tooltip is attached only while the text is actually cut off, so a short
 * description does not answer a hover with a bubble repeating the card.
 * @param props.text - the description as rendered, already localized.
 * @returns the description element, tooltip-anchored while it overflows.
 */
function CardDescription({ text }: { text: string }): ReactNode {
  const ref = useRef<HTMLSpanElement | null>(null)
  const [truncated, setTruncated] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    /* v8 ignore next -- the ref is attached before layout effects run. */
    if (el === null) return
    const measure = () => { setTruncated(el.scrollHeight > el.clientHeight) }
    measure()
    // Card width follows the settings pane, which resizes with the window.
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => { observer.disconnect() }
  }, [text])
  return (
    // Capped near the card's own width: the default half-viewport bubble would
    // spill a description out of the settings dialog and across the app behind it.
    <Tooltip label={text} side="bottom" delayMs={400} disabled={!truncated} maxWidth={360}>
      {/* The empty title stops the card body's native tooltip from climbing to
        this span: a cut-off description answers with one bubble, not two. */}
      <span ref={ref} className={css.cardDesc} title="">{text}</span>
    </Tooltip>
  )
}

/** Props the two form-field groups share. */
interface FormFieldsProps {
  t: (key: AgentPresetSettingsKey) => string
  readOnly: boolean
  /** Form patches; an explicit undefined clears the field. */
  patchMetadata?: (patch: { [K in keyof MetadataForm]?: MetadataForm[K] | undefined }) => void
  patchComposition?: (patch: Partial<CompositionForm>) => void
}

/** One provider/model/effort triple as three inline inputs. */
function ModelSelectionInput({ value, onChange, disabled, t, providers }: {
  value: ModelSelectionFields
  onChange: (next: ModelSelectionFields) => void
  disabled: boolean
  t: (key: AgentPresetSettingsKey) => string
  providers: readonly { id: string; name: string }[]
}): ReactNode {
  return (
    <span className={css.modelRow}>
      <select
        className={css.input}
        value={providers.some(p => p.id === value.provider) ? value.provider : ''}
        disabled={disabled}
        aria-label={t('providerLabel')}
        onChange={(event) => { onChange({ ...value, provider: event.target.value === '' ? value.provider : event.target.value }) }}
      >
        <option value="">{value.provider === '' ? t('providerLabel') : value.provider}</option>
        {providers.map(provider => (
          <option key={provider.id} value={provider.id}>{provider.id}</option>
        ))}
      </select>
      <input
        className={css.input}
        value={value.model}
        disabled={disabled}
        spellCheck={false}
        placeholder={t('modelLabel')}
        aria-label={t('modelLabel')}
        onChange={(event) => { onChange({ ...value, model: event.target.value }) }}
      />
      {(() => {
        const current = value.reasoningEffort ?? ''
        const efforts: readonly string[] = ['low', 'medium', 'high'].includes(current) || current === ''
          ? ['low', 'medium', 'high']
          : [current, 'low', 'medium', 'high']
        return (
          <select
            className={css.input}
            value={current}
            disabled={disabled}
            aria-label={t('effortLabel')}
            onChange={(event) => {
              const picked = event.target.value
              onChange(picked === ''
                ? { provider: value.provider, model: value.model }
                : { ...value, reasoningEffort: picked })
            }}
          >
            <option value="">{t('effortLabel')}</option>
            {efforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}
          </select>
        )
      })()}
    </span>
  )
}

/** The preset.yml fields: display text, the IM opt-in, and the model chain. */
function MetadataFormFields({ t, readOnly, patchMetadata, providers, value }: FormFieldsProps & {
  providers: readonly { id: string; name: string }[]
  value: MetadataForm
}): ReactNode {
  const metadata = value
  const set = (patch: { [K in keyof MetadataForm]?: MetadataForm[K] | undefined }): void => {
    patchMetadata?.(patch)
  }
  const fallbacks = metadata.modelFallbacks ?? []
  return (
    <div className={css.formGrid}>
      <label className={css.field}>
        <span className={css.fieldLabel}>{t('fieldName')}</span>
        <input className={css.input} value={metadata.name ?? ''} readOnly={readOnly} spellCheck={false}
          onChange={(event) => { set({ name: event.target.value }) }} />
      </label>
      <label className={css.field}>
        <span className={css.fieldLabel}>{t('fieldDescription')}</span>
        <input className={css.input} value={metadata.description ?? ''} readOnly={readOnly} spellCheck={false}
          onChange={(event) => { set({ description: event.target.value }) }} />
      </label>
      <div className={css.formRow}>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('fieldOrder')}</span>
          <input className={css.input} type="number" value={metadata.order ?? ''} readOnly={readOnly}
            onChange={(event) => {
              const raw = event.target.value
              set({ order: raw === '' ? undefined : Number(raw) })
            }} />
        </label>
        <label className={css.checkField}>
          <input type="checkbox" checked={metadata.im === true} disabled={readOnly}
            onChange={(event) => { set({ im: event.target.checked }) }} />
          {t('fieldIm')}
        </label>
      </div>
      <div className={css.field}>
        <span className={css.fieldLabel}>{t('modelDefault')}</span>
        {metadata.model === undefined
          ? (readOnly
            ? <p className={css.hint}>{t('modelUnset')}</p>
            : (
              <button type="button" className={css.secondaryButton}
                onClick={() => { set({ model: { provider: '', model: '' } }) }}>
                {t('modelAdd')}
              </button>
            ))
          : (
            <span className={css.formRow}>
              <ModelSelectionInput value={metadata.model} disabled={readOnly} t={t} providers={providers}
                onChange={(next) => { set({ model: next.provider === '' && next.model === '' ? undefined : next }) }} />
              {!readOnly ? (
                <button type="button" className={css.iconButton} data-tip={t('modelRemove')}
                  aria-label={t('modelRemove')}
                  onClick={() => { set({ model: undefined }) }}>✕</button>
              ) : null}
            </span>
          )}
      </div>
      {fallbacks.length > 0 || !readOnly ? (
        <div className={css.field}>
          <span className={css.fieldLabel}>{t('modelFallbacks')}</span>
          {fallbacks.map((fallback, index) => (
            <span key={index} className={css.formRow}>
              <ModelSelectionInput value={fallback} disabled={readOnly} t={t} providers={providers}
                onChange={(next) => {
                  const nextFallbacks = [...fallbacks]
                  nextFallbacks[index] = next
                  set({ modelFallbacks: nextFallbacks })
                }} />
              {!readOnly ? (
                <button type="button" className={css.iconButton} data-tip={t('fallbackRemove')}
                  aria-label={`${t('fallbackRemove')} ${index + 1}`}
                  onClick={() => { set({ modelFallbacks: fallbacks.filter((_, i) => i !== index) }) }}>✕</button>
              ) : null}
            </span>
          ))}
          {!readOnly ? (
            <button type="button" className={css.secondaryButton}
              onClick={() => { set({ modelFallbacks: [...fallbacks, { provider: '', model: '' }] }) }}>
              {t('fallbackAdd')}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** One composition row's editable line: id, package, config, gates, isolate. */
/** Editor state for one blur-committed YAML snippet field of a row. */
function useSnippetField(row: RowFields, key: 'config' | 'isolate', onChange: (next: RowFields) => void): {
  shown: string
  error: boolean
  /** A snippet being typed that has not committed yet. */
  editing: boolean
  setText: (text: string) => void
  commit: () => void
} {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const commit = (): void => {
    if (text === null) return
    try {
      const parsed = text.trim() === '' ? undefined : parseConfigSnippet(text)
      onChange(key === 'config' ? { ...row, config: parsed } : { ...row, isolate: parsed })
      setText(null)
      setError(false)
    } catch {
      setError(true)
    }
  }
  const shown = text ?? (row[key] === undefined ? '' : renderConfigSnippet(row[key]))
  return {
    shown,
    error,
    editing: text !== null,
    setText: (value: string) => { setText(value); setError(false) },
    commit,
  }
}

/** One labelled YAML snippet editor (a row's config, a group's isolate). */
function SnippetField({ label, value, error, readOnly, t, onChange, onCommit }: {
  label: string
  value: string
  error: boolean
  readOnly: boolean
  t: (key: AgentPresetSettingsKey) => string
  onChange: (text: string) => void
  onCommit: () => void
}): ReactNode {
  return (
    <label className={css.rowSnippet}>
      <span className={css.keyHeading}>{label}</span>
      <textarea
        className={error ? `${css.editorText} ${css.editorTextInvalid}` : css.editorText}
        style={{ minHeight: 40 }}
        value={value}
        readOnly={readOnly}
        spellCheck={false}
        placeholder={t('rowConfig')}
        onChange={(event) => {
          if (readOnly) return
          onChange(event.target.value)
        }}
        onBlur={onCommit}
      />
    </label>
  )
}

/** The enabled cell of a row line: a checkbox, or a `!!js` chip when the
   gate is an expression (the expression itself edits on the line below). */
function GateCell({ row, readOnly, t, onChange }: {
  row: RowFields
  readOnly: boolean
  t: (key: AgentPresetSettingsKey) => string
  onChange: (next: RowFields) => void
}): ReactNode {
  if (typeof row.disabled === 'object') {
    return (
      <span
        className={css.gateChip}
        title={`${t('jsExpressionGate')} ${row.disabled.js}`}
        aria-label={`${t('jsExpressionGate')}${row.id === '' ? '' : `: ${row.id}`}`}
      >!!js</span>
    )
  }
  return (
    <input
      type="checkbox"
      className={css.gateCheck}
      checked={row.disabled !== true}
      disabled={readOnly}
      aria-label={`${t('rowHeadEnabled')}${row.id === '' ? '' : `: ${row.id}`}`}
      onChange={(event) => {
        if (!event.target.checked) {
          onChange({ ...row, disabled: true })
          return
        }
        const cleared: RowFields = { ...row }
        delete cleared.disabled
        onChange(cleared)
      }}
    />
  )
}

/** One schema field as an inline control chip on the row's own line:
   checkbox beside its key for booleans, key beside the control for
   selects, numbers, and short text. */
function InlineWidget({ name, field, value, readOnly, onChange }: {
  name: string
  field: ConfigField
  value: unknown
  readOnly: boolean
  onChange: (next: unknown) => void
}): ReactNode {
  if (field.kind === 'boolean') {
    return (
      <label className={css.inlineCheck}>
        <input type="checkbox" checked={value === true} disabled={readOnly} aria-label={name}
          onChange={(event) => { onChange(event.target.checked) }} />
        <span className={css.inlineKey}>{name}</span>
      </label>
    )
  }
  if (field.kind === 'enum') {
    const current = typeof value === 'string' ? value : ''
    const options = field.options.includes(current) || current === ''
      ? field.options
      : [current, ...field.options]
    return (
      <label className={css.inlineField}>
        <span className={css.inlineKey}>{name}</span>
        <select className={`${css.inlineInput} ${css.inputMono}`} value={current} disabled={readOnly} aria-label={name}
          onChange={(event) => { onChange(event.target.value) }}>
          {current === '' ? <option value="" /> : null}
          {options.map(option => <option key={option} value={option}>{option}</option>)}
        </select>
      </label>
    )
  }
  if (field.kind === 'number') {
    return (
      <label className={css.inlineField}>
        <span className={css.inlineKey}>{name}</span>
        <input type="number" className={`${css.inlineInput} ${css.inputMono}`} value={typeof value === 'number' ? value : ''}
          readOnly={readOnly} spellCheck={false} aria-label={name}
          onChange={(event) => {
            const parsed = Number(event.target.value)
            if (event.target.value !== '' && Number.isFinite(parsed)) onChange(parsed)
          }} />
      </label>
    )
  }
  if (field.kind === 'text') {
    return (
      <label className={css.inlineField}>
        <span className={css.inlineKey}>{name}</span>
        <input className={`${css.inlineInput} ${css.inputMono}`} value={typeof value === 'string' ? value : ''}
          readOnly={readOnly} spellCheck={false} aria-label={name}
          onChange={(event) => { onChange(event.target.value) }} />
      </label>
    )
  }
  return null
}

/** The plugin package picker: a select over the known packages, with a
   free-text fallback for packages the catalog does not know. */
function PackageSelect({ row, readOnly, t, packageListId, onChange }: {
  row: RowFields
  readOnly: boolean
  t: (key: AgentPresetSettingsKey) => string
  packageListId: string
  onChange: (next: RowFields) => void
}): ReactNode {
  const [custom, setCustom] = useState(false)
  if (custom) {
    return (
      <span className={css.pkgCustom}>
        <input className={`${css.cellInput} ${css.inputMono}`} value={row.name} list={packageListId} readOnly={readOnly}
          spellCheck={false} placeholder={t('rowName')} aria-label={t('rowHeadPackage')}
          onChange={(event) => { onChange({ ...row, name: event.target.value }) }} />
        <button type="button" className={css.iconButton} aria-label={t('packagePick')} title={t('packagePick')}
          onClick={() => { setCustom(false) }}>▾</button>
      </span>
    )
  }
  const current = row.name
  const options = current !== '' && !KNOWN_PACKAGES.includes(current) ? [current, ...KNOWN_PACKAGES] : KNOWN_PACKAGES
  return (
    <select
      className={`${css.cellInput} ${css.inputMono}`}
      value={current}
      disabled={readOnly}
      aria-label={t('rowHeadPackage')}
      onChange={(event) => {
        const picked = event.target.value
        if (picked === '') return
        if (picked === '__custom') {
          setCustom(true)
          return
        }
        onChange({ ...row, name: picked, id: row.id === '' ? shortPackageId(picked) : row.id })
      }}
    >
      {current === '' ? <option value="">{t('packagePlaceholder')}</option> : null}
      {options.map(name => <option key={name} value={name}>{name}</option>)}
      {!readOnly ? <option value="__custom">{t('packageCustom')}</option> : null}
    </select>
  )
}

/** One key-map value as the control its own runtime type reads as — the
   generic editor behind isolate maps and the advanced fold, where no
   package schema speaks for the key. */
function KeyValueCell({ name, value, readOnly, t, onChange }: {
  /** The key this value sits under; the control's accessible name. */
  name: string
  value: unknown
  readOnly: boolean
  t: (key: AgentPresetSettingsKey) => string
  onChange: (next: unknown) => void
}): ReactNode {
  if (typeof value === 'boolean') {
    return (
      <input
        type="checkbox"
        className={css.gateCheck}
        checked={value}
        disabled={readOnly}
        aria-label={name}
        onChange={(event) => { onChange(event.target.checked) }}
      />
    )
  }
  if (typeof value === 'number') {
    return (
      <input
        type="number"
        className={`${css.cellInput} ${css.inputMono}`}
        value={value}
        readOnly={readOnly}
        spellCheck={false}
        aria-label={name}
        onChange={(event) => {
          const parsed = Number(event.target.value)
          if (event.target.value !== '' && Number.isFinite(parsed)) onChange(parsed)
        }}
      />
    )
  }
  if (typeof value === 'string') {
    const onText = (event: { target: { value: string } }): void => { onChange(event.target.value) }
    return value.includes('\n') || value.length > 72 ? (
      <textarea className={css.cellArea} value={value} readOnly={readOnly} spellCheck={false}
        aria-label={name} onChange={onText} />
    ) : (
      <input className={css.cellInput} value={value} readOnly={readOnly} spellCheck={false}
        aria-label={name} onChange={onText} />
    )
  }
  if (isJsExprNode(value)) {
    return (
      <span className={css.gateLine}>
        <code className={css.jsBadge} aria-hidden="true">!!js</code>
        <input
          className={`${css.cellInput} ${css.inputMono}`}
          value={value.__jsExpr}
          readOnly={readOnly}
          spellCheck={false}
          aria-label={name}
          onChange={(event) => { onChange({ __jsExpr: event.target.value }) }}
        />
      </span>
    )
  }
  return <YamlCell name={name} value={value} readOnly={readOnly} t={t} onChange={onChange} />
}

/** One object/array key-map value as a blur-committed YAML mini editor. */
function YamlCell({ name, value, readOnly, t, onChange }: {
  name: string
  value: unknown
  readOnly: boolean
  t: (key: AgentPresetSettingsKey) => string
  onChange: (next: unknown) => void
}): ReactNode {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState(false)
  return (
    <span className={css.cellStack}>
      <textarea
        className={error ? `${css.cellArea} ${css.editorTextInvalid}` : css.cellArea}
        value={text ?? renderConfigSnippet(value)}
        readOnly={readOnly}
        spellCheck={false}
        placeholder="YAML"
        aria-label={name}
        onChange={(event) => { setText(event.target.value); setError(false) }}
        onBlur={() => {
          if (text === null) return
          try {
            onChange(parseConfigSnippet(text))
            setText(null)
            setError(false)
          } catch {
            setError(true)
          }
        }}
      />
      {error ? <p className={css.error} role="alert">{t('configInvalid')}</p> : null}
    </span>
  )
}

/** A config (or isolate) key map as one control line per key: the key sits
   in the identifier column, its control in the package column — the same two
   columns the row lines above use. */
function KeyValueFields({ heading, record, readOnly, t, onPatch }: {
  /** Section heading; empty renders no heading line. */
  heading: string
  record: Record<string, unknown>
  readOnly: boolean
  t: (key: AgentPresetSettingsKey) => string
  onPatch: (next: unknown) => void
}): ReactNode {
  const keys = Object.keys(record)
  if (keys.length === 0 && readOnly) return null
  const setKey = (key: string, value: unknown): void => { onPatch({ ...record, [key]: value }) }
  const dropKey = (key: string): void => {
    const rest: Record<string, unknown> = {}
    for (const current of keys) {
      if (current !== key) rest[current] = record[current]
    }
    onPatch(rest)
  }
  return (
    <div className={css.keyBlock}>
      {heading === '' ? null : <span className={css.keyHeading}>{heading}</span>}
      <div className={css.keyRows}>
        {keys.map(key => (
          <div key={key} className={css.keyRow}>
            <span className={css.keyName} title={key}>{key}</span>
            <span className={css.keyValue}>
              <KeyValueCell name={key} value={record[key]} readOnly={readOnly} t={t} onChange={(value) => { setKey(key, value) }} />
            </span>
            {!readOnly ? (
              <button
                type="button"
                className={`${css.iconButton} ${css.iconDanger} ${css.keyCell}`}
                aria-label={`${t('keyRemove')}: ${key}`}
                onClick={() => { dropKey(key) }}
              >✕</button>
            ) : null}
          </div>
        ))}
      </div>
      {!readOnly ? (
        <AddKeyRow t={t} isTaken={key => key in record} onAdd={(key, value) => { setKey(key, value) }} />
      ) : null}
    </div>
  )
}

/** The inline "add one config key" line: a key, a YAML value, and ＋ — on
   the same two columns as the key rows above. */
function AddKeyRow({ t, isTaken, onAdd }: {
  t: (key: AgentPresetSettingsKey) => string
  isTaken: (key: string) => boolean
  onAdd: (key: string, value: unknown) => void
}): ReactNode {
  const [key, setKey] = useState('')
  const [value, setValue] = useState('')
  const [error, setError] = useState<null | 'yaml' | 'taken'>(null)
  const commit = (): void => {
    if (key === '') return
    if (isTaken(key)) {
      setError('taken')
      return
    }
    try {
      onAdd(key, value.trim() === '' ? '' : parseConfigSnippet(value))
      setKey('')
      setValue('')
      setError(null)
    } catch {
      setError('yaml')
    }
  }
  const commitOnEnter = (event: { key: string }): void => {
    if (event.key === 'Enter') commit()
  }
  return (
    <div className={css.keyAdd}>
      <input
        className={`${css.cellInput} ${css.inputMono} ${css.keyColName}`}
        value={key}
        spellCheck={false}
        placeholder={t('keyNamePlaceholder')}
        aria-label={t('keyNamePlaceholder')}
        onChange={(event) => { setKey(event.target.value); setError(null) }}
        onKeyDown={commitOnEnter}
      />
      <input
        className={`${css.cellInput} ${css.inputMono} ${css.keyColValue}`}
        value={value}
        spellCheck={false}
        placeholder={t('keyValuePlaceholder')}
        aria-label={t('keyValuePlaceholder')}
        onChange={(event) => { setValue(event.target.value); setError(null) }}
        onKeyDown={commitOnEnter}
      />
      <button type="button" className={`${css.iconButton} ${css.keyCell}`} aria-label={t('keyAdd')} title={t('keyAdd')}
        onClick={() => { commit() }}
      >＋</button>
      {error === null ? null : (
        <p className={css.error} role="alert">{error === 'taken' ? t('keyExists') : t('configInvalid')}</p>
      )}
    </div>
  )
}

/** One row's ordering tools; the read-only viewer keeps the column empty so
   the shared line grid does not shift between modes. */
function RowTools({ index, total, t, onRemove, onMove, placeholder }: {
  index: number
  total: number
  t: (key: AgentPresetSettingsKey) => string
  onRemove: () => void
  onMove: (delta: number) => void
  placeholder?: boolean
}): ReactNode {
  if (placeholder === true) return <span aria-hidden="true" />
  return (
    <span className={css.rowTools}>
      <button type="button" className={css.iconButton} disabled={index === 0}
        aria-label={t('rowUp')} onClick={() => { onMove(-1) }}>↑</button>
      <button type="button" className={css.iconButton} disabled={index === total - 1}
        aria-label={t('rowDown')} onClick={() => { onMove(1) }}>↓</button>
      <button type="button" className={`${css.iconButton} ${css.iconDanger}`} aria-label={t('rowRemove')}
        onClick={() => { onRemove() }}>✕</button>
    </span>
  )
}

function RowFieldsInput({ row, index, total, readOnly, t, onChange, onRemove, onMove, packageListId }: {
  row: RowFields
  index: number
  total: number
  readOnly: boolean
  t: (key: AgentPresetSettingsKey) => string
  onChange: (next: RowFields) => void
  onRemove: () => void
  onMove: (delta: number) => void
  /** The shared datalist of package names already used in this composition. */
  packageListId: string | undefined
}): ReactNode {
  const configSnippet = useSnippetField(row, 'config', onChange)
  const isolateSnippet = useSnippetField(row, 'isolate', onChange)
  const classified = classifyConfig(row.name, row.config)
  const advancedKeys = Object.keys(classified.advanced)
  const [advOpen, setAdvOpen] = useState(false)
  const patchConfig = (next: unknown): void => { onChange({ ...row, config: next }) }
  const booleans = classified.fields.filter(f => f.field.kind === 'boolean')
  const expressions = classified.fields.filter(f => f.field.kind === 'js')
  const parameters = classified.fields.filter(f => f.field.kind === 'enum' || f.field.kind === 'number' || f.field.kind === 'text')
  const prompts = classified.fields.filter(f => f.field.kind === 'prompt')
  const gate = typeof row.disabled === 'object' ? row.disabled : undefined
  const isolateEntries = isKeyMap(row.isolate) ? Object.entries(row.isolate) : []
  const isolateBools = isolateEntries.filter(([, value]) => typeof value === 'boolean')
  const showAdvChip = !classified.mapped || advancedKeys.length > 0 || !readOnly
  const patchIsolateBool = (key: string, checked: boolean): void => {
    const isolate = { ...(row.isolate as Record<string, unknown>), [key]: checked }
    onChange({ ...row, isolate })
  }
  return (
    <div className={`${css.rowCard} ${prompts.length > 0 ? css.tileWide : ''}`}>
      <div className={css.tileHead} title={row.name === '' ? undefined : `${t('rowHeadPackage')}: ${row.name}`}>
        <GateCell row={row} readOnly={readOnly} t={t} onChange={onChange} />
        <input
          className={`${css.cellInput} ${css.inputMono}`}
          value={row.id}
          readOnly={readOnly}
          spellCheck={false}
          placeholder={t('rowId')}
          aria-label={`${t('rowHeadId')} ${index + 1}`}
          onChange={(event) => { onChange({ ...row, id: event.target.value }) }}
        />
        <RowTools index={index} total={total} t={t} onRemove={onRemove} onMove={onMove} placeholder={readOnly} />
      </div>
      {gate || expressions.length > 0 || booleans.length > 0 || parameters.length > 0 || isolateBools.length > 0 || showAdvChip ? (
        <div className={css.tileCfg}>
          {gate ? (
            <label className={css.paramLine}>
              <code className={css.jsBadge} aria-hidden="true">!!js</code>
              <input
                className={`${css.inlineInput} ${css.inputMono}`}
                value={gate.js}
                readOnly={readOnly}
                spellCheck={false}
                aria-label={t('jsExpressionGate')}
                title={`${t('jsExpressionGate')} ${gate.js}`}
                onChange={(event) => { onChange({ ...row, disabled: { js: event.target.value } }) }}
              />
            </label>
          ) : null}
          {expressions.map(({ field, value }) => (
            <label key={field.key} className={css.paramLine}>
              <span className={css.inlineKey}>{field.key}</span>
              <code className={css.jsBadge} aria-hidden="true">!!js</code>
              <input
                className={`${css.inlineInput} ${css.inputMono}`}
                value={isJsExprNode(value) ? value.__jsExpr : ''}
                readOnly={readOnly}
                spellCheck={false}
                aria-label={field.key}
                onChange={(event) => {
                  patchConfig({ ...(row.config as Record<string, unknown>), [field.key]: { __jsExpr: event.target.value } })
                }}
              />
            </label>
          ))}
          {booleans.length > 0 || isolateBools.length > 0 ? (
            <div className={css.toggleRow}>
              {isolateBools.map(([key, value]) => (
                <label key={key} className={css.inlineCheck}>
                  <input type="checkbox" checked={value === true} disabled={readOnly} aria-label={key}
                    onChange={(event) => { patchIsolateBool(key, event.target.checked) }} />
                  <span className={css.inlineKey}>{key}</span>
                </label>
              ))}
              {booleans.map(({ field, value }) => (
                <label key={field.key} className={css.inlineCheck}>
                  <input type="checkbox" checked={value === true} disabled={readOnly} aria-label={field.key}
                    onChange={(event) => {
                      patchConfig({ ...(row.config as Record<string, unknown>), [field.key]: event.target.checked })
                    }} />
                  <span className={css.inlineKey}>{field.key}</span>
                </label>
              ))}
            </div>
          ) : null}
          {parameters.map(({ field, value }) => (
            <InlineWidget
              key={field.key} name={field.key} field={field} value={value} readOnly={readOnly}
              onChange={(next) => { patchConfig({ ...(row.config as Record<string, unknown>), [field.key]: next }) }}
            />
          ))}
          {showAdvChip ? (
            <button type="button" className={css.advChip} aria-expanded={advOpen}
              onClick={() => { setAdvOpen(!advOpen) }}>
              {t('advancedLabel')}{advancedKeys.length > 0 ? ` · ${advancedKeys.length}` : ''}
            </button>
          ) : null}
        </div>
      ) : null}
      {prompts.map(({ field, value }) => (
        <textarea
          key={field.key}
          className={css.promptArea}
          value={typeof value === 'string' ? value : ''}
          readOnly={readOnly}
          spellCheck={false}
          aria-label={field.key}
          onChange={(event) => { patchConfig({ ...(row.config as Record<string, unknown>), [field.key]: event.target.value }) }}
        />
      ))}
      {advOpen ? (
        <div className={css.belowArea}>
          {!classified.mapped ? (
            <>
              <SnippetField
                label={t('configKeysLabel')} value={configSnippet.shown} error={configSnippet.error} readOnly={readOnly} t={t}
                onChange={configSnippet.setText} onCommit={configSnippet.commit}
              />
              {configSnippet.error ? <p className={css.error} role="alert">{t('configInvalid')}</p> : null}
            </>
          ) : (
            <>
              <div className={css.keyRow}>
                <span className={css.keyName}>{t('rowHeadPackage')}</span>
                <span className={css.keyValue}>
                  {packageListId === undefined ? null : (
                    <PackageSelect
                      row={row} readOnly={readOnly} t={t} packageListId={packageListId} onChange={onChange}
                    />
                  )}
                </span>
              </div>
              <KeyValueFields heading="" record={classified.advanced} readOnly={readOnly} t={t} onPatch={patchConfig} />
            </>
          )}
        </div>
      ) : null}
      {row.isolate !== undefined && !isKeyMap(row.isolate) ? (
        <div className={css.belowArea}>
          <SnippetField
            label={t('isolateKeysLabel')} value={isolateSnippet.shown} error={isolateSnippet.error} readOnly={readOnly} t={t}
            onChange={isolateSnippet.setText} onCommit={isolateSnippet.commit}
          />
          {isolateSnippet.error ? <p className={css.error} role="alert">{t('configInvalid')}</p> : null}
        </div>
      ) : null}
    </div>
  )
}

/** One group row: a full-width section — fold header carries the group's
   switch, id, child count, and its isolate toggles; the open body lays its
   child tools out as tiles in their own grid. */
function GroupRowFieldsInput({ row, index, total, readOnly, t, onChange, onRemove, onMove, packageListId }: {
  row: RowFields
  index: number
  total: number
  readOnly: boolean
  t: (key: AgentPresetSettingsKey) => string
  onChange: (next: RowFields) => void
  onRemove: () => void
  onMove: (delta: number) => void
  packageListId: string | undefined
}): ReactNode {
  const isolateSnippet = useSnippetField(row, 'isolate', onChange)
  const [open, setOpen] = useState(false)
  const patchChild = (childIndex: number, next: RowFields): void => {
    const children = (row.children ?? []).map((current, i) => i === childIndex ? next : current)
    onChange({ ...row, children })
  }
  const moveChild = (childIndex: number, delta: number): void => {
    const list = row.children ?? []
    const target = childIndex + delta
    if (target < 0 || target >= list.length) return
    const next = [...list]
    const [moved] = next.splice(childIndex, 1)
    if (moved !== undefined) next.splice(target, 0, moved)
    onChange({ ...row, children: next })
  }
  const gate = typeof row.disabled === 'object' ? row.disabled : undefined
  const isolateEntries = isKeyMap(row.isolate) ? Object.entries(row.isolate) : []
  const isolateBools = isolateEntries.filter(([, value]) => typeof value === 'boolean')
  const isolateRest = isolateEntries.filter(([, value]) => typeof value !== 'boolean')
  const showIsolateSnippet = row.isolate !== undefined && !isKeyMap(row.isolate)
  return (
    <div className={`${css.rowCard} ${css.rowGroupCard} ${css.tileWide}`}>
      <details open={open} className={css.rowGroup}>
        {/* The header IS the group's own switch line: clicks on its inputs must fold nothing. */}
        <summary
          className={css.rowGroupHead}
          title={`${t('rowHeadPackage')}: ${row.name}`}
          onClick={(event) => {
            event.preventDefault()
            if ((event.target as HTMLElement).closest('input, textarea, button') === null) setOpen(!open)
          }}
        >
          <span className={css.chev} aria-hidden="true">▸</span>
          <GateCell row={row} readOnly={readOnly} t={t} onChange={onChange} />
          <input
            className={`${css.cellInput} ${css.inputMono}`}
            value={row.id}
            readOnly={readOnly}
            spellCheck={false}
            placeholder={t('rowId')}
            aria-label={`${t('rowGroup')} ${index + 1}`}
            onChange={(event) => { onChange({ ...row, id: event.target.value }) }}
          />
          <span className={css.groupCount}>{(row.children ?? []).length}</span>
          {gate ? (
            <input
              className={`${css.inlineInput} ${css.inlineExpr} ${css.inputMono}`}
              value={gate.js}
              readOnly={readOnly}
              spellCheck={false}
              aria-label={t('jsExpressionGate')}
              title={`${t('jsExpressionGate')} ${gate.js}`}
              onChange={(event) => { onChange({ ...row, disabled: { js: event.target.value } }) }}
            />
          ) : null}
          <span className={css.toggleRow}>
            {isolateBools.map(([key, value]) => (
              <label key={key} className={css.inlineCheck}>
                <input
                  type="checkbox"
                  checked={value === true}
                  disabled={readOnly}
                  aria-label={key}
                  onChange={(event) => {
                    const isolate = { ...(row.isolate as Record<string, unknown>), [key]: event.target.checked }
                    onChange({ ...row, isolate })
                  }}
                />
                <span className={css.inlineKey}>{key}</span>
              </label>
            ))}
          </span>
          <RowTools index={index} total={total} t={t} onRemove={onRemove} onMove={onMove} placeholder={readOnly} />
        </summary>
        <div className={css.rowGroupBody}>
          {showIsolateSnippet ? (
            <>
              <SnippetField
                label={t('isolateKeysLabel')} value={isolateSnippet.shown} error={isolateSnippet.error} readOnly={readOnly} t={t}
                onChange={isolateSnippet.setText} onCommit={isolateSnippet.commit}
              />
              {isolateSnippet.error ? <p className={css.error} role="alert">{t('configInvalid')}</p> : null}
            </>
          ) : null}
          <div className={css.tileGrid}>
            {(row.children ?? []).map((child, childIndex) => (
              <RowFieldsInput
                key={childIndex}
                row={child}
                index={childIndex}
                total={(row.children ?? []).length}
                readOnly={readOnly}
                t={t}
                packageListId={packageListId}
                onChange={(next) => { patchChild(childIndex, next) }}
                onRemove={() => {
                  const children = (row.children ?? []).filter((_, i) => i !== childIndex)
                  onChange({ ...row, children })
                }}
                onMove={(delta) => { moveChild(childIndex, delta) }}
              />
            ))}
          </div>
          {!readOnly ? (
            <button type="button" className={`${css.secondaryButton} ${css.addRowButton}`}
              onClick={() => { onChange({ ...row, children: [...(row.children ?? []), { id: '', name: '' }] }) }}>
              {t('rowAddChild')}
            </button>
          ) : null}
        </div>
        {isolateRest.length > 0 ? (
          <div className={css.belowArea}>
            <KeyValueFields
              heading={t('isolateKeysLabel')}
              record={Object.fromEntries(isolateRest)}
              readOnly={readOnly}
              t={t}
              onPatch={(next) => { onChange({ ...row, isolate: next }) }}
            />
          </div>
        ) : null}
      </details>
    </div>
  )
}

/** The shared datalist of package names this composition already uses. */
const PACKAGE_DATALIST_ID = 'dsh-agent-preset-package-list'

/** Collect the distinct plugin package names a composition references. */
function collectPackageNames(rows: RowFields[], into: Set<string>): void {
  for (const row of rows) {
    if (row.name !== '' && row.name !== 'cordis:group') into.add(row.name)
    if (row.children !== undefined) collectPackageNames(row.children, into)
  }
}

/** The agent.cordis.yml fields: one line per plugin row under a single set of
   column headers, each row's config as per-key controls of its value types. */
function CompositionFormFields({ t, readOnly, patchComposition, value }: FormFieldsProps & {
  value: CompositionForm
}): ReactNode {
  const rows = value.rows
  const setRows = (next: RowFields[]): void => { patchComposition?.({ rows: next }) }
  const patchRow = (index: number, next: RowFields): void => {
    setRows(rows.map((current, i) => i === index ? next : current))
  }
  const moveRow = (list: RowFields[], index: number, delta: number): RowFields[] => {
    const target = index + delta
    if (target < 0 || target >= list.length) return list
    const next = [...list]
    const [moved] = next.splice(index, 1)
    if (moved !== undefined) next.splice(target, 0, moved)
    return next
  }
  const packageNames = new Set<string>(KNOWN_PACKAGES)
  collectPackageNames(rows, packageNames)
  // The four semantic modules are a pure view over the stored row order:
  // rows keep their indices and bytes, the sections only decide placement.
  const moduleRows = new Map<RowModule, { row: RowFields; index: number }[]>()
  rows.forEach((row, index) => {
    const module = moduleOf(row)
    const list = moduleRows.get(module) ?? []
    list.push({ row, index })
    moduleRows.set(module, list)
  })
  const moduleKey: Record<RowModule, AgentPresetSettingsKey> = {
    prompt: 'modulePrompt',
    tools: 'moduleTools',
    runtime: 'moduleRuntime',
    advanced: 'advancedLabel',
  }
  const renderRow = ({ row, index }: { row: RowFields; index: number }): ReactNode => (
    row.group === true ? (
      <GroupRowFieldsInput
        row={row}
        index={index}
        total={rows.length}
        readOnly={readOnly}
        t={t}
        packageListId={PACKAGE_DATALIST_ID}
        onChange={(next) => { patchRow(index, next) }}
        onRemove={() => { setRows(rows.filter((_, i) => i !== index)) }}
        onMove={(delta) => { setRows(moveRow(rows, index, delta)) }}
      />
    ) : (
      <RowFieldsInput
        row={row}
        index={index}
        total={rows.length}
        readOnly={readOnly}
        t={t}
        packageListId={PACKAGE_DATALIST_ID}
        onChange={(next) => { patchRow(index, next) }}
        onRemove={() => { setRows(rows.filter((_, i) => i !== index)) }}
        onMove={(delta) => { setRows(moveRow(rows, index, delta)) }}
      />
    )
  )
  return (
    <div className={css.editorFields}>
      <datalist id={PACKAGE_DATALIST_ID}>
        {Array.from(packageNames, name => <option key={name} value={name} />)}
      </datalist>
      {MODULE_ORDER.map((module) => {
        const list = moduleRows.get(module)
        if (list === undefined || list.length === 0) return null
        return (
          <section key={module} className={css.module}>
            <h4 className={css.moduleHead}>{t(moduleKey[module])}</h4>
            <div className={css.tileGrid}>
              {list.map(entry => renderRow(entry))}
            </div>
          </section>
        )
      })}
      {!readOnly ? (
        <button type="button" className={`${css.secondaryButton} ${css.addRowButton}`}
          onClick={() => { setRows([...rows, { id: '', name: '' }]) }}>
          {t('rowAdd')}
        </button>
      ) : null}
    </div>
  )
}

/**
 * Render the Agent presets section content column.
 * @param props - composed slot props.
 * @returns the section, or null when the deployment composes no presets.
 */
export function AgentPresetSection(props: AgentPresetSectionProps): ReactNode {
  const { useAgentPresetSection, t, load } = props
  const state = useAgentPresetSection(snapshot => snapshot)
  const viewedId = state.view?.id ?? state.edit?.id
  const viewedRow = viewedId === undefined ? undefined : state.rows.find(row => row.id === viewedId)
  const viewedTitle = state.view === null && state.edit === null
    ? ''
    : viewedRow === undefined ? (state.view?.title ?? state.edit?.id ?? '') : presetDisplayText(viewedRow, t).name
  const [viewerTab, setViewerTab] = useState<'composition' | 'metadata'>('composition')
  const [providers, setProviders] = useState<readonly { id: string; name: string }[]>([])
  // The read-only viewer's own per-file face. Form-first, like the editor.
  const [viewForm, setViewForm] = useState<{ metadata: boolean; composition: boolean }>({
    metadata: true,
    composition: true,
  })
  const editing = state.edit !== null
  const currentMetadataText = state.edit?.metadata ?? state.view?.metadata ?? ''
  const currentCompositionText = state.edit?.composition ?? state.view?.content ?? ''
  const metadataForm = parseMetadataForm(currentMetadataText)
  const compositionForm = parseCompositionForm(currentCompositionText)
  // Each file decides its own face: the metadata round-trips for almost
  // every preset, while compositions with group rows stay YAML. The form
  // is offered per file only when that file round-trips exactly.
  const editingMetadata = editing && state.edit?.metadataMode === 'form'
  const editingComposition = editing && state.edit?.compositionMode === 'form'
  useEffect(() => {
    if (!editing || state.edit?.metadataMode !== 'form') return
    let alive = true
    void props.modelProviders().then((result) => {
      if (alive) setProviders(result)
    }).catch(() => { /* selects fall back to free text */ })
    return () => { alive = false }
    // Providers load once per editor session; the texts drive everything else.
  }, [editing, state.edit?.metadataMode])

  useEffect(() => {
    void load()
  }, [load])

  // A deployment that composes no presets has nothing to manage: every
  // session shares the host composition and the page would be an empty list.
  if (state.status === 'unavailable') return null
  if (state.status === 'error') {
    /* v8 ignore next -- an error status always carries text; the fallback satisfies the nullable type */
    const detail = state.error ?? ''
    return (
      <div className={css.section}>
        <p className={css.error} role="alert">{`${t('error')} ${detail}`}</p>
        <button type="button" className={css.secondaryButton} onClick={() => { void load() }}>
          {t('retry')}
        </button>
      </div>
    )
  }

  /* The guided alternative to copying: the self-referential preset can
     read this very composition and author a new one in conversation.
     Offered only where that preset is actually on the roster and a
     session can be landed; without a writable root the draft could
     never be discovered, so the reason rides the disabled button. */
  const creatorButton = props.startCreatorDraft !== undefined && state.rows.some(row => row.id === 'cordis')
    ? (
      <button
        type="button"
        className={css.creatorButton}
        disabled={!state.authorable}
        title={state.authorable ? undefined : t('duplicateUnavailable')}
        onClick={() => {
          props.startCreatorDraft?.()
          props.close()
        }}
      >
        <IconPlusOutline16 size={14} />
        {t('creatorDraft')}
      </button>
    )
    : null

  return (
    <div className={css.section}>
      <h2 className={css.title}>{t('nav')}</h2>
      <p className={css.intro}>{t('sectionIntro')}</p>
      {state.error === null ? null : <p className={css.error} role="alert">{state.error}</p>}
      {([['system', t('builtInGroup')], ['user', t('customGroup')]] as const).map(([trust, heading]) => {
        const group = state.rows
          .filter(row => row.trust === trust)
          .map(row => ({ row, text: presetDisplayText(row, t) }))
        // The custom group is where a preset of one's own will appear, so it
        // stays on screen even while empty: heading plus the creator entry.
        const tail = trust === 'user' ? creatorButton : null
        if (group.length === 0 && tail === null) return null
        return (
          <section key={trust} className={css.group}>
            <h3 className={css.groupHead}>{heading}</h3>
            {group.length === 0 ? null : (
              <ul className={css.cards}>
                {group.map(({ row, text }) => (
                  <li
                    key={row.id}
                    className={row.broken !== undefined
                      ? `${css.card} ${css.cardBroken}`
                      : row.isDefault ? `${css.card} ${css.cardActive}` : css.card}
                  >
                    {/* The card body IS the control: picking a preset is the
                      common act, so it should not hide behind a small button.
                      The action row sits outside it — nesting buttons is
                      invalid, and these act on the card rather than select it.
                      A broken preset cannot compose a session, so its body
                      refuses the pick; the reason rides the badge rather than
                      the card face, which stays the preset's own
                      description. */}
                    <button
                      type="button"
                      className={css.cardMain}
                      aria-pressed={row.isDefault}
                      // Broken says so through `aria-disabled` rather than
                      // `disabled`, which would take the card out of the tab
                      // order. With the reason moved onto the badge, that is
                      // the only way anyone without a pointer reaches it.
                      disabled={row.isDefault}
                      aria-disabled={row.broken !== undefined}
                      // Without this the name is the whole card read aloud —
                      // title, badge, description, id.
                      aria-label={`${row.broken !== undefined ? t('brokenBadge') : row.isDefault ? t('inUse') : t('setDefault')}: ${text.name}`}
                      // The reason rides the badge, not the whole card: two
                      // tooltips over one target would race, and the card's
                      // own label answers what clicking it would do.
                      title={row.broken !== undefined ? t('brokenBadge') : row.isDefault ? t('inUse') : t('setDefault')}
                      onClick={() => {
                        if (row.broken !== undefined) return
                        void props.makeDefault(row.id)
                      }}
                    >
                      <span className={css.cardHead}>
                        <span className={css.cardName}>{text.name}</span>
                        {row.broken !== undefined
                          ? (
                            <span className={css.brokenBadge}>
                              {t('brokenBadge')}
                              {/* Pointer-only, hence `aria-hidden`: the same
                                reason reaches assistive technology through the
                                alert below, and a second copy inside the card's
                                own text would be read out twice. */}
                              <span className={css.brokenTip} aria-hidden="true">{row.broken}</span>
                            </span>
                          )
                          : null}
                        <span className={css.badge}>
                          {row.trust === 'user' ? t('userTrust') : t('builtIn')}
                        </span>
                        {row.isDefault ? <span className={css.inUse}>{t('inUse')}</span> : null}
                      </span>
                      <CardDescription text={text.description ?? t('noDescription')} />
                      {/* Visually hidden, deliberately: the pointer path is the
                        badge's tooltip, and a disabled card body is out of the
                        tab order, so this is the only reading a screen reader
                        or a keyboard-only user gets. */}
                      {row.broken === undefined
                        ? null
                        : <span className={css.cardBrokenReason} role="alert">{row.broken}</span>}
                      <code className={css.cardId}>{row.id}</code>
                    </button>
                    <div className={css.cardFoot}>
                      {/* Every preset opens in the viewer: reading a shipped
                        one is the point (it is the known-good composition a
                        copy starts from), and a custom one graduates to the
                        in-browser editor from the same viewer. A broken
                        preset has no readable composition to offer, so its
                        viewer is withheld; a broken custom one keeps the
                        location action — the files are where it gets
                        fixed. */}
                      {row.broken === undefined ? (
                        <button
                          type="button"
                          className={css.iconButton}
                          data-tip={t('view')}
                          aria-label={`${t('view')}: ${text.name}`}
                          onClick={() => { void props.view(row.id) }}
                        >
                          <IconBrowseOutline16 />
                        </button>
                      ) : null}
                      {row.trust === 'user' ? (
                        <button
                          type="button"
                          className={css.iconButton}
                          data-tip={state.hasDocument ? t('openLocation') : t('showLocation')}
                          aria-label={`${state.hasDocument ? t('openLocation') : t('showLocation')}: ${text.name}`}
                          onClick={() => { void props.openLocation(row.id) }}
                        >
                          <IconFolderOpenOutline16 />
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className={css.iconButton}
                        disabled={!state.authorable || row.broken !== undefined}
                        data-tip={row.broken !== undefined
                          ? t('brokenNoCopy')
                          : state.authorable ? t('duplicate') : t('duplicateUnavailable')}
                        aria-label={`${t('duplicate')}: ${text.name}`}
                        onClick={() => { props.beginCopy(row.id) }}
                      >
                        <IconCopyOutline16 />
                      </button>
                      {row.trust === 'user'
                        ? (
                          <button
                            type="button"
                            className={`${css.iconButton} ${css.iconDanger}`}
                            data-tip={t('delete')}
                            aria-label={`${t('delete')}: ${text.name}`}
                            onClick={() => { props.confirmDelete(row.id) }}
                          >
                            <IconTrashOutline16 />
                          </button>
                        )
                        : null}
                    </div>
                    {state.revealedPaths[row.id] === undefined
                      ? null
                      : (
                        <p className={css.revealedPath}>
                          <span className={css.revealedPathLabel}>{t('revealedPathLabel')}</span>
                          <code>{state.revealedPaths[row.id]}</code>
                        </p>
                      )}
                  </li>
                ))}
              </ul>
            )}
            {tail}
          </section>
        )
      })}
      <CopyDialog
        state={state}
        t={t}
        actions={{
          cancelCopy: props.cancelCopy,
          confirmCopy: props.confirmCopy,
          setCopyId: props.setCopyId,
          setCopyName: props.setCopyName,
        }}
      />
      <Modal
        open={state.view !== null || state.edit !== null}
        onClose={() => {
          if (state.edit !== null) props.cancelEdit()
          else props.closeView()
        }}
        title={viewedTitle === '' ? t('view') : `${t('view')} · ${viewedTitle}`}
        closeLabel={t('close')}
        description={t('composition')}
        className={`${css.dialog} ${css.viewDialog}`}
        footer={state.edit === null ? (
          <>
            {state.view?.trust === 'user' ? (
              <Button variant="outline" onClick={() => { props.beginEdit() }}>
                {t('edit')}
              </Button>
            ) : null}
            <Button variant="outline" autoFocus onClick={() => { props.closeView() }}>
              {t('close')}
            </Button>
          </>
        ) : (
          <>
            <Button variant="outline" disabled={state.edit.saving} onClick={() => { props.cancelEdit() }}>
              {t('cancel')}
            </Button>
            <Button disabled={state.edit.saving} onClick={() => { void props.saveEdit() }}>
              {state.edit.saving ? t('saving') : t('save')}
            </Button>
          </>
        )}
      >
        {(state.edit === null ? state.view === null : false) ? null : (
          <>
            <div className={css.viewerTabs} role="tablist">
              {([['composition', 'compositionFile'], ['metadata', 'metadataFile']] as const).map(
                ([tab, label]) => (
                  <button
                    key={tab}
                    type="button"
                    role="tab"
                    aria-selected={viewerTab === tab}
                    className={viewerTab === tab ? `${css.viewerTab} ${css.viewerTabActive}` : css.viewerTab}
                    onClick={() => { setViewerTab(tab) }}
                  >
                    {t(label)}
                  </button>
                ),
              )}
              <span className={css.spacer} />
              {(() => {
                const representable = viewerTab === 'composition'
                  ? compositionForm !== undefined
                  : metadataForm !== undefined
                if (!representable) {
                  return <span className={css.viewerTab} title={t('formUnavailable')}>{t('modeYaml')}</span>
                }
                const file = viewerTab === 'composition' ? 'composition' : 'metadata'
                const inForm = editing
                  ? (file === 'composition' ? editingComposition : editingMetadata)
                  : viewForm[file]
                return (
                  <button
                    type="button"
                    className={css.viewerTab}
                    aria-pressed={inForm}
                    onClick={() => {
                      if (editing) {
                        props.setEditMode(file, inForm ? 'yaml' : 'form')
                      } else {
                        setViewForm(current => ({ ...current, [file]: !inForm }))
                      }
                    }}
                  >
                    {inForm ? t('modeYaml') : t('modeForm')}
                  </button>
                )
              })()}
            </div>
            {/* The body scrolls on its own: a long composition must never push
                the tab row out of view or the footer buttons out of reach. */}
            <div className={css.viewerBody}>
              {viewerTab === 'composition'
                ? (compositionForm !== undefined && (editing ? editingComposition : viewForm.composition)
                  ? (
                    <CompositionFormFields
                      t={t} readOnly={!editing} value={compositionForm}
                      patchComposition={props.patchCompositionForm}
                    />
                  )
                  : <pre className={css.viewerCode}>{currentCompositionText}</pre>)
                : (metadataForm !== undefined && (editing ? editingMetadata : viewForm.metadata)
                  ? (
                    <MetadataFormFields
                      t={t} readOnly={!editing} value={metadataForm} providers={providers}
                      patchMetadata={props.patchMetadataForm}
                    />
                  )
                  : <pre className={css.viewerCode}>{currentMetadataText}</pre>)}
              {state.edit !== null && state.edit.error === null ? null : state.edit === null ? null : (
                <p className={css.error} role="alert">{state.edit.error}</p>
              )}
            </div>
          </>
        )}
      </Modal>
      <Modal
        open={state.pendingDelete !== null}
        onClose={() => { props.confirmDelete(null) }}
        title={t('deleteTitle')}
        closeLabel={t('close')}
        description={t('deleteDescription')}
        className={css.deleteDialog as string}
        footer={(
          <>
            <Button
              variant="outline"
              autoFocus
              disabled={state.deleting}
              onClick={() => { props.confirmDelete(null) }}
            >
              {t('cancel')}
            </Button>
            <Button
              variant="outline"
              className={css.deleteConfirm}
              disabled={state.deleting}
              onClick={() => { void props.remove() }}
            >
              {state.deleting ? t('deleting') : t('deleteConfirm')}
            </Button>
          </>
        )}
      />
    </div>
  )
}
