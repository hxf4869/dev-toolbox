import type { Extension } from '@codemirror/state'

import type {
  DiffDriver,
  DiffDriverOptions,
  EditorDriver,
  EditorDriverOptions,
  StructuredDataLanguage,
} from './contracts'

async function loadLanguage(language: StructuredDataLanguage): Promise<Extension> {
  if (language === 'plaintext') return []
  if (language === 'json') {
    const { json } = await import('@codemirror/lang-json')
    return json()
  }
  const { yaml } = await import('@codemirror/lang-yaml')
  return yaml()
}

async function loadCodeMirrorCore() {
  const [state, view, commands] = await Promise.all([
    import('@codemirror/state'),
    import('@codemirror/view'),
    import('@codemirror/commands'),
  ])
  return { ...state, ...view, ...commands }
}

function replaceDocument(
  view: import('@codemirror/view').EditorView,
  value: string,
  applying: { value: boolean },
) {
  if (view.state.doc.toString() === value) return
  applying.value = true
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } })
  applying.value = false
}

export async function createCodeMirrorEditor(options: EditorDriverOptions): Promise<EditorDriver> {
  const cm = await loadCodeMirrorCore()
  const [languageExtension] = await Promise.all([loadLanguage(options.language)])
  const languageCompartment = new cm.Compartment()
  const ariaLabelCompartment = new cm.Compartment()
  const readOnlyCompartment = new cm.Compartment()
  const applying = { value: false }
  const state = cm.EditorState.create({
    doc: options.value,
    extensions: [
      cm.lineNumbers(),
      cm.highlightActiveLine(),
      cm.history(),
      cm.keymap.of([...cm.defaultKeymap, ...cm.historyKeymap]),
      ariaLabelCompartment.of(cm.EditorView.contentAttributes.of({ 'aria-label': options.ariaLabel })),
      cm.EditorView.theme({
        '&': { color: 'var(--text-primary)', backgroundColor: 'var(--bg-code)' },
        '.cm-content': { caretColor: 'var(--accent)' },
        '&.cm-focused .cm-cursor': { borderLeftColor: 'var(--accent)' },
        '.cm-gutters': {
          color: 'var(--text-muted)',
          backgroundColor: 'var(--bg-code)',
          borderRightColor: 'var(--border-subtle)',
        },
      }),
      languageCompartment.of(languageExtension),
      readOnlyCompartment.of([
        cm.EditorState.readOnly.of(options.readOnly),
        cm.EditorView.editable.of(!options.readOnly),
      ]),
      cm.EditorView.updateListener.of((update) => {
        if (update.docChanged && !applying.value) options.onChange(update.state.doc.toString())
      }),
    ],
  })
  const view = new cm.EditorView({ state, parent: options.host })
  let disposed = false

  return {
    kind: 'codemirror',
    getValue: () => view.state.doc.toString(),
    setValue(value) {
      replaceDocument(view, value, applying)
    },
    async setLanguage(language) {
      const extension = await loadLanguage(language)
      if (!disposed) view.dispatch({ effects: languageCompartment.reconfigure(extension) })
    },
    setAriaLabel(ariaLabel) {
      if (!disposed) {
        view.dispatch({
          effects: ariaLabelCompartment.reconfigure(cm.EditorView.contentAttributes.of({ 'aria-label': ariaLabel })),
        })
      }
    },
    setReadOnly(readOnly) {
      view.dispatch({
        effects: readOnlyCompartment.reconfigure([
          cm.EditorState.readOnly.of(readOnly),
          cm.EditorView.editable.of(!readOnly),
        ]),
      })
    },
    dispose() {
      if (disposed) return
      disposed = true
      view.destroy()
    },
  }
}

export async function createCodeMirrorDiffEditor(options: DiffDriverOptions): Promise<DiffDriver> {
  const [cm, { unifiedMergeView }] = await Promise.all([
    loadCodeMirrorCore(),
    import('@codemirror/merge'),
  ])
  const languageCompartment = new cm.Compartment()
  const diffCompartment = new cm.Compartment()
  const applying = { value: false }
  const state = cm.EditorState.create({
    doc: options.modified,
    extensions: [
      cm.lineNumbers(),
      cm.EditorView.contentAttributes.of({ 'aria-label': options.ariaLabel }),
      cm.EditorView.theme({
        '&': { color: 'var(--text-primary)', backgroundColor: 'var(--bg-code)' },
        '.cm-gutters': {
          color: 'var(--text-muted)',
          backgroundColor: 'var(--bg-code)',
          borderRightColor: 'var(--border-subtle)',
        },
      }),
      languageCompartment.of(await loadLanguage(options.language)),
      diffCompartment.of(unifiedMergeView({ original: options.original, mergeControls: false })),
      cm.EditorState.readOnly.of(true),
      cm.EditorView.editable.of(false),
    ],
  })
  const view = new cm.EditorView({ state, parent: options.host })
  let disposed = false

  return {
    kind: 'codemirror',
    getModifiedValue: () => view.state.doc.toString(),
    setTexts(original, modified) {
      replaceDocument(view, modified, applying)
      view.dispatch({
        effects: diffCompartment.reconfigure(unifiedMergeView({ original, mergeControls: false })),
      })
    },
    async setLanguage(language) {
      const extension = await loadLanguage(language)
      if (!disposed) view.dispatch({ effects: languageCompartment.reconfigure(extension) })
    },
    dispose() {
      if (disposed) return
      disposed = true
      view.destroy()
    },
  }
}
