// Incremental output redactor (docs/16 §6.2).
//
// Frozen properties:
//  1. Any chunk partition of the same logical stream yields byte-identical
//     redacted output.
//  2. No released prefix ever contains raw text that could still combine into
//     a sensitive value (credential value, Bearer token, private key, private
//     IPv4 address).
//
// Design: the buffer keeps a tail that could still participate in a match
// ("hold region"); the release cut is always content-determined, so the
// partition cannot influence output. A released slice is redacted with the
// same deterministic rules as the Go one-shot redactor: keyword=value,
// "Bearer <token>", PEM private keys, private IPv4 — placeholders <CAT_n>
// numbered per instance in discovery order.

const maximumHoldBytes = 4096
const maximumKeyHoldBytes = 512 * 1024
const ipTailHold = 15

const credentialPattern = /([A-Za-z0-9]+(?:[_-][A-Za-z0-9]+)*)[ \t]*[:=][ \t]*([^\s,;]+)/g
const bearerPattern = /\bBearer[ \t]+[A-Za-z0-9._~+/=-]{8,}/g
const keyPattern = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g
const keyBeginPattern = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/
const ipPattern = /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/g
const beginPrefix = '-----BEGIN '

interface Span {
  start: number
  end: number
  category: string
  prefix?: string
}

export class StreamRedactor {
  #buffer = ''
  #counters = new Map<string, number>()

  push(chunk: string): string {
    this.#buffer += chunk
    return this.#drain(false)
  }

  flush(): string {
    const released = this.#drain(true)
    this.#buffer = ''
    return released
  }

  #placeholder(category: string): string {
    const next = (this.#counters.get(category) ?? 0) + 1
    this.#counters.set(category, next)
    return `<${category}_${next}>`
  }

  #drain(final: boolean): string {
    let output = ''
    for (;;) {
      const begin = keyBeginPattern.exec(this.#buffer)
      if (begin) {
        const complete = /-----END [A-Z0-9 ]*PRIVATE KEY-----/g.exec(this.#buffer.slice(begin.index))
        if (complete) {
          const cut = begin.index + complete.index + complete[0].length
          output += this.#redactSlice(this.#buffer.slice(0, cut))
          this.#buffer = this.#buffer.slice(cut)
          continue
        }
        // Unterminated key: hold everything from the BEGIN marker.
        if (!final && this.#buffer.length - begin.index <= maximumKeyHoldBytes) {
          output += this.#redactSlice(this.#buffer.slice(0, begin.index))
          this.#buffer = this.#buffer.slice(begin.index)
          return output
        }
        // Stream end or oversized hold: mirror the one-shot rule — without a
        // matching END there is no key span, so continue as normal text.
      }
      const holdFrom = this.#holdStart()
      if (holdFrom === null || holdFrom >= this.#buffer.length) {
        if (final) {
          output += this.#redactSlice(this.#buffer)
          this.#buffer = ''
          return output
        }
        if (holdFrom === null) {
          output += this.#redactSlice(this.#buffer)
          this.#buffer = ''
          return output
        }
        return output
      }
      const cut = this.#adjustCut(holdFrom)
      if (cut > 0) {
        output += this.#redactSlice(this.#buffer.slice(0, cut))
        this.#buffer = this.#buffer.slice(cut)
      }
      if (!final) return output
      // Final: no more input can arrive, so all remaining matches are closed
      // from the stream's point of view.
      output += this.#redactSlice(this.#buffer)
      this.#buffer = ''
      return output
    }
  }

  // Earliest position whose suffix could still become part of a sensitive
  // value; everything strictly before it is fully decided.
  #holdStart(): number | null {
    const buffer = this.#buffer
    if (buffer.length === 0) return null
    const candidates: number[] = []
    for (const match of allMatches(credentialPattern, buffer)) {
      const keyword = match[1]
      const value = match[2]
      if (keyword === undefined || value === undefined || !isCredentialKeyword(keyword)) continue
      const valueStart = match.index + match[0].length - value.length
      // An open value (run reaches the buffer end) is not yet decidable.
      candidates.push(match.index)
      if (valueStart < buffer.length && buffer.length - valueStart > maximumHoldBytes) {
        // Bounded hold: extremely long running values release past the cap.
      }
    }
    for (const match of allMatches(/\bBearer[ \t]+/gi, buffer)) {
      candidates.push(match.index)
    }
    const partialBegin = partialPrefixStart(buffer, beginPrefix)
    if (partialBegin !== null) candidates.push(partialBegin)
    const markerStart = partialBeginMarkerStart(buffer)
    if (markerStart !== null) candidates.push(markerStart)
    const tailStart = tailKeywordStart(buffer)
    if (tailStart !== null) candidates.push(tailStart)
    candidates.push(Math.max(0, buffer.length - ipTailHold))
    const earliest = Math.min(...candidates)
    if (earliest >= buffer.length) return null
    return earliest
  }

  // Moves the cut left out of any closed match span so a released slice never
  // splits a match in half (the remainder would otherwise be emitted raw).
  #adjustCut(cut: number): number {
    let adjusted = cut
    for (;;) {
      const spans = this.#closedSpans()
      let moved = false
      for (const span of spans) {
        if (adjusted > span.start && adjusted < span.end) {
          adjusted = span.start
          moved = true
        }
      }
      if (!moved || adjusted === 0) return adjusted
    }
  }

  #closedSpans(): Span[] {
    return spansFor(this.#buffer)
  }

  // Redacts a fully decided slice with the frozen deterministic rules; the
  // earliest-span-wins cursor keeps contained matches from double-emitting.
  #redactSlice(text: string): string {
    if (text.length === 0) return ''
    const events = spansFor(text)
    events.sort((left, right) => left.start - right.start || right.end - left.end)
    let result = ''
    let cursor = 0
    for (const event of events) {
      if (event.start < cursor) continue
      result += text.slice(cursor, event.start)
      if (event.prefix !== undefined) result += event.prefix
      result += this.#placeholder(event.category)
      cursor = event.end
    }
    result += text.slice(cursor)
    return result
  }
}

// Collects the deterministic match spans of one slice in rule order: private
// keys, then credentials, then Bearer tokens, then private IPs — matching the
// Go one-shot application order at every overlap.
function spansFor(text: string): Span[] {
  const spans: Span[] = []
  for (const match of allMatches(keyPattern, text)) {
    spans.push({ start: match.index, end: match.index + match[0].length, category: 'PRIVATE_KEY' })
  }
  for (const match of allMatches(credentialPattern, text)) {
    const keyword = match[1]
    const value = match[2]
    if (keyword === undefined || value === undefined || !isCredentialKeyword(keyword)) continue
    if (overlaps(spans, match.index, match.index + match[0].length)) continue
    const keywordLength = keyword.length
    const separatorLength = match[0].length - keywordLength - value.length
    spans.push({
      start: match.index,
      end: match.index + match[0].length,
      category: categoryFor(keyword),
      prefix: match[0].slice(0, keywordLength + separatorLength),
    })
  }
  for (const match of allMatches(bearerPattern, text)) {
    if (overlaps(spans, match.index, match.index + match[0].length)) continue
    spans.push({ start: match.index, end: match.index + match[0].length, category: 'TOKEN', prefix: 'Bearer ' })
  }
  for (const match of allMatches(ipPattern, text)) {
    if (overlaps(spans, match.index, match.index + match[0].length)) continue
    spans.push({ start: match.index, end: match.index + match[0].length, category: 'INTERNAL_IP' })
  }
  return spans
}

// A credential keyword must end in a known suffix after [_-] joins.
export function isCredentialKeyword(keyword: string): boolean {
  const normalized = keyword.toLowerCase().replace(/-/g, '_')
  return (
    normalized.endsWith('password') ||
    normalized.endsWith('passwd') ||
    normalized.endsWith('username') ||
    normalized.endsWith('api_key') ||
    normalized.endsWith('apikey') ||
    normalized.endsWith('token') ||
    normalized.endsWith('secret')
  )
}

export function categoryFor(keyword: string): string {
  const normalized = keyword.toLowerCase().replace(/-/g, '_')
  if (normalized.endsWith('password') || normalized.endsWith('passwd')) return 'PASSWORD'
  if (normalized.endsWith('username')) return 'USERNAME'
  if (normalized.endsWith('api_key') || normalized.endsWith('apikey')) return 'API_KEY'
  if (normalized.endsWith('token')) return 'TOKEN'
  if (normalized.endsWith('secret')) return 'SECRET'
  return 'CREDENTIAL'
}

// The tail is a viable prefix of "-----BEGIN ..." only while it matches the
// marker's leading characters.
function partialPrefixStart(buffer: string, marker: string): number | null {
  const maximum = Math.min(marker.length - 1, buffer.length)
  for (let length = maximum; length >= 1; length--) {
    const tail = buffer.slice(buffer.length - length)
    if (marker.startsWith(tail)) return buffer.length - length
  }
  return null
}

// An incomplete "-----BEGIN ... PRIVATE KEY-----" opening must hold: the
// BEGIN marker pattern spans uppercase letters, digits, spaces and dashes, so
// any suffix made of that charset could still complete into a marker.
function partialBeginMarkerStart(buffer: string): number | null {
  const charset = /[A-Z0-9 -]/
  let position = buffer.length
  while (position > 0 && charset.test(buffer[position - 1] ?? '')) position--
  if (position === buffer.length || buffer.length - position > 128) return null
  const tail = buffer.slice(position)
  if (!tail.includes('-')) return null
  let dashStart = position
  while (dashStart < buffer.length && (buffer[dashStart] ?? '') !== '-') dashStart++
  return dashStart
}

// A word-character tail could still complete into a credential keyword.
function tailKeywordStart(buffer: string): number | null {
  let index = buffer.length
  while (index > 0) {
    const character = buffer[index - 1] ?? ''
    if (/[A-Za-z0-9]/.test(character) || character === '_' || character === '-') {
      index--
      continue
    }
    break
  }
  if (index === buffer.length) return null
  if (buffer.length - index > maximumHoldBytes) return null
  return index
}

function overlaps(spans: Span[], start: number, end: number): boolean {
  return spans.some((span) => start < span.end && end > span.start)
}

function allMatches(pattern: RegExp, text: string): RegExpExecArray[] {
  const regex = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g')
  const matches: RegExpExecArray[] = []
  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    matches.push(match)
    if (match[0].length === 0) regex.lastIndex++
  }
  return matches
}
