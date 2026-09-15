/**
 * Pure DTO validation and serialization for Zotero Word citation,
 * bibliography, and document-preference fields. This module knows no OpenXML
 * DOM: callers place the returned instruction strings and custom properties.
 * @module dsh-zotero/docx/fields
 */

import { randomUUID } from 'node:crypto'

export const ZOTERO_CSL_CITATION_SCHEMA =
  'https://github.com/citation-style-language/schema/raw/master/csl-citation.json'
export const ZOTERO_BIBLIOGRAPHY_INSTRUCTION =
  'ADDIN ZOTERO_BIBL {"uncited":[],"omitted":[],"custom":[]} CSL_BIBLIOGRAPHY'
export const ZOTERO_DOCUMENT_DATA_VERSION = 3
export const ZOTERO_PREF_CHUNK_UTF16_LIMIT = 255

export type CslPrimitive = string | number | boolean | null
export type CslJsonValue =
  CslPrimitive | readonly CslJsonValue[] | { readonly [key: string]: CslJsonValue }
export type CslItemData = { readonly id: string | number; readonly type: string } & Readonly<
  Record<string, CslJsonValue>
>

export interface ZoteroWordCitationItem {
  readonly id: string | number
  readonly uris: readonly string[]
  readonly itemData: CslItemData
}

export interface ZoteroWordCitationProperties {
  readonly formattedCitation: string
  readonly plainCitation: string
  readonly noteIndex: number
}

export interface ZoteroWordCitationPayload {
  readonly citationID: string
  readonly properties: ZoteroWordCitationProperties
  readonly citationItems: readonly ZoteroWordCitationItem[]
  readonly schema: typeof ZOTERO_CSL_CITATION_SCHEMA
}

export interface CreateZoteroCitationOptions {
  readonly citationItems: readonly ZoteroWordCitationItem[]
  /** Zotero integration name; formattedCitation is the persisted properties key. */
  readonly formattedCitation?: string
  /** Package-orchestrator alias for formattedCitation. */
  readonly formattedText?: string
  readonly plainCitation?: string
  readonly noteIndex?: number
  /** Supply only for deterministic import/tests; callers must keep it document-unique. */
  readonly citationID?: string
}

export interface ZoteroDocumentPreferences {
  readonly dataVersion: 3
  readonly zoteroVersion: string
  readonly sessionID: string
  readonly style: {
    readonly styleID: string
    readonly locale: string
    readonly hasBibliography: true
    readonly bibliographyStyleHasBeenSet: true
  }
  readonly prefs: {
    readonly fieldType: 'Field'
    readonly automaticJournalAbbreviations: true
    readonly noteType: 0
  }
}

export interface CreateZoteroDocumentPreferencesOptions {
  readonly style: string
  readonly locale: string
  readonly zoteroVersion: string
  readonly sessionID?: string
}

export interface ZoteroPreferenceChunk {
  readonly name: `ZOTERO_PREF_${number}`
  readonly value: string
}

export type ZoteroFieldErrorCode =
  | 'DOCX_CITATION_INVALID'
  | 'DOCX_CITATION_INSTRUCTION_INVALID'
  | 'DOCX_BIBLIOGRAPHY_INSTRUCTION_INVALID'
  | 'DOCX_PREFS_INVALID'
  | 'DOCX_PREFS_CHUNKS_INVALID'

export class ZoteroFieldError extends Error {
  constructor(
    readonly code: ZoteroFieldErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ZoteroFieldError'
  }
}

function fail(code: ZoteroFieldErrorCode, message: string): never {
  throw new ZoteroFieldError(code, message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isJsonValue(value: unknown, ancestors = new Set<object>()): value is CslJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object') return false
  if (ancestors.has(value)) return false
  ancestors.add(value)
  const valid = Array.isArray(value)
    ? value.every((entry) => isJsonValue(entry, ancestors))
    : Object.getPrototypeOf(value) === Object.prototype &&
      Object.values(value).every((entry) => isJsonValue(entry, ancestors))
  ancestors.delete(value)
  return valid
}

const ZOTERO_ITEM_URI =
  /^https?:\/\/zotero\.org\/(users\/(\d+)|groups\/(\d+))\/items\/([A-Z0-9]{8})$/

/** True only for a canonical Zotero user/group item URI. */
export function isCanonicalZoteroItemUri(value: string): boolean {
  const match = ZOTERO_ITEM_URI.exec(value)
  if (match === null) return false
  const id = Number(match[2] ?? match[3])
  if (!Number.isSafeInteger(id)) return false
  return match[2] !== undefined ? id >= 0 : id > 0
}

/** Validate the embedded CSL item carried by a Word citation field. */
export function validateCslItemData(value: unknown): asserts value is CslItemData {
  if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail('DOCX_CITATION_INVALID', 'Citation itemData must be a plain CSL JSON object.')
  }
  if (
    (typeof value.id !== 'string' && typeof value.id !== 'number') ||
    (typeof value.id === 'string' && value.id === '') ||
    (typeof value.id === 'number' && !Number.isFinite(value.id))
  ) {
    fail('DOCX_CITATION_INVALID', 'Citation itemData must carry a finite string or number id.')
  }
  if (typeof value.type !== 'string' || value.type.trim() === '') {
    fail('DOCX_CITATION_INVALID', 'Citation itemData must carry a non-empty CSL type.')
  }
  if (!isJsonValue(value)) {
    fail('DOCX_CITATION_INVALID', 'Citation itemData must contain only finite JSON values.')
  }
}

function validateCitationItem(value: unknown): asserts value is ZoteroWordCitationItem {
  if (!isRecord(value)) fail('DOCX_CITATION_INVALID', 'Each citation item must be an object.')
  if (
    (typeof value.id !== 'string' && typeof value.id !== 'number') ||
    (typeof value.id === 'string' && value.id === '') ||
    (typeof value.id === 'number' && !Number.isFinite(value.id))
  ) {
    fail('DOCX_CITATION_INVALID', 'Each citation item must carry a finite string or number id.')
  }
  if (!Array.isArray(value.uris) || value.uris.length === 0) {
    fail(
      'DOCX_CITATION_INVALID',
      'Each citation item must carry at least one canonical Zotero URI.',
    )
  }
  const uris = value.uris
  if (
    uris.some((uri) => typeof uri !== 'string' || !isCanonicalZoteroItemUri(uri)) ||
    new Set(uris).size !== uris.length
  ) {
    fail(
      'DOCX_CITATION_INVALID',
      'Citation item URIs must be unique canonical http(s) Zotero user/group item URIs.',
    )
  }
  validateCslItemData(value.itemData)
  if (value.itemData.id !== value.id) {
    fail('DOCX_CITATION_INVALID', 'Citation item id must equal embedded itemData.id.')
  }
}

/** Validate a complete Zotero CSL citation payload without coercion. */
export function validateZoteroCitationPayload(
  value: unknown,
): asserts value is ZoteroWordCitationPayload {
  if (!isRecord(value)) fail('DOCX_CITATION_INVALID', 'Citation payload must be an object.')
  if (typeof value.citationID !== 'string' || value.citationID.trim() === '') {
    fail('DOCX_CITATION_INVALID', 'Citation payload must carry a non-empty citationID.')
  }
  if (value.schema !== ZOTERO_CSL_CITATION_SCHEMA) {
    fail('DOCX_CITATION_INVALID', 'Citation payload carries an unsupported CSL citation schema.')
  }
  const properties = value.properties
  if (
    !isRecord(properties) ||
    typeof properties.formattedCitation !== 'string' ||
    typeof properties.plainCitation !== 'string' ||
    !Number.isSafeInteger(properties.noteIndex) ||
    (properties.noteIndex as number) < 0
  ) {
    fail(
      'DOCX_CITATION_INVALID',
      'Citation properties require formattedCitation, plainCitation, and a non-negative noteIndex.',
    )
  }
  if (!Array.isArray(value.citationItems) || value.citationItems.length === 0) {
    fail('DOCX_CITATION_INVALID', 'Citation payload must carry at least one citation item.')
  }
  value.citationItems.forEach(validateCitationItem)
}

/** Build a validated citation payload with a fresh document-unique ID by default. */
export function createZoteroCitationPayload(
  options: CreateZoteroCitationOptions,
): ZoteroWordCitationPayload {
  const formattedCitation = options.formattedCitation ?? options.formattedText
  if (formattedCitation === undefined) {
    fail('DOCX_CITATION_INVALID', 'Citation options require formattedCitation or formattedText.')
  }
  const payload: ZoteroWordCitationPayload = {
    citationID: options.citationID ?? randomUUID().replaceAll('-', ''),
    properties: {
      formattedCitation,
      plainCitation: options.plainCitation ?? formattedCitation,
      noteIndex: options.noteIndex ?? 0,
    },
    citationItems: options.citationItems,
    schema: ZOTERO_CSL_CITATION_SCHEMA,
  }
  validateZoteroCitationPayload(payload)
  return payload
}

/** Build and serialize one citation instruction in a single pure call. */
export function createZoteroCitationInstruction(options: CreateZoteroCitationOptions): string {
  return serializeZoteroCitationInstruction(createZoteroCitationPayload(options))
}

/** Serialize exactly one `ADDIN ZOTERO_ITEM CSL_CITATION` Word instruction. */
export function serializeZoteroCitationInstruction(payload: ZoteroWordCitationPayload): string {
  validateZoteroCitationPayload(payload)
  return `ADDIN ZOTERO_ITEM CSL_CITATION ${JSON.stringify(payload)}`
}

/** Parse and validate one exact Zotero citation instruction. */
export function parseZoteroCitationInstruction(instruction: string): ZoteroWordCitationPayload {
  const prefix = 'ADDIN ZOTERO_ITEM CSL_CITATION '
  if (!instruction.startsWith(prefix)) {
    fail('DOCX_CITATION_INSTRUCTION_INVALID', 'Not a Zotero CSL citation instruction.')
  }
  let value: unknown
  try {
    value = JSON.parse(instruction.slice(prefix.length))
  } catch (error) {
    throw new ZoteroFieldError(
      'DOCX_CITATION_INSTRUCTION_INVALID',
      `Zotero citation instruction contains invalid JSON: ${error instanceof Error ? error.message : String(error)}.`,
    )
  }
  validateZoteroCitationPayload(value)
  return value
}

/** Serialize the one canonical empty Zotero bibliography instruction. */
export function serializeZoteroBibliographyInstruction(): string {
  return ZOTERO_BIBLIOGRAPHY_INSTRUCTION
}

/** Accept only the exact canonical empty Zotero bibliography instruction. */
export function parseZoteroBibliographyInstruction(instruction: string): {
  readonly uncited: readonly []
  readonly omitted: readonly []
  readonly custom: readonly []
} {
  if (instruction !== ZOTERO_BIBLIOGRAPHY_INSTRUCTION) {
    fail(
      'DOCX_BIBLIOGRAPHY_INSTRUCTION_INVALID',
      'Not the canonical empty Zotero CSL bibliography instruction.',
    )
  }
  return { uncited: [], omitted: [], custom: [] }
}

function requireNonEmpty(name: string, value: string): string {
  if (value.trim() === '') fail('DOCX_PREFS_INVALID', `${name} must not be blank.`)
  return value
}

function styleUrl(style: string): string {
  const value = requireNonEmpty('style', style.trim())
  if (/^https?:\/\//.test(value)) {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      return fail('DOCX_PREFS_INVALID', 'style must be a valid http(s) URL or style id.')
    }
    if (url.username !== '' || url.password !== '' || url.hash !== '') {
      fail('DOCX_PREFS_INVALID', 'style URL must not contain credentials or a fragment.')
    }
    return url.toString()
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    fail('DOCX_PREFS_INVALID', 'style id contains unsupported characters.')
  }
  return `http://www.zotero.org/styles/${value}`
}

function nextSessionID(): string {
  return randomUUID().replaceAll('-', '').slice(0, 16)
}

/** Build current Zotero XML-v3 document preferences. */
export function createZoteroDocumentPreferences(
  options: CreateZoteroDocumentPreferencesOptions,
): ZoteroDocumentPreferences {
  const preferences: ZoteroDocumentPreferences = {
    dataVersion: 3,
    zoteroVersion: requireNonEmpty('zoteroVersion', options.zoteroVersion),
    sessionID: requireNonEmpty('sessionID', options.sessionID ?? nextSessionID()),
    style: {
      styleID: styleUrl(options.style),
      locale: requireNonEmpty('locale', options.locale),
      hasBibliography: true,
      bibliographyStyleHasBeenSet: true,
    },
    prefs: {
      fieldType: 'Field',
      automaticJournalAbbreviations: true,
      noteType: 0,
    },
  }
  validateZoteroDocumentPreferences(preferences)
  return preferences
}

/** Validate the exact preferences subset emitted for a Word field document. */
export function validateZoteroDocumentPreferences(
  value: unknown,
): asserts value is ZoteroDocumentPreferences {
  if (!isRecord(value) || value.dataVersion !== 3) {
    fail('DOCX_PREFS_INVALID', 'Zotero document preferences must use XML data-version 3.')
  }
  if (
    typeof value.zoteroVersion !== 'string' ||
    value.zoteroVersion.trim() === '' ||
    typeof value.sessionID !== 'string' ||
    value.sessionID.trim() === ''
  ) {
    fail('DOCX_PREFS_INVALID', 'Zotero document preferences require version and session id.')
  }
  const style = value.style
  if (
    !isRecord(style) ||
    typeof style.styleID !== 'string' ||
    style.styleID.trim() === '' ||
    typeof style.locale !== 'string' ||
    style.locale.trim() === '' ||
    style.hasBibliography !== true ||
    style.bibliographyStyleHasBeenSet !== true
  ) {
    fail('DOCX_PREFS_INVALID', 'Zotero document style preferences are invalid.')
  }
  const prefs = value.prefs
  if (
    !isRecord(prefs) ||
    prefs.fieldType !== 'Field' ||
    prefs.automaticJournalAbbreviations !== true ||
    prefs.noteType !== 0
  ) {
    fail(
      'DOCX_PREFS_INVALID',
      'Zotero Word preferences require Field, abbreviations, and noteType 0.',
    )
  }
}

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function xmlUnescape(value: string): string {
  if (/&(?!(?:amp|lt|gt|quot|apos);)/.test(value)) {
    fail('DOCX_PREFS_INVALID', 'Zotero document preferences contain an unsupported XML entity.')
  }
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&gt;', '>')
    .replaceAll('&lt;', '<')
    .replaceAll('&amp;', '&')
}

/** Serialize preferences in Zotero's current XML data-version 3 format. */
export function serializeZoteroDocumentPreferences(preferences: ZoteroDocumentPreferences): string {
  validateZoteroDocumentPreferences(preferences)
  const style = preferences.style
  return (
    `<data data-version="3" zotero-version="${xmlEscape(preferences.zoteroVersion)}">` +
    `<session id="${xmlEscape(preferences.sessionID)}"/>` +
    `<style id="${xmlEscape(style.styleID)}" locale="${xmlEscape(style.locale)}" ` +
    'hasBibliography="1" bibliographyStyleHasBeenSet="1"/>' +
    '<prefs>' +
    '<pref name="fieldType" value="Field"/>' +
    '<pref name="automaticJournalAbbreviations" value="true"/>' +
    '<pref name="noteType" value="0"/>' +
    '</prefs></data>'
  )
}

function attributes(source: string): Record<string, string> {
  const found: Record<string, string> = {}
  const pattern = /([A-Za-z][A-Za-z0-9-]*)="([^"]*)"/g
  let cursor = 0
  for (const match of source.matchAll(pattern)) {
    if (match.index !== cursor || Object.hasOwn(found, match[1]!)) {
      fail('DOCX_PREFS_INVALID', 'Zotero document preferences contain malformed attributes.')
    }
    found[match[1]!] = xmlUnescape(match[2]!)
    cursor = match.index + match[0].length
    if (source[cursor] === ' ') cursor += 1
  }
  if (cursor !== source.length) {
    fail('DOCX_PREFS_INVALID', 'Zotero document preferences contain malformed attributes.')
  }
  return found
}

function exactKeys(record: Record<string, string>, keys: readonly string[]): boolean {
  const actual = Object.keys(record).sort()
  return (
    actual.length === keys.length &&
    keys
      .slice()
      .sort()
      .every((key, index) => key === actual[index])
  )
}

/** Parse the strict XML-v3 shape emitted by this module, without an XML DOM. */
export function parseZoteroDocumentPreferences(xml: string): ZoteroDocumentPreferences {
  if (/<!DOCTYPE|<!ENTITY|<\?|<!--|\u0000/i.test(xml)) {
    fail('DOCX_PREFS_INVALID', 'Zotero document preferences contain prohibited XML syntax.')
  }
  const match =
    /^<data ([^>]*)><session ([^>]*)\/><style ([^>]*)\/><prefs>(.*)<\/prefs><\/data>$/.exec(xml)
  if (match === null)
    fail('DOCX_PREFS_INVALID', 'Zotero document preferences XML has invalid structure.')
  const data = attributes(match[1]!)
  const session = attributes(match[2]!)
  const style = attributes(match[3]!)
  if (!exactKeys(data, ['data-version', 'zotero-version']) || data['data-version'] !== '3') {
    fail('DOCX_PREFS_INVALID', 'Zotero document preferences must declare data-version 3.')
  }
  if (!exactKeys(session, ['id'])) fail('DOCX_PREFS_INVALID', 'Zotero session element is invalid.')
  if (
    !exactKeys(style, ['id', 'locale', 'hasBibliography', 'bibliographyStyleHasBeenSet']) ||
    style.hasBibliography !== '1' ||
    style.bibliographyStyleHasBeenSet !== '1'
  ) {
    fail('DOCX_PREFS_INVALID', 'Zotero style element is invalid.')
  }
  const prefPattern = /<pref name="([^"]+)" value="([^"]*)"\/>/g
  const prefs: Record<string, string> = {}
  let cursor = 0
  for (const pref of match[4]!.matchAll(prefPattern)) {
    if (pref.index !== cursor || Object.hasOwn(prefs, pref[1]!)) {
      fail('DOCX_PREFS_INVALID', 'Zotero prefs contain malformed or duplicate entries.')
    }
    prefs[xmlUnescape(pref[1]!)] = xmlUnescape(pref[2]!)
    cursor = pref.index + pref[0].length
  }
  if (
    cursor !== match[4]!.length ||
    !exactKeys(prefs, ['fieldType', 'automaticJournalAbbreviations', 'noteType']) ||
    prefs.fieldType !== 'Field' ||
    prefs.automaticJournalAbbreviations !== 'true' ||
    prefs.noteType !== '0'
  ) {
    fail('DOCX_PREFS_INVALID', 'Zotero prefs are incomplete, unknown, or invalid.')
  }
  const value: ZoteroDocumentPreferences = {
    dataVersion: 3,
    zoteroVersion: data['zotero-version']!,
    sessionID: session.id!,
    style: {
      styleID: style.id!,
      locale: style.locale!,
      hasBibliography: true,
      bibliographyStyleHasBeenSet: true,
    },
    prefs: {
      fieldType: prefs.fieldType as 'Field',
      automaticJournalAbbreviations: true,
      noteType: Number(prefs.noteType) as 0,
    },
  }
  validateZoteroDocumentPreferences(value)
  return value
}

/** Split a string by UTF-16 units without splitting a surrogate pair. */
export function chunkUtf16(value: string, maxUnits = ZOTERO_PREF_CHUNK_UTF16_LIMIT): string[] {
  if (!Number.isSafeInteger(maxUnits) || maxUnits < 2 || maxUnits > 255) {
    fail(
      'DOCX_PREFS_CHUNKS_INVALID',
      'Preference chunk limit must be an integer from 2 through 255.',
    )
  }
  const chunks: string[] = []
  let chunk = ''
  for (const point of value) {
    if (chunk.length + point.length > maxUnits) {
      chunks.push(chunk)
      chunk = ''
    }
    chunk += point
  }
  if (chunk !== '' || chunks.length === 0) chunks.push(chunk)
  return chunks
}

/** Serialize XML preferences to contiguous `ZOTERO_PREF_N` custom properties. */
export function serializeZoteroPreferenceChunks(
  preferences: ZoteroDocumentPreferences,
): ZoteroPreferenceChunk[] {
  return chunkUtf16(serializeZoteroDocumentPreferences(preferences)).map((value, index) => ({
    name: `ZOTERO_PREF_${index + 1}`,
    value,
  }))
}

/** Reassemble and validate contiguous `ZOTERO_PREF_1..N` custom properties. */
export function parseZoteroPreferenceChunks(
  properties: readonly { readonly name: string; readonly value: string }[],
): ZoteroDocumentPreferences {
  if (properties.length === 0) {
    fail('DOCX_PREFS_CHUNKS_INVALID', 'No ZOTERO_PREF_N custom properties were provided.')
  }
  const numbered = properties.map((property) => {
    const match = /^ZOTERO_PREF_([1-9]\d*)$/.exec(property.name)
    if (match === null || property.value.length > ZOTERO_PREF_CHUNK_UTF16_LIMIT) {
      fail(
        'DOCX_PREFS_CHUNKS_INVALID',
        'Preference properties must be ZOTERO_PREF_1..N chunks of at most 255 UTF-16 units.',
      )
    }
    return { index: Number(match[1]), value: property.value }
  })
  numbered.sort((a, b) => a.index - b.index)
  numbered.forEach((chunk, index) => {
    if (!Number.isSafeInteger(chunk.index) || chunk.index !== index + 1) {
      fail(
        'DOCX_PREFS_CHUNKS_INVALID',
        'ZOTERO_PREF_N custom properties must be unique and contiguous from 1.',
      )
    }
    if (/^[\uDC00-\uDFFF]/.test(chunk.value) || /[\uD800-\uDBFF]$/.test(chunk.value)) {
      fail('DOCX_PREFS_CHUNKS_INVALID', 'A preference chunk splits a UTF-16 surrogate pair.')
    }
  })
  return parseZoteroDocumentPreferences(numbered.map((chunk) => chunk.value).join(''))
}
