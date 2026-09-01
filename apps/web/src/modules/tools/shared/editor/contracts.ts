export type StructuredDataLanguage = 'json' | 'yaml' | 'plaintext'

export type EditorKind = 'monaco' | 'codemirror'

export interface EditorDriverOptions {
  host: HTMLElement
  ariaLabel: string
  language: StructuredDataLanguage
  value: string
  readOnly: boolean
  onChange(value: string): void
}

export interface EditorDriver {
  readonly kind: EditorKind
  getValue(): string
  setValue(value: string): void
  setLanguage(language: StructuredDataLanguage): Promise<void>
  setAriaLabel(label: string): void
  setReadOnly(readOnly: boolean): void
  dispose(): void
}

export interface DiffDriverOptions {
  host: HTMLElement
  ariaLabel: string
  language: StructuredDataLanguage
  original: string
  modified: string
}

export interface DiffDriver {
  readonly kind: EditorKind
  getModifiedValue(): string
  setTexts(original: string, modified: string): void
  setLanguage(language: StructuredDataLanguage): Promise<void>
  dispose(): void
}

export type EditorDriverFactory = (options: EditorDriverOptions) => Promise<EditorDriver>
export type DiffDriverFactory = (options: DiffDriverOptions) => Promise<DiffDriver>

export interface EditorCapabilityQuery {
  readonly matches: boolean
  addEventListener(type: 'change', listener: () => void): void
  removeEventListener(type: 'change', listener: () => void): void
}
