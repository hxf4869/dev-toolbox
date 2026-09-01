export const REGEX_TEXT_LIMIT = 1024 * 1024
export const REGEX_MATCH_DISPLAY_LIMIT = 500

export interface RegexRunRequest {
  id: number
  pattern: string
  flags: string
  text: string
  replacement: string
}

export interface RegexMatch {
  number: number
  start: number
  end: number
  value: string
  groups: Array<string | null>
  namedGroups: Record<string, string | null>
}

export interface RegexRunResult {
  matches: RegexMatch[]
  matchLimitReached: boolean
  replacementPreview: string | null
}

export type RegexWorkerResponse =
  | { id: number; type: 'result'; result: RegexRunResult }
  | { id: number; type: 'error'; message: string }
