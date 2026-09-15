/**
 * Pure citation-marker parsing for DOCX text projections. Modern markers carry
 * canonical Zotero item refs; the deliberately opt-in legacy grammar carries
 * personal-library keys only. Returned offsets are UTF-16 string ranges, the
 * same coordinate system Word text runs and JavaScript strings use.
 * @module dsh-zotero/docx/markers
 */

import { formatRef, parseRef, requireSupportedLocalRef } from '../refs.js'

export type ZoteroCitationMarkerKind = 'modern' | 'legacy'

export interface ZoteroCitationMarker {
  readonly kind: ZoteroCitationMarkerKind
  /** Inclusive UTF-16 offset in the input text. */
  readonly start: number
  /** Exclusive UTF-16 offset in the input text. */
  readonly end: number
  readonly raw: string
  /** Canonical, supported Zotero item refs in citation order. */
  readonly refs: readonly string[]
}

export interface ParseZoteroCitationMarkersOptions {
  /** Accept `[@KEY]` and `[@KEY, @KEY; @KEY]`; false by default. */
  readonly allowLegacy?: boolean
}

export type ZoteroMarkerErrorCode =
  'DOCX_MARKER_INVALID' | 'DOCX_MARKER_DUPLICATE_REF' | 'DOCX_MARKER_OVERLAP'

export class ZoteroMarkerError extends Error {
  constructor(
    readonly code: ZoteroMarkerErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ZoteroMarkerError'
  }
}

const MODERN_OPEN = '{{zotero-cite:'
const MODERN_NAME = 'zotero-cite'
const LEGACY_KEY_LIST = /^@[A-Z0-9]{8}(?:\s*[,;]\s*@[A-Z0-9]{8})*$/
const LEGACY_KEY = /@([A-Z0-9]{8})/g

function invalid(message: string): never {
  throw new ZoteroMarkerError('DOCX_MARKER_INVALID', message)
}

function uniqueRefs(refs: readonly string[], raw: string): readonly string[] {
  const seen = new Set<string>()
  for (const ref of refs) {
    if (seen.has(ref)) {
      throw new ZoteroMarkerError(
        'DOCX_MARKER_DUPLICATE_REF',
        `Citation marker ${JSON.stringify(raw)} repeats ${ref}.`,
      )
    }
    seen.add(ref)
  }
  return refs
}

function parseModern(raw: string, body: string): readonly string[] {
  const values = body.split(';')
  if (values.length === 0 || values.some((value) => value === '')) {
    invalid(`Citation marker ${JSON.stringify(raw)} contains an empty reference.`)
  }
  const refs = values.map((value) => {
    if (value.trim() !== value) {
      invalid(
        `Citation marker ${JSON.stringify(raw)} must contain canonical refs without surrounding whitespace.`,
      )
    }
    try {
      const ref = requireSupportedLocalRef(parseRef(value), ['item'])
      const canonical = formatRef(ref)
      if (canonical !== value) {
        invalid(`Citation marker ${JSON.stringify(raw)} contains a non-canonical Zotero ref.`)
      }
      return canonical
    } catch (error) {
      if (error instanceof ZoteroMarkerError) throw error
      invalid(
        `Citation marker ${JSON.stringify(raw)} contains an invalid or unsupported Zotero item ref.`,
      )
    }
  })
  return uniqueRefs(refs, raw)
}

function modernMarkers(text: string): ZoteroCitationMarker[] {
  const markers: ZoteroCitationMarker[] = []
  let cursor = 0
  while (cursor < text.length) {
    const open = text.indexOf('{{', cursor)
    if (open === -1) break
    const close = text.indexOf('}}', open + 2)
    const tail = close === -1 ? text.slice(open) : text.slice(open, close + 2)
    const markerShaped = tail.toLowerCase().includes(MODERN_NAME)
    if (close === -1) {
      if (markerShaped) invalid('An unterminated Zotero citation marker was found.')
      break
    }
    if (!markerShaped) {
      cursor = close + 2
      continue
    }
    if (!tail.startsWith(MODERN_OPEN)) {
      invalid(`Malformed Zotero citation marker ${JSON.stringify(tail)}.`)
    }
    if (tail.slice(2, -2).includes('{{') || text[close + 2] === '}') {
      invalid(`Malformed or overlapping Zotero citation marker ${JSON.stringify(tail)}.`)
    }
    const body = tail.slice(MODERN_OPEN.length, -2)
    const refs = parseModern(tail, body)
    markers.push({ kind: 'modern', start: open, end: close + 2, raw: tail, refs })
    cursor = close + 2
  }

  // A marker name outside a completed `{{...}}` pair is still suspicious and
  // must not be silently left as ordinary text.
  const lower = text.toLowerCase()
  let nameAt = lower.indexOf(MODERN_NAME)
  while (nameAt !== -1) {
    const covered = markers.some(
      (marker) => marker.kind === 'modern' && nameAt >= marker.start && nameAt < marker.end,
    )
    if (!covered) invalid('Malformed Zotero citation marker-shaped text was found.')
    nameAt = lower.indexOf(MODERN_NAME, nameAt + MODERN_NAME.length)
  }
  return markers
}

function legacyMarkers(text: string): ZoteroCitationMarker[] {
  const markers: ZoteroCitationMarker[] = []
  let cursor = 0
  while (cursor < text.length) {
    const start = text.indexOf('[@', cursor)
    if (start === -1) break
    const endBracket = text.indexOf(']', start + 2)
    if (endBracket === -1) invalid('An unterminated legacy Zotero citation marker was found.')
    const raw = text.slice(start, endBracket + 1)
    const body = raw.slice(1, -1)
    if (
      raw.includes('\n') ||
      raw.includes('\r') ||
      body.includes('[') ||
      !LEGACY_KEY_LIST.test(body)
    ) {
      invalid(`Malformed legacy Zotero citation marker ${JSON.stringify(raw)}.`)
    }
    const refs = Array.from(body.matchAll(LEGACY_KEY), (match) =>
      formatRef(
        requireSupportedLocalRef(parseRef(`zotero://user/0/item/${match[1] as string}`), ['item']),
      ),
    )
    uniqueRefs(refs, raw)
    markers.push({ kind: 'legacy', start, end: endBracket + 1, raw, refs })
    cursor = endBracket + 1
  }
  return markers
}

/**
 * Parse supported markers from one text projection. Any modern marker-shaped
 * text is validated even when legacy support is disabled; malformed syntax is
 * never downgraded to ordinary prose. Legacy syntax is ignored unless opted in.
 */
export function parseZoteroCitationMarkers(
  text: string,
  options: ParseZoteroCitationMarkersOptions = {},
): ZoteroCitationMarker[] {
  const markers = modernMarkers(text)
  if (options.allowLegacy === true) markers.push(...legacyMarkers(text))
  markers.sort((a, b) => a.start - b.start || b.end - a.end)
  for (let index = 1; index < markers.length; index += 1) {
    const previous = markers[index - 1]!
    const current = markers[index]!
    if (current.start < previous.end) {
      throw new ZoteroMarkerError(
        'DOCX_MARKER_OVERLAP',
        `Citation markers ${JSON.stringify(previous.raw)} and ${JSON.stringify(current.raw)} overlap.`,
      )
    }
  }
  return markers
}
