/** Zotero-backed citation-cluster data for native Word fields. */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { ZOTERO_UNEXPECTED, ZoteroError } from '../errors.js'
import { asRecord, asString } from '../json.js'
import { formatRef, parseZoteroRelationUri } from '../refs.js'
import type { ZoteroExportResult, ZoteroObjectRef } from '../types.js'

export interface WordCitationItemData {
  readonly id: string | number
  readonly uris: readonly string[]
  readonly itemData: Readonly<Record<string, JsonValue>>
}

export interface WordCitationClusterData {
  readonly formattedText: string
  readonly items: readonly WordCitationItemData[]
}

export interface CitationExportService {
  export(
    request: {
      refs: ZoteroObjectRef[]
      format: 'citation' | 'csljson'
      style?: string
      locale?: string
    },
    signal?: AbortSignal,
  ): Promise<ZoteroExportResult>
}

/** Build one CSL cluster (not independently concatenated citations) and exact item data. */
export async function loadWordCitationCluster(
  service: CitationExportService,
  refs: readonly ZoteroObjectRef[],
  style: string,
  locale: string,
  signal?: AbortSignal,
): Promise<WordCitationClusterData> {
  const requestRefs = refs.map((ref) => ({ ...ref, library: { ...ref.library } }))
  const [citation, csl] = await Promise.all([
    service.export({ refs: requestRefs, format: 'citation', style, locale }, signal),
    service.export({ refs: requestRefs, format: 'csljson' }, signal),
  ])
  if (citation.format !== 'citation' || csl.format !== 'csljson') {
    throw new ZoteroError(
      'Zotero returned the wrong export format for a Word citation.',
      ZOTERO_UNEXPECTED,
    )
  }
  const formattedText = citationHtmlToText(citation.citations.map((entry) => entry.text).join(''))
  if (formattedText === '') {
    throw new ZoteroError('Zotero returned an empty formatted citation.', ZOTERO_UNEXPECTED)
  }
  let records: unknown
  try {
    records = JSON.parse(csl.text)
  } catch (error) {
    throw new ZoteroError(
      'Zotero returned invalid CSL JSON for a Word citation.',
      ZOTERO_UNEXPECTED,
      {
        cause: error,
      },
    )
  }
  if (!Array.isArray(records)) {
    throw new ZoteroError('Zotero returned CSL JSON that is not an item array.', ZOTERO_UNEXPECTED)
  }
  const byRef = csl.items.map((entry) => {
    if (entry.entryIndex === undefined) {
      throw new ZoteroError(`Zotero could not map CSL JSON to ${entry.ref}.`, ZOTERO_UNEXPECTED)
    }
    return { ref: entry.ref, record: records[entry.entryIndex] }
  })
  const items = refs.map((ref) => {
    const formattedRef = formatRef(ref)
    const match = byRef.find((entry) => entry.ref === formattedRef)
    const record = asRecord(match?.record)
    if (record === undefined) {
      throw new ZoteroError(
        `Zotero did not return CSL JSON for ${formattedRef}.`,
        ZOTERO_UNEXPECTED,
      )
    }
    const id = cslIdOf(record)
    const uri = canonicalItemUri(ref, record, id)
    return {
      id: uri,
      uris: [uri],
      itemData: { ...(record as Record<string, JsonValue>), id: uri },
    }
  })
  return { formattedText, items }
}

function cslIdOf(record: Record<string, unknown>): string | number {
  const id = record['id']
  if (
    (typeof id === 'string' && id.trim() !== '') ||
    (typeof id === 'number' && Number.isFinite(id))
  ) {
    return id
  }
  throw new ZoteroError('A CSL JSON item has no usable id.', ZOTERO_UNEXPECTED)
}

function canonicalItemUri(
  ref: ZoteroObjectRef,
  record: Record<string, unknown>,
  id: string | number,
): string {
  const candidates = [asString(record['uri']), typeof id === 'string' ? id : undefined].filter(
    (value): value is string => value !== undefined,
  )
  for (const candidate of candidates) {
    const parsed = parseZoteroRelationUri(candidate)
    if (parsed === null || parsed.key !== ref.key) continue
    if (ref.library.type === 'group') {
      if (parsed.library.type === 'group' && parsed.library.id === ref.library.id) return candidate
      continue
    }
    if (parsed.library.type === 'user') return candidate
  }
  throw new ZoteroError(
    `Zotero did not return a canonical item URI for ${formatRef(ref)}; the Word field was not created.`,
    ZOTERO_UNEXPECTED,
  )
}

/** Decode the limited HTML citation output into honest visible text. */
export function citationHtmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&#(\d+);/g, (_whole, digits: string) => String.fromCodePoint(Number(digits)))
    .replace(/&#x([0-9a-f]+);/gi, (_whole, digits: string) =>
      String.fromCodePoint(Number.parseInt(digits, 16)),
    )
    .replace(/&nbsp;/gi, '\u00a0')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .trim()
}
