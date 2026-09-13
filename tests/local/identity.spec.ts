/**
 * Instance-identity specs: a read pinned to one Zotero instance (a ref
 * carrying `?server=`) must never consume a scope listing cached under a
 * different `Zotero-Server-ID`, even inside the TTL window. After a profile
 * or database switch, same-key objects are different objects, so serving the
 * old instance's cached graph would be a provenance error.
 * @module tests/provider/identity
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ZoteroHttpClient } from '../../src/http-client.js'
import { ZoteroWriteHttpClient } from '../../src/write-http.js'
import { WriteAuthorizer } from '../../src/write-auth.js'
import {
  LocalApiProvider,
  type LocalApiProvider as LocalApiProviderType,
} from '../../src/local/provider.js'
import { parseRef } from '../../src/refs.js'
import {
  createProvider,
  setupProvider,
  teardownProvider,
  type ProviderHarness,
} from '../helpers/provider-harness.js'
import {
  COLLECTION_KEY,
  GROUP_LIBRARY,
  ITEM_KEY,
  apiPath,
  itemRef,
  refOf,
} from '../helpers/server/keys.js'
import { collectionRow, item, versionHeaders } from '../helpers/server/objects.js'
import { serveJson, serveStatus } from '../helpers/server/serve.js'

let mock: ProviderHarness['mock']
let provider: LocalApiProviderType
let harness: ProviderHarness

beforeEach(async () => {
  harness = await setupProvider()
  mock = harness.mock
  provider = harness.provider
})

afterEach(async () => {
  await teardownProvider(harness)
})

/** The parent item fixture; its collection membership drives name resolution. */
const PARENT = item({ meta: { numChildren: 0 }, data: { collections: [COLLECTION_KEY] } })

/** The canonical collection row, renamed to say which instance served it. */
function collectionListing(instance: 'A' | 'B'): unknown[] {
  return [collectionRow({ data: { name: `${instance} Papers` } })]
}

describe('Server-ID cache identity', () => {
  it('re-fetches a claimed listing served by another instance inside the TTL', async () => {
    let instance: 'A' | 'B' = 'A'
    // Both routes answer as the current instance, which flips before the
    // second read; a serve* helper would freeze the first response.
    mock.route('GET', `${apiPath()}/items/${ITEM_KEY}`, (req, res, helpers) =>
      helpers.json(PARENT, versionHeaders(instance)),
    )
    mock.route('GET', `${apiPath()}/collections`, (req, res, helpers) =>
      helpers.json(collectionListing(instance), versionHeaders(instance)),
    )

    // First read pins instance A's listing in the TTL cache.
    const first = await provider.getItem({
      ref: parseRef(itemRef()),
      include: new Set(),
    })
    expect(first.collections).toEqual([
      { ref: 'zotero://user/0/collection/COLL1234?server=A', name: 'A Papers' },
    ])

    // Profile switch: same keys, different instance, renamed collection. The
    // B-pinned ref must re-fetch instead of consuming A's cached entry.
    instance = 'B'
    const second = await provider.getItem({
      ref: parseRef('zotero://user/0/item/ABCD1234?server=B'),
      include: new Set(),
    })
    expect(second.collections).toEqual([
      { ref: 'zotero://user/0/collection/COLL1234?server=B', name: 'B Papers' },
    ])
    const listingRequests = mock.requests.filter(
      (request) => request.pathname === '/api/users/0/collections',
    )
    expect(listingRequests).toHaveLength(2)
    expect(listingRequests[1]!.headers['zotero-server-id']).toBe('B')
  })

  it('keeps serving the TTL cache for reads without an identity claim', async () => {
    let instance: 'A' | 'B' = 'A'
    serveJson(mock, `${apiPath()}/items/${ITEM_KEY}`, PARENT, versionHeaders(instance))
    serveJson(
      mock,
      `${apiPath()}/collections`,
      collectionListing(instance),
      versionHeaders(instance),
    )

    await provider.getItem({
      ref: parseRef(itemRef()),
      include: new Set(),
    })
    // A second unclaimed read rides the cached listing — no identity claim,
    // so the entry's own TTL governs staleness as before.
    await provider.getItem({
      ref: parseRef(itemRef()),
      include: new Set(),
    })
    expect(
      mock.requests.filter((request) => request.pathname === '/api/users/0/collections'),
    ).toHaveLength(1)
  })

  it('fails closed when the cache holds no identity but the read claims one', async () => {
    // First response carries no Server-ID (pre-Zotero-10 behavior).
    let sendId = false
    let servedName = 'A Papers'
    // Both values change before the claiming read; a serve* helper would
    // freeze the anonymous first answer.
    mock.route('GET', `${apiPath()}/items/${ITEM_KEY}`, (req, res, helpers) =>
      helpers.json(PARENT, sendId ? versionHeaders('B') : {}),
    )
    mock.route('GET', `${apiPath()}/collections`, (req, res, helpers) =>
      helpers.json(
        [collectionRow({ data: { name: servedName } })],
        sendId ? versionHeaders('B') : {},
      ),
    )

    await provider.getItem({
      ref: parseRef(itemRef()),
      include: new Set(),
    })
    // A claiming read cannot prove the anonymous entry matches; re-fetch.
    sendId = true
    servedName = 'B Papers'
    const detail = await provider.getItem({
      ref: parseRef('zotero://user/0/item/ABCD1234?server=B'),
      include: new Set(),
    })
    expect(detail.collections).toEqual([
      { ref: 'zotero://user/0/collection/COLL1234?server=B', name: 'B Papers' },
    ])
    expect(
      mock.requests.filter((request) => request.pathname === '/api/users/0/collections'),
    ).toHaveLength(2)
  })

  it('serves group listings under their own library partition', async () => {
    let instance: 'A' | 'B' = 'A'
    serveJson(mock, `${apiPath()}/items/${ITEM_KEY}`, PARENT, versionHeaders(instance))
    serveJson(
      mock,
      `${apiPath()}/collections`,
      collectionListing(instance),
      versionHeaders(instance),
    )
    serveJson(mock, `${apiPath(GROUP_LIBRARY)}/items/${ITEM_KEY}`, PARENT, versionHeaders(instance))
    serveJson(
      mock,
      `${apiPath(GROUP_LIBRARY)}/collections`,
      collectionListing(instance),
      versionHeaders(instance),
    )

    const personal = await provider.getItem({
      ref: parseRef(itemRef()),
      include: new Set(),
    })
    const group = await provider.getItem({
      ref: parseRef(refOf('item', ITEM_KEY, GROUP_LIBRARY)),
      include: new Set(),
    })
    expect(personal.collections[0]!.ref).toContain('user/0')
    expect(group.collections[0]!.ref).toContain('group/42')
    expect(
      mock.requests.filter((request) => request.pathname.endsWith('/collections')),
    ).toHaveLength(2)
  })

  it('exposes createProvider limits unchanged for identity specs', async () => {
    // Pins that the shared harness still builds an independent provider per
    // spec; the identity guard lives in provider state, not module state.
    const fresh = createProvider(mock)
    expect(fresh.id).toBe(provider.id)
  })

  it('reports no write state from a provider that wires no write capability', async () => {
    mock.route('GET', '/api/', (_req, res, helpers) =>
      helpers.raw(200, { 'Zotero-Server-ID': 'srv-identity-1' }, JSON.stringify({})),
    )
    const status = await provider.status()
    expect(status.connected).toBe(true)
    expect(status.write).toBeUndefined()
  })

  it('reports the write state with the stored-grant fact when the capability is wired', async () => {
    const client = new ZoteroHttpClient({
      baseUrl: mock.baseUrl,
      timeoutMs: 5000,
      maxResponseBytes: 1_000_000,
    })
    const writer = new ZoteroWriteHttpClient({
      baseUrl: mock.baseUrl,
      timeoutMs: 5000,
      maxResponseBytes: 1_000_000,
    })
    const writable = new LocalApiProvider(
      client,
      {
        maxNoteScanRecords: 200,
        maxDetailChars: 500,
        maxNoteBodyChars: 30_000,
        maxNoteChars: 2000,
        maxNoteRecords: 50,
        maxAnnotationRecords: 100,
        fulltextChunkWords: 200,
        maxEvidenceChars: 6000,
        maxEvidencePassages: 4,
        maxFulltextChars: 100_000,
        maxExportChars: 1_000_000,
        defaultStyle: 'apa',
        defaultLocale: 'en-US',
        maxBrowseResults: 50,
        maxChangesResults: 50,
      },
      {},
      writer,
      new WriteAuthorizer({ client: writer, persistKey: () => true }),
    )
    mock.route('GET', '/api/', (_req, res, helpers) =>
      helpers.raw(200, { 'Zotero-Server-ID': 'srv-identity-1' }, JSON.stringify({})),
    )
    const status = await writable.status()
    expect(status.write).toEqual({ enabled: true, authorized: false })
  })

  it('carries the error code in the status diagnosis so callers can route on it', async () => {
    serveStatus(mock, '/api/', 403, 'forbidden')
    const status = await provider.status()
    expect(status.connected).toBe(false)
    expect(status.diagnosis).toContain('ZOTERO_API_DISABLED')
  })
})
