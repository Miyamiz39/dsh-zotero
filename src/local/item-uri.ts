/** Authoritative Zotero item URI lookup from one Local API item response. */

import type { ZoteroHttpClient } from '../http-client.js'
import { ZOTERO_UNEXPECTED, ZoteroError } from '../errors.js'
import { asRecord, asString, isObjectKey } from '../json.js'
import {
  formatRef,
  libraryPrefix,
  parseZoteroRelationUri,
  requireSupportedLocalRef,
} from '../refs.js'
import type { SupportedLocalLibrary, ZoteroObjectRef } from '../types.js'

/**
 * Read Zotero's own alternate item link and normalize it to the URI shape used
 * by word-processor integration fields. The real personal-library user id is
 * never inferred from local `user/0`; it must arrive in Zotero's response.
 */
export async function canonicalItemUri(
  client: ZoteroHttpClient,
  input: ZoteroObjectRef,
  signal?: AbortSignal,
): Promise<string> {
  const ref = requireSupportedLocalRef(input, ['item'])
  const prefix = libraryPrefix(ref.library as SupportedLocalLibrary)
  const { json } = await client.getJson<unknown>(`${prefix}/items/${ref.key}`, undefined, {
    signal,
    serverId: ref.serverId,
  })
  const record = asRecord(json)
  const responseKey = asString(record?.key) ?? asString(asRecord(record?.data)?.key)
  if (responseKey === undefined || !isObjectKey(responseKey) || responseKey !== ref.key) {
    throw new ZoteroError(
      `Zotero returned the wrong item while resolving ${formatRef(ref)} for a Word field.`,
      ZOTERO_UNEXPECTED,
    )
  }
  const alternate = asRecord(asRecord(record?.links)?.alternate)
  const href = asString(alternate?.href)
  const parsed = href === undefined ? null : parseZoteroRelationUri(href)
  if (parsed === null || parsed.key !== ref.key || !sameCanonicalLibrary(ref, parsed.library)) {
    throw new ZoteroError(
      `Zotero did not return an authoritative alternate item URI for ${formatRef(ref)}; the Word field was not created.`,
      ZOTERO_UNEXPECTED,
    )
  }
  const segment = parsed.library.type === 'group' ? 'groups' : 'users'
  return `http://zotero.org/${segment}/${parsed.library.id}/items/${parsed.key}`
}

function sameCanonicalLibrary(
  ref: ZoteroObjectRef,
  canonical: { readonly type: 'user' | 'group'; readonly id: number },
): boolean {
  if (ref.library.type === 'group') {
    return canonical.type === 'group' && canonical.id === ref.library.id
  }
  return canonical.type === 'user'
}
