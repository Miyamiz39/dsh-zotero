import { describe, expect, it } from 'vitest'
import { parseZoteroCitationMarkers, ZoteroMarkerError } from '../../src/docx/markers.js'

const A = 'zotero://user/0/item/ABCD1234'
const B = 'zotero://group/42/item/EFGH5678?server=desk_1'

function codeOf(run: () => unknown): string | undefined {
  try {
    run()
  } catch (error) {
    return error instanceof ZoteroMarkerError ? error.code : undefined
  }
  return undefined
}

describe('parseZoteroCitationMarkers', () => {
  it('parses strict modern markers and reports exact UTF-16 ranges', () => {
    const raw = `{{zotero-cite:${A};${B}}}`
    const text = `😀 before ${raw} after`
    expect(parseZoteroCitationMarkers(text)).toEqual([
      {
        kind: 'modern',
        start: '😀 before '.length,
        end: '😀 before '.length + raw.length,
        raw,
        refs: [A, B],
      },
    ])
  })

  it('preserves a canonical server qualifier', () => {
    const ref = 'zotero://user/0/item/ABCD1234?server=Zotero_Desk-9'
    expect(parseZoteroCitationMarkers(`{{zotero-cite:${ref}}}`)[0]?.refs).toEqual([ref])
  })

  it('finds adjacent markers in source order', () => {
    const first = `{{zotero-cite:${A}}}`
    const second = '{{zotero-cite:zotero://user/0/item/IJKL9012}}'
    expect(parseZoteroCitationMarkers(`${first}${second}`).map(({ raw }) => raw)).toEqual([
      first,
      second,
    ])
  })

  it('ignores legacy markers unless explicitly enabled', () => {
    expect(parseZoteroCitationMarkers('See [@ABCD1234].')).toEqual([])
    expect(parseZoteroCitationMarkers('See [@ABCD1234].', { allowLegacy: true })).toEqual([
      {
        kind: 'legacy',
        start: 4,
        end: 15,
        raw: '[@ABCD1234]',
        refs: [A],
      },
    ])
  })

  it('parses comma/semicolon legacy lists as personal user/0 item refs', () => {
    const marker = '[@ABCD1234, @EFGH5678;@IJKL9012]'
    expect(parseZoteroCitationMarkers(marker, { allowLegacy: true })[0]?.refs).toEqual([
      A,
      'zotero://user/0/item/EFGH5678',
      'zotero://user/0/item/IJKL9012',
    ])
  })

  it.each([
    '{{zotero-cite:}}',
    `{{zotero-cite:${A};}}`,
    `{{zotero-cite:;${A}}}`,
    `{{zotero-cite:${A};;${B}}}`,
    `{{zotero-cite: ${A}}}`,
    `{{zotero-cite:${A}; ${B}}}`,
    '{{Zotero-Cite:zotero://user/0/item/ABCD1234}}',
    '{{zotero-cite:zotero://user/0/attachment/ABCD1234}}',
    '{{zotero-cite:zotero://user/7/item/ABCD1234}}',
    '{{zotero-cite:zotero://group/0/item/ABCD1234}}',
    '{{zotero-cite:zotero://user/0/item/abcd1234}}',
    '{{zotero-cite:zotero://user/0/item/ABCD1234?server=x&bad=y}}',
    `{{zotero-cite:${A}}`,
    `zotero-cite:${A}`,
    `{{ prefix zotero-cite:${A}}}`,
    `{{zotero-cite:${A}}}}`,
    `{{zotero-cite:{{${A}}}}}`,
  ])('rejects malformed or suspicious modern marker-shaped text: %s', (value) => {
    expect(codeOf(() => parseZoteroCitationMarkers(value))).toBe('DOCX_MARKER_INVALID')
  })

  it('rejects duplicate modern refs, including qualified duplicates', () => {
    expect(codeOf(() => parseZoteroCitationMarkers(`{{zotero-cite:${A};${A}}}`))).toBe(
      'DOCX_MARKER_DUPLICATE_REF',
    )
  })

  it.each([
    '[@]',
    '[@ABCD123]',
    '[@abcd1234]',
    '[@ABCD1234,]',
    '[@ABCD1234 @EFGH5678]',
    '[@ABCD1234,,@EFGH5678]',
    '[@ABCD1234\n,@EFGH5678]',
    '[@ABCD1234',
  ])('rejects malformed legacy marker-shaped text when enabled: %s', (value) => {
    expect(codeOf(() => parseZoteroCitationMarkers(value, { allowLegacy: true }))).toBe(
      'DOCX_MARKER_INVALID',
    )
  })

  it('rejects duplicate legacy keys', () => {
    expect(
      codeOf(() => parseZoteroCitationMarkers('[@ABCD1234; @ABCD1234]', { allowLegacy: true })),
    ).toBe('DOCX_MARKER_DUPLICATE_REF')
  })

  it('rejects an enabled legacy marker nested inside a modern marker', () => {
    const text = `{{zotero-cite:${A};[@EFGH5678]}}`
    expect(codeOf(() => parseZoteroCitationMarkers(text, { allowLegacy: true }))).toBe(
      'DOCX_MARKER_INVALID',
    )
  })

  it('does not mistake ordinary bracketed prose for a marker', () => {
    expect(
      parseZoteroCitationMarkers('array[index] and {{template}}', { allowLegacy: true }),
    ).toEqual([])
  })
})
