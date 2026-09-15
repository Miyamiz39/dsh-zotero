/** Structure-aware WordprocessingML citation marker rewriting and field inspection. */

import {
  parseZoteroBibliographyInstruction,
  parseZoteroCitationInstruction,
  serializeZoteroBibliographyInstruction,
  type ZoteroWordCitationPayload,
} from './fields.js'
import {
  parseZoteroCitationMarkers,
  type ParseZoteroCitationMarkersOptions,
  type ZoteroCitationMarker,
} from './markers.js'
import {
  childElements,
  descendants,
  localName,
  parseXml,
  serializeXml,
  WORD_NS,
  XML_NS,
} from './xml.js'

export const SUPPORTED_WORD_STORY = 'word/document.xml'
export const UNSUPPORTED_WORD_STORIES = [
  /^word\/header\d*\.xml$/i,
  /^word\/footer\d*\.xml$/i,
  /^word\/footnotes\.xml$/i,
  /^word\/endnotes\.xml$/i,
  /^word\/comments(?:Extended|Extensible)?\.xml$/i,
] as const

const UNSUPPORTED_CONTEXTS = new Set([
  'hyperlink',
  'sdt',
  'ins',
  'del',
  'moveFrom',
  'moveTo',
  'moveFromRangeStart',
  'moveFromRangeEnd',
  'moveToRangeStart',
  'moveToRangeEnd',
  'smartTag',
  'customXml',
  'proofErr',
  'permStart',
  'permEnd',
  'bookmarkStart',
  'bookmarkEnd',
  'commentRangeStart',
  'commentRangeEnd',
  'commentReference',
  'drawing',
  'pict',
  'object',
  'txbxContent',
  'AlternateContent',
  'fldSimple',
])

export type WordmlErrorCode =
  | 'DOCX_WORDML_STRUCTURE_INVALID'
  | 'DOCX_MARKER_UNSAFE_CONTEXT'
  | 'DOCX_MARKER_MAP_FAILED'
  | 'DOCX_MARKER_REPLACEMENT_MISMATCH'
  | 'DOCX_FIELD_STRUCTURE_INVALID'
  | 'DOCX_BIBLIOGRAPHY_DUPLICATE'

export class WordmlError extends Error {
  constructor(
    readonly code: WordmlErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'WordmlError'
  }
}

export interface UnsupportedStoryMarker {
  readonly part: string
  readonly paragraph: number
  readonly text: string
}

export interface ZoteroFieldReplacement {
  /** Exact marker identity. Replacements must match document order one-for-one. */
  readonly marker: ZoteroCitationMarker
  readonly instruction: string
  readonly resultText: string
}

export interface RewriteWordDocumentOptions extends ParseZoteroCitationMarkersOptions {
  readonly addBibliography?: boolean
  readonly bibliographyResultText?: string
}

export interface RewriteWordDocumentResult {
  readonly bytes: Uint8Array
  readonly markers: readonly ZoteroCitationMarker[]
  readonly citationCount: number
  readonly bibliographyAdded: boolean
  readonly bibliographyCount: number
}

export interface ScannedCitationField {
  readonly instruction: string
  readonly payloadText: string
  readonly payload: ZoteroWordCitationPayload
}

export interface ScannedBibliographyField {
  readonly instruction: string
  readonly payloadText: string
}

export interface WordFieldScan {
  readonly complexFieldCount: number
  readonly citationFields: readonly ScannedCitationField[]
  readonly bibliographyFields: readonly ScannedBibliographyField[]
  readonly duplicateCitationIds: readonly string[]
}

interface TextSegment {
  readonly node: Text
  readonly run: Element
  readonly start: number
  readonly end: number
}

interface ParagraphProjection {
  readonly text: string
  readonly segments: readonly TextSegment[]
}

interface OpenField {
  readonly instruction: string[]
  separated: boolean
}

function fail(code: WordmlErrorCode, message: string): never {
  throw new WordmlError(code, message)
}

function directWordChildren(parent: Node, name: string): Element[] {
  return childElements(parent).filter(
    (child) => child.namespaceURI === WORD_NS && localName(child) === name,
  )
}

function attribute(element: Element, name: string): string | null {
  return element.getAttributeNS(WORD_NS, name) ?? element.getAttribute(`w:${name}`)
}

function paragraphProjection(paragraph: Element): ParagraphProjection {
  let text = ''
  const segments: TextSegment[] = []
  for (const node of descendants(paragraph, WORD_NS, 't')) {
    const value = node.textContent ?? ''
    const run = nearestWordAncestor(node, 'r', paragraph)
    const directText =
      node.childNodes.length === 1 && node.firstChild?.nodeType === 3
        ? (node.firstChild as Text)
        : undefined
    const start = text.length
    text += value
    if (run !== undefined && directText !== undefined) {
      segments.push({ node: directText, run, start, end: text.length })
    }
  }
  return { text, segments }
}

function nearestWordAncestor(node: Node, name: string, stop: Element): Element | undefined {
  let current = node.parentNode
  while (current !== null && current !== stop) {
    if (
      current.nodeType === 1 &&
      (current as Element).namespaceURI === WORD_NS &&
      localName(current) === name
    ) {
      return current as Element
    }
    current = current.parentNode
  }
  return undefined
}

function suspiciousStoryText(text: string, allowLegacy: boolean): boolean {
  return /zotero-cite/i.test(text) || (allowLegacy && /\[@[A-Z0-9]{8}/.test(text))
}

/** Whether a package part is a marker-capable story this layer deliberately does not mutate. */
export function isUnsupportedWordStory(part: string): boolean {
  return UNSUPPORTED_WORD_STORIES.some((pattern) => pattern.test(part))
}

/**
 * Report marker-shaped paragraph text in headers, footers, notes, and comments. The caller must
 * fail the whole finalization when any finding is returned; malformed marker-shaped text is still
 * reported rather than being downgraded to prose.
 */
export function scanUnsupportedWordStory(
  part: string,
  bytes: Uint8Array,
  options: ParseZoteroCitationMarkersOptions = {},
): UnsupportedStoryMarker[] {
  if (!isUnsupportedWordStory(part)) return []
  const document = parseXml(bytes, part)
  const findings: UnsupportedStoryMarker[] = []
  descendants(document, WORD_NS, 'p').forEach((paragraph, index) => {
    const text = paragraphProjection(paragraph).text
    if (suspiciousStoryText(text, options.allowLegacy === true)) {
      findings.push({ part, paragraph: index + 1, text })
    }
  })
  return findings
}

/** Parse supported markers in the main story and validate every marker's exact WordML context. */
export function scanDocumentMarkers(
  bytes: Uint8Array,
  options: ParseZoteroCitationMarkersOptions = {},
): ZoteroCitationMarker[] {
  const document = parseMainDocument(bytes)
  return collectDocumentMarkers(document, options).markers
}

/**
 * Replace every validated main-story marker with one direct-run complex ADDIN field. Replacements
 * are applied in reverse document order so source UTF-16 offsets remain stable.
 */
export function rewriteWordDocument(
  bytes: Uint8Array,
  replacements: readonly ZoteroFieldReplacement[],
  options: RewriteWordDocumentOptions = {},
): RewriteWordDocumentResult {
  const document = parseMainDocument(bytes)
  const collected = collectDocumentMarkers(document, options)
  if (replacements.length !== collected.markers.length) {
    fail(
      'DOCX_MARKER_REPLACEMENT_MISMATCH',
      `Document has ${collected.markers.length} citation markers but ${replacements.length} replacements were supplied.`,
    )
  }
  replacements.forEach((replacement, index) => {
    const marker = collected.markers[index]!
    if (!sameMarker(marker, replacement.marker)) {
      fail(
        'DOCX_MARKER_REPLACEMENT_MISMATCH',
        `Replacement ${index + 1} does not match marker ${JSON.stringify(marker.raw)}.`,
      )
    }
    // Validate before mutating any XML so malformed field payloads fail atomically.
    parseZoteroCitationInstruction(replacement.instruction)
  })

  const work = collected.byParagraph
    .flatMap(({ paragraph, projection, markers }, paragraphIndex) =>
      markers.map((marker) => ({ paragraph, projection, marker, paragraphIndex })),
    )
    .sort((a, b) => b.paragraphIndex - a.paragraphIndex || b.marker.start - a.marker.start)
  for (const item of work) {
    const globalIndex = collected.markers.indexOf(item.marker)
    const replacement = replacements[globalIndex]!
    replaceMarker(item.paragraph, item.projection, item.marker, replacement)
  }

  const before = scanWordFieldsDocument(document)
  if (before.bibliographyFields.length > 1) {
    fail(
      'DOCX_BIBLIOGRAPHY_DUPLICATE',
      'Document contains more than one Zotero bibliography field.',
    )
  }
  let bibliographyAdded = false
  if (options.addBibliography === true && before.bibliographyFields.length === 0) {
    appendBibliography(document, options.bibliographyResultText ?? '[Zotero bibliography]')
    bibliographyAdded = true
  }
  const after = scanWordFieldsDocument(document)
  if (after.bibliographyFields.length > 1) {
    fail(
      'DOCX_BIBLIOGRAPHY_DUPLICATE',
      'Document contains more than one Zotero bibliography field.',
    )
  }
  return {
    bytes: serializeXml(document),
    markers: collected.markers,
    citationCount: after.citationFields.length,
    bibliographyAdded,
    bibliographyCount: after.bibliographyFields.length,
  }
}

/** Independently scan balanced complex fields and validate exact Zotero field instructions. */
export function scanWordFields(bytes: Uint8Array, part = SUPPORTED_WORD_STORY): WordFieldScan {
  return scanWordFieldsDocument(parseXml(bytes, part))
}

function parseMainDocument(bytes: Uint8Array): Document {
  const document = parseXml(bytes, SUPPORTED_WORD_STORY)
  const roots = document.documentElement
  if (
    roots === null ||
    roots.namespaceURI !== WORD_NS ||
    localName(roots) !== 'document' ||
    directWordChildren(roots, 'body').length !== 1
  ) {
    fail(
      'DOCX_WORDML_STRUCTURE_INVALID',
      'word/document.xml must contain one WordprocessingML document/body.',
    )
  }
  return document
}

function collectDocumentMarkers(
  document: Document,
  options: ParseZoteroCitationMarkersOptions,
): {
  markers: ZoteroCitationMarker[]
  byParagraph: Array<{
    paragraph: Element
    projection: ParagraphProjection
    markers: ZoteroCitationMarker[]
  }>
} {
  const markers: ZoteroCitationMarker[] = []
  const byParagraph: Array<{
    paragraph: Element
    projection: ParagraphProjection
    markers: ZoteroCitationMarker[]
  }> = []
  for (const paragraph of descendants(document, WORD_NS, 'p')) {
    const projection = paragraphProjection(paragraph)
    const fullText = paragraph.textContent ?? ''
    if (
      suspiciousStoryText(fullText, options.allowLegacy === true) &&
      !suspiciousStoryText(projection.text, options.allowLegacy === true)
    ) {
      fail(
        'DOCX_MARKER_UNSAFE_CONTEXT',
        'Marker-shaped text occurs outside supported direct w:t run content.',
      )
    }
    const found = parseZoteroCitationMarkers(projection.text, options)
    for (const marker of found) validateMarkerContext(paragraph, projection, marker)
    markers.push(...found)
    byParagraph.push({ paragraph, projection, markers: found })
  }
  return { markers, byParagraph }
}

function validateMarkerContext(
  paragraph: Element,
  projection: ParagraphProjection,
  marker: ZoteroCitationMarker,
): void {
  if (
    descendants(paragraph, WORD_NS, 'fldChar').length > 0 ||
    descendants(paragraph, WORD_NS, 'instrText').length > 0 ||
    descendants(paragraph, WORD_NS, 'fldSimple').length > 0
  ) {
    fail(
      'DOCX_MARKER_UNSAFE_CONTEXT',
      `Marker ${JSON.stringify(marker.raw)} shares a paragraph with an existing field.`,
    )
  }
  const unsupported = Array.from(paragraph.getElementsByTagName('*')).find((element) =>
    UNSUPPORTED_CONTEXTS.has(localName(element)),
  )
  if (unsupported !== undefined) {
    fail(
      'DOCX_MARKER_UNSAFE_CONTEXT',
      `Marker ${JSON.stringify(marker.raw)} shares a paragraph with unsupported ${localName(unsupported)} content.`,
    )
  }
  const touched = projection.segments.filter(
    (segment) => segment.end > marker.start && segment.start < marker.end,
  )
  if (
    touched.length === 0 ||
    touched[0]!.start > marker.start ||
    touched.at(-1)!.end < marker.end
  ) {
    fail(
      'DOCX_MARKER_MAP_FAILED',
      `Could not map marker ${JSON.stringify(marker.raw)} to Word runs.`,
    )
  }
  for (const segment of touched) {
    validateTextContext(segment.node.parentNode as Element, segment.run, paragraph, marker)
  }
}

function validateTextContext(
  text: Element,
  run: Element,
  paragraph: Element,
  marker: ZoteroCitationMarker,
): void {
  if (text.parentNode !== run || run.parentNode !== paragraph) {
    fail(
      'DOCX_MARKER_UNSAFE_CONTEXT',
      `Marker ${JSON.stringify(marker.raw)} is not in direct paragraph runs and text nodes.`,
    )
  }
  let current: Node | null = text
  while (current !== null && current !== paragraph) {
    if (current.nodeType === 1 && UNSUPPORTED_CONTEXTS.has(localName(current))) {
      fail(
        'DOCX_MARKER_UNSAFE_CONTEXT',
        `Marker ${JSON.stringify(marker.raw)} is inside unsupported ${localName(current)} content.`,
      )
    }
    current = current.parentNode
  }
  for (const child of childElements(run)) {
    if (
      child.namespaceURI !== WORD_NS ||
      (localName(child) !== 'rPr' && localName(child) !== 't')
    ) {
      fail(
        'DOCX_MARKER_UNSAFE_CONTEXT',
        `Marker ${JSON.stringify(marker.raw)} touches a run carrying unsupported ${localName(child)} content.`,
      )
    }
  }
}

function sameMarker(left: ZoteroCitationMarker, right: ZoteroCitationMarker): boolean {
  return (
    left.kind === right.kind &&
    left.start === right.start &&
    left.end === right.end &&
    left.raw === right.raw &&
    left.refs.length === right.refs.length &&
    left.refs.every((ref, index) => ref === right.refs[index])
  )
}

function setText(node: Text, value: string): void {
  node.data = value
  const parent = node.parentNode as Element
  if (/^\s|\s$/.test(value)) parent.setAttributeNS(XML_NS, 'xml:space', 'preserve')
  else parent.removeAttributeNS(XML_NS, 'space')
}

function trimRun(
  run: Element,
  segments: readonly TextSegment[],
  boundary: number,
  keepPrefix: boolean,
): void {
  for (const segment of segments.filter((candidate) => candidate.run === run)) {
    const original = segment.node.data
    const point = Math.max(0, Math.min(original.length, boundary - segment.start))
    setText(segment.node, keepPrefix ? original.slice(0, point) : original.slice(point))
  }
}

function cloneSegments(run: Element, originals: readonly TextSegment[]): TextSegment[] {
  const nodes = directWordChildren(run, 't').map((element) => {
    if (element.firstChild?.nodeType === 3) return element.firstChild as Text
    return element.appendChild(element.ownerDocument.createTextNode(''))
  })
  return originals.map((segment, index) => ({ ...segment, run, node: nodes[index]! }))
}

function replaceMarker(
  paragraph: Element,
  projection: ParagraphProjection,
  marker: ZoteroCitationMarker,
  replacement: ZoteroFieldReplacement,
): void {
  const touched = projection.segments.filter(
    (segment) => segment.end > marker.start && segment.start < marker.end,
  )
  const firstRun = touched[0]!.run
  const lastRun = touched.at(-1)!.run
  const resultProperties = directWordChildren(firstRun, 'rPr')[0]?.cloneNode(true) as
    Element | undefined
  let suffixRun: Element | undefined
  if (firstRun === lastRun) {
    suffixRun = firstRun.cloneNode(true) as Element
    trimRun(firstRun, projection.segments, marker.start, true)
    trimRun(
      suffixRun,
      cloneSegments(
        suffixRun,
        projection.segments.filter((segment) => segment.run === firstRun),
      ),
      marker.end,
      false,
    )
  } else {
    trimRun(firstRun, projection.segments, marker.start, true)
    trimRun(lastRun, projection.segments, marker.end, false)
    const runs = [...new Set(touched.map((segment) => segment.run))]
    for (const run of runs.slice(1, -1)) {
      for (const node of directWordChildren(run, 't')) {
        const text = node.firstChild
        if (node.childNodes.length !== 1 || text?.nodeType !== 3) {
          fail(
            'DOCX_MARKER_UNSAFE_CONTEXT',
            `Marker ${JSON.stringify(marker.raw)} touches a malformed text run.`,
          )
        }
        setText(text as Text, '')
      }
    }
  }
  const anchor = firstRun.nextSibling
  for (const run of makeComplexFieldRuns(
    paragraph.ownerDocument,
    replacement.instruction,
    replacement.resultText,
    resultProperties,
  )) {
    paragraph.insertBefore(run, anchor)
  }
  if (suffixRun !== undefined) paragraph.insertBefore(suffixRun, anchor)
}

function makeWordElement(document: Document, name: string): Element {
  return document.createElementNS(WORD_NS, `w:${name}`)
}

function makeComplexFieldRuns(
  document: Document,
  instruction: string,
  resultText: string,
  resultProperties?: Element,
): Element[] {
  const run = (): Element => makeWordElement(document, 'r')
  const begin = run()
  const beginChar = makeWordElement(document, 'fldChar')
  beginChar.setAttributeNS(WORD_NS, 'w:fldCharType', 'begin')
  begin.appendChild(beginChar)

  const code = run()
  const instructionText = makeWordElement(document, 'instrText')
  instructionText.setAttributeNS(XML_NS, 'xml:space', 'preserve')
  instructionText.appendChild(document.createTextNode(` ${instruction} `))
  code.appendChild(instructionText)

  const separator = run()
  const separatorChar = makeWordElement(document, 'fldChar')
  separatorChar.setAttributeNS(WORD_NS, 'w:fldCharType', 'separate')
  separator.appendChild(separatorChar)

  const result = run()
  if (resultProperties !== undefined) result.appendChild(resultProperties.cloneNode(true))
  const resultNode = makeWordElement(document, 't')
  if (/^\s|\s$/.test(resultText)) resultNode.setAttributeNS(XML_NS, 'xml:space', 'preserve')
  resultNode.appendChild(document.createTextNode(resultText))
  result.appendChild(resultNode)

  const end = run()
  const endChar = makeWordElement(document, 'fldChar')
  endChar.setAttributeNS(WORD_NS, 'w:fldCharType', 'end')
  end.appendChild(endChar)
  return [begin, code, separator, result, end]
}

function appendBibliography(document: Document, resultText: string): void {
  const body = directWordChildren(document.documentElement, 'body')[0]!
  const paragraph = makeWordElement(document, 'p')
  for (const run of makeComplexFieldRuns(
    document,
    serializeZoteroBibliographyInstruction(),
    resultText,
  )) {
    paragraph.appendChild(run)
  }
  const section = directWordChildren(body, 'sectPr')
  if (section.length > 1) {
    fail('DOCX_WORDML_STRUCTURE_INVALID', 'Document body contains duplicate body-level sectPr.')
  }
  body.insertBefore(paragraph, section[0] ?? null)
}

function scanWordFieldsDocument(document: Document): WordFieldScan {
  const complete: string[] = []
  let complexFieldCount = 0
  const walk = (node: Node, stack: OpenField[]): void => {
    if (node.nodeType === 1) {
      const element = node as Element
      const name = localName(element)
      if (element.namespaceURI === WORD_NS && name === 'fldSimple') {
        const instruction = attribute(element, 'instr') ?? ''
        if (/ZOTERO_(?:ITEM|BIBL)/.test(instruction)) {
          fail('DOCX_FIELD_STRUCTURE_INVALID', 'Zotero fields must be balanced complex fields.')
        }
      } else if (element.namespaceURI === WORD_NS && name === 'fldChar') {
        const kind = attribute(element, 'fldCharType')
        if (kind === 'begin') {
          stack.push({ instruction: [], separated: false })
          complexFieldCount += 1
        } else if (kind === 'separate') {
          const current = stack.at(-1)
          if (current === undefined || current.separated) {
            fail('DOCX_FIELD_STRUCTURE_INVALID', 'Complex field has an unmatched separator.')
          }
          current.separated = true
        } else if (kind === 'end') {
          const current = stack.pop()
          if (current === undefined || !current.separated) {
            fail(
              'DOCX_FIELD_STRUCTURE_INVALID',
              'Complex field has an unmatched or unseparated end.',
            )
          }
          complete.push(current.instruction.join('').trim())
        } else {
          fail('DOCX_FIELD_STRUCTURE_INVALID', 'Complex field has an unknown fldCharType.')
        }
      } else if (element.namespaceURI === WORD_NS && name === 'instrText') {
        const current = stack.at(-1)
        if (current === undefined || current.separated) {
          fail(
            'DOCX_FIELD_STRUCTURE_INVALID',
            'instrText occurs outside a field instruction range.',
          )
        }
        current.instruction.push(element.textContent ?? '')
      }
    }
    if (node.childNodes !== null) {
      for (const child of Array.from(node.childNodes)) walk(child, stack)
    }
  }
  for (const paragraph of descendants(document, WORD_NS, 'p')) {
    if (nearestWordAncestor(paragraph, 'p', document.documentElement) !== undefined) continue
    const stack: OpenField[] = []
    walk(paragraph, stack)
    if (stack.length !== 0) {
      fail('DOCX_FIELD_STRUCTURE_INVALID', 'Complex field is not balanced within one paragraph.')
    }
  }

  const citationFields: ScannedCitationField[] = []
  const bibliographyFields: ScannedBibliographyField[] = []
  for (const instruction of complete) {
    if (instruction.startsWith('ADDIN ZOTERO_ITEM CSL_CITATION')) {
      const payload = parseZoteroCitationInstruction(instruction)
      citationFields.push({
        instruction,
        payloadText: instruction.slice('ADDIN ZOTERO_ITEM CSL_CITATION '.length),
        payload,
      })
    } else if (instruction.includes('ZOTERO_ITEM') || instruction.includes('CSL_CITATION')) {
      // Marker-shaped Zotero field instructions may never hide as ordinary fields.
      parseZoteroCitationInstruction(instruction)
    } else if (instruction.startsWith('ADDIN ZOTERO_BIBL')) {
      parseZoteroBibliographyInstruction(instruction)
      bibliographyFields.push({
        instruction,
        payloadText: instruction.slice('ADDIN ZOTERO_BIBL '.length, -' CSL_BIBLIOGRAPHY'.length),
      })
    } else if (instruction.includes('ZOTERO_BIBL') || instruction.includes('CSL_BIBLIOGRAPHY')) {
      parseZoteroBibliographyInstruction(instruction)
    }
  }
  const counts = new Map<string, number>()
  for (const field of citationFields) {
    counts.set(field.payload.citationID, (counts.get(field.payload.citationID) ?? 0) + 1)
  }
  return {
    complexFieldCount,
    citationFields,
    bibliographyFields,
    duplicateCitationIds: [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([id]) => id)
      .sort(),
  }
}
