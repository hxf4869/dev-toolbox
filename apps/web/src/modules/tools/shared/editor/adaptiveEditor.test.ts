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
