import { DOMParser } from '@xmldom/xmldom'
import { describe, expect, it } from 'vitest'
import {
  createZoteroCitationPayload,
  serializeZoteroBibliographyInstruction,
  serializeZoteroCitationInstruction,
} from '../../src/docx/fields.js'
import {
  isUnsupportedWordStory,
  rewriteWordDocument,
  scanDocumentMarkers,
  scanUnsupportedWordStory,
  scanWordFields,
  WordmlError,
  type ZoteroFieldReplacement,
} from '../../src/docx/wordml.js'

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006'
const REF = 'zotero://user/0/item/ABCD1234'
const MARKER = `{{zotero-cite:${REF}}}`
const encoder = new TextEncoder()
const decoder = new TextDecoder()

function xml(value: string): Uint8Array {
  return encoder.encode(value)
}

function documentXml(body: string): Uint8Array {
  return xml(`<w:document xmlns:w="${W}" xmlns:mc="${MC}"><w:body>${body}</w:body></w:document>`)
}

function run(text: string, properties = ''): string {
  return `<w:r>${properties}<w:t>${escapeXml(text)}</w:t></w:r>`
}

function paragraph(content: string): string {
  return `<w:p>${content}</w:p>`
}

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function citationInstruction(id: string, rendered = '(Example, 2026)'): string {
  return serializeZoteroCitationInstruction(
    createZoteroCitationPayload({
      citationID: id,
      formattedCitation: rendered,
      citationItems: [
        {
          id: 'http://zotero.org/users/1/items/ABCD1234',
          uris: ['http://zotero.org/users/1/items/ABCD1234'],
          itemData: {
            id: 'http://zotero.org/users/1/items/ABCD1234',
            type: 'article-journal',
            title: 'Example',
          },
        },
      ],
    }),
  )
}

function replacement(
  marker: ReturnType<typeof scanDocumentMarkers>[number],
  id = 'citation-1',
): ZoteroFieldReplacement {
  return {
    marker,
    instruction: citationInstruction(id),
    resultText: '(Example, 2026)',
  }
}

function expectCode(run: () => unknown, code: string): void {
  let thrown: unknown
  try {
    run()
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(WordmlError)
  expect((thrown as WordmlError).code).toBe(code)
}

function elements(bytes: Uint8Array, name: string): Element[] {
  const doc = new DOMParser().parseFromString(decoder.decode(bytes), 'application/xml')
  return Array.from(doc.getElementsByTagNameNS(W, name))
}

function paragraphText(bytes: Uint8Array): string[] {
  return elements(bytes, 'p').map((node) =>
    Array.from(node.getElementsByTagNameNS(W, 't'))
      .map((text) => text.textContent ?? '')
      .join(''),
  )
}

describe('main-story marker discovery and replacement', () => {
  it('finds a marker split across direct text runs and replaces it with five balanced direct runs', () => {
    const source = documentXml(
      paragraph(
        run(`Before ${MARKER.slice(0, 12)}`, '<w:rPr><w:i/></w:rPr>') +
          run(`${MARKER.slice(12)} after`),
      ),
    )
    const markers = scanDocumentMarkers(source)
    expect(markers).toHaveLength(1)
    const output = rewriteWordDocument(source, [replacement(markers[0]!)])
    expect(output.citationCount).toBe(1)
    expect(output.bibliographyCount).toBe(0)
    expect(paragraphText(output.bytes)).toEqual(['Before (Example, 2026) after'])

    const fields = scanWordFields(output.bytes)
    expect(fields.complexFieldCount).toBe(1)
    expect(fields.citationFields[0]?.payload.citationID).toBe('citation-1')
    expect(
      elements(output.bytes, 'fldChar').map((node) => node.getAttributeNS(W, 'fldCharType')),
    ).toEqual(['begin', 'separate', 'end'])
    const paragraphNode = elements(output.bytes, 'p')[0]!
    const fieldRuns = Array.from(paragraphNode.childNodes).filter(
      (node): node is Element => node.nodeType === 1 && (node as Element).localName === 'r',
    )
    expect(fieldRuns).toHaveLength(7)
    expect(fieldRuns.slice(1, 6).every((node) => node.parentNode === paragraphNode)).toBe(true)
    const resultRun = fieldRuns[4]!
    expect(resultRun.getElementsByTagNameNS(W, 'i')).toHaveLength(1)
  })

  it('preserves unrelated prefix/suffix and applies multiple paragraph markers in reverse order', () => {
    const second = `{{zotero-cite:zotero://group/2/item/EFGH5678}}`
    const source = documentXml(paragraph(run(`A ${MARKER} middle ${second} Z`)))
    const markers = scanDocumentMarkers(source)
    const output = rewriteWordDocument(source, [
      { ...replacement(markers[0]!, 'one'), resultText: '[ONE]' },
      { ...replacement(markers[1]!, 'two'), resultText: '[TWO]' },
    ])
    expect(paragraphText(output.bytes)).toEqual(['A [ONE] middle [TWO] Z'])
    expect(
      scanWordFields(output.bytes).citationFields.map((field) => field.payload.citationID),
    ).toEqual(['one', 'two'])
  })

  it('supports a marker spanning several direct runs with multiple w:t children', () => {
    const source = documentXml(
      paragraph(
        `<w:r><w:rPr><w:b/></w:rPr><w:t>pre ${escapeXml(MARKER.slice(0, 8))}</w:t><w:t>${escapeXml(MARKER.slice(8, 20))}</w:t></w:r>` +
          run(`${MARKER.slice(20)} post`),
      ),
    )
    const markers = scanDocumentMarkers(source)
    const output = rewriteWordDocument(source, [replacement(markers[0]!)])
    expect(paragraphText(output.bytes)).toEqual(['pre (Example, 2026) post'])
    expect(scanWordFields(output.bytes).citationFields).toHaveLength(1)
  })

  it('requires exact replacement identity and validates instructions before mutation', () => {
    const source = documentXml(paragraph(run(MARKER)))
    const marker = scanDocumentMarkers(source)[0]!
    expectCode(() => rewriteWordDocument(source, []), 'DOCX_MARKER_REPLACEMENT_MISMATCH')
    expectCode(
      () =>
        rewriteWordDocument(source, [
          {
            marker: { ...marker, raw: 'other' },
            instruction: citationInstruction('x'),
            resultText: 'x',
          },
        ]),
      'DOCX_MARKER_REPLACEMENT_MISMATCH',
    )
    expect(() =>
      rewriteWordDocument(source, [
        { marker, instruction: 'ADDIN ZOTERO_ITEM CSL_CITATION {}', resultText: 'x' },
      ]),
    ).toThrow(/citation/i)
  })

  it('leaves existing Zotero fields untouched when no marker shares their paragraph', () => {
    const instruction = citationInstruction('existing')
    const source = documentXml(
      complexFieldXml(instruction, '(Existing)') + paragraph(run(`New ${MARKER}`)),
    )
    const marker = scanDocumentMarkers(source)[0]!
    const output = rewriteWordDocument(source, [replacement(marker, 'new')])
    const scan = scanWordFields(output.bytes)
    expect(scan.citationFields.map((field) => field.payload.citationID)).toEqual([
      'existing',
      'new',
    ])
    expect(decoder.decode(output.bytes)).toContain(instruction)
  })
})

describe('unsafe marker contexts fail closed', () => {
  it.each([
    ['hyperlink', `<w:hyperlink>${run(MARKER)}</w:hyperlink>`],
    ['sdt', `<w:sdt><w:sdtContent>${run(MARKER)}</w:sdtContent></w:sdt>`],
    ['tracked insertion', `<w:ins>${run(MARKER)}</w:ins>`],
    ['tracked deletion', `<w:del>${run(MARKER)}</w:del>`],
    ['move', `<w:moveFrom>${run(MARKER)}</w:moveFrom>`],
    ['smart tag', `<w:smartTag>${run(MARKER)}</w:smartTag>`],
    ['custom XML', `<w:customXml>${run(MARKER)}</w:customXml>`],
    ['text box', `<w:txbxContent>${paragraph(run(MARKER))}</w:txbxContent>`],
    [
      'alternate content',
      `<mc:AlternateContent><mc:Choice Requires="w">${run(MARKER)}</mc:Choice></mc:AlternateContent>`,
    ],
  ])('rejects %s content', (_name, content) => {
    expectCode(
      () => scanDocumentMarkers(documentXml(paragraph(content))),
      'DOCX_MARKER_UNSAFE_CONTEXT',
    )
  })

  it.each([
    '<w:proofErr w:type="spellStart"/>',
    '<w:permStart w:id="1"/>',
    '<w:bookmarkStart w:id="1" w:name="x"/>',
    '<w:commentRangeStart w:id="1"/>',
    '<w:moveFromRangeStart w:id="1" w:name="x"/>',
    '<w:drawing/>',
  ])('rejects marker paragraph sharing unsupported range/content %s', (content) => {
    expectCode(
      () => scanDocumentMarkers(documentXml(paragraph(content + run(MARKER)))),
      'DOCX_MARKER_UNSAFE_CONTEXT',
    )
  })

  it('rejects a marker in or sharing a paragraph with complex or simple fields', () => {
    expectCode(
      () =>
        scanDocumentMarkers(
          documentXml(paragraph('<w:r><w:fldChar w:fldCharType="begin"/></w:r>' + run(MARKER))),
        ),
      'DOCX_MARKER_UNSAFE_CONTEXT',
    )
    expectCode(
      () =>
        scanDocumentMarkers(
          documentXml(paragraph(`<w:fldSimple w:instr="DATE">${run(MARKER)}</w:fldSimple>`)),
        ),
      'DOCX_MARKER_UNSAFE_CONTEXT',
    )
  })

  it.each(['<w:tab/>', '<w:br/>', '<w:sym w:char="F020"/>', '<w:footnoteReference w:id="1"/>'])(
    'rejects a touched run carrying non-rPr/w:t child %s',
    (child) => {
      const source = documentXml(paragraph(`<w:r><w:t>${escapeXml(MARKER)}</w:t>${child}</w:r>`))
      expectCode(() => scanDocumentMarkers(source), 'DOCX_MARKER_UNSAFE_CONTEXT')
    },
  )
})

describe('unsupported Word stories', () => {
  it.each([
    'word/header1.xml',
    'word/footer2.xml',
    'word/footnotes.xml',
    'word/endnotes.xml',
    'word/comments.xml',
    'word/commentsExtended.xml',
  ])('recognizes and reports marker-shaped text in %s', (part) => {
    expect(isUnsupportedWordStory(part)).toBe(true)
    const source = xml(`<w:root xmlns:w="${W}">${paragraph(run(MARKER))}</w:root>`)
    expect(scanUnsupportedWordStory(part, source)).toEqual([{ part, paragraph: 1, text: MARKER }])
  })

  it('reports malformed marker-shaped text without parsing it and ignores ordinary text', () => {
    const malformed = xml(
      `<w:root xmlns:w="${W}">${paragraph(run('{{ZOTERO-CITE:not-finished'))}</w:root>`,
    )
    expect(scanUnsupportedWordStory('word/header1.xml', malformed)).toHaveLength(1)
    expect(
      scanUnsupportedWordStory(
        'word/header1.xml',
        xml(`<w:root xmlns:w="${W}">${paragraph(run('ordinary'))}</w:root>`),
      ),
    ).toEqual([])
    expect(scanUnsupportedWordStory('word/styles.xml', malformed)).toEqual([])
  })

  it('reports legacy-shaped content only when legacy parsing is enabled', () => {
    const source = xml(`<w:root xmlns:w="${W}">${paragraph(run('[@ABCD1234]'))}</w:root>`)
    expect(scanUnsupportedWordStory('word/footer1.xml', source)).toEqual([])
    expect(
      scanUnsupportedWordStory('word/footer1.xml', source, { allowLegacy: true }),
    ).toHaveLength(1)
  })
})

describe('bibliography placement and cardinality', () => {
  it('appends one bibliography immediately before body-level sectPr without a heading', () => {
    const source = documentXml(paragraph(run(MARKER)) + '<w:sectPr><w:pgSz/></w:sectPr>')
    const marker = scanDocumentMarkers(source)[0]!
    const output = rewriteWordDocument(source, [replacement(marker)], {
      addBibliography: true,
      bibliographyResultText: '[Refresh bibliography]',
    })
    expect(output.bibliographyAdded).toBe(true)
    expect(output.bibliographyCount).toBe(1)
    expect(paragraphText(output.bytes)).toEqual(['(Example, 2026)', '[Refresh bibliography]'])
    const serialized = decoder.decode(output.bytes)
    expect(serialized.indexOf(serializeZoteroBibliographyInstruction())).toBeLessThan(
      serialized.indexOf('<w:sectPr'),
    )
    expect(serialized).not.toContain('Bibliography</w:t>')
  })

  it('does not add a second bibliography and rejects duplicates', () => {
    const existing = complexFieldXml(serializeZoteroBibliographyInstruction(), '[Existing]')
    const source = documentXml(existing)
    const output = rewriteWordDocument(source, [], { addBibliography: true })
    expect(output.bibliographyAdded).toBe(false)
    expect(output.bibliographyCount).toBe(1)

    const duplicate = documentXml(existing + existing)
    expectCode(
      () => rewriteWordDocument(duplicate, [], { addBibliography: true }),
      'DOCX_BIBLIOGRAPHY_DUPLICATE',
    )
  })
})

describe('independent complex field scanning', () => {
  it('reconstructs a citation instruction across contiguous instrText runs', () => {
    const instruction = citationInstruction('split')
    const midpoint = Math.floor(instruction.length / 2)
    const source = documentXml(
      paragraph(
        '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
          `<w:r><w:instrText>${escapeXml(instruction.slice(0, midpoint))}</w:instrText></w:r>` +
          `<w:r><w:instrText>${escapeXml(instruction.slice(midpoint))}</w:instrText></w:r>` +
          '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
          run('(Split)') +
          '<w:r><w:fldChar w:fldCharType="end"/></w:r>',
      ),
    )
    const scan = scanWordFields(source)
    expect(scan.complexFieldCount).toBe(1)
    expect(scan.citationFields[0]?.instruction).toBe(instruction)
    expect(JSON.parse(scan.citationFields[0]!.payloadText)).toHaveProperty('citationID', 'split')
  })

  it('reports duplicate citation IDs and bibliography payload data', () => {
    const citation = complexFieldXml(citationInstruction('same'), '(One)')
    const bibliography = complexFieldXml(serializeZoteroBibliographyInstruction(), '[Bib]')
    const scan = scanWordFields(documentXml(citation + citation + bibliography))
    expect(scan.duplicateCitationIds).toEqual(['same'])
    expect(scan.citationFields).toHaveLength(2)
    expect(scan.bibliographyFields[0]?.payloadText).toBe('{"uncited":[],"omitted":[],"custom":[]}')
  })

  it.each([
    paragraph('<w:r><w:fldChar w:fldCharType="end"/></w:r>'),
    paragraph('<w:r><w:fldChar w:fldCharType="begin"/></w:r>'),
    paragraph(
      '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>',
    ),
    paragraph('<w:r><w:fldChar w:fldCharType="separate"/></w:r>'),
    paragraph('<w:r><w:instrText> DATE </w:instrText></w:r>'),
    paragraph(
      '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:instrText>x</w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>',
    ),
  ])('rejects malformed complex field structure', (body) => {
    expectCode(() => scanWordFields(documentXml(body)), 'DOCX_FIELD_STRUCTURE_INVALID')
  })

  it('rejects Zotero simple fields and malformed Zotero instructions', () => {
    expectCode(
      () => scanWordFields(documentXml(paragraph('<w:fldSimple w:instr="ZOTERO_ITEM"/>'))),
      'DOCX_FIELD_STRUCTURE_INVALID',
    )
    expect(() =>
      scanWordFields(documentXml(complexFieldXml('ADDIN ZOTERO_ITEM nope', 'x'))),
    ).toThrow(/citation/i)
    expect(() =>
      scanWordFields(documentXml(complexFieldXml('ADDIN ZOTERO_BIBL nope', 'x'))),
    ).toThrow(/bibliography/i)
  })

  it('counts nested balanced ordinary fields independently', () => {
    const source = documentXml(
      paragraph(
        '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
          '<w:r><w:instrText> OUTER </w:instrText></w:r>' +
          '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
          '<w:r><w:instrText> INNER </w:instrText></w:r>' +
          '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
          '<w:r><w:fldChar w:fldCharType="end"/></w:r>' +
          '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
          '<w:r><w:fldChar w:fldCharType="end"/></w:r>',
      ),
    )
    expect(scanWordFields(source)).toMatchObject({
      complexFieldCount: 2,
      citationFields: [],
      bibliographyFields: [],
      duplicateCitationIds: [],
    })
  })
})

function complexFieldXml(instruction: string, result: string): string {
  return paragraph(
    '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
      `<w:r><w:instrText xml:space="preserve"> ${escapeXml(instruction)} </w:instrText></w:r>` +
      '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
      run(result) +
      '<w:r><w:fldChar w:fldCharType="end"/></w:r>',
  )
}
