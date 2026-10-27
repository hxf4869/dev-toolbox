import { vi } from 'vitest'

import { createAdaptiveDiffEditor, createAdaptiveEditor } from './adaptiveEditor'
import type {
  DiffDriver,
  EditorCapabilityQuery,
  EditorDriver,
  EditorKind,
} from './contracts'

class FakeCapabilityQuery implements EditorCapabilityQuery {
  private readonly listeners = new Set<() => void>()

  constructor(public matches: boolean) {}

  addEventListener(_type: 'change', listener: () => void) {
    this.listeners.add(listener)
  }

  removeEventListener(_type: 'change', listener: () => void) {
    this.listeners.delete(listener)
  }

  setMatches(matches: boolean) {
    this.matches = matches
    for (const listener of this.listeners) listener()
  }
}

function createEditorFactory(kind: EditorKind, events: string[], live: { count: number }) {
  return vi.fn(async (options): Promise<EditorDriver> => {
    let value = options.value
    live.count += 1
    events.push(`create:${kind}:${value}`)
    expect(live.count).toBe(1)
    return {
      kind,
      getValue: () => value,
      setValue: (nextValue) => {
        value = nextValue
      },
      setLanguage: vi.fn(async () => {}),
      setAriaLabel: vi.fn(),
      setReadOnly: vi.fn(),
      dispose: vi.fn(() => {
        live.count -= 1
        events.push(`dispose:${kind}:${value}`)
      }),
    }
  })
}

describe('adaptive structured-data editor', () => {
  it('loads only the matching editor and migrates current text after disposing the old instance', async () => {
    const query = new FakeCapabilityQuery(true)
    const events: string[] = []
    const live = { count: 0 }
    const monaco = createEditorFactory('monaco', events, live)
    const codeMirror = createEditorFactory('codemirror', events, live)
    const editor = createAdaptiveEditor({
      host: document.createElement('div'),
      ariaLabel: 'JSON input',
      language: 'json',
      value: '{"version":1}',
      capabilityQuery: query,
      loadMonaco: monaco,
      loadCodeMirror: codeMirror,
    })

    await editor.ready
    expect(editor.kind).toBe('monaco')
    expect(monaco).toHaveBeenCalledTimes(1)
    expect(monaco).toHaveBeenCalledWith(expect.objectContaining({ ariaLabel: 'JSON input' }))
    expect(codeMirror).not.toHaveBeenCalled()
    editor.setValue('{"version":2}')

    query.setMatches(false)
    await editor.refresh()

    expect(editor.kind).toBe('codemirror')
    expect(events).toEqual([
      'create:monaco:{"version":1}',
      'dispose:monaco:{"version":2}',
      'create:codemirror:{"version":2}',
    ])
    expect(editor.getValue()).toBe('{"version":2}')

    editor.dispose()
    editor.dispose()
    expect(live.count).toBe(0)
    expect(events.at(-1)).toBe('dispose:codemirror:{"version":2}')
  })

  it('disposes an asynchronously loaded stale editor before creating the newly selected kind', async () => {
    const query = new FakeCapabilityQuery(true)
    let finishMonaco!: (driver: EditorDriver) => void
    const staleDriver: EditorDriver = {
      kind: 'monaco',
      getValue: () => 'latest text',
      setValue: vi.fn(),
      setLanguage: vi.fn(async () => {}),
      setAriaLabel: vi.fn(),
      setReadOnly: vi.fn(),
      dispose: vi.fn(),
    }
    const monaco = vi.fn(
      () => new Promise<EditorDriver>((resolve) => (finishMonaco = resolve)),
    )
    const codeMirror = vi.fn(async (options): Promise<EditorDriver> => ({
      kind: 'codemirror',
      getValue: () => options.value,
      setValue: vi.fn(),
      setLanguage: vi.fn(async () => {}),
      setAriaLabel: vi.fn(),
      setReadOnly: vi.fn(),
      dispose: vi.fn(),
    }))
    const editor = createAdaptiveEditor({
      host: document.createElement('div'),
      ariaLabel: 'YAML input',
      language: 'yaml',
      capabilityQuery: query,
      loadMonaco: monaco,
      loadCodeMirror: codeMirror,
    })

    await Promise.resolve()
    query.setMatches(false)
    finishMonaco(staleDriver)
    await editor.refresh()

    expect(staleDriver.dispose).toHaveBeenCalledOnce()
    expect(codeMirror).toHaveBeenCalledWith(expect.objectContaining({ value: '' }))
    expect(editor.kind).toBe('codemirror')
    editor.dispose()
  })

  it('applies text, language, and read-only updates made while the editor chunk is loading', async () => {
    const query = new FakeCapabilityQuery(false)
    let finishLoading!: (driver: EditorDriver) => void
    let value = 'initial'
    const driver: EditorDriver = {
      kind: 'codemirror',
      getValue: () => value,
      setValue: vi.fn((nextValue: string) => {
        value = nextValue
      }),
      setLanguage: vi.fn(async () => {}),
      setAriaLabel: vi.fn(),
      setReadOnly: vi.fn(),
      dispose: vi.fn(),
    }
    const editor = createAdaptiveEditor({
      host: document.createElement('div'),
      ariaLabel: 'JSON input',
      language: 'json',
      value: 'initial',
      capabilityQuery: query,
      loadMonaco: vi.fn(),
      loadCodeMirror: () => new Promise((resolve) => (finishLoading = resolve)),
    })

    await Promise.resolve()
    editor.setValue('updated during loading')
    const languageUpdate = editor.setLanguage('yaml')
    editor.setAriaLabel('Updated YAML input')
    editor.setReadOnly(true)
    finishLoading(driver)
    await editor.ready
    await languageUpdate

    expect(driver.setValue).toHaveBeenCalledWith('updated during loading')
    expect(driver.setLanguage).toHaveBeenCalledWith('yaml')
    expect(driver.setAriaLabel).toHaveBeenCalledWith('Updated YAML input')
    expect(driver.setReadOnly).toHaveBeenCalledWith(true)
    expect(editor.getValue()).toBe('updated during loading')
    editor.dispose()
  })
})

describe('adaptive diff editor', () => {
  it('uses a read-only diff driver, migrates modified text, and disposes each driver', async () => {
    const query = new FakeCapabilityQuery(false)
    const disposed: EditorKind[] = []
    const factory = (kind: EditorKind) =>
      vi.fn(async (options): Promise<DiffDriver> => {
        let original = options.original
        let modified = options.modified
        return {
          kind,
          getModifiedValue: () => modified,
          setTexts: (nextOriginal, nextModified) => {
            original = nextOriginal
            modified = nextModified
            void original
          },
          setLanguage: vi.fn(async () => {}),
          dispose: () => disposed.push(kind),
        }
      })
    const monaco = factory('monaco')
    const codeMirror = factory('codemirror')
    const diff = createAdaptiveDiffEditor({
      host: document.createElement('div'),
      ariaLabel: 'JSON diff',
      language: 'json',
      original: '{}',
      modified: '{"ok":false}',
      capabilityQuery: query,
      loadMonaco: monaco,
      loadCodeMirror: codeMirror,
    })

    await diff.ready
    diff.setTexts('{"ok":false}', '{"ok":true}')
    query.setMatches(true)
    await diff.refresh()

    expect(monaco).toHaveBeenCalledWith(
      expect.objectContaining({ original: '{"ok":false}', modified: '{"ok":true}' }),
    )
    expect(disposed).toEqual(['codemirror'])
    diff.dispose()
    expect(disposed).toEqual(['codemirror', 'monaco'])
  })
})

describe('adaptive editor load failures', () => {
  function createDriver(kind: EditorKind, initialValue: string): EditorDriver {
    let value = initialValue
    return {
      kind,
      getValue: () => value,
      setValue: (nextValue) => {
        value = nextValue
      },
      setLanguage: vi.fn(async () => {}),
      setAriaLabel: vi.fn(),
      setReadOnly: vi.fn(),
      dispose: vi.fn(),
    }
  }

  it('keeps text and lets a later refresh succeed after the initial load fails', async () => {
    const query = new FakeCapabilityQuery(false)
    let attempts = 0
    const codeMirror = vi.fn(async (options): Promise<EditorDriver> => {
      attempts += 1
      if (attempts === 1) throw new Error('chunk load failed')
      return createDriver('codemirror', options.value)
    })
    const editor = createAdaptiveEditor({
      host: document.createElement('div'),
      ariaLabel: 'JSON input',
      language: 'json',
      value: '{"kept":true}',
      capabilityQuery: query,
      loadMonaco: vi.fn(),
      loadCodeMirror: codeMirror,
    })

    // ready 的 rejection 必须显式抛给调用方，而不是伪装成功。
    await expect(editor.ready).rejects.toThrow('chunk load failed')
    expect(editor.kind).toBeNull()
    // 失败期间文本仍可读写，不丢数据。
    editor.setValue('{"kept":true,"edited":1}')
    expect(editor.getValue()).toBe('{"kept":true,"edited":1}')

    // 手动重试（refresh）成功后编辑器可用且文本完整。
    await editor.refresh()
    expect(editor.kind).toBe('codemirror')
    expect(editor.getValue()).toBe('{"kept":true,"edited":1}')
    expect(codeMirror).toHaveBeenCalledTimes(2)
    editor.dispose()
  })

  it('lets later refresh, language updates, and capability changes run after a failed migration', async () => {
    const query = new FakeCapabilityQuery(false)
    let monacoAttempts = 0
    const monaco = vi.fn(async (options): Promise<EditorDriver> => {
      monacoAttempts += 1
      if (monacoAttempts === 1) throw new Error('monaco chunk failed')
      return createDriver('monaco', options.value)
    })
    const onMigrationError = vi.fn()
    const editor = createAdaptiveEditor({
      host: document.createElement('div'),
      ariaLabel: 'JSON input',
      language: 'json',
      value: 'text',
      capabilityQuery: query,
      loadMonaco: monaco,
      loadCodeMirror: vi.fn(async (options) => createDriver('codemirror', options.value)),
      onMigrationError,
    })
    await editor.refresh()

    // 能力变化触发迁移失败：onMigrationError 接住，且不阻塞后续操作。
    query.setMatches(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(onMigrationError).toHaveBeenCalledOnce()

    // 队列未毒化：语言更新可以照常执行。
    await editor.setLanguage('yaml')

    // 再次能力变化重试加载成功。
    query.setMatches(false)
    query.setMatches(true)
    await editor.refresh()
    expect(editor.kind).toBe('monaco')
    editor.dispose()
  })

  it('does not mount a driver that resolves after dispose', async () => {
    const query = new FakeCapabilityQuery(false)
    let finishLoading!: (driver: EditorDriver) => void
    const pending = new Promise<EditorDriver>((resolve) => {
      finishLoading = resolve
    })
    const driver = createDriver('codemirror', 'late')
    const codeMirror = vi.fn(() => pending)
    const editor = createAdaptiveEditor({
      host: document.createElement('div'),
      ariaLabel: 'JSON input',
      language: 'json',
      value: '',
      capabilityQuery: query,
      loadMonaco: vi.fn(),
      loadCodeMirror: codeMirror,
    })

    // 等到 loader 已被调用、加载在途，再 dispose。
    await Promise.resolve()
    editor.dispose()
    finishLoading(driver)
    await pending
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(driver.dispose).toHaveBeenCalledOnce()
    expect(editor.kind).toBeNull()
  })

  it('keeps the diff migration queue usable after a failed load', async () => {
    const query = new FakeCapabilityQuery(false)
    let attempts = 0
    const factory = (): DiffDriver => ({
      kind: 'codemirror',
      getModifiedValue: () => '{"after":1}',
      setTexts: vi.fn(),
      setLanguage: vi.fn(async () => {}),
      dispose: vi.fn(),
    })
    const codeMirror = vi.fn(async (): Promise<DiffDriver> => {
      attempts += 1
      if (attempts === 1) throw new Error('diff chunk failed')
      return factory()
    })
    const diff = createAdaptiveDiffEditor({
      host: document.createElement('div'),
      ariaLabel: 'JSON diff',
      language: 'json',
      original: '{}',
      modified: '{"before":1}',
      capabilityQuery: query,
      loadMonaco: vi.fn(),
      loadCodeMirror: codeMirror,
    })

    await expect(diff.ready).rejects.toThrow('diff chunk failed')
    expect(diff.getModifiedValue()).toBe('{"before":1}')

    diff.setTexts('{}', '{"after":1}')
    await diff.refresh()
    expect(diff.kind).toBe('codemirror')
    expect(diff.getModifiedValue()).toBe('{"after":1}')
    diff.dispose()
  })
})
