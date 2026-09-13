/**
 * The `changes()` provider contract: baseline readings (which mint the
 * cursor), `?since=` diffs over the unbound versions-format reads, the item
 * space in the API's own three reads (top-level items, child objects, the
 * trash), the fulltext listing, tombstones from `/deleted`, display caps with
 * true counts in `totals`, and the cursor rules — a cursor is handed back only
 * when the whole range was read under one version on one instance, and it
 * carries the instance and library it belongs to.
 * @module tests/provider/changes
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type LocalApiProvider } from '../../src/local/provider.js'
import { MockZotero, type RouteHandler } from '../helpers/mock-zotero.js'
import {
  setupProvider,
  teardownProvider,
  zoteroError,
  type ProviderHarness,
} from '../helpers/provider-harness.js'
import type { ZoteroChangesCursor } from '../../src/types.js'

let mock: MockZotero
let provider: LocalApiProvider
let harness: ProviderHarness

beforeEach(async () => {
  harness = await setupProvider({ maxChangesResults: 3 })
  mock = harness.mock
  provider = harness.provider
})

afterEach(async () => {
  await teardownProvider(harness)
})

/** The cursor the fixtures start from: instance S1, personal library, version 42. */
function at(version: number, serverId = 'S1'): ZoteroChangesCursor {
  return { serverId, library: { type: 'user', id: 0 }, version }
}

/** A key→version map shaped like `format=versions` responses. */
function versionMap(entries: [string, number][]): Record<string, number> {
  return Object.fromEntries(entries)
}

/** `count` synthetic 8-character keys at ascending versions. */
function changedKeys(count: number): [string, number][] {
  return Array.from({ length: count }, (_, index) => [
    `KEY${String(index + 1).padStart(5, '0')}`,
    index + 1,
  ])
}

type Endpoint = 'live' | 'top' | 'trash'

/** How one endpoint's diff answer behaves; the probe on `/items/top` is separate. */
type DiffBehaviour = 'ok' | 'not-found' | 'error'

interface ItemsFixture {
  /** Changed top-level items (`/items/top`). */
  readonly top?: Record<string, number>
  /**
   * Changed child objects — notes, attachments, annotations. Only `/items`
   * reports them, which is exactly the difference the diff splits on.
   */
  readonly children?: Record<string, number>
  /** Changed items in the trash (`/items/trash`). */
  readonly trash?: Record<string, number>
  readonly prefix?: string
  /** The version the probe and (by default) the diff reads report. */
  readonly version?: string
  /** The version the diff reads alone report, for a snapshot that moved. */
  readonly diffVersion?: string
  /** `Total-Results` overrides; defaults to each body's key count. */
  readonly total?: Partial<Record<Endpoint, string>>
  /** Probe shape: versioned 200 (default), 200 without the header, or 404. */
  readonly probe?: 'ok' | 'unversioned' | 'not-found'
  /** Per-endpoint diff answers; defaults to a 200 map for all three. */
  readonly diff?: Partial<Record<Endpoint, DiffBehaviour>>
  /** Raw bodies that replace a computed map, for the shape tests. */
  readonly body?: Partial<Record<Endpoint, unknown>>
  /** The instance the responses claim, for a build that ignores the request header. */
  readonly serverId?: string
}

/**
 * Serve the item space the way the API partitions it: `/items` (live items,
 * child objects included), `/items/top` (their top-level subset) and
 * `/items/trash`. `/items/top` also carries the pre-read version probe
 * (`?limit=1`, headers only), so the cursor claim depends on the two reporting
 * one version.
 */
function routeItems(options: ItemsFixture = {}): void {
  const prefix = options.prefix ?? '/api/users/0'
  const version = options.version ?? '50'
  const serverId = options.serverId ?? 'S1'
  const top = options.top ?? {}
  const bodies: Record<Endpoint, Record<string, number>> = {
    live: { ...top, ...(options.children ?? {}) },
    top,
    trash: options.trash ?? {},
  }
  const answer = (
    endpoint: Endpoint,
    helpers: Parameters<RouteHandler>[2],
    search: URLSearchParams,
  ): void => {
    if (endpoint === 'top' && search.get('limit') === '1') {
      if (options.probe === 'not-found') {
        helpers.raw(404, { 'Content-Type': 'text/plain' }, 'Not found')
        return
      }
      helpers.json([], {
        'Zotero-Server-ID': serverId,
        ...(options.probe === 'unversioned' ? {} : { 'Last-Modified-Version': version }),
      })
      return
    }
    expect(search.get('since')).toBeDefined()
    expect(search.get('format')).toBe('versions')
    // The diff is read unbounded: a page cap would report a version that
    // already sits past the rows it hid, which is the bug this pins.
    expect(search.get('limit')).toBeNull()
    const behaviour = options.diff?.[endpoint] ?? 'ok'
    if (behaviour === 'not-found') {
      helpers.raw(404, { 'Content-Type': 'text/plain' }, 'Not found')
      return
    }
    if (behaviour === 'error') {
      helpers.raw(500, { 'Content-Type': 'text/plain' }, 'boom')
      return
    }
    const body = options.body?.[endpoint] ?? bodies[endpoint]
    const total =
      options.total?.[endpoint] ??
      String(Array.isArray(body) ? body.length : Object.keys(body ?? {}).length)
    helpers.json(body, {
      'Zotero-Server-ID': serverId,
      'Last-Modified-Version': options.diffVersion ?? version,
      'Total-Results': total,
    })
  }
  mock.route('GET', `${prefix}/items`, (req, res, helpers, search) =>
    answer('live', helpers, search),
  )
  mock.route('GET', `${prefix}/items/top`, (req, res, helpers, search) =>
    answer('top', helpers, search),
  )
  mock.route('GET', `${prefix}/items/trash`, (req, res, helpers, search) =>
    answer('trash', helpers, search),
  )
}

/** Serve one non-items versions resource; `headers` carries what the build sends. */
function routeVersions(
  path: string,
  body: Record<string, number>,
  headers: Record<string, string> = {},
): void {
  mock.route('GET', path, (req, res, helpers, search) => {
    expect(search.get('since')).toBeDefined()
    expect(search.get('format')).toBe('versions')
    expect(search.get('limit')).toBeNull()
    helpers.json(body, { 'Zotero-Server-ID': 'S1', ...headers })
  })
}

/** A tombstone payload with all four documented lists. */
function tombstones(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { items: [], collections: [], searches: [], tags: [], ...overrides }
}

/** Serve `/deleted` with a well-formed payload. */
function routeTombstones(overrides: Record<string, unknown> = {}): void {
  mock.route('GET', '/api/users/0/deleted', (req, res, helpers, search) => {
    expect(search.get('since')).toBeDefined()
    helpers.json(tombstones(overrides))
  })
}

/** The diff requests only: the probe is an `/items/top?limit=1` read. */
function diffRequests(): { pathname: string }[] {
  return mock.requests.filter((request) => request.search.get('limit') !== '1')
}

describe('changes', () => {
  it('takes a baseline reading and mints the cursor the next call diffs from', async () => {
    mock.route('GET', '/api/users/0/items/top', (req, res, helpers, search) => {
      expect(search.get('limit')).toBe('1')
      helpers.json([], {
        'Last-Modified-Version': '42',
        'Zotero-Server-ID': 'S1',
      })
    })
    const result = await provider.changes({})
    expect(result.cursor).toEqual({ serverId: 'S1', library: { type: 'user', id: 0 }, version: 42 })
    expect(result.serverId).toBe('S1')
    expect(result.fromVersion).toBeUndefined()
    expect(result.versionUnavailable).toBeUndefined()
    expect(result.changed).toEqual({})
    // A baseline reads exactly one endpoint.
    expect(mock.requests).toHaveLength(1)
  })

  it('mints no cursor when the build names no instance to pin it to', async () => {
    // A version without a database identity is exactly the cursor that could
    // be handed to another instance later, so it is not offered at all.
    mock.route('GET', '/api/users/0/items/top', (req, res, helpers) =>
      helpers.json([], { 'Last-Modified-Version': '42' }),
    )
    const result = await provider.changes({})
    expect(result.cursor).toBeUndefined()
    expect(result.serverId).toBeUndefined()
    // The version was read, so this is not a versionless build.
    expect(result.versionUnavailable).toBeUndefined()
  })

  it('reports a build with no library version as cursor-less and version-unavailable', async () => {
    mock.route('GET', '/api/users/0/items/top', (req, res, helpers) =>
      helpers.json([], { 'Zotero-Server-ID': 'S1' }),
    )
    const result = await provider.changes({})
    expect(result.cursor).toBeUndefined()
    expect(result.versionUnavailable).toBe(true)
    expect(result.changed).toEqual({})
  })

  it('reports a baseline on a build that serves no item read as version-unavailable', async () => {
    mock.route('GET', '/api/users/0/items/top', (req, res, helpers) =>
      helpers.raw(404, { 'Content-Type': 'text/plain' }, 'Not found'),
    )
    const result = await provider.changes({})
    expect(result.cursor).toBeUndefined()
    expect(result.serverId).toBeUndefined()
    expect(result.versionUnavailable).toBe(true)
    expect(result.changed).toEqual({})
  })

  it('diffs every resource whole and hands back a cursor for this instance', async () => {
    routeItems({
      top: versionMap([
        ['ABCD1234', 44],
        ['BBBB1234', 47],
      ]),
      version: '50',
    })
    routeVersions('/api/users/0/collections', versionMap([['COLL1234', 45]]), {
      'Last-Modified-Version': '50',
    })
    routeVersions('/api/users/0/searches', versionMap([]), { 'Last-Modified-Version': '50' })
    // The real fulltext endpoint sends neither version nor total headers.
    routeVersions('/api/users/0/fulltext', versionMap([['WXYZ6789', 46]]))
    routeTombstones({ items: ['EEEE0001'], tags: ['obsolete'] })

    const result = await provider.changes({
      since: at(42),
      include: new Set(['items', 'collections', 'savedSearches', 'fulltext', 'deleted']),
    })
    expect(mock.requests[0]?.search.get('limit')).toBe('1')
    // The claim travels on every request, so the server can refuse a foreign
    // database itself rather than trusting the client to notice.
    for (const request of mock.requests) {
      expect(request.headers['zotero-server-id']).toBe('S1')
    }
    expect(result.fromVersion).toBe(42)
    expect(result.cursor).toEqual({ serverId: 'S1', library: { type: 'user', id: 0 }, version: 50 })
    expect(result.libraryChanged).toBeUndefined()
    expect(result.changed.items?.map((entry) => entry.key)).toEqual(['BBBB1234', 'ABCD1234'])
    expect(result.changed.items?.[0]).toEqual({ key: 'BBBB1234', version: 47 })
    expect(result.changed.collections?.map((entry) => entry.key)).toEqual(['COLL1234'])
    expect(result.changed.savedSearches).toEqual([])
    expect(result.changed.fulltextAttachments?.map((entry) => entry.key)).toEqual(['WXYZ6789'])
    expect(result.deleted).toEqual({
      items: ['EEEE0001'],
      collections: [],
      savedSearches: [],
      tags: ['obsolete'],
    })
    expect(result.totals).toEqual({
      items: 2,
      collections: 1,
      savedSearches: 0,
      fulltextAttachments: 1,
      deletedItems: 1,
      deletedCollections: 0,
      deletedSavedSearches: 0,
      deletedTags: 1,
    })
    expect(result.unobservable).toBeUndefined()
    expect(result.truncated).toBeUndefined()
  })

  it('leaves the full-text listing out unless it is named', async () => {
    // `/fulltext?since=` filters on the index's own version counter, so its
    // rows belong to no library version and cannot be part of a default diff.
    routeItems({ top: versionMap([['ABCD1234', 44]]) })
    routeVersions('/api/users/0/collections', versionMap([]), { 'Last-Modified-Version': '50' })
    routeVersions('/api/users/0/searches', versionMap([]), { 'Last-Modified-Version': '50' })
    routeTombstones()
    const result = await provider.changes({ since: at(42) })
    expect(diffRequests().map((request) => request.pathname)).not.toContain('/api/users/0/fulltext')
    expect(result.changed.fulltextAttachments).toBeUndefined()
    expect(result.totals?.fulltextAttachments).toBeUndefined()
    expect(result.cursor?.version).toBe(50)
  })

  it('caps each listing but keeps the cursor and the true totals', async () => {
    routeItems({ top: versionMap(changedKeys(9)), total: { top: '9' } })
    const result = await provider.changes({ since: at(42), include: new Set(['items']) })
    expect(result.changed.items).toHaveLength(3)
    expect(result.totals?.items).toBe(9)
    expect(result.truncated).toBe(true)
    // The cap is a display concern only: the read was whole, so the cursor stands.
    expect(result.cursor?.version).toBe(50)
  })

  it('withholds the cursor when the build capped the read', async () => {
    // The response carries fewer rows than the total it reports — a build that
    // imposed its own page cap. The rows it hid sit below the version it
    // reports, so that version must not be resumable. `truncated` stays absent:
    // it speaks about the listing, and this listing is exactly the rows read.
    routeItems({ top: versionMap(changedKeys(3)), total: { top: '9' } })
    const result = await provider.changes({ since: at(42), include: new Set(['items']) })
    expect(result.changed.items).toHaveLength(3)
    expect(result.totals?.items).toBe(9)
    expect(result.truncated).toBeUndefined()
    expect(result.cursor).toBeUndefined()
    expect(result.libraryChanged).toBeUndefined()
  })

  it('withholds the cursor when the library moved while the diff was read', async () => {
    routeItems({ top: versionMap([['ABCD1234', 44]]), version: '42', diffVersion: '50' })
    const result = await provider.changes({ since: at(42), include: new Set(['items']) })
    expect(result.changed.items?.map((entry) => entry.key)).toEqual(['ABCD1234'])
    expect(result.cursor).toBeUndefined()
    expect(result.libraryChanged).toBe(true)
  })

  it('reads the diff but withholds the cursor when the probe reports no version', async () => {
    routeItems({ top: versionMap([['ABCD1234', 44]]), probe: 'unversioned' })
    const result = await provider.changes({ since: at(42), include: new Set(['items']) })
    expect(result.changed.items).toHaveLength(1)
    expect(result.cursor).toBeUndefined()
    expect(result.versionUnavailable).toBe(true)
    expect(result.libraryChanged).toBeUndefined()
  })

  it('trusts an unbounded read when the build sends no Total-Results', async () => {
    // Local-API builds may omit the header on the versions format. Without it,
    // a whole read cannot be distinguished from a capped one, so the unbounded
    // request is trusted rather than reported as incomplete.
    const body = versionMap(changedKeys(3))
    mock.route('GET', '/api/users/0/items/top', (req, res, helpers, search) => {
      if (search.get('limit') === '1') {
        helpers.json([], { 'Last-Modified-Version': '50' })
        return
      }
      expect(search.get('limit')).toBeNull()
      helpers.json(body, { 'Last-Modified-Version': '50' })
    })
    mock.route('GET', '/api/users/0/items', (req, res, helpers) =>
      helpers.json({}, { 'Last-Modified-Version': '50' }),
    )
    mock.route('GET', '/api/users/0/items/trash', (req, res, helpers) =>
      helpers.json({}, { 'Last-Modified-Version': '50' }),
    )
    routeTombstones()
    const result = await provider.changes({ since: at(42), include: new Set(['items', 'deleted']) })
    expect(result.cursor?.version).toBe(50)
    expect(result.totals?.items).toBe(3)
    expect(result.truncated).toBeUndefined()
    // Served but empty tombstones are a finding, not a gap: the lists are
    // present and empty, and the counts say the read happened.
    expect(result.deleted).toEqual({ items: [], collections: [], savedSearches: [], tags: [] })
    expect(result.totals?.deletedItems).toBe(0)
  })

  it('keeps the claimed instance when the reads name none', async () => {
    // Not every build stamps its responses; a claim does not need them to
    // stand, it only needs them not to contradict it.
    for (const path of [
      '/api/users/0/items',
      '/api/users/0/items/top',
      '/api/users/0/items/trash',
    ]) {
      mock.route('GET', path, (req, res, helpers, search) => {
        helpers.json(search.get('limit') === '1' ? [] : { ABCD1234: 44 }, {
          'Last-Modified-Version': '50',
          'Total-Results': '1',
        })
      })
    }
    const result = await provider.changes({ since: at(42), include: new Set(['items']) })
    expect(result.cursor).toEqual({ serverId: 'S1', library: { type: 'user', id: 0 }, version: 50 })
    expect(result.changed.items).toEqual([{ key: 'ABCD1234', version: 44 }])
  })

  it('reports a body that is not a version map as unreadable, never as no changes', async () => {
    // An array body, a string body, a key→string map: none of them can be read
    // as a changelist, and "0 changed" is the one thing they must not become.
    routeItems({ body: { top: [{ key: 'ABCD1234', version: 44 }] } })
    const result = await provider.changes({ since: at(42), include: new Set(['items']) })
    expect(result.changed.items).toBeUndefined()
    expect(result.totals).toBeUndefined()
    expect(result.unobservable).toEqual([{ kind: 'items', reason: 'unreadable' }])
    expect(result.cursor).toBeUndefined()
  })

  it('reports a map whose values are not version numbers as unreadable', async () => {
    routeItems({ body: { top: { ABCD1234: '44' } }, total: { top: '1' } })
    const result = await provider.changes({ since: at(42), include: new Set(['items']) })
    expect(result.unobservable).toEqual([{ kind: 'items', reason: 'unreadable' }])
    expect(result.changed.items).toBeUndefined()
    expect(result.cursor).toBeUndefined()
  })

  it('treats malformed keys as unreadable rather than dropping the row', async () => {
    routeItems({ body: { top: { 'bad-key!': 44 } }, total: { top: '1' } })
    const result = await provider.changes({ since: at(42), include: new Set(['items']) })
    expect(result.unobservable).toEqual([{ kind: 'items', reason: 'unreadable' }])
    expect(result.totals).toBeUndefined()
  })

  it('caps the tombstone listing and reports its true count', async () => {
    routeItems({})
    routeTombstones({ items: ['DELE0001', 'DELE0002', 'DELE0003', 'DELE0004'] })
    const result = await provider.changes({ since: at(42), include: new Set(['items', 'deleted']) })
    expect(result.deleted?.items).toEqual(['DELE0001', 'DELE0002', 'DELE0003'])
    expect(result.totals?.deletedItems).toBe(4)
    expect(result.truncated).toBe(true)
    expect(result.cursor?.version).toBe(50)
  })

  it('counts tombstone kinds it does not model instead of dropping them', async () => {
    routeItems({})
    // A documented kind with a non-array value would be unreadable, but these
    // are kinds this domain does not interpret: arrays are counted, anything
    // else carries no countable entries.
    routeTombstones({ settings: ['alpha', 'beta'], other: 'not-a-list' })
    const result = await provider.changes({ since: at(42), include: new Set(['items', 'deleted']) })
    expect(result.deleted).toEqual({ items: [], collections: [], savedSearches: [], tags: [] })
    expect(result.totals?.deletedOther).toBe(2)
    expect(result.cursor?.version).toBe(50)
  })

  it('honors include subsets and skips their endpoints', async () => {
    routeItems({})
    routeVersions('/api/users/0/collections', versionMap([['COLL1234', 44]]), {
      'Last-Modified-Version': '50',
    })
    const result = await provider.changes({
      since: at(10),
      include: new Set(['collections']),
    })
    expect(result.changed.collections?.map((entry) => entry.key)).toEqual(['COLL1234'])
    expect(result.changed.items).toBeUndefined()
    const paths = diffRequests().map((request) => request.pathname)
    expect(paths).toEqual(['/api/users/0/collections'])
  })

  it('diffs a group library under its own prefix and pins the cursor to it', async () => {
    routeItems({
      top: versionMap([['ABCD1234', 7]]),
      prefix: '/api/groups/42',
      version: '9',
      serverId: 'S2',
    })
    const result = await provider.changes({
      library: { type: 'group', id: 42 },
      since: { serverId: 'S2', library: { type: 'group', id: 42 }, version: 3 },
      include: new Set(['items']),
    })
    expect(result.library).toEqual({ type: 'group', id: 42 })
    expect(result.cursor).toEqual({
      serverId: 'S2',
      library: { type: 'group', id: 42 },
      version: 9,
    })
    expect(result.changed.items?.[0]?.key).toBe('ABCD1234')
  })

  it('names an endpoint this build does not serve, with that reason, and keeps the cursor', async () => {
    // /deleted 404s on some local-API versions (Zotero 10.0.2-beta.9 has no
    // such route). The rest of the diff answers and says what it could not
    // cover; the cursor stands, because removals were never observable here.
    routeItems({ top: versionMap([['ABCD1234', 44]]) })
    const result = await provider.changes({ since: at(42), include: new Set(['items', 'deleted']) })
    expect(result.changed.items?.map((entry) => entry.key)).toEqual(['ABCD1234'])
    expect(result.deleted).toBeUndefined()
    expect(result.unobservable).toEqual([{ kind: 'deleted', reason: 'not-served' }])
    expect(result.cursor?.version).toBe(50)
    expect(result.truncated).toBeUndefined()
  })

  it('names a range older than the build keeps, with that reason, and keeps the cursor', async () => {
    // A 409 on a versioned read is "the delete log does not go back that far"
    // (Zotero's own sync client reads it that way). Removals in that range are
    // gone; re-baselining covers them from here, so the cursor still stands.
    routeItems({})
    mock.route('GET', '/api/users/0/deleted', (req, res, helpers) =>
      helpers.raw(409, { 'Content-Type': 'text/plain' }, 'Conflict'),
    )
    const result = await provider.changes({ since: at(1), include: new Set(['items', 'deleted']) })
    expect(result.unobservable).toEqual([{ kind: 'deleted', reason: 'range-not-covered' }])
    expect(result.deleted).toBeUndefined()
    expect(result.cursor?.version).toBe(50)
  })

  it('reports an unreadable tombstone payload as unobservable and withholds the cursor', async () => {
    routeItems({})
    mock.route('GET', '/api/users/0/deleted', (req, res, helpers) =>
      helpers.json({ items: 'not-a-list', collections: [], searches: [], tags: [] }),
    )
    const result = await provider.changes({ since: at(42), include: new Set(['items', 'deleted']) })
    expect(result.unobservable).toEqual([{ kind: 'deleted', reason: 'unreadable' }])
    expect(result.deleted).toBeUndefined()
    expect(result.totals?.deletedItems).toBeUndefined()
    // The rows exist and this call failed to read them: advancing would step
    // over them, so no cursor.
    expect(result.cursor).toBeUndefined()
  })

  it('reports a tombstone body that is not an object as unreadable', async () => {
    routeItems({})
    mock.route('GET', '/api/users/0/deleted', (req, res, helpers) => helpers.json(['DELE0001']))
    const result = await provider.changes({ since: at(42), include: new Set(['items', 'deleted']) })
    expect(result.unobservable).toEqual([{ kind: 'deleted', reason: 'unreadable' }])
    expect(result.deleted).toBeUndefined()
    expect(result.cursor).toBeUndefined()
  })

  it('reports a missing tombstone list as an empty one, the way Zotero reads its own payload', async () => {
    routeItems({})
    mock.route('GET', '/api/users/0/deleted', (req, res, helpers) =>
      helpers.json({ items: ['DELE0001'] }),
    )
    const result = await provider.changes({ since: at(42), include: new Set(['items', 'deleted']) })
    expect(result.deleted).toEqual({
      items: ['DELE0001'],
      collections: [],
      savedSearches: [],
      tags: [],
    })
    expect(result.totals?.deletedCollections).toBe(0)
    expect(result.totals?.deletedTags).toBe(0)
  })

  it('reports a versionless library as an empty, cursor-less diff', async () => {
    routeItems({
      probe: 'not-found',
      diff: { live: 'not-found', top: 'not-found', trash: 'not-found' },
    })
    const result = await provider.changes({ since: at(42), include: new Set(['items']) })
    expect(result.cursor).toBeUndefined()
    expect(result.changed.items).toBeUndefined()
    expect(result.unobservable).toEqual([{ kind: 'items', reason: 'not-served' }])
    expect(result.totals).toBeUndefined()
    expect(result.versionUnavailable).toBe(true)
  })

  it('names every resource a build serves none of, each once', async () => {
    for (const path of [
      '/api/users/0/items',
      '/api/users/0/items/top',
      '/api/users/0/items/trash',
      '/api/users/0/collections',
      '/api/users/0/searches',
      '/api/users/0/fulltext',
      '/api/users/0/deleted',
    ]) {
      mock.route('GET', path, (req, res, helpers) =>
        helpers.raw(404, { 'Content-Type': 'text/plain' }, 'Not found'),
      )
    }
    const result = await provider.changes({
      since: at(42),
      include: new Set(['items', 'collections', 'savedSearches', 'fulltext', 'deleted']),
    })
    expect(result.changed).toEqual({})
    expect(result.unobservable).toEqual([
      { kind: 'items', reason: 'not-served' },
      { kind: 'collections', reason: 'not-served' },
      { kind: 'savedSearches', reason: 'not-served' },
      { kind: 'fulltext', reason: 'not-served' },
      { kind: 'deleted', reason: 'not-served' },
    ])
    expect(result.totals).toBeUndefined()
    expect(result.cursor).toBeUndefined()
    expect(result.versionUnavailable).toBe(true)
  })

  it('fails loud when a resource faults for a reason other than absence', async () => {
    // Only a 404 (and a 409 range refusal) degrades to `unobservable`; a server
    // fault must never be reported as "this resource did not change".
    routeItems({ top: versionMap([['ABCD1234', 44]]), diff: { top: 'error' } })
    await zoteroError(
      provider.changes({ since: at(42), include: new Set(['items']) }),
      'ZOTERO_UNEXPECTED',
      'HTTP 500',
    )
  })

  it('breaks version ties by key so a listing has one order', async () => {
    routeItems({
      top: versionMap([
        ['BBBB1234', 44],
        ['AAAA1234', 44],
      ]),
    })
    const result = await provider.changes({ since: at(10), include: new Set(['items']) })
    expect(result.changed.items?.map((entry) => entry.key)).toEqual(['AAAA1234', 'BBBB1234'])
  })

  it('refuses a cursor that belongs to another library before any request', async () => {
    // Version counters are per library, so a cursor from user/0 says nothing
    // about group/42 — and no response would reveal the mix-up.
    await zoteroError(
      provider.changes({ library: { type: 'group', id: 42 }, since: at(42) }),
      'ZOTERO_INVALID_ARGUMENT',
      'belongs to user/0',
    )
    expect(mock.requests).toHaveLength(0)
  })

  it('fails loud when a response names an instance other than the claim', async () => {
    // The request carries the claim, so a real build rejects a foreign
    // database with 412. If one answers anyway, the result would mix two
    // databases — that is a fault, not a diff.
    routeItems({ top: versionMap([['ABCD1234', 44]]), serverId: 'S2' })
    await zoteroError(
      provider.changes({ since: at(42), include: new Set(['items']) }),
      'ZOTERO_SERVER_MISMATCH',
    )
  })
})
