/**
 * Zotero custom-property integration for a DOCX OPC package. The updater owns
 * only ZOTERO_PREF_N properties and the package declarations that make
 * docProps/custom.xml reachable; unrelated properties and value types remain
 * untouched.
 * @module dsh-zotero/docx/properties
 */

import type { OpcArchive } from './opc.js'
import {
  createZoteroDocumentPreferences,
  parseZoteroPreferenceChunks,
  serializeZoteroPreferenceChunks,
  type CreateZoteroDocumentPreferencesOptions,
  type ZoteroDocumentPreferences,
  type ZoteroPreferenceChunk,
} from './fields.js'
import {
  childElements,
  CONTENT_TYPES_NS,
  CUSTOM_PROPERTY_NS,
  CUSTOM_VALUE_NS,
  descendants,
  localName,
  PACKAGE_REL_NS,
  parseXml,
  serializeXml,
} from './xml.js'

export const ZOTERO_CUSTOM_PROPERTIES_PART = 'docProps/custom.xml'
export const ZOTERO_ROOT_RELATIONSHIPS_PART = '_rels/.rels'
export const ZOTERO_CONTENT_TYPES_PART = '[Content_Types].xml'
export const ZOTERO_CUSTOM_RELATIONSHIP_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties'
export const ZOTERO_CUSTOM_PROPERTIES_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.custom-properties+xml'
export const OFFICE_CUSTOM_PROPERTY_FMTID = '{D5CDD505-2E9C-101B-9397-08002B2CF9AE}'

export interface ZoteroPropertiesArchive {
  has(name: string): boolean
  read(name: string, maxBytes?: number): Uint8Array
  replace(name: string, bytes: Uint8Array): void
  add(name: string, bytes: Uint8Array): void
}

// Compile-time proof that the narrow duck type stays compatible with OpcArchive.
type _OpcArchiveCompatibility = OpcArchive extends ZoteroPropertiesArchive ? true : never
const _opcArchiveCompatibility: _OpcArchiveCompatibility = true
void _opcArchiveCompatibility

export interface ZoteroPackageRelationshipFacts {
  readonly relationshipId: string
  readonly target: 'docProps/custom.xml'
  readonly type: typeof ZOTERO_CUSTOM_RELATIONSHIP_TYPE
}

export interface ZoteroContentTypeFacts {
  readonly partName: '/docProps/custom.xml'
  readonly contentType: typeof ZOTERO_CUSTOM_PROPERTIES_CONTENT_TYPE
}

export interface ZoteroPropertiesProbe {
  readonly preferences: ZoteroDocumentPreferences
  readonly chunks: readonly ZoteroPreferenceChunk[]
  readonly relationship: ZoteroPackageRelationshipFacts
  readonly contentType: ZoteroContentTypeFacts
}

/** Package-orchestration compatibility view. A successful read is consistent by construction. */
export interface ZoteroDocumentPropertiesRead {
  readonly preferences: ZoteroDocumentPreferences
  readonly chunks: readonly ZoteroPreferenceChunk[]
  readonly consistent: true
}

export interface UpdateZoteroPropertiesResult extends ZoteroPropertiesProbe {
  readonly customPropertiesCreated: boolean
  readonly relationshipCreated: boolean
  readonly contentTypeCreated: boolean
}

export type ZoteroPropertiesErrorCode =
  | 'DOCX_CUSTOM_PROPERTIES_INVALID'
  | 'DOCX_CUSTOM_PROPERTY_DUPLICATE'
  | 'DOCX_CUSTOM_PROPERTY_PID_INVALID'
  | 'DOCX_CUSTOM_PROPERTY_TYPE_INVALID'
  | 'DOCX_CUSTOM_PROPERTY_SEQUENCE_INVALID'
  | 'DOCX_CUSTOM_RELATIONSHIP_INVALID'
  | 'DOCX_CUSTOM_RELATIONSHIP_DUPLICATE'
  | 'DOCX_CUSTOM_CONTENT_TYPE_INVALID'
  | 'DOCX_CUSTOM_CONTENT_TYPE_DUPLICATE'

export class ZoteroPropertiesError extends Error {
  constructor(
    readonly code: ZoteroPropertiesErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ZoteroPropertiesError'
  }
}

function fail(code: ZoteroPropertiesErrorCode, message: string): never {
  throw new ZoteroPropertiesError(code, message)
}

function requireRoot(document: Document, namespace: string, name: string, part: string): Element {
  const root = document.documentElement
  if (root.namespaceURI !== namespace || localName(root) !== name) {
    fail('DOCX_CUSTOM_PROPERTIES_INVALID', `${part} has an unexpected root element.`)
  }
  return root
}

function exactElements(root: Element, namespace: string, name: string): Element[] {
  return childElements(root).filter(
    (element) => element.namespaceURI === namespace && localName(element) === name,
  )
}

function requiredPositivePid(element: Element): number {
  const raw = element.getAttribute('pid') ?? ''
  if (!/^[1-9]\d*$/.test(raw)) {
    fail('DOCX_CUSTOM_PROPERTY_PID_INVALID', 'A custom property has an invalid pid.')
  }
  const pid = Number(raw)
  if (!Number.isSafeInteger(pid)) {
    fail('DOCX_CUSTOM_PROPERTY_PID_INVALID', 'A custom property pid exceeds the safe range.')
  }
  return pid
}

interface ParsedCustomProperties {
  readonly document: Document
  readonly root: Element
  readonly zoteroElements: readonly Element[]
  readonly chunks: readonly ZoteroPreferenceChunk[]
  readonly nextPid: number
}

function parseCustomProperties(bytes: Uint8Array): ParsedCustomProperties {
  const document = parseXml(bytes, ZOTERO_CUSTOM_PROPERTIES_PART)
  const root = requireRoot(
    document,
    CUSTOM_PROPERTY_NS,
    'Properties',
    ZOTERO_CUSTOM_PROPERTIES_PART,
  )
  const properties = exactElements(root, CUSTOM_PROPERTY_NS, 'property')
  if (properties.length !== childElements(root).length) {
    fail(
      'DOCX_CUSTOM_PROPERTIES_INVALID',
      'docProps/custom.xml contains an unexpected child element.',
    )
  }
  const names = new Set<string>()
  const pids = new Set<number>()
  const zoteroElements: Element[] = []
  const chunks: ZoteroPreferenceChunk[] = []
  let maxPid = 1
  for (const property of properties) {
    const name = property.getAttribute('name') ?? ''
    if (name === '' || names.has(name)) {
      fail(
        'DOCX_CUSTOM_PROPERTY_DUPLICATE',
        `Custom property name ${JSON.stringify(name)} is blank or duplicated.`,
      )
    }
    names.add(name)
    const pid = requiredPositivePid(property)
    if (pids.has(pid)) {
      fail('DOCX_CUSTOM_PROPERTY_PID_INVALID', `Custom property pid ${pid} is duplicated.`)
    }
    pids.add(pid)
    maxPid = Math.max(maxPid, pid)
    if (!/^ZOTERO_PREF_\d+$/.test(name)) continue
    const values = childElements(property)
    if (
      values.length !== 1 ||
      values[0]!.namespaceURI !== CUSTOM_VALUE_NS ||
      localName(values[0]!) !== 'lpwstr'
    ) {
      fail('DOCX_CUSTOM_PROPERTY_TYPE_INVALID', `${name} must contain exactly one vt:lpwstr value.`)
    }
    if (
      values[0]!.childNodes.length > 1 ||
      (values[0]!.firstChild !== null && values[0]!.firstChild.nodeType !== 3)
    ) {
      fail('DOCX_CUSTOM_PROPERTY_TYPE_INVALID', `${name} must contain plain text only.`)
    }
    zoteroElements.push(property)
    chunks.push({ name: name as `ZOTERO_PREF_${number}`, value: values[0]!.textContent ?? '' })
  }
  if (chunks.length > 0) {
    try {
      parseZoteroPreferenceChunks(chunks)
    } catch (error) {
      throw new ZoteroPropertiesError(
        'DOCX_CUSTOM_PROPERTY_SEQUENCE_INVALID',
        `Existing ZOTERO_PREF_N properties are invalid: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  if (!Number.isSafeInteger(maxPid + chunks.length + 1)) {
    fail('DOCX_CUSTOM_PROPERTY_PID_INVALID', 'No safe custom property pid remains.')
  }
  return { document, root, zoteroElements, chunks, nextPid: maxPid + 1 }
}

function newCustomPropertiesDocument(template: Document): ParsedCustomProperties {
  const document = template.implementation.createDocument(CUSTOM_PROPERTY_NS, 'Properties', null)
  document.documentElement.setAttribute('xmlns:vt', CUSTOM_VALUE_NS)
  return {
    document,
    root: document.documentElement,
    zoteroElements: [],
    chunks: [],
    nextPid: 2,
  }
}

function appendPreferenceProperties(
  parsed: ParsedCustomProperties,
  chunks: readonly ZoteroPreferenceChunk[],
): void {
  for (const element of parsed.zoteroElements) parsed.root.removeChild(element)
  chunks.forEach((chunk, index) => {
    const property = parsed.document.createElementNS(CUSTOM_PROPERTY_NS, 'property')
    property.setAttribute('fmtid', OFFICE_CUSTOM_PROPERTY_FMTID)
    property.setAttribute('pid', String(parsed.nextPid + index))
    property.setAttribute('name', chunk.name)
    const value = parsed.document.createElementNS(CUSTOM_VALUE_NS, 'vt:lpwstr')
    value.appendChild(parsed.document.createTextNode(chunk.value))
    property.appendChild(value)
    parsed.root.appendChild(property)
  })
}

function uniqueRelationshipIds(root: Element): Set<string> {
  const ids = new Set<string>()
  for (const relationship of exactElements(root, PACKAGE_REL_NS, 'Relationship')) {
    const id = relationship.getAttribute('Id') ?? ''
    if (id === '' || ids.has(id)) {
      fail(
        'DOCX_CUSTOM_RELATIONSHIP_DUPLICATE',
        `Package relationship Id ${JSON.stringify(id)} is blank or duplicated.`,
      )
    }
    ids.add(id)
  }
  return ids
}

interface RelationshipParse {
  readonly document: Document
  readonly root: Element
  readonly element?: Element
  readonly ids: Set<string>
}

function parseRelationships(archive: ZoteroPropertiesArchive): RelationshipParse {
  const document = parseXml(
    archive.read(ZOTERO_ROOT_RELATIONSHIPS_PART),
    ZOTERO_ROOT_RELATIONSHIPS_PART,
  )
  const root = requireRoot(
    document,
    PACKAGE_REL_NS,
    'Relationships',
    ZOTERO_ROOT_RELATIONSHIPS_PART,
  )
  const relationships = exactElements(root, PACKAGE_REL_NS, 'Relationship')
  if (relationships.length !== childElements(root).length) {
    fail('DOCX_CUSTOM_RELATIONSHIP_INVALID', '_rels/.rels contains an unexpected child element.')
  }
  const ids = uniqueRelationshipIds(root)
  const custom = relationships.filter(
    (element) => element.getAttribute('Type') === ZOTERO_CUSTOM_RELATIONSHIP_TYPE,
  )
  if (custom.length > 1) {
    fail(
      'DOCX_CUSTOM_RELATIONSHIP_DUPLICATE',
      'The package has duplicate custom-properties relationships.',
    )
  }
  const element = custom[0]
  if (
    element !== undefined &&
    (element.getAttribute('Target') !== ZOTERO_CUSTOM_PROPERTIES_PART ||
      element.hasAttribute('TargetMode'))
  ) {
    fail(
      'DOCX_CUSTOM_RELATIONSHIP_INVALID',
      'The custom-properties relationship must target docProps/custom.xml internally.',
    )
  }
  return { document, root, element, ids }
}

function nextRelationshipId(ids: ReadonlySet<string>): string {
  let index = 1
  while (ids.has(`rIdZotero${index}`)) index += 1
  return `rIdZotero${index}`
}

interface ContentTypeParse {
  readonly document: Document
  readonly root: Element
  readonly element?: Element
}

function parseContentTypes(archive: ZoteroPropertiesArchive): ContentTypeParse {
  const document = parseXml(archive.read(ZOTERO_CONTENT_TYPES_PART), ZOTERO_CONTENT_TYPES_PART)
  const root = requireRoot(document, CONTENT_TYPES_NS, 'Types', ZOTERO_CONTENT_TYPES_PART)
  const overrides = exactElements(root, CONTENT_TYPES_NS, 'Override')
  const targets = overrides.filter(
    (element) => element.getAttribute('PartName') === '/docProps/custom.xml',
  )
  if (targets.length > 1) {
    fail(
      'DOCX_CUSTOM_CONTENT_TYPE_DUPLICATE',
      'The package has duplicate custom-properties content-type overrides.',
    )
  }
  const element = targets[0]
  if (
    element !== undefined &&
    element.getAttribute('ContentType') !== ZOTERO_CUSTOM_PROPERTIES_CONTENT_TYPE
  ) {
    fail(
      'DOCX_CUSTOM_CONTENT_TYPE_INVALID',
      'The custom-properties content-type override has the wrong type.',
    )
  }
  return { document, root, element }
}

function relationshipFacts(element: Element): ZoteroPackageRelationshipFacts {
  return {
    relationshipId: element.getAttribute('Id') ?? '',
    target: 'docProps/custom.xml',
    type: ZOTERO_CUSTOM_RELATIONSHIP_TYPE,
  }
}

const CONTENT_TYPE_FACTS: ZoteroContentTypeFacts = {
  partName: '/docProps/custom.xml',
  contentType: ZOTERO_CUSTOM_PROPERTIES_CONTENT_TYPE,
}

/**
 * Replace Zotero preference chunks and ensure the singleton root relationship
 * and content-type override. Existing Zotero chunks are validated before any
 * mutation; unrelated custom properties, PIDs, and value elements survive.
 */
export function updateZoteroCustomProperties(
  archive: ZoteroPropertiesArchive,
  options: CreateZoteroDocumentPreferencesOptions,
): UpdateZoteroPropertiesResult {
  const preferences = createZoteroDocumentPreferences(options)
  const chunks = serializeZoteroPreferenceChunks(preferences)
  const customCreated = !archive.has(ZOTERO_CUSTOM_PROPERTIES_PART)
  const relationships = parseRelationships(archive)
  const contentTypes = parseContentTypes(archive)
  const custom = customCreated
    ? newCustomPropertiesDocument(relationships.document)
    : parseCustomProperties(archive.read(ZOTERO_CUSTOM_PROPERTIES_PART))

  appendPreferenceProperties(custom, chunks)
  if (customCreated) archive.add(ZOTERO_CUSTOM_PROPERTIES_PART, serializeXml(custom.document))
  else archive.replace(ZOTERO_CUSTOM_PROPERTIES_PART, serializeXml(custom.document))

  let relationship = relationships.element
  const relationshipCreated = relationship === undefined
  if (relationship === undefined) {
    relationship = relationships.document.createElementNS(PACKAGE_REL_NS, 'Relationship')
    relationship.setAttribute('Id', nextRelationshipId(relationships.ids))
    relationship.setAttribute('Type', ZOTERO_CUSTOM_RELATIONSHIP_TYPE)
    relationship.setAttribute('Target', ZOTERO_CUSTOM_PROPERTIES_PART)
    relationships.root.appendChild(relationship)
    archive.replace(ZOTERO_ROOT_RELATIONSHIPS_PART, serializeXml(relationships.document))
  }

  let contentType = contentTypes.element
  const contentTypeCreated = contentType === undefined
  if (contentType === undefined) {
    contentType = contentTypes.document.createElementNS(CONTENT_TYPES_NS, 'Override')
    contentType.setAttribute('PartName', '/docProps/custom.xml')
    contentType.setAttribute('ContentType', ZOTERO_CUSTOM_PROPERTIES_CONTENT_TYPE)
    contentTypes.root.appendChild(contentType)
    archive.replace(ZOTERO_CONTENT_TYPES_PART, serializeXml(contentTypes.document))
  }

  return {
    preferences,
    chunks,
    relationship: relationshipFacts(relationship),
    contentType: CONTENT_TYPE_FACTS,
    customPropertiesCreated: customCreated,
    relationshipCreated,
    contentTypeCreated,
  }
}

/** Compatibility wrapper used by the DOCX package orchestrator. */
export function writeDocumentProperties(
  archive: ZoteroPropertiesArchive,
  options: CreateZoteroDocumentPreferencesOptions,
): UpdateZoteroPropertiesResult {
  return updateZoteroCustomProperties(archive, options)
}

/** Compatibility wrapper used by the independent DOCX probe. */
export function readDocumentProperties(
  archive: ZoteroPropertiesArchive,
): ZoteroDocumentPropertiesRead {
  const result = probeZoteroCustomProperties(archive)
  return { preferences: result.preferences, chunks: result.chunks, consistent: true }
}

/** Parse Zotero preference properties and prove both OPC declarations agree. */
export function probeZoteroCustomProperties(
  archive: ZoteroPropertiesArchive,
): ZoteroPropertiesProbe {
  if (!archive.has(ZOTERO_CUSTOM_PROPERTIES_PART)) {
    fail('DOCX_CUSTOM_PROPERTIES_INVALID', 'docProps/custom.xml is missing.')
  }
  const custom = parseCustomProperties(archive.read(ZOTERO_CUSTOM_PROPERTIES_PART))
  if (custom.chunks.length === 0) {
    fail('DOCX_CUSTOM_PROPERTY_SEQUENCE_INVALID', 'No ZOTERO_PREF_N properties were found.')
  }
  const relationships = parseRelationships(archive)
  if (relationships.element === undefined) {
    fail('DOCX_CUSTOM_RELATIONSHIP_INVALID', 'The custom-properties relationship is missing.')
  }
  const contentTypes = parseContentTypes(archive)
  if (contentTypes.element === undefined) {
    fail(
      'DOCX_CUSTOM_CONTENT_TYPE_INVALID',
      'The custom-properties content-type override is missing.',
    )
  }
  return {
    preferences: parseZoteroPreferenceChunks(custom.chunks),
    chunks: custom.chunks.slice().sort((a, b) => {
      const left = Number(a.name.slice('ZOTERO_PREF_'.length))
      const right = Number(b.name.slice('ZOTERO_PREF_'.length))
      return left - right
    }),
    relationship: relationshipFacts(relationships.element),
    contentType: CONTENT_TYPE_FACTS,
  }
}
