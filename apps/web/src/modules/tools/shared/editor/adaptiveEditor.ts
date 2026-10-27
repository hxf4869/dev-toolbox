import { createEditorCapabilityQuery, selectEditorKind } from './capability'
import type {
  DiffDriver,
  DiffDriverFactory,
  EditorCapabilityQuery,
  EditorDriver,
  EditorDriverFactory,
  EditorKind,
  StructuredDataLanguage,
} from './contracts'

export interface AdaptiveEditorOptions {
  host: HTMLElement
  ariaLabel: string
  language: StructuredDataLanguage
  value?: string
  readOnly?: boolean
  onChange?(value: string): void
  capabilityQuery?: EditorCapabilityQuery
  loadMonaco?: EditorDriverFactory
  loadCodeMirror?: EditorDriverFactory
  // 接住能力变化等无人 await 的迁移 rejection；ready/refresh 的 rejection
  // 仍由调用方自行处理并呈现。
  onMigrationError?(error: unknown): void
}

export interface AdaptiveEditor {
  readonly kind: EditorKind | null
  readonly ready: Promise<void>
  getValue(): string
  setValue(value: string): void
  setLanguage(language: StructuredDataLanguage): Promise<void>
  setAriaLabel(label: string): void
  setReadOnly(readOnly: boolean): void
  refresh(): Promise<void>
  dispose(): void
}

export interface AdaptiveDiffEditorOptions {
  host: HTMLElement
  ariaLabel: string
  language: StructuredDataLanguage
  original: string
  modified: string
  capabilityQuery?: EditorCapabilityQuery
  loadMonaco?: DiffDriverFactory
  loadCodeMirror?: DiffDriverFactory
  onMigrationError?(error: unknown): void
}

export interface AdaptiveDiffEditor {
  readonly kind: EditorKind | null
  readonly ready: Promise<void>
  getModifiedValue(): string
  setTexts(original: string, modified: string): void
  setLanguage(language: StructuredDataLanguage): Promise<void>
  refresh(): Promise<void>
  dispose(): void
}

const defaultEditorLoaders = {
  monaco: async (options: Parameters<EditorDriverFactory>[0]) => {
    const { createMonacoEditor } = await import('./monacoAdapter')
    return createMonacoEditor(options)
  },
  codemirror: async (options: Parameters<EditorDriverFactory>[0]) => {
    const { createCodeMirrorEditor } = await import('./codeMirrorAdapter')
    return createCodeMirrorEditor(options)
  },
} satisfies Record<EditorKind, EditorDriverFactory>

const defaultDiffLoaders = {
  monaco: async (options: Parameters<DiffDriverFactory>[0]) => {
    const { createMonacoDiffEditor } = await import('./monacoAdapter')
    return createMonacoDiffEditor(options)
  },
  codemirror: async (options: Parameters<DiffDriverFactory>[0]) => {
    const { createCodeMirrorDiffEditor } = await import('./codeMirrorAdapter')
    return createCodeMirrorDiffEditor(options)
  },
} satisfies Record<EditorKind, DiffDriverFactory>

export function createAdaptiveEditor(options: AdaptiveEditorOptions): AdaptiveEditor {
  const query = options.capabilityQuery ?? createEditorCapabilityQuery()
  const loaders: Record<EditorKind, EditorDriverFactory> = {
    monaco: options.loadMonaco ?? defaultEditorLoaders.monaco,
    codemirror: options.loadCodeMirror ?? defaultEditorLoaders.codemirror,
  }
  let driver: EditorDriver | null = null
  let value = options.value ?? ''
  let language = options.language
  let ariaLabel = options.ariaLabel
  let readOnly = options.readOnly ?? false
  let disposed = false
  let operation = Promise.resolve()

  const migrate = async (): Promise<void> => {
    if (disposed) return
    const targetKind = selectEditorKind(query)
    if (driver?.kind === targetKind) return

    if (driver) {
      value = driver.getValue()
      driver.dispose()
      driver = null
    }

    const loadedLanguage = language
    const loadedAriaLabel = ariaLabel
    const loadedReadOnly = readOnly
    const nextDriver = await loaders[targetKind]({
      host: options.host,
      ariaLabel: loadedAriaLabel,
      language: loadedLanguage,
      value,
      readOnly: loadedReadOnly,
      onChange(nextValue) {
        value = nextValue
        options.onChange?.(nextValue)
      },
    })

    if (disposed) {
      nextDriver.dispose()
      return
    }
    if (nextDriver.getValue() !== value) nextDriver.setValue(value)
    if (loadedLanguage !== language) await nextDriver.setLanguage(language)
    if (loadedAriaLabel !== ariaLabel) nextDriver.setAriaLabel(ariaLabel)
    if (loadedReadOnly !== readOnly) nextDriver.setReadOnly(readOnly)
    if (selectEditorKind(query) !== targetKind) {
      nextDriver.dispose()
      return migrate()
    }
    driver = nextDriver
  }

  const enqueueMigration = () => {
    // 一次迁移失败不能毒化队列：隔离上一次的 rejection，让后续 refresh、
    // 语言更新与能力变化照常执行；本次返回的 promise 仍向上抛给调用方呈现。
    operation = operation.then(migrate, migrate)
    return operation
  }
  const onCapabilityChange = () => {
    void enqueueMigration().catch((error: unknown) => {
      options.onMigrationError?.(error)
    })
  }
  query.addEventListener('change', onCapabilityChange)
  const ready = enqueueMigration()

  return {
    get kind() {
      return driver?.kind ?? null
    },
    ready,
    getValue() {
      return driver?.getValue() ?? value
    },
    setValue(nextValue) {
      value = nextValue
      driver?.setValue(nextValue)
    },
    setLanguage(nextLanguage) {
      language = nextLanguage
      const applyLanguage = async (): Promise<void> => {
        await driver?.setLanguage(nextLanguage)
      }
      operation = operation.then(applyLanguage, applyLanguage)
      return operation
    },
    setAriaLabel(nextAriaLabel) {
      ariaLabel = nextAriaLabel
      driver?.setAriaLabel(nextAriaLabel)
    },
    setReadOnly(nextReadOnly) {
      readOnly = nextReadOnly
      driver?.setReadOnly(nextReadOnly)
    },
    refresh: enqueueMigration,
    dispose() {
      if (disposed) return
      disposed = true
      query.removeEventListener('change', onCapabilityChange)
      if (driver) {
        value = driver.getValue()
        driver.dispose()
        driver = null
      }
    },
  }
}

export function createAdaptiveDiffEditor(options: AdaptiveDiffEditorOptions): AdaptiveDiffEditor {
  const query = options.capabilityQuery ?? createEditorCapabilityQuery()
  const loaders: Record<EditorKind, DiffDriverFactory> = {
    monaco: options.loadMonaco ?? defaultDiffLoaders.monaco,
    codemirror: options.loadCodeMirror ?? defaultDiffLoaders.codemirror,
  }
  let driver: DiffDriver | null = null
  let original = options.original
  let modified = options.modified
  let language = options.language
  let disposed = false
  let operation = Promise.resolve()

  const migrate = async (): Promise<void> => {
    if (disposed) return
    const targetKind = selectEditorKind(query)
    if (driver?.kind === targetKind) return

    if (driver) {
      modified = driver.getModifiedValue()
      driver.dispose()
      driver = null
    }

    const loadedLanguage = language
    const loadedOriginal = original
    const loadedModified = modified
    const nextDriver = await loaders[targetKind]({
      host: options.host,
      ariaLabel: options.ariaLabel,
      language: loadedLanguage,
      original: loadedOriginal,
      modified: loadedModified,
    })
    if (disposed) {
      nextDriver.dispose()
      return
    }
    if (loadedOriginal !== original || loadedModified !== modified) {
      nextDriver.setTexts(original, modified)
    }
    if (loadedLanguage !== language) await nextDriver.setLanguage(language)
    if (selectEditorKind(query) !== targetKind) {
      nextDriver.dispose()
      return migrate()
    }
    driver = nextDriver
  }

  const enqueueMigration = () => {
    // 与普通编辑器相同：一次迁移失败不能毒化队列，后续迁移照常执行。
    operation = operation.then(migrate, migrate)
    return operation
  }
  const onCapabilityChange = () => {
    void enqueueMigration().catch((error: unknown) => {
      options.onMigrationError?.(error)
    })
  }
  query.addEventListener('change', onCapabilityChange)
  const ready = enqueueMigration()

  return {
    get kind() {
      return driver?.kind ?? null
    },
    ready,
    getModifiedValue() {
      return driver?.getModifiedValue() ?? modified
    },
    setTexts(nextOriginal, nextModified) {
      original = nextOriginal
      modified = nextModified
      driver?.setTexts(nextOriginal, nextModified)
    },
    setLanguage(nextLanguage) {
      language = nextLanguage
      const applyLanguage = async (): Promise<void> => {
        await driver?.setLanguage(nextLanguage)
      }
      operation = operation.then(applyLanguage, applyLanguage)
      return operation
    },
    refresh: enqueueMigration,
    dispose() {
      if (disposed) return
      disposed = true
      query.removeEventListener('change', onCapabilityChange)
      if (driver) {
        modified = driver.getModifiedValue()
        driver.dispose()
        driver = null
      }
    },
  }
}
