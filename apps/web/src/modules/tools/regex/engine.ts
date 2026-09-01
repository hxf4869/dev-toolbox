import { REGEX_MATCH_DISPLAY_LIMIT, type RegexMatch, type RegexRunResult } from './contracts'

export function executeRegex(
  pattern: string,
  flags: string,
  text: string,
  replacement: string,
): RegexRunResult {
  const expression = new RegExp(pattern, flags)
  const matches: RegexMatch[] = []
  let matchLimitReached = false
  let match: RegExpExecArray | null
  while ((match = expression.exec(text)) !== null) {
    if (matches.length === REGEX_MATCH_DISPLAY_LIMIT) {
      matchLimitReached = true
      break
    }
    matches.push({
      number: matches.length + 1,
      start: match.index,
      end: match.index + match[0].length,
      value: match[0],
      groups: match.slice(1).map((value) => value ?? null),
      namedGroups: Object.fromEntries(Object.entries(match.groups ?? {}).map(([key, value]) => [key, value ?? null])),
    })
    if (!expression.global) break
    if (match[0].length === 0) expression.lastIndex = advanceStringIndex(text, expression.lastIndex, expression.unicode)
  }
  return {
    matches,
    matchLimitReached,
    replacementPreview: matchLimitReached ? null : text.replace(new RegExp(pattern, flags), replacement),
  }
}

function advanceStringIndex(value: string, index: number, unicode: boolean): number {
  if (!unicode || index + 1 >= value.length) return index + 1
  const first = value.charCodeAt(index)
  if (first < 0xd800 || first > 0xdbff) return index + 1
  const second = value.charCodeAt(index + 1)
  return second >= 0xdc00 && second <= 0xdfff ? index + 2 : index + 1
}
