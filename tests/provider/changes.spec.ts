/**
 * The `changes()` provider contract: baseline readings (which mint the
 * cursor), `?since=` diffs over the unbound versions-format reads, the
 * fulltext listing, tombstones from `/deleted`, display caps with true counts
 * in `totals`, and the cursor rules — a cursor is handed back only when the
 * whole range was read under one version on one instance, and it carries the
 * instance and library it belongs to.
 * @module tests/provider/changes
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type LocalApiProvider } from '../../src/local/provider.js'
import { MockZotero } from '../helpers/mock-zotero.js'
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

/**
 * Serve the items path, which carries both the pre-read version probe
 * (`?limit=1`, headers only) and the items diff itself: the cursor claim
 * depends on the two reporting one version.
 */
function routeItemsTop(
  diffBody: Record<string, unknown>,
  options: {
    prefix?: string
    /** The version the probe and (by default) the diff page report. */
    version?: string
    /** The version the diff page alone reports, for a snapshot that moved. */
    diffVersion?: string
    /** `Total-Results` for the diff page; defaults to the body key count. */
    total?: string
    /** Probe shape: versioned 200 (default), 200 without the header, or 404. */
    probe?: 'ok' | 'unversioned' | 'not-found'
    /** Diff page shape: a 200 map (default), a 404 like a versionless build, or a hard fault. */
    diff?: 'ok' | 'not-found' | 'error'
    /** The instance the responses claim, for a build that ignores the request header. */
    serverId?: string
  } = {},
): void {
  const prefix = options.prefix ?? '/api/users/0'
  const version = options.version ?? '50'
  const serverId = options.serverId ?? 'S1'
  mock.route('GET', `${prefix}/items/top`, (req, res, helpers, search) => {
    if (search.get('limit') === '1') {
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
    if (options.diff === 'not-found') {
      helpers.raw(404, { 'Content-Type': 'text/plain' }, 'Not found')
      return
    }
    if (options.diff === 'error') {
      helpers.raw(500, { 'Content-Type': 'text/plain' }, 'boom')
      return
    }
    helpers.json(diffBody, {
      'Zotero-Server-ID': serverId,
      'Last-Modified-Version': options.diffVersion ?? version,
      'Total-Results': options.total ?? String(Object.keys(diffBody).length),
    })
  })
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
  })

  it('diffs every resource whole and hands back a cursor for this instance', async () => {
    routeItemsTop(
      versionMap([
        ['ABCD1234', 44],
        ['BBBB1234', 47],
      ]),
      { version: '50' },
    )
    routeVersions('/api/users/0/collections', versionMap([['COLL1234', 45]]), {
      'Last-Modified-Version': '50',
    })
    routeVersions('/api/users/0/searches', versionMap([]), { 'Last-Modified-Version': '50' })
    // The real fulltext endpoint sends neither version nor total headers.
    routeVersions('/api/users/0/fulltext', versionMap([['WXYZ6789', 46]]))
    mock.route('GET', '/api/users/0/deleted', (req, res, helpers, search) => {
      expect(search.get('since')).toBe('42')
      // A non-array tombstone section is skipped by the key filter.
      helpers.json({ items: ['EEEE0001'], collections: [], searches: 'garbage' })
    })

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
    expect(result.deleted?.items).toEqual(['EEEE0001'])
    expect(result.totals).toEqual({
      items: 2,
      collections: 1,
      savedSearches: 0,
      fulltextAttachments: 1,
      deletedItems: 1,
      deletedCollections: 0,
      deletedSavedSearches: 0,
    })
    expect(result.unsupported).toBeUndefined()
    expect(result.truncated).toBeUndefined()
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
    routeItemsTop(versionMap([['ABCD1234', 44]]), { serverId: 'S2' })
    await zoteroError(
      provider.changes({ since: at(42), include: new Set(['items']) }),
      'ZOTERO_SERVER_MISMATCH',
    )
  })

  it('leaves the full-text listing out unless it is named', async () => {
    // `/fulltext?since=` filters on the index's own version counter, so its
    // rows belong to no library version and cannot be part of a default diff.
    routeItemsTop(versionMap([['ABCD1234', 44]]))
    routeVersions('/api/users/0/collections', versionMap([]), { 'Last-Modified-Version': '50' })
    routeVersions('/api/users/0/searches', versionMap([]), { 'Last-Modified-Version': '50' })
    mock.route('GET', '/api/users/0/deleted', (req, res, helpers) =>
      helpers.json({ items: [], collections: [], searches: [] }),
    )
    const result = await provider.changes({ since: at(42) })
    expect(diffRequests().map((request) => request.pathname)).not.toContain('/api/users/0/fulltext')
    expect(result.changed.fulltextAttachments).toBeUndefined()
    expect(result.totals?.fulltextAttachments).toBeUndefined()
    expect(result.cursor?.version).toBe(50)
  })

  it('caps the listing but keeps the cursor and the true totals', async () => {
    routeItemsTop(versionMap(changedKeys(9)), { total: '9' })
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
    routeItemsTop(versionMap(changedKeys(3)), { total: '9' })
    const result = await provider.changes({ since: at(42), include: new Set(['items']) })
    expect(result.changed.items).toHaveLength(3)
    expect(result.totals?.items).toBe(9)
    expect(result.truncated).toBeUndefined()
    expect(result.cursor).toBeUndefined()
    expect(result.libraryChanged).toBeUndefined()
  })

  it('withholds the cursor when the library moved while the diff was read', async () => {
    routeItemsTop(versionMap([['ABCD1234', 44]]), { version: '42', diffVersion: '50' })
    const result = await provider.changes({ since: at(42), include: new Set(['items']) })
    expect(result.changed.items?.map((entry) => entry.key)).toEqual(['ABCD1234'])
    expect(result.cursor).toBeUndefined()
    expect(result.libraryChanged).toBe(true)
  })

  it('withholds the cursor when the probe cannot read a library version', async () => {
    routeItemsTop(versionMap([['ABCD1234', 44]]), { probe: 'unversioned' })
    const result = await provider.changes({ since: at(42), include: new Set(['items']) })
    expect(result.changed.items).toHaveLength(1)
    expect(result.cursor).toBeUndefined()
    expect(result.libraryChanged).toBeUndefined()
    // The range was read, but nothing can be pinned to a version — and the
    // result names the cause instead of leaving it to the reader.
    expect(result.versionUnavailable).toBe(true)
  })

  it('still reports the diff when only the probe degrades', async () => {
    routeItemsTop(versionMap([['ABCD1234', 44]]), { probe: 'not-found' })
    const result = await provider.changes({ since: at(42), include: new Set(['items']) })
    expect(result.changed.items).toHaveLength(1)
    expect(result.cursor).toBeUndefined()
    expect(result.unsupported).toBeUndefined()
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
    mock.route('GET', '/api/users/0/deleted', (req, res, helpers) =>
      helpers.json({ items: [], collections: [], searches: [] }),
    )
    const result = await provider.changes({ since: at(42), include: new Set(['items', 'deleted']) })
    expect(result.cursor?.version).toBe(50)
    expect(result.totals?.items).toBe(3)
    expect(result.truncated).toBeUndefined()
    // Served but empty tombstones stay out of the listing while their count is reported.
    expect(result.deleted).toBeUndefined()
    expect(result.totals?.deletedItems).toBe(0)
  })

  it('keeps the claimed instance when the reads name none', async () => {
    // Not every build stamps its responses; a claim does not need them to
    // stand, it only needs them not to contradict it.
    mock.route('GET', '/api/users/0/items/top', (req, res, helpers, search) => {
      helpers.json(search.get('limit') === '1' ? [] : { ABCD1234: 44 }, {
        'Last-Modified-Version': '50',
        'Total-Results': '1',
      })
    })
    const result = await provider.changes({ since: at(42), include: new Set(['items']) })
    expect(result.cursor).toEqual({ serverId: 'S1', library: { type: 'user', id: 0 }, version: 50 })
  })

  it('treats a body that is not a version map as an unverified read', async () => {
    mock.route('GET', '/api/users/0/items/top', (req, res, helpers, search) => {
      if (search.get('limit') === '1') {
        helpers.json([], { 'Last-Modified-Version': '50' })
        return
      }
      helpers.json([{ key: 'ABCD1234', version: 44 }], { 'Last-Modified-Version': '50' })
    })
    const result = await provider.changes({ since: at(42), include: new Set(['items']) })
    expect(result.changed.items).toEqual([])
    expect(result.cursor).toBeUndefined()
    expect(result.totals?.items).toBe(0)
  })

  it('caps the tombstone listing and reports its true count', async () => {
    routeItemsTop(versionMap([]))
    mock.route('GET', '/api/users/0/deleted', (req, res, helpers) =>
      helpers.json({
        items: ['DELE0001', 'DELE0002', 'DELE0003', 'DELE0004'],
        collections: [],
        searches: [],
      }),
    )
    const result = await provider.changes({ since: at(42), include: new Set(['items', 'deleted']) })
    expect(result.deleted?.items).toEqual(['DELE0001', 'DELE0002', 'DELE0003'])
    expect(result.totals?.deletedItems).toBe(4)
    expect(result.truncated).toBe(true)
    expect(result.cursor?.version).toBe(50)
  })

  it('honors include subsets and skips their endpoints', async () => {
    routeItemsTop(versionMap([]))
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
    routeItemsTop(versionMap([['ABCD1234', 7]]), {
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

  it('omits malformed keys and non-numeric versions from version maps', async () => {
    routeItemsTop({ ABCD1234: 44, 'bad-key!': 5, SHORT: 'not-a-number' }, { total: '3' })
    const result = await provider.changes({ since: at(10), include: new Set(['items']) })
    expect(result.changed.items).toEqual([{ key: 'ABCD1234', version: 44 }])
    // The header counts the objects the server matched, before key shaping.
    expect(result.totals?.items).toBe(3)
    expect(result.cursor?.version).toBe(50)
  })

  it('names a resource this build does not serve instead of leaving it silent', async () => {
    // /deleted 404s on some local-API versions (Zotero 10.0.2-beta.9 has no
    // such route); the rest of the diff answers and says what it could not cover.
    routeItemsTop(versionMap([['ABCD1234', 44]]))
    const result = await provider.changes({ since: at(42), include: new Set(['items', 'deleted']) })
    expect(result.changed.items?.map((entry) => entry.key)).toEqual(['ABCD1234'])
    expect(result.deleted).toBeUndefined()
    expect(result.unsupported).toEqual(['deleted'])
    expect(result.cursor?.version).toBe(50)
    expect(result.truncated).toBeUndefined()
  })

  it('reports a versionless library as an empty, cursor-less diff', async () => {
    routeItemsTop({}, { probe: 'not-found', diff: 'not-found' })
    const result = await provider.changes({ since: at(42), include: new Set(['items']) })
    expect(result.cursor).toBeUndefined()
    expect(result.changed.items).toBeUndefined()
    expect(result.unsupported).toEqual(['items'])
    expect(result.totals).toBeUndefined()
  })

  it('names every resource a build serves none of', async () => {
    for (const path of [
      '/api/users/0/items/top',
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
    expect(result.unsupported).toEqual([
      'items',
      'collections',
      'savedSearches',
      'fulltext',
      'deleted',
    ])
    expect(result.totals).toBeUndefined()
    expect(result.cursor).toBeUndefined()
  })

  it('fails loud when a resource faults for a reason other than absence', async () => {
    // Only a 404 degrades to `unsupported`; a server fault must never be
    // reported as "this resource did not change".
    routeItemsTop(versionMap([['ABCD1234', 44]]), { diff: 'error' })
    await zoteroError(
      provider.changes({ since: at(42), include: new Set(['items']) }),
      'ZOTERO_UNEXPECTED',
      'HTTP 500',
    )
  })

  it('breaks version ties by key so a listing has one order', async () => {
    routeItemsTop(
      versionMap([
        ['BBBB1234', 44],
        ['AAAA1234', 44],
      ]),
      { total: '2' },
    )
    const result = await provider.changes({ since: at(10), include: new Set(['items']) })
    expect(result.changed.items?.map((entry) => entry.key)).toEqual(['AAAA1234', 'BBBB1234'])
  })

  it('reports a versionless library as an empty baseline reading', async () => {
    mock.route('GET', '/api/users/0/items/top', (req, res, helpers) =>
      helpers.raw(404, { 'Content-Type': 'text/plain' }, 'Not found'),
    )
    const result = await provider.changes({})
    expect(result.cursor).toBeUndefined()
    expect(result.changed).toEqual({})
    expect(result.versionUnavailable).toBe(true)
  })
})
