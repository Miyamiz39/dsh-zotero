/**
 * The `zotero_changes` domain: baseline version readings and `?since=` diffs
 * over the versions-format endpoints, with tombstones from /deleted. A
 * resource this Zotero build cannot serve degrades to absence — and is named
 * in `unsupported` — instead of failing the whole read.
 *
 * Every versions resource is read unbounded (no `limit`): the local API
 * returns the whole changed set for such a request, which is what lets the
 * version the response reports be a cursor a caller may resume from, while
 * `maxChangesResults` only shortens the listing the model sees. `toVersion`
 * is reported only when the whole range was actually read and the library
 * version did not move during the fan-out; otherwise the caller must not
 * advance from this result.
 * @module dsh-zotero/local/changes-domain
 */

import type { ZoteroHttpClient } from '../http-client.js'
import { ZOTERO_NOT_FOUND } from '../errors.js'
import { asRecord, isObjectKey } from '../json.js'
import { libraryPrefix, PERSONAL_LIBRARY } from '../refs.js'
import type { LocalApiLimits } from './limits.js'
import { ZoteroError } from '../errors.js'
import type {
  ZoteroChangesInclude,
  ZoteroChangesRequest,
  ZoteroChangedObject,
  ZoteroChangesResult,
  ZoteroChangesTotals,
} from '../types.js'

/** Every resource kind this domain can read, in request order (also gates `unsupported`). */
const ZOTERO_CHANGES_INCLUDES: readonly ZoteroChangesInclude[] = [
  'items',
  'collections',
  'savedSearches',
  'fulltext',
  'deleted',
]

/**
 * The kinds a diff covers when the caller names none. `fulltext` is left out
 * on purpose: `/fulltext?since=` filters on `fulltextItems.version`, a counter
 * of its own (`fulltext_<libraryID>`, see Zotero's `fulltext.js`), not on the
 * library version — live-checked at Zotero 10.0.2-beta.9, where `since=0` and
 * `since=<library version>` return the same rows, and the endpoint sends no
 * version header of its own. Such rows cannot be part of a library-version
 * delta, so they are only read when a caller asks for them explicitly.
 */
const DEFAULT_CHANGES_INCLUDES: readonly ZoteroChangesInclude[] = [
  'items',
  'collections',
  'savedSearches',
  'deleted',
]

/** A non-negative integer header reading, or undefined when absent or malformed. */
function numericHeader(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name)?.trim()
  return raw !== undefined && raw !== '' && /^\d+$/.test(raw) ? Number(raw) : undefined
}

/**
 * Diff the library against a local transaction version. Zotero 10+ versions
 * are local transactions: any edit, sync, or local-API write advances them,
 * so `?since=` answers "what changed here" without the cloud and without a
 * background watcher. Without `since` this is a baseline reading — just the
 * current version for the next call to diff from. `format=versions`
 * responses are key→version maps; `/deleted` returns tombstone key lists.
 * Each listing is capped at `maxChangesResults` entries with its true count
 * in `totals` and an honest `truncated` flag.
 */
export async function changes(
  deps: { client: ZoteroHttpClient; limits: LocalApiLimits },
  request: ZoteroChangesRequest,
  signal?: AbortSignal,
): Promise<ZoteroChangesResult> {
  const library = request.library ?? PERSONAL_LIBRARY
  const prefix = libraryPrefix(library)
  const cap = deps.limits.maxChangesResults
  const include = request.include ?? new Set(DEFAULT_CHANGES_INCLUDES)
  let serverId: string | undefined

  /**
   * A diff resource this Zotero build does not serve (some local-API
   * versions 404 on `/deleted`, for example) contributes nothing instead
   * of failing the whole read — degradation matches the plugin's honest-
   * absence contract everywhere else, and the caller is told which kinds
   * the diff could not cover.
   */
  const optional = async <T>(run: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await run()
    } catch (error) {
      if (error instanceof ZoteroError && error.code === ZOTERO_NOT_FOUND) return undefined
      throw error
    }
  }

  /**
   * The library's current transaction version, read before any resource so
   * the fan-out can be pinned to one snapshot. Only the headers matter, so
   * the probe itself asks for a single row.
   */
  const probeVersion = async (): Promise<number | undefined> => {
    const params = new URLSearchParams()
    params.set('limit', '1')
    const response = await deps.client.get(`${prefix}/items/top`, params, { signal })
    serverId = serverId ?? response.headers.get('zotero-server-id') ?? undefined
    return numericHeader(response.headers, 'last-modified-version')
  }

  if (request.since === undefined) {
    // A library that cannot serve versioned items at all has no changes
    // story; the baseline reading reports an unknown version.
    const version = await optional(probeVersion)
    return {
      library,
      ...(serverId !== undefined ? { serverId } : {}),
      ...(version !== undefined ? { toVersion: version } : {}),
      changed: {},
    }
  }

  // The version this diff is pinned to. Every array resource reports the
  // library's *current* version in `Last-Modified-Version` — not the newest
  // version on its page — so any other reading means a write landed while this
  // call was reading, and the range cannot be attributed to one version.
  const snapshot = await optional(probeVersion)
  let complete = snapshot !== undefined
  let libraryChanged = false

  /**
   * Read one versions resource whole. `Total-Results` counts the matched
   * objects before any listing cap, so a map carrying fewer keys than the
   * header promises means this build capped the response and the read is not
   * the whole range. Without the header the unbounded request is trusted to be
   * whole — a short page is complete, and nothing more is knowable here.
   */
  const readVersions = async (
    path: string,
  ): Promise<{
    entries: ZoteroChangedObject[]
    total: number
    complete: boolean
    version?: number
  }> => {
    const params = new URLSearchParams()
    params.set('since', String(request.since))
    params.set('format', 'versions')
    // Deliberately no `limit`: the local API answers an unbounded request in
    // full, and a capped read could not be resumed (the API has no version
    // upper bound, and the reported version would already sit past the rows
    // the cap hid).
    const { json, headers } = await deps.client.getJson<unknown>(path, params, { signal })
    serverId = serverId ?? headers.get('zotero-server-id') ?? undefined
    const map = asRecord(json)
    const rawKeys = map === undefined ? [] : Object.keys(map)
    const entries = Object.entries(map ?? {})
      .filter(([key, version]) => isObjectKey(key) && typeof version === 'number')
      .map(([key, version]) => ({ key, version: version as number }))
      .sort((a, b) => b.version - a.version || a.key.localeCompare(b.key))
    const headerTotal = numericHeader(headers, 'total-results')
    const version = numericHeader(headers, 'last-modified-version')
    return {
      entries,
      total: headerTotal ?? rawKeys.length,
      // A non-map body read as "no changes" would be a silent lie, so it counts
      // as an incomplete read instead.
      complete: map !== undefined && (headerTotal === undefined || headerTotal === rawKeys.length),
      ...(version !== undefined ? { version } : {}),
    }
  }

  const changed: {
    items?: ZoteroChangedObject[]
    collections?: ZoteroChangedObject[]
    savedSearches?: ZoteroChangedObject[]
    fulltextAttachments?: ZoteroChangedObject[]
  } = {}
  const totals: ZoteroChangesTotals = {}
  const unsupported: ZoteroChangesInclude[] = []
  let truncated = false

  /**
   * Read one versions resource into the result: record its true count, fold
   * its completeness and snapshot reading into the call's verdict, and return
   * the capped listing for the model.
   */
  const readKind = async (
    kind: { include: ZoteroChangesInclude; key: keyof ZoteroChangesTotals },
    path: string,
  ): Promise<ZoteroChangedObject[] | undefined> => {
    const result = await optional(() => readVersions(path))
    if (result === undefined) {
      unsupported.push(kind.include)
      return undefined
    }
    if (snapshot !== undefined && result.version !== undefined && result.version !== snapshot) {
      // A write landed while this call was reading, so no single version
      // describes the range this result reports.
      libraryChanged = true
      complete = false
    }
    complete = complete && result.complete
    totals[kind.key] = result.total
    if (result.entries.length > cap) truncated = true
    return result.entries.slice(0, cap)
  }

  if (include.has('items')) {
    const entries = await readKind({ include: 'items', key: 'items' }, `${prefix}/items/top`)
    if (entries !== undefined) changed.items = entries
  }
  if (include.has('collections')) {
    const entries = await readKind(
      { include: 'collections', key: 'collections' },
      `${prefix}/collections`,
    )
    if (entries !== undefined) changed.collections = entries
  }
  if (include.has('savedSearches')) {
    const entries = await readKind(
      { include: 'savedSearches', key: 'savedSearches' },
      `${prefix}/searches`,
    )
    if (entries !== undefined) changed.savedSearches = entries
  }
  if (include.has('fulltext')) {
    // The index listing, read only when asked for: unbounded and unversioned,
    // it answers in the full-text counter's own namespace, so its rows are a
    // listing for this library version rather than a delta on it.
    const entries = await readKind(
      { include: 'fulltext', key: 'fulltextAttachments' },
      `${prefix}/fulltext`,
    )
    if (entries !== undefined) changed.fulltextAttachments = entries
  }

  // When the tombstone read succeeds, all three lists exist together
  // (possibly empty) — matching the wire contract's required keys. The
  // endpoint pages nothing and carries no version of its own, so it can never
  // make the read incomplete: it only shortens what is listed below.
  const deleted: { items: string[]; collections: string[]; savedSearches: string[] } = {
    items: [],
    collections: [],
    savedSearches: [],
  }
  if (include.has('deleted')) {
    const payload = await optional(async () => {
      const params = new URLSearchParams()
      params.set('since', String(request.since))
      return await deps.client.getJson<unknown>(`${prefix}/deleted`, params, {
        signal,
      })
    })
    if (payload === undefined) {
      unsupported.push('deleted')
    } else {
      serverId = serverId ?? payload.headers.get('zotero-server-id') ?? undefined
      const record = asRecord(payload.json)
      const keysOf = (field: string): string[] =>
        (Array.isArray(record?.[field]) ? (record![field] as unknown[]) : []).filter(
          (key): key is string => typeof key === 'string' && isObjectKey(key),
        )
      const served = {
        items: keysOf('items'),
        collections: keysOf('collections'),
        savedSearches: keysOf('searches'),
      }
      deleted.items = served.items.slice(0, cap)
      deleted.collections = served.collections.slice(0, cap)
      deleted.savedSearches = served.savedSearches.slice(0, cap)
      totals.deletedItems = served.items.length
      totals.deletedCollections = served.collections.length
      totals.deletedSavedSearches = served.savedSearches.length
      for (const keys of Object.values(served)) {
        if (keys.length > cap) truncated = true
      }
    }
  }

  const served = Object.keys(totals).length > 0
  return {
    library,
    ...(serverId !== undefined ? { serverId } : {}),
    fromVersion: request.since,
    // The cursor is the snapshot reading itself: every served resource was
    // read whole (or the call would not be complete), so advancing to it
    // covers the entire range this result reports.
    ...(complete && snapshot !== undefined ? { toVersion: snapshot } : {}),
    ...(libraryChanged ? { libraryChanged } : {}),
    changed,
    ...(deleted.items.length > 0 ||
    deleted.collections.length > 0 ||
    deleted.savedSearches.length > 0
      ? { deleted }
      : {}),
    ...(served ? { totals } : {}),
    ...(unsupported.length > 0 ? { unsupported } : {}),
    ...(truncated ? { truncated } : {}),
  }
}
