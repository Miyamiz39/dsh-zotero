/**
 * The `changes()` provider contract: baseline readings (current version
 * only), `?since=` diffs over the unbound versions-format reads, the fulltext
 * delta, tombstones from `/deleted`, display caps with true counts in
 * `totals`, and the cursor rule — `toVersion` is reported only when the whole
 * range was read and the library version did not move while it read.
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
  } = {},
): void {
  const prefix = options.prefix ?? '/api/users/0'
  const version = options.version ?? '50'
  mock.route('GET', `${prefix}/items/top`, (req, res, helpers, search) => {
    if (search.get('limit') === '1') {
      if (options.probe === 'not-found') {
        helpers.raw(404, { 'Content-Type': 'text/plain' }, 'Not found')
        return
      }
      helpers.json([], {
        'Zotero-Server-ID': 'S1',
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
    helpers.json(body, headers)
  })
}

/** The diff requests only: the probe is an `/items/top?limit=1` read. */
function diffRequests(): { pathname: string }[] {
  return mock.requests.filter((request) => request.search.get('limit') !== '1')
}

describe('changes', () => {
  it('takes a baseline reading of the current library version without diffs', async () => {
    mock.route('GET', '/api/users/0/items/top', (req, res, helpers, search) => {
      expect(search.get('limit')).toBe('1')
      helpers.json([], {
        'Last-Modified-Version': '42',
        'Zotero-Server-ID': 'S1',
      })
    })
    const result = await provider.changes({})
    expect(result.toVersion).toBe(42)
    expect(result.serverId).toBe('S1')
    expect(result.fromVersion).toBeUndefined()
    expect(result.changed).toEqual({})
    // A baseline reads exactly one endpoint.
    expect(mock.requests).toHaveLength(1)
  })

  it('diffs every resource whole and reports the snapshot version as the cursor', async () => {
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
      since: 42,
      include: new Set(['items', 'collections', 'savedSearches', 'fulltext', 'deleted']),
    })
    expect(mock.requests[0]?.search.get('limit')).toBe('1')
    expect(result.fromVersion).toBe(42)
    expect(result.toVersion).toBe(50)
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

  it('leaves the full-text listing out unless it is named', async () => {
    // `/fulltext?since=` filters on the index's own version counter, so its
    // rows belong to no library version and cannot be part of a default diff.
    routeItemsTop(versionMap([['ABCD1234', 44]]))
    routeVersions('/api/users/0/collections', versionMap([]), { 'Last-Modified-Version': '50' })
    routeVersions('/api/users/0/searches', versionMap([]), { 'Last-Modified-Version': '50' })
    mock.route('GET', '/api/users/0/deleted', (req, res, helpers) =>
      helpers.json({ items: [], collections: [], searches: [] }),
    )
    const result = await provider.changes({ since: 42 })
    expect(diffRequests().map((request) => request.pathname)).not.toContain('/api/users/0/fulltext')
    expect(result.changed.fulltextAttachments).toBeUndefined()
    expect(result.totals?.fulltextAttachments).toBeUndefined()
    expect(result.toVersion).toBe(50)
  })

  it('caps the listing but keeps the cursor and the true totals', async () => {
    routeItemsTop(versionMap(changedKeys(9)), { total: '9' })
    const result = await provider.changes({ since: 42, include: new Set(['items']) })
    expect(result.changed.items).toHaveLength(3)
    expect(result.totals?.items).toBe(9)
    expect(result.truncated).toBe(true)
    // The cap is a display concern only: the read was whole, so the cursor stands.
    expect(result.toVersion).toBe(50)
  })

  it('withholds the cursor when the build capped the read', async () => {
    // The response carries fewer rows than the total it reports — a build that
    // imposed its own page cap. The rows it hid sit below the version it
    // reports, so that version must not be resumable. `truncated` stays absent:
    // it speaks about the listing, and this listing is exactly the rows read.
    routeItemsTop(versionMap(changedKeys(3)), { total: '9' })
    const result = await provider.changes({ since: 42, include: new Set(['items']) })
    expect(result.changed.items).toHaveLength(3)
    expect(result.totals?.items).toBe(9)
    expect(result.truncated).toBeUndefined()
    expect(result.toVersion).toBeUndefined()
    expect(result.libraryChanged).toBeUndefined()
  })

  it('withholds the cursor when the library moved while the diff was read', async () => {
    routeItemsTop(versionMap([['ABCD1234', 44]]), { version: '42', diffVersion: '50' })
    const result = await provider.changes({ since: 42, include: new Set(['items']) })
    expect(result.changed.items?.map((entry) => entry.key)).toEqual(['ABCD1234'])
    expect(result.toVersion).toBeUndefined()
    expect(result.libraryChanged).toBe(true)
  })

  it('withholds the cursor when the probe cannot read a library version', async () => {
    routeItemsTop(versionMap([['ABCD1234', 44]]), { probe: 'unversioned' })
    const result = await provider.changes({ since: 42, include: new Set(['items']) })
    expect(result.changed.items).toHaveLength(1)
    expect(result.toVersion).toBeUndefined()
    expect(result.libraryChanged).toBeUndefined()
  })

  it('still reports the diff when only the probe degrades', async () => {
    routeItemsTop(versionMap([['ABCD1234', 44]]), { probe: 'not-found' })
    const result = await provider.changes({ since: 42, include: new Set(['items']) })
    expect(result.changed.items).toHaveLength(1)
    expect(result.toVersion).toBeUndefined()
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
    const result = await provider.changes({ since: 42, include: new Set(['items', 'deleted']) })
    expect(result.toVersion).toBe(50)
    expect(result.totals?.items).toBe(3)
    expect(result.truncated).toBeUndefined()
    // Served but empty tombstones stay out of the listing while their count is reported.
    expect(result.deleted).toBeUndefined()
    expect(result.totals?.deletedItems).toBe(0)
  })

  it('treats a body that is not a version map as an unverified read', async () => {
    mock.route('GET', '/api/users/0/items/top', (req, res, helpers, search) => {
      if (search.get('limit') === '1') {
        helpers.json([], { 'Last-Modified-Version': '50' })
        return
      }
      helpers.json([{ key: 'ABCD1234', version: 44 }], { 'Last-Modified-Version': '50' })
    })
    const result = await provider.changes({ since: 42, include: new Set(['items']) })
    expect(result.changed.items).toEqual([])
    expect(result.toVersion).toBeUndefined()
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
    const result = await provider.changes({ since: 42, include: new Set(['items', 'deleted']) })
    expect(result.deleted?.items).toEqual(['DELE0001', 'DELE0002', 'DELE0003'])
    expect(result.totals?.deletedItems).toBe(4)
    expect(result.truncated).toBe(true)
    expect(result.toVersion).toBe(50)
  })

  it('honors include subsets and skips their endpoints', async () => {
    routeItemsTop(versionMap([]))
    routeVersions('/api/users/0/collections', versionMap([['COLL1234', 44]]), {
      'Last-Modified-Version': '50',
    })
    const result = await provider.changes({
      since: 10,
      include: new Set(['collections']),
    })
    expect(result.changed.collections?.map((entry) => entry.key)).toEqual(['COLL1234'])
    expect(result.changed.items).toBeUndefined()
    const paths = diffRequests().map((request) => request.pathname)
    expect(paths).toEqual(['/api/users/0/collections'])
  })

  it('diffs a group library under its own prefix', async () => {
    routeItemsTop(versionMap([['ABCD1234', 7]]), { prefix: '/api/groups/42', version: '9' })
    const result = await provider.changes({
      library: { type: 'group', id: 42 },
      since: 3,
      include: new Set(['items']),
    })
    expect(result.library).toEqual({ type: 'group', id: 42 })
    expect(result.serverId).toBe('S1')
    expect(result.changed.items?.[0]?.key).toBe('ABCD1234')
    expect(result.toVersion).toBe(9)
  })

  it('omits malformed keys and non-numeric versions from version maps', async () => {
    routeItemsTop({ ABCD1234: 44, 'bad-key!': 5, SHORT: 'not-a-number' }, { total: '3' })
    const result = await provider.changes({ since: 10, include: new Set(['items']) })
    expect(result.changed.items).toEqual([{ key: 'ABCD1234', version: 44 }])
    // The header counts the objects the server matched, before key shaping.
    expect(result.totals?.items).toBe(3)
    expect(result.toVersion).toBe(50)
  })

  it('names a resource this build does not serve instead of leaving it silent', async () => {
    // /deleted 404s on some local-API versions (Zotero 10.0.2-beta.9 has no
    // such route); the rest of the diff answers and says what it could not cover.
    routeItemsTop(versionMap([['ABCD1234', 44]]))
    const result = await provider.changes({ since: 42, include: new Set(['items', 'deleted']) })
    expect(result.changed.items?.map((entry) => entry.key)).toEqual(['ABCD1234'])
    expect(result.deleted).toBeUndefined()
    expect(result.unsupported).toEqual(['deleted'])
    expect(result.toVersion).toBe(50)
    expect(result.truncated).toBeUndefined()
  })

  it('reports a versionless library as an empty, uncursored diff', async () => {
    routeItemsTop({}, { probe: 'not-found', diff: 'not-found' })
    const result = await provider.changes({ since: 42, include: new Set(['items']) })
    expect(result.toVersion).toBeUndefined()
    expect(result.changed.items).toBeUndefined()
    expect(result.unsupported).toEqual(['items'])
    expect(result.totals).toBeUndefined()
  })

  it('reports a versionless library as an empty baseline reading', async () => {
    mock.route('GET', '/api/users/0/items/top', (req, res, helpers) =>
      helpers.raw(404, { 'Content-Type': 'text/plain' }, 'Not found'),
    )
    const result = await provider.changes({})
    expect(result.toVersion).toBeUndefined()
    expect(result.changed).toEqual({})
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
      since: 42,
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
    expect(result.toVersion).toBeUndefined()
  })

  it('fails loud when a resource faults for a reason other than absence', async () => {
    // Only a 404 degrades to `unsupported`; a server fault must never be
    // reported as "this resource did not change".
    routeItemsTop(versionMap([['ABCD1234', 44]]), { diff: 'error' })
    await zoteroError(
      provider.changes({ since: 42, include: new Set(['items']) }),
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
    const result = await provider.changes({ since: 10, include: new Set(['items']) })
    expect(result.changed.items?.map((entry) => entry.key)).toEqual(['AAAA1234', 'BBBB1234'])
  })
})
