/**
 * Route installers for the mocked Local API.
 *
 * The specs used to register the same canonical responses inline, over and
 * over: the retrieval parent alone was written out 35 times, the search hit 26
 * times, the export item 26 times. Each repetition was a chance for one of
 * them to drift, and a reader could not tell a deliberate variation from a
 * copy-paste edit.
 *
 * Two conventions run through this module:
 *
 * - An **absent** field takes the canonical default.
 * - A **`null`** field means "serve nothing here", so a test that depends on an
 *   endpoint answering 404 says so explicitly instead of relying on nobody
 *   having registered it.
 * @module tests/helpers/server/serve
 */

import type { MockZotero } from '../mock-zotero.js'
import { ATTACHMENT_KEY, SERVER_ID, apiPath, PERSONAL_LIBRARY, type TestLibrary } from './keys.js'
import {
  annotationRow,
  attachment,
  collectionRow,
  noteRow,
  paperItem,
  versionHeaders,
  type WireObject,
} from './objects.js'

/** A 200 JSON answer, with optional headers. */
export function serveJson(
  mock: MockZotero,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  mock.route('GET', path, (req, res, helpers) => helpers.json(body, headers))
}

/** A non-200 answer with a plain-text body, for the failure paths. */
export function serveStatus(mock: MockZotero, path: string, status: number, body = ''): void {
  mock.route('GET', path, (req, res, helpers) =>
    helpers.raw(status, { 'Content-Type': 'text/plain' }, body),
  )
}

/** Which parts of the item graph a test wants served. `null` leaves that route unregistered. */
export interface ItemGraphSpec {
  /** The item itself; defaults to the canonical paper. */
  readonly parent?: WireObject
  /** The attachment read as an item in its own right, which the graph walk needs; defaults to the canonical PDF. */
  readonly attachmentItem?: WireObject | null
  /** Its direct children — notes and attachments; defaults to one of each. */
  readonly children?: readonly WireObject[] | null
  /** The annotations under the canonical attachment; defaults to one. */
  readonly attachmentChildren?: readonly WireObject[] | null
  /** The collections listing that resolves `data.collections` names; defaults to the canonical collection. */
  readonly collections?: readonly WireObject[] | null
  /** The instance the answers claim; `null` omits the header, for the builds that report none. */
  readonly serverId?: string | null
  /** The library the routes are served under. */
  readonly library?: TestLibrary
}

/**
 * The key of the attachment one parent points at. Zotero's item read carries
 * the attachment as a link, and the annotations live under whatever that link
 * names, so the graph follows the link rather than assuming the canonical PDF.
 * @param parent - the parent whose attachment link to read.
 * @returns the attachment key.
 */
function pdfKeyOf(parent: WireObject): string {
  const link = parent.links?.attachment as { href?: string } | undefined
  const key = link?.href?.split('/').pop()
  return key === undefined || key === '' ? ATTACHMENT_KEY : key
}

/**
 * Serve one item and its child graph the way Zotero partitions it: the item,
 * the notes and attachments directly under it, the annotations under its PDF
 * attachment, and the collections listing that turns collection keys into
 * names. Each route is registered separately, so a test that omits a route
 * gets the 404 the unregistered endpoint would really answer.
 * @param mock - the server to register on.
 * @param spec - which parts to serve and under which instance.
 */
export function serveItemGraph(mock: MockZotero, spec: ItemGraphSpec = {}): void {
  const library = spec.library ?? PERSONAL_LIBRARY
  const prefix = apiPath(library)
  const parent = spec.parent ?? paperItem()
  // One key drives both attachment routes: the item read and the annotation
  // walk must agree on which PDF the graph is about.
  const pdfKey = spec.attachmentItem?.key ?? pdfKeyOf(parent)
  const attachmentItem =
    spec.attachmentItem === undefined ? attachment({ key: pdfKey }) : spec.attachmentItem
  const children = spec.children === undefined ? [noteRow(), attachment()] : spec.children
  const attachmentChildren =
    spec.attachmentChildren === undefined ? [annotationRow()] : spec.attachmentChildren
  const collections = spec.collections === undefined ? [collectionRow()] : spec.collections
  const headers = spec.serverId === null ? {} : versionHeaders(spec.serverId ?? SERVER_ID)

  serveJson(mock, `${prefix}/items/${parent.key}`, parent, headers)
  if (attachmentItem !== null) {
    serveJson(mock, `${prefix}/items/${pdfKey}`, attachmentItem, headers)
  }
  if (children !== null) {
    serveJson(mock, `${prefix}/items/${parent.key}/children`, children, headers)
  }
  if (attachmentChildren !== null) {
    serveJson(mock, `${prefix}/items/${pdfKey}/children`, attachmentChildren, headers)
  }
  if (collections !== null) {
    serveJson(mock, `${prefix}/collections`, collections, headers)
  }
}

/** One search page: the listing body plus the `Total-Results` header the paging contract requires. */
export interface SearchPageSpec {
  /** The rows the listing returns. */
  readonly items: readonly WireObject[]
  /** The total the header reports; defaults to the row count. */
  readonly total?: number
  readonly serverId?: string | null
  readonly library?: TestLibrary
  /** The listing endpoint; defaults to the whole-library regex. */
  readonly path?: string | RegExp
}

/**
 * Serve one search listing. The default path matches both `/items` and
 * `/items/top`, which is what a whole-library search asks for.
 * @param mock - the server to register on.
 * @param spec - the page to serve.
 */
export function serveSearchPage(mock: MockZotero, spec: SearchPageSpec): void {
  const library = spec.library ?? PERSONAL_LIBRARY
  const path = spec.path ?? new RegExp(`${apiPath(library)}/items(/top)?$`)
  const headers: Record<string, string> = {
    'Total-Results': String(spec.total ?? spec.items.length),
    ...(spec.serverId === null ? {} : versionHeaders(spec.serverId ?? SERVER_ID)),
  }
  mock.route('GET', path, (req, res, helpers) => helpers.json([...spec.items], headers))
}

/**
 * Serve an attachment's full text. The default payload indexes part of the
 * document, so a test that does not care about coverage still exercises the
 * incomplete arm honestly.
 * @param mock - the server to register on.
 * @param key - the attachment whose text is served.
 * @param payload - the fulltext body.
 * @param library - the library the attachment lives in.
 */
export function serveFulltext(
  mock: MockZotero,
  key: string,
  payload: unknown = canonicalFulltext(),
  library: TestLibrary = PERSONAL_LIBRARY,
): void {
  serveJson(mock, `${apiPath(library)}/items/${key}/fulltext`, payload)
}

/**
 * The canonical fulltext body: three sentences, one of which is irrelevant, so
 * a ranking test has something to rank and a coverage test has a partial
 * index to report.
 * @returns the fulltext payload.
 */
export function canonicalFulltext(): Record<string, unknown> {
  return {
    content:
      'Flash attention speeds up transformer training. Attention is all you need. Farming crops in the spring.',
    indexedPages: 10,
    totalPages: 12,
    indexedChars: 1000,
    totalChars: 1200,
  }
}
