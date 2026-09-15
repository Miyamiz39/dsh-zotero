import { describe, expect, it } from 'vitest'
import {
  chunkUtf16,
  createZoteroCitationPayload,
  createZoteroDocumentPreferences,
  isCanonicalZoteroItemUri,
  parseZoteroBibliographyInstruction,
  parseZoteroCitationInstruction,
  parseZoteroDocumentPreferences,
  parseZoteroPreferenceChunks,
  serializeZoteroBibliographyInstruction,
  serializeZoteroCitationInstruction,
  serializeZoteroDocumentPreferences,
  serializeZoteroPreferenceChunks,
  validateCslItemData,
  validateZoteroCitationPayload,
  validateZoteroDocumentPreferences,
  ZOTERO_BIBLIOGRAPHY_INSTRUCTION,
  ZOTERO_CSL_CITATION_SCHEMA,
  ZoteroFieldError,
} from '../../src/docx/fields.js'

const ITEM = {
  id: 42,
  uris: ['http://zotero.org/users/0/items/ABCD1234'],
  itemData: {
    id: 42,
    type: 'article-journal',
    title: 'A & B',
    author: [{ family: 'Li', given: 'Ming' }],
    issued: { 'date-parts': [[2026]] },
  },
} as const

function codeOf(run: () => unknown): string | undefined {
  try {
    run()
  } catch (error) {
    return error instanceof ZoteroFieldError ? error.code : undefined
  }
  return undefined
}

describe('Zotero Word citation fields', () => {
  it('builds and serializes the exact Zotero CSL citation instruction', () => {
    const payload = createZoteroCitationPayload({
      citationID: 'citation01',
      citationItems: [ITEM],
      formattedCitation: '(Li, 2026)',
    })
    expect(payload).toEqual({
      citationID: 'citation01',
      properties: {
        formattedCitation: '(Li, 2026)',
        plainCitation: '(Li, 2026)',
        noteIndex: 0,
      },
      citationItems: [ITEM],
      schema: ZOTERO_CSL_CITATION_SCHEMA,
    })
    const instruction = serializeZoteroCitationInstruction(payload)
    expect(instruction).toBe(`ADDIN ZOTERO_ITEM CSL_CITATION ${JSON.stringify(payload)}`)
    expect(parseZoteroCitationInstruction(instruction)).toEqual(payload)
  })

  it('generates unique citation IDs and preserves explicit property values', () => {
    const first = createZoteroCitationPayload({
      citationItems: [ITEM],
      formattedCitation: '<i>Li</i>',
      plainCitation: 'Li',
      noteIndex: 2,
    })
    const second = createZoteroCitationPayload({
      citationItems: [ITEM],
      formattedCitation: 'Li',
    })
    expect(first.citationID).toMatch(/^[a-f0-9]{32}$/)
    expect(second.citationID).not.toBe(first.citationID)
    expect(first.properties).toEqual({
      formattedCitation: '<i>Li</i>',
      plainCitation: 'Li',
      noteIndex: 2,
    })
  })

  it.each([
    'http://zotero.org/users/0/items/ABCD1234',
    'https://zotero.org/users/99/items/ABCD1234',
    'https://zotero.org/groups/42/items/EFGH5678',
  ])('accepts canonical Zotero item URI %s', (uri) => {
    expect(isCanonicalZoteroItemUri(uri)).toBe(true)
  })

  it.each([
    'http://www.zotero.org/users/0/items/ABCD1234',
    'https://api.zotero.org/users/0/items/ABCD1234',
    'ftp://zotero.org/users/0/items/ABCD1234',
    'https://zotero.org/groups/0/items/ABCD1234',
    'https://zotero.org/users/0/items/abcd1234',
    'https://zotero.org/users/0/items/ABCD1234/',
    'https://zotero.org/users/0/items/ABCD1234?x=1',
    'https://evil.example/users/0/items/ABCD1234',
  ])('rejects noncanonical Zotero item URI %s', (uri) => {
    expect(isCanonicalZoteroItemUri(uri)).toBe(false)
  })

  it('validates group citation data and multiple canonical URIs', () => {
    const group = {
      id: 'embedded-1',
      uris: [
        'https://zotero.org/groups/42/items/EFGH5678',
        'http://zotero.org/users/0/items/ABCD1234',
      ],
      itemData: { id: 'embedded-1', type: 'book', title: 'Book' },
    }
    expect(() =>
      validateZoteroCitationPayload(
        createZoteroCitationPayload({ citationItems: [group], formattedCitation: '(Book)' }),
      ),
    ).not.toThrow()
  })

  it.each([
    { ...ITEM, id: 7 },
    { ...ITEM, uris: [] },
    { ...ITEM, uris: [ITEM.uris[0], ITEM.uris[0]] },
    { ...ITEM, uris: ['https://evil.example/users/0/items/ABCD1234'] },
    { ...ITEM, itemData: { id: 42, type: '' } },
    { ...ITEM, itemData: { id: 41, type: 'book' } },
  ])('rejects invalid citation item %#', (citationItem) => {
    expect(
      codeOf(() =>
        createZoteroCitationPayload({ citationItems: [citationItem], formattedCitation: 'x' }),
      ),
    ).toBe('DOCX_CITATION_INVALID')
  })

  it('rejects malformed payloads and malformed instructions', () => {
    expect(codeOf(() => validateZoteroCitationPayload({}))).toBe('DOCX_CITATION_INVALID')
    expect(
      codeOf(() =>
        validateZoteroCitationPayload({
          citationID: 'x',
          properties: { formattedCitation: 'x', plainCitation: 'x', noteIndex: -1 },
          citationItems: [ITEM],
          schema: ZOTERO_CSL_CITATION_SCHEMA,
        }),
      ),
    ).toBe('DOCX_CITATION_INVALID')
    expect(codeOf(() => parseZoteroCitationInstruction('ADDIN OTHER {}'))).toBe(
      'DOCX_CITATION_INSTRUCTION_INVALID',
    )
    expect(codeOf(() => parseZoteroCitationInstruction('ADDIN ZOTERO_ITEM CSL_CITATION {'))).toBe(
      'DOCX_CITATION_INSTRUCTION_INVALID',
    )
  })

  it('rejects non-JSON CSL values, invalid ids, and cyclic itemData', () => {
    expect(codeOf(() => validateCslItemData({ id: Number.NaN, type: 'book' }))).toBe(
      'DOCX_CITATION_INVALID',
    )
    expect(codeOf(() => validateCslItemData({ id: 'x', type: 'book', bad: undefined }))).toBe(
      'DOCX_CITATION_INVALID',
    )
    const cyclic: Record<string, unknown> = { id: 'x', type: 'book' }
    cyclic.self = cyclic
    expect(codeOf(() => validateCslItemData(cyclic))).toBe('DOCX_CITATION_INVALID')
  })
})

describe('Zotero Word bibliography fields', () => {
  it('serializes and parses the exact canonical empty bibliography instruction', () => {
    expect(serializeZoteroBibliographyInstruction()).toBe(
      'ADDIN ZOTERO_BIBL {"uncited":[],"omitted":[],"custom":[]} CSL_BIBLIOGRAPHY',
    )
    expect(serializeZoteroBibliographyInstruction()).toBe(ZOTERO_BIBLIOGRAPHY_INSTRUCTION)
    expect(parseZoteroBibliographyInstruction(ZOTERO_BIBLIOGRAPHY_INSTRUCTION)).toEqual({
      uncited: [],
      omitted: [],
      custom: [],
    })
  })

  it.each([
    ' ADDIN ZOTERO_BIBL {"uncited":[],"omitted":[],"custom":[]} CSL_BIBLIOGRAPHY',
    'ADDIN ZOTERO_BIBL {"omitted":[],"uncited":[],"custom":[]} CSL_BIBLIOGRAPHY',
    'ADDIN ZOTERO_BIBL {"uncited":[[]],"omitted":[],"custom":[]} CSL_BIBLIOGRAPHY',
    'ADDIN ZOTERO_BIBL {} CSL_BIBLIOGRAPHY',
  ])('rejects noncanonical bibliography instruction %s', (instruction) => {
    expect(codeOf(() => parseZoteroBibliographyInstruction(instruction))).toBe(
      'DOCX_BIBLIOGRAPHY_INSTRUCTION_INVALID',
    )
  })
})

describe('Zotero XML-v3 document preferences', () => {
  const preferences = createZoteroDocumentPreferences({
    style: 'apa',
    locale: 'en-US',
    zoteroVersion: '7.0.15',
    sessionID: 'session&one',
  })

  it('builds the required Word preferences and normalizes a style id', () => {
    expect(preferences).toEqual({
      dataVersion: 3,
      zoteroVersion: '7.0.15',
      sessionID: 'session&one',
      style: {
        styleID: 'http://www.zotero.org/styles/apa',
        locale: 'en-US',
        hasBibliography: true,
        bibliographyStyleHasBeenSet: true,
      },
      prefs: {
        fieldType: 'Field',
        automaticJournalAbbreviations: true,
        noteType: 0,
      },
    })
  })

  it('serializes exact XML data-version 3 and round-trips escaped attributes', () => {
    const xml = serializeZoteroDocumentPreferences(preferences)
    expect(xml).toBe(
      '<data data-version="3" zotero-version="7.0.15"><session id="session&amp;one"/>' +
        '<style id="http://www.zotero.org/styles/apa" locale="en-US" ' +
        'hasBibliography="1" bibliographyStyleHasBeenSet="1"/><prefs>' +
        '<pref name="fieldType" value="Field"/>' +
        '<pref name="automaticJournalAbbreviations" value="true"/>' +
        '<pref name="noteType" value="0"/></prefs></data>',
    )
    expect(parseZoteroDocumentPreferences(xml)).toEqual(preferences)
  })

  it('preserves a valid explicit style URL and creates a session by default', () => {
    const value = createZoteroDocumentPreferences({
      style: 'https://citationstyles.org/styles/chicago-author-date',
      locale: 'zh-CN',
      zoteroVersion: '8.0',
    })
    expect(value.style.styleID).toBe('https://citationstyles.org/styles/chicago-author-date')
    expect(value.sessionID).toMatch(/^[a-f0-9]{16}$/)
  })

  it('chunks at no more than 255 UTF-16 units without splitting surrogate pairs', () => {
    const chunks = chunkUtf16(`${'a'.repeat(254)}😀b`)
    expect(chunks).toEqual(['a'.repeat(254), '😀b'])
    expect(chunks.every((chunk) => chunk.length <= 255)).toBe(true)
    expect(chunks.join('')).toBe(`${'a'.repeat(254)}😀b`)
  })

  it('serializes contiguous custom properties and parses them regardless of input order', () => {
    const long = createZoteroDocumentPreferences({
      style: 'apa',
      locale: `en-${'x'.repeat(260)}`,
      zoteroVersion: '7.0',
      sessionID: 'session',
    })
    const chunks = serializeZoteroPreferenceChunks(long)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.map(({ name }) => name)).toEqual(
      chunks.map((_, index) => `ZOTERO_PREF_${index + 1}`),
    )
    expect(chunks.every(({ value }) => value.length <= 255)).toBe(true)
    expect(parseZoteroPreferenceChunks([...chunks].reverse())).toEqual(long)
  })

  it.each([
    '<data data-version="4" zotero-version="7"><session id="s"/><style id="x" locale="en" hasBibliography="1" bibliographyStyleHasBeenSet="1"/><prefs><pref name="fieldType" value="Field"/><pref name="automaticJournalAbbreviations" value="true"/><pref name="noteType" value="0"/></prefs></data>',
    '<!DOCTYPE data><data data-version="3"></data>',
    '<?xml version="1.0"?><data data-version="3"></data>',
    '<data data-version="3" zotero-version="7"><session id="s"/><style id="x" locale="en" hasBibliography="0" bibliographyStyleHasBeenSet="1"/><prefs><pref name="fieldType" value="Field"/><pref name="automaticJournalAbbreviations" value="true"/><pref name="noteType" value="0"/></prefs></data>',
    '<data data-version="3" zotero-version="7"><session id="s"/><style id="x" locale="en" hasBibliography="1" bibliographyStyleHasBeenSet="1"/><prefs><pref name="fieldType" value="Bookmark"/><pref name="automaticJournalAbbreviations" value="true"/><pref name="noteType" value="0"/></prefs></data>',
  ])('rejects invalid document preferences XML', (xml) => {
    expect(codeOf(() => parseZoteroDocumentPreferences(xml))).toBe('DOCX_PREFS_INVALID')
  })

  it('rejects invalid preference DTOs and styles', () => {
    expect(codeOf(() => validateZoteroDocumentPreferences({ dataVersion: 4 }))).toBe(
      'DOCX_PREFS_INVALID',
    )
    expect(
      codeOf(() =>
        createZoteroDocumentPreferences({
          style: 'bad style',
          locale: 'en-US',
          zoteroVersion: '7',
        }),
      ),
    ).toBe('DOCX_PREFS_INVALID')
  })

  const invalidChunks: Array<readonly { name: string; value: string }[]> = [
    [],
    [{ name: 'ZOTERO_PREF_0', value: 'x' }],
    [{ name: 'ZOTERO_PREF_2', value: 'x' }],
    [
      { name: 'ZOTERO_PREF_1', value: 'x' },
      { name: 'ZOTERO_PREF_1', value: 'y' },
    ],
    [{ name: 'OTHER_1', value: 'x' }],
    [{ name: 'ZOTERO_PREF_1', value: 'x'.repeat(256) }],
    [
      { name: 'ZOTERO_PREF_1', value: '\ud83d' },
      { name: 'ZOTERO_PREF_2', value: '\ude00' },
    ],
  ]

  it.each(invalidChunks.map((chunks) => [chunks] as const))(
    'rejects non-contiguous, duplicate, oversized, or split chunks %#',
    (chunks) => {
      expect(codeOf(() => parseZoteroPreferenceChunks(chunks))).toBe('DOCX_PREFS_CHUNKS_INVALID')
    },
  )

  it('rejects invalid chunk limits', () => {
    expect(codeOf(() => chunkUtf16('x', 1))).toBe('DOCX_PREFS_CHUNKS_INVALID')
    expect(codeOf(() => chunkUtf16('x', 256))).toBe('DOCX_PREFS_CHUNKS_INVALID')
  })
})
