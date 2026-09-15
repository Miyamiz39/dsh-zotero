/** DOCX package orchestration: native-field finalization and independent probing. */

import { parseRef } from '../refs.js'
import type { ZoteroObjectRef } from '../types.js'
import type { ZoteroService } from '../service.js'
import { loadWordCitationCluster } from './citation-data.js'
import { createZoteroCitationInstruction, type ZoteroWordCitationItem } from './fields.js'
import type { ZoteroCitationMarker } from './markers.js'
import { OpcArchive } from './opc.js'
import { probeZoteroCustomProperties, updateZoteroCustomProperties } from './properties.js'
import {
  isUnsupportedWordStory,
  rewriteWordDocument,
  scanDocumentMarkers,
  scanUnsupportedWordStory,
  scanWordFields,
  type ZoteroFieldReplacement,
} from './wordml.js'

const DOCUMENT_PART = 'word/document.xml'

export interface FinalizeDocxOptions {
  readonly style: string
  readonly locale: string
  readonly legacyMarkers: boolean
  readonly maxArchiveBytes: number
}

export interface FinalizeDocxResult {
  readonly bytes: Uint8Array
  readonly citationCount: number
  readonly refs: readonly string[]
  readonly bibliographyAdded: boolean
  readonly warnings: readonly string[]
}

export interface ProbeDocxResult {
  readonly valid: boolean
  readonly citationCount: number
  readonly bibliographyCount: number
  readonly hasDocumentPreferences: boolean
  readonly unresolvedMarkers: number
  readonly warnings: readonly string[]
}

/** Transform a bounded DOCX into a package carrying native Zotero fields. */
export async function finalizeDocxBytes(
  bytes: Uint8Array,
  service: ZoteroService,
  options: FinalizeDocxOptions,
  signal?: AbortSignal,
): Promise<FinalizeDocxResult> {
  const archive = OpcArchive.open(bytes, { maxArchiveBytes: options.maxArchiveBytes })
  requireCoreDocxParts(archive)
  const unsupported = unsupportedMarkers(archive, options.legacyMarkers)
  if (unsupported.length > 0) {
    throw new Error(
      `Citation markers occur in unsupported Word stories: ${unsupported.join(', ')}.`,
    )
  }
  const documentBytes = archive.read(DOCUMENT_PART)
  const markers = scanDocumentMarkers(documentBytes, { allowLegacy: options.legacyMarkers })
  if (markers.length === 0) throw new Error('No supported Zotero citation markers found.')
  assertOneLibraryAndIdentity(markers)
  const status = await service.status(signal)
  if (status.zoteroVersion === undefined || status.zoteroVersion.trim() === '') {
    throw new Error('Zotero did not report its version; document preferences were not fabricated.')
  }

  const replacements: ZoteroFieldReplacement[] = []
  for (const marker of markers) {
    if (signal?.aborted === true) throw signal.reason
    const refs = marker.refs.map((value) => parseRef(value))
    const cluster = await loadWordCitationCluster(
      service,
      refs,
      options.style,
      options.locale,
      signal,
    )
    replacements.push({
      marker,
      instruction: createZoteroCitationInstruction({
        formattedCitation: cluster.formattedText,
        citationItems: cluster.items as readonly ZoteroWordCitationItem[],
      }),
      resultText: cluster.formattedText,
    })
  }
  const rewritten = rewriteWordDocument(documentBytes, replacements, {
    allowLegacy: options.legacyMarkers,
    addBibliography: true,
  })
  archive.replace(DOCUMENT_PART, rewritten.bytes)
  updateZoteroCustomProperties(archive, {
    style: options.style,
    locale: options.locale,
    zoteroVersion: status.zoteroVersion,
  })
  const output = archive.generate()
  if (output.length > options.maxArchiveBytes) {
    throw new Error(`Generated DOCX exceeds the ${options.maxArchiveBytes}-byte limit.`)
  }
  const probe = probeDocxBytes(output, {
    legacyMarkers: options.legacyMarkers,
    maxArchiveBytes: options.maxArchiveBytes,
  })
  if (!probe.valid || probe.citationCount !== replacements.length) {
    throw new Error('Generated DOCX failed independent Zotero field validation.')
  }
  return {
    bytes: output,
    citationCount: replacements.length,
    refs: Array.from(new Set(markers.flatMap((marker) => marker.refs))),
    bibliographyAdded: rewritten.bibliographyAdded,
    warnings: probe.warnings,
  }
}

/** Offline, independent structural probe. It never contacts Zotero. */
export function probeDocxBytes(
  bytes: Uint8Array,
  options: { readonly legacyMarkers: boolean; readonly maxArchiveBytes: number },
): ProbeDocxResult {
  const archive = OpcArchive.open(bytes, { maxArchiveBytes: options.maxArchiveBytes })
  requireCoreDocxParts(archive)
  const documentBytes = archive.read(DOCUMENT_PART)
  const markers = scanDocumentMarkers(documentBytes, { allowLegacy: options.legacyMarkers })
  const fields = scanWordFields(documentBytes)
  const properties = probeZoteroCustomProperties(archive)
  const unsupported = unsupportedMarkers(archive, options.legacyMarkers)
  const unresolvedMarkers = markers.length + unsupported.length
  return {
    valid:
      fields.citationFields.length > 0 &&
      fields.bibliographyFields.length === 1 &&
      fields.duplicateCitationIds.length === 0 &&
      properties.preferences.dataVersion === 3 &&
      unresolvedMarkers === 0,
    citationCount: fields.citationFields.length,
    bibliographyCount: fields.bibliographyFields.length,
    hasDocumentPreferences: true,
    unresolvedMarkers,
    warnings: unsupported.map((name) => `Unresolved marker in unsupported story ${name}`),
  }
}

function unsupportedMarkers(archive: OpcArchive, legacyMarkers: boolean): string[] {
  return archive
    .names()
    .filter((name) => isUnsupportedWordStory(name))
    .flatMap((name) =>
      scanUnsupportedWordStory(name, archive.read(name), { allowLegacy: legacyMarkers }).map(
        (finding) => `${finding.part}#paragraph-${finding.paragraph}`,
      ),
    )
}

function requireCoreDocxParts(archive: OpcArchive): void {
  for (const name of ['[Content_Types].xml', '_rels/.rels', DOCUMENT_PART]) {
    if (!archive.has(name)) throw new Error(`DOCX is missing ${name}.`)
  }
}

function assertOneLibraryAndIdentity(markers: readonly ZoteroCitationMarker[]): void {
  const refs = markers.flatMap((marker) => marker.refs).map((value) => parseRef(value))
  const libraries = new Set(refs.map((ref) => `${ref.library.type}/${ref.library.id}`))
  if (libraries.size !== 1) throw new Error('One finalized DOCX must cite a single Zotero library.')
  const ids = new Set(refs.map((ref: ZoteroObjectRef) => ref.serverId).filter(Boolean))
  if (ids.size > 1) throw new Error('One finalized DOCX must cite a single Zotero instance.')
}
