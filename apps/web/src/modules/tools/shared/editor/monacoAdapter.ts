import type {
  DiffDriver,
  DiffDriverOptions,
  EditorDriver,
  EditorDriverOptions,
  StructuredDataLanguage,
} from './contracts'

type WorkerConstructor = new () => Worker

const runtimeWorkers = new Set<Worker>()
let runtimeReferences = 0
let editorWorkerConstructor: WorkerConstructor | null = null
let jsonWorkerConstructor: WorkerConstructor | null = null
let jsonFeature: typeof import('monaco-editor/languages/features/json/register') | null = null
let themeObserver: MutationObserver | null = null

function activeMonacoTheme() {
  return document.documentElement.dataset.theme === 'light' ? 'vs' : 'vs-dark'
}

async function loadWorkerConstructor(path: 'editor' | 'json'): Promise<WorkerConstructor> {
  if (path === 'json') {
    const module = await import('monaco-editor/language/json/json.worker?worker')
    return module.default
  }
  const module = await import('monaco-editor/editor/editor.worker?worker')
  return module.default
}

async function prepareMonaco(language: StructuredDataLanguage) {
  const [monaco, editorWorker] = await Promise.all([
    import('monaco-editor/editor/editor.api'),
    loadWorkerConstructor('editor'),
    // Monaco 0.56's JSON worker manager registers editor services as a side effect.
    // Load those registrations before the first standalone model, including YAML-first routes.
    import('monaco-editor/languages/features/json/jsonMode'),
  ])
  editorWorkerConstructor = editorWorker

  const ensureLanguage = async (nextLanguage: StructuredDataLanguage) => {
    if (nextLanguage === 'plaintext') return
    if (nextLanguage === 'json') {
      const [feature, constructor] = await Promise.all([
        import('monaco-editor/languages/features/json/register'),
        loadWorkerConstructor('json'),
      ])
      jsonFeature = feature
      jsonWorkerConstructor = constructor
      return
    }
    await import('monaco-editor/languages/definitions/yaml/register')
  }
  await ensureLanguage(language)

  globalThis.MonacoEnvironment = {
    getWorker(_moduleId, label) {
      const Constructor =
        label === 'json' && jsonWorkerConstructor
          ? jsonWorkerConstructor
          : editorWorkerConstructor
      if (!Constructor) throw new Error('Monaco worker runtime is not ready')
      const worker = new Constructor()
      runtimeWorkers.add(worker)
      return worker
    },
  }

  monaco.editor.setTheme(activeMonacoTheme())
  if (runtimeReferences === 0) {
    themeObserver = new MutationObserver(() => monaco.editor.setTheme(activeMonacoTheme()))
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  }
  runtimeReferences += 1
  return { monaco, ensureLanguage, release: releaseMonacoRuntime }
}

function releaseMonacoRuntime() {
  runtimeReferences = Math.max(0, runtimeReferences - 1)
  if (runtimeReferences > 0) return

  // Notify Monaco's JSON worker manager first so a later route entry creates a
  // fresh proxy instead of retaining a proxy for a terminated Worker.
  if (jsonFeature) {
    jsonFeature.jsonDefaults.setDiagnosticsOptions(jsonFeature.jsonDefaults.diagnosticsOptions)
  }
  for (const worker of runtimeWorkers) worker.terminate()
  runtimeWorkers.clear()
  themeObserver?.disconnect()
  themeObserver = null
}

export async function createMonacoEditor(options: EditorDriverOptions): Promise<EditorDriver> {
  const { monaco, ensureLanguage, release } = await prepareMonaco(options.language)
  const model = monaco.editor.createModel(options.value, options.language)
  const editor = monaco.editor.create(options.host, {
    automaticLayout: true,
    ariaLabel: options.ariaLabel,
    minimap: { enabled: false },
    model,
    readOnly: options.readOnly,
    scrollBeyondLastLine: false,
  })
  let applyingValue = false
  let disposed = false
  const changeSubscription = editor.onDidChangeModelContent(() => {
    if (!applyingValue) options.onChange(model.getValue())
  })

  return {
    kind: 'monaco',
    getValue: () => model.getValue(),
    setValue(value) {
      if (model.getValue() === value) return
      applyingValue = true
      model.setValue(value)
      applyingValue = false
    },
    async setLanguage(language) {
      await ensureLanguage(language)
      if (disposed) return
      monaco.editor.setModelLanguage(model, language)
    },
    setAriaLabel(ariaLabel) {
      editor.updateOptions({ ariaLabel })
    },
    setReadOnly(readOnly) {
      editor.updateOptions({ readOnly })
    },
    dispose() {
      if (disposed) return
      disposed = true
      changeSubscription.dispose()
      editor.dispose()
      model.dispose()
      release()
    },
  }
}

export async function createMonacoDiffEditor(options: DiffDriverOptions): Promise<DiffDriver> {
  const { monaco, ensureLanguage, release } = await prepareMonaco(options.language)
  const originalModel = monaco.editor.createModel(options.original, options.language)
  const modifiedModel = monaco.editor.createModel(options.modified, options.language)
  const diffEditor = monaco.editor.createDiffEditor(options.host, {
    automaticLayout: true,
    ariaLabel: options.ariaLabel,
    enableSplitViewResizing: true,
    originalEditable: false,
    readOnly: true,
    renderSideBySide: true,
    scrollBeyondLastLine: false,
  })
  diffEditor.setModel({ original: originalModel, modified: modifiedModel })
  let disposed = false

  return {
    kind: 'monaco',
    getModifiedValue: () => modifiedModel.getValue(),
    setTexts(original, modified) {
      originalModel.setValue(original)
      modifiedModel.setValue(modified)
    },
    async setLanguage(language) {
      await ensureLanguage(language)
      if (disposed) return
      monaco.editor.setModelLanguage(originalModel, language)
      monaco.editor.setModelLanguage(modifiedModel, language)
    },
    dispose() {
      if (disposed) return
      disposed = true
      diffEditor.setModel(null)
      diffEditor.dispose()
      originalModel.dispose()
      modifiedModel.dispose()
      release()
    },
  }
}
