// @codemirror/lang-json exposes a type-only linter helper without declaring
// @codemirror/lint as a runtime dependency. This adapter never imports that helper.
declare module '@codemirror/lint' {
  export interface Diagnostic {
    from: number
    to?: number
    severity: 'hint' | 'info' | 'warning' | 'error'
    message: string
  }
}
