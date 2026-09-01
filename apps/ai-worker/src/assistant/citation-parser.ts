// Incremental citation marker parser (docs/16 §8.11).
//
// The provider output stream is the only place [[S1]]–[[S8]] markers are
// interpreted. The parser is a bounded finite-state machine that never buffers
// more than 6 ASCII bytes, survives markers split at any byte boundary, fails
// the run on any [[S-prefixed text that cannot complete to a valid marker, and
// treats every [[C... occurrence in provider text as forgery.

export type CitationParserResult =
  | { kind: 'text'; text: string }
  | { kind: 'citation'; ordinal: number }
  | { kind: 'invalid'; reason: string }

const maximumMarkerBytes = 6

export class CitationParser {
  #pending = ''
  #closed = false

  constructor(private readonly maxOrdinal: number) {}

  /** Feeds one arbitrary chunk and returns the ordered parse results. */
  push(chunk: string): CitationParserResult[] {
    const results: CitationParserResult[] = []
    for (const character of chunk) {
      const outcome = this.#consume(character, results)
      if (outcome === 'invalid') return results
    }
    return results
  }

  /**
   * Ends the stream. Text that can no longer become a marker is released;
   * an incomplete reserved prefix fails the run.
   */
  flush(): CitationParserResult[] {
    const results: CitationParserResult[] = []
    if (this.#pending.length > 0) {
      if (this.#isReserved(this.#pending)) {
        results.push({ kind: 'invalid', reason: 'unterminated citation marker' })
        this.#pending = ''
        this.#closed = true
        return results
      }
      results.push({ kind: 'text', text: this.#pending })
      this.#pending = ''
    }
    this.#closed = true
    return results
  }

  #isReserved(pending: string): boolean {
    return pending.startsWith('[[S') || pending.startsWith('[[C')
  }

  #consume(character: string, results: CitationParserResult[]): 'ok' | 'invalid' {
    if (this.#closed) return 'invalid'
    const candidate = this.#pending + character
    // Still inside a possible marker window.
    if (candidate.length <= maximumMarkerBytes && this.#viable(candidate)) {
      this.#pending = candidate
      // A complete marker releases immediately.
      const marker = /^\[\[S([1-8])\]\]$/.exec(candidate)
      if (marker && marker[1] !== undefined) {
        const ordinal = Number(marker[1])
        this.#pending = ''
        if (ordinal < 1 || ordinal > this.maxOrdinal) {
          results.push({ kind: 'invalid', reason: 'citation ordinal outside this run' })
          return 'invalid'
        }
        results.push({ kind: 'citation', ordinal })
        return 'ok'
      }
      return 'ok'
    }
    // The candidate can no longer be part of any marker syntax.
    if (this.#pending.startsWith('[[') && (candidate.startsWith('[[C') || candidate === '[[C')) {
      results.push({ kind: 'invalid', reason: 'provider text forged a canonical citation prefix' })
      return 'invalid'
    }
    if (candidate.startsWith('[[C')) {
      results.push({ kind: 'invalid', reason: 'provider text forged a canonical citation prefix' })
      return 'invalid'
    }
    if (this.#pending.startsWith('[[S') || candidate.startsWith('[[S')) {
      // "[[S" is reserved: anything that cannot complete as [[S1]]–[[S8]] fails.
      results.push({ kind: 'invalid', reason: 'malformed citation marker' })
      return 'invalid'
    }
    // Plain text: release the buffered prefix and rescan the current character.
    if (this.#pending.length > 0) {
      results.push({ kind: 'text', text: this.#pending })
      this.#pending = ''
    }
    if (character === '[') {
      this.#pending = '['
      return 'ok'
    }
    results.push({ kind: 'text', text: character })
    return 'ok'
  }

  // Viable prefixes of the reserved syntaxes "[[S1]]".."[[S8]]" and the
  // forgery prefix "[[C"; anything else left the marker window already.
  #viable(candidate: string): boolean {
    if (candidate.length > maximumMarkerBytes) return false
    if (!candidate.startsWith('[[')) return candidate === '['
    if (candidate.length === 2) return true
    const flag = candidate[2] ?? ''
    if (flag === 'C') return true // reserved forgery prefix; fails once decided
    if (flag !== 'S') return false
    if (candidate.length === 3) return true
    const digit = candidate[3] ?? ''
    if (!/[1-8]/.test(digit)) return false
    if (candidate.length === 4) return true
    if (candidate.length === 5) return (candidate[4] ?? '') === ']'
    if (candidate.length === 6) return candidate.slice(4) === ']]'
    return false
  }
}
