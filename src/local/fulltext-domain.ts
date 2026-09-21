/** Raw indexed-fulltext access for one Zotero item or attachment. */
import { asRecord } from '../json.js'
import { ZOTERO_NO_FULLTEXT, ZoteroError } from '../errors.js'
import { libraryPrefix, requireSupportedLocalRef } from '../refs.js'
import type { ZoteroHttpClient } from '../http-client.js'
import type { ZoteroFulltextResult, ZoteroObjectRef } from '../types.js'
import { resolveAttachmentKey } from './attachment-location.js'

export async function getFulltext(
  deps: { client: ZoteroHttpClient },
  ref: ZoteroObjectRef,
  signal?: AbortSignal,
): Promise<ZoteroFulltextResult> {
  const local = requireSupportedLocalRef(ref, ['item', 'attachment'])
  const attachmentKey = await resolveAttachmentKey(deps, local, signal)
  const prefix = libraryPrefix(local.library)
  let response: Awaited<ReturnType<ZoteroHttpClient['getJson']>>
  try {
    response = await deps.client.getJson<unknown>(
      `${prefix}/items/${attachmentKey}/fulltext`,
      undefined,
      { signal, serverId: local.serverId },
    )
  } catch (error) {
    throw new ZoteroError(
      `No indexed full text found for attachment ${attachmentKey}.`,
      ZOTERO_NO_FULLTEXT,
      { cause: error },
    )
  }
  const record = asRecord(response.json)
  const content = typeof record?.content === 'string' ? record.content : ''
  return {
    attachmentKey,
    ...(typeof record?.indexedPages === 'number' ? { indexedPages: record.indexedPages } : {}),
    ...(typeof record?.totalPages === 'number' ? { totalPages: record.totalPages } : {}),
    chars: content.length,
    content,
  }
}
