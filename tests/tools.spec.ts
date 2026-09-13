import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, {
  type ToolDefinition,
  type ToolExecutionResult,
  type ToolResult,
} from '@deepseek-ai/dsh-tools'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import ZoteroService from '../src/index.js'
import { ZOTERO_NOT_RUNNING } from '../src/errors.js'
import { renderChanges } from '../src/tools/changes.js'
import { renderBrowse } from '../src/tools/browse.js'
import { parseLibrary, requireLibrary } from '../src/tools/validate.js'
import { renderChildren } from '../src/tools/children.js'
import { renderGet } from '../src/tools/get.js'
import { renderRetrieve } from '../src/tools/retrieve.js'
import { renderSearch } from '../src/tools/search.js'
import { MockZotero } from './helpers/mock-zotero.js'
import { ATTACHMENT_CHILD_ROWS, CHILD_ROWS, ITEM } from './helpers/fixtures.js'

let mock: MockZotero
let ctx: Context
let callCounter = 0

beforeEach(async () => {
  mock = await MockZotero.start()
  ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  await ctx.plugin(ZoteroService, { baseUrl: mock.baseUrl })
})

afterEach(async () => {
  await mock.close()
})

function runTool(name: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
  return ctx.tools.execute({
    callId: ToolCallId(`tool-${++callCounter}`),
    name,
    arguments: args,
    signal: new AbortController().signal,
  })
}

describe('zotero_search tool', () => {
  it('registers and exposes its schema to the assembly', () => {
    const definition = ctx.tools.get('zotero_search')
    expect(definition).toBeDefined()
    expect(ctx.tools.schemas().some((schema) => schema.name === 'zotero_search')).toBe(true)
  })

  it('executes a library search and renders a compact list', async () => {
    mock.route('GET', /^\/api\/users\/0\/items(\/top)?$/, (req, res, helpers) =>
      helpers.json([ITEM], { 'Total-Results': '1', 'Zotero-Server-ID': 'S1' }),
    )
    const result = await runTool('zotero_search', { query: 'flash attention', limit: 5 })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('unreachable')
    expect(result.value).toEqual({
      scope: { kind: 'library', library: { type: 'user', id: 0 } },
      items: [
        {
          ref: 'zotero://user/0/item/ABCD1234?server=S1',
          title: 'FlashAttention-2',
          creatorSummary: 'Dao, Tri',
          year: 2023,
          itemType: 'conferencePaper',
        },
      ],
      total: 1,
      offset: 0,
      returned: 1,
    })
    expect(result.content[0]?.type).toBe('text')
    expect((result.content[0] as { text: string }).text).toBe(
      'Found 1 of 1 results:\n1. zotero://user/0/item/ABCD1234?server=S1 — FlashAttention-2 (2023) [conferencePaper] — Dao, Tri',
    )
  })

  it('renders the supplemental note list only when note-body matches exist', () => {
    const noteRow = {
      ref: 'zotero://user/0/item/NOTE1111',
      title: 'cascade note',
      creatorSummary: '',
      itemType: 'note',
    }
    const value = {
      scope: { kind: 'library' as const, library: { type: 'user' as const, id: 0 as const } },
      items: [],
      total: 42,
      offset: 0,
      returned: 2,
    }
    const withNotes = renderSearch(
      {},
      {
        ...value,
        supplemental: {
          kind: 'noteBody' as const,
          items: [noteRow, noteRow],
          scanned: 5,
          truncated: true,
        },
      },
    )
    expect((withNotes[0] as { text: string }).text).toContain(
      '+2 note-body matches (scanned 5+ notes, ordered by dateModified desc, outside the paged total):',
    )
    const completeScan = renderSearch(
      {},
      {
        ...value,
        supplemental: {
          kind: 'noteBody' as const,
          items: [{ ...noteRow, title: 'settled note', creatorSummary: 'Dao, Tri', year: 2024 }],
          scanned: 5,
          truncated: false,
        },
      },
    )
    expect((completeScan[0] as { text: string }).text).toContain(
      '+1 note-body matches (scanned 5 notes, ordered by dateModified desc, outside the paged total):',
    )
    expect((completeScan[0] as { text: string }).text).toContain(' — Dao, Tri')
    const withoutNotes = renderSearch({}, value)
    expect((withoutNotes[0] as { text: string }).text).not.toContain('note-body')
    const emptySupplement = renderSearch(
      {},
      {
        ...value,
        supplemental: { kind: 'noteBody' as const, items: [], scanned: 3, truncated: false },
      },
    )
    expect((emptySupplement[0] as { text: string }).text).not.toContain('note-body')
  })

  it('chains a resolved scope ref into the next page without re-resolving names', async () => {
    const collection = {
      key: 'COLL1234',
      version: 1,
      data: { key: 'COLL1234', version: 1, name: 'LLM Papers' },
    }
    mock.route('GET', '/api/users/0/collections', (req, res, helpers) =>
      helpers.json([collection], { 'Zotero-Server-ID': 'S1' }),
    )
    mock.route('GET', '/api/users/0/collections/COLL1234', (req, res, helpers) =>
      helpers.json(collection, { 'Zotero-Server-ID': 'S1' }),
    )
    mock.route('GET', '/api/users/0/collections/COLL1234/items/top', (req, res, helpers) =>
      helpers.json([ITEM], { 'Total-Results': '1', 'Zotero-Server-ID': 'S1' }),
    )
    const first = await runTool('zotero_search', {
      scope: { kind: 'collection', refOrName: 'LLM Papers' },
    })
    expect(first.isError).toBe(false)
    if (first.isError) throw new Error('unreachable')
    const scope = (first.value as { scope: { kind: string; ref: string } }).scope
    expect(scope).toEqual({
      kind: 'collection',
      ref: 'zotero://user/0/collection/COLL1234?server=S1',
      name: 'LLM Papers',
    })
    await runTool('zotero_search', {
      scope: { kind: 'collection', refOrName: scope.ref },
      offset: 10,
    })
    // The ref page fetches only that collection (for its name) — the full
    // listing is never re-requested after the name has been resolved once.
    expect(mock.requests.map((request) => request.pathname)).toEqual([
      '/api/users/0/collections',
      '/api/users/0/collections/COLL1234/items/top',
      '/api/users/0/collections/COLL1234',
      '/api/users/0/collections/COLL1234/items/top',
    ])
  })

  it('rejects a "||"-containing tag with a typed argument error', async () => {
    const result = await runTool('zotero_search', { query: 'x', tags: ['reviewed', 'a||b'] })
    expect(result.isError).toBe(true)
    if (!result.isError) throw new Error('unreachable')
    expect((result.content[0] as { text: string }).text).toContain('literal tag names')
    expect(mock.requests).toEqual([])
  })

  it('rejects a limit above the configured maximum', async () => {
    const result = await runTool('zotero_search', { query: 'x', limit: 21 })
    expect(result.isError).toBe(true)
    if (!result.isError) throw new Error('unreachable')
    expect((result.content[0] as { text: string }).text).toContain(
      'limit must be an integer between 1 and 20',
    )
  })

  it('rejects tagMatch without a tag filter', async () => {
    const result = await runTool('zotero_search', { query: 'x', tagMatch: 'any' })
    expect(result.isError).toBe(true)
    if (!result.isError) throw new Error('unreachable')
    expect((result.content[0] as { text: string }).text).toContain(
      'tagMatch requires tags; it has no effect without a tag filter',
    )
    expect(mock.requests).toEqual([])
  })

  it('rejects an empty scope refOrName and malformed item types', async () => {
    const emptyScope = await runTool('zotero_search', {
      scope: { kind: 'collection', refOrName: '  ' },
    })
    expect(emptyScope.isError).toBe(true)
    if (!emptyScope.isError) throw new Error('unreachable')
    expect((emptyScope.content[0] as { text: string }).text).toContain('scope.refOrName')

    const badType = await runTool('zotero_search', { itemTypes: ['-attachment'] })
    expect(badType.isError).toBe(true)
    if (!badType.isError) throw new Error('unreachable')
    expect((badType.content[0] as { text: string }).text).toContain('itemTypes')
  })

  it('announces further pages in the rendered output', async () => {
    mock.route('GET', /^\/api\/users\/0\/items(\/top)?$/, (req, res, helpers) =>
      helpers.json([ITEM], { 'Total-Results': '25' }),
    )
    const result = await runTool('zotero_search', { limit: 5 })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('unreachable')
    expect((result.content[0] as { text: string }).text).toContain(
      'More results available: search again with offset 1',
    )
  })

  it('declares itself concurrency-safe', () => {
    const definition = ctx.tools.get('zotero_search')!
    expect(definition.isConcurrencySafe?.({})).toBe(true)
  })

  it('passes valid item types through and marks PDF attachments in the render', async () => {
    const withPdf = {
      ...ITEM,
      links: {
        self: {
          href: 'http://localhost:23119/api/users/0/items/ABCD1234',
          type: 'application/json',
        },
        attachment: {
          href: 'http://localhost:23119/api/users/0/items/WXYZ6789',
          type: 'application/json',
          attachmentType: 'application/pdf',
        },
      },
    }
    mock.route('GET', /^\/api\/users\/0\/items(\/top)?$/, (req, res, helpers) =>
      helpers.json([withPdf], { 'Total-Results': '1' }),
    )
    const result = await runTool('zotero_search', {
      itemTypes: ['journalArticle', 'conferencePaper'],
      query: 'x',
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('unreachable')
    expect(mock.requests[0]!.search.get('itemType')).toBe('journalArticle || conferencePaper')
    expect((result.content[0] as { text: string }).text).toContain(' — PDF')
  })

  it('treats whitespace-only queries as omitted and rejects zero limits and blank tags', async () => {
    mock.route('GET', /^\/api\/users\/0\/items(\/top)?$/, (req, res, helpers) =>
      helpers.json([], { 'Total-Results': '0' }),
    )
    const blankQuery = await runTool('zotero_search', { query: '   ' })
    expect(blankQuery.isError).toBe(false)
    expect(mock.requests[0]!.search.has('q')).toBe(false)

    const zeroLimit = await runTool('zotero_search', { limit: 0 })
    expect(zeroLimit.isError).toBe(true)
    if (!zeroLimit.isError) throw new Error('unreachable')
    expect((zeroLimit.content[0] as { text: string }).text).toContain(
      'limit must be an integer between 1 and 20',
    )

    const negativeOffset = await runTool('zotero_search', { offset: -1 })
    expect(negativeOffset.isError).toBe(true)
    if (!negativeOffset.isError) throw new Error('unreachable')
    expect((negativeOffset.content[0] as { text: string }).text).toContain(
      'offset must be an integer between 0 and 1000000',
    )

    const blankTag = await runTool('zotero_search', { tags: ['   '] })
    expect(blankTag.isError).toBe(true)
    if (!blankTag.isError) throw new Error('unreachable')
    expect((blankTag.content[0] as { text: string }).text).toContain('literal tag names')
  })

  it('renders missing years and creators without decoration', async () => {
    const bare = {
      ...ITEM,
      meta: {},
      data: { ...ITEM.data, creators: [] },
    }
    mock.route('GET', /^\/api\/users\/0\/items(\/top)?$/, (req, res, helpers) =>
      helpers.json([bare], { 'Total-Results': '1' }),
    )
    const result = await runTool('zotero_search', { query: 'x' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('unreachable')
    expect((result.content[0] as { text: string }).text).toBe(
      'Found 1 of 1 results:\n1. zotero://user/0/item/ABCD1234 — FlashAttention-2 [conferencePaper]',
    )
  })
})

const GET_PARENT = {
  key: 'ABCD1234',
  version: 3,
  links: {
    self: { href: 'http://localhost:23119/api/users/0/items/ABCD1234', type: 'application/json' },
    attachment: {
      href: 'http://localhost:23119/api/users/0/items/WXYZ6789',
      type: 'application/json',
      attachmentType: 'application/pdf',
    },
  },
  meta: { creatorSummary: 'Dao, Tri', parsedDate: '2023-07-28', numChildren: 3 },
  data: {
    itemType: 'journalArticle',
    title: 'FlashAttention-2',
    date: '2023-07-28',
    creators: [{ creatorType: 'author', firstName: 'Tri', lastName: 'Dao' }],
    publicationTitle: 'ICML',
    DOI: '10.1234/fa2',
    url: 'https://arxiv.org/abs/2307.08691',
    abstractNote: 'FlashAttention is fast.',
    tags: [{ tag: 'attention' }, { tag: 'efficient' }],
    collections: ['COLL1234', 'COLL9999'],
  },
}

describe('zotero_get tool', () => {
  it('registers and exposes its schema to the assembly', () => {
    expect(ctx.tools.get('zotero_get')).toBeDefined()
    expect(ctx.tools.schemas().some((schema) => schema.name === 'zotero_get')).toBe(true)
  })

  it('reads metadata with a single request by default', async () => {
    mock.route('GET', '/api/users/0/items/ABCD1234', (req, res, helpers) =>
      helpers.json(
        {
          ...GET_PARENT,
          links: { self: GET_PARENT.links.self },
          data: { ...GET_PARENT.data, collections: [] },
        },
        { 'Zotero-Server-ID': 'S1' },
      ),
    )
    const result = await runTool('zotero_get', { ref: 'zotero://user/0/item/ABCD1234' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('unreachable')
    expect(mock.requests.map((request) => request.pathname)).toEqual([
      '/api/users/0/items/ABCD1234',
    ])
    expect(result.value).toMatchObject({
      ref: 'zotero://user/0/item/ABCD1234?server=S1',
      title: 'FlashAttention-2',
      year: 2023,
      collections: [],
      children: { total: 3 },
    })
    expect(result.content[0]?.type).toBe('text')
    expect((result.content[0] as { text: string }).text).toBe(
      [
        'zotero://user/0/item/ABCD1234?server=S1 — FlashAttention-2 (2023) [journalArticle]',
        'Creators: Tri Dao',
        'ICML · 2023-07-28 · DOI: 10.1234/fa2',
        'URL: https://arxiv.org/abs/2307.08691',
        'Tags: attention, efficient',
        'Abstract: FlashAttention is fast.',
        'Children: 3 total',
      ].join('\n'),
    )
  })

  it('passes unconsumed fields through extraFields under fields:"all"', async () => {
    mock.route('GET', '/api/users/0/items/ABCD1234', (req, res, helpers) =>
      helpers.json({
        key: 'ABCD1234',
        version: 3,
        data: {
          itemType: 'dataset',
          title: 'Replication data',
          repository: 'Zenodo',
          libraryCatalog: 'Zotero',
        },
      }),
    )
    const result = await runTool('zotero_get', {
      ref: 'zotero://user/0/item/ABCD1234',
      fields: 'all',
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('unreachable')
    const value = result.value as { extraFields?: Record<string, unknown> }
    expect(value.extraFields).toEqual({ repository: 'Zenodo', libraryCatalog: 'Zotero' })
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('Additional fields: libraryCatalog: Zotero; repository: Zenodo')
  })

  it('renders a bare item without decorations', async () => {
    mock.route('GET', '/api/users/0/items/ABCD1234', (req, res, helpers) =>
      helpers.json({
        key: 'ABCD1234',
        data: { itemType: 'journalArticle', title: 'Bare' },
      }),
    )
    const result = await runTool('zotero_get', { ref: 'zotero://user/0/item/ABCD1234' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('unreachable')
    expect((result.content[0] as { text: string }).text).toBe(
      'zotero://user/0/item/ABCD1234 — Bare [journalArticle]\nChildren: 0 total',
    )
  })

  it('includes children and collection names on request', async () => {
    mock.route('GET', '/api/users/0/items/ABCD1234', (req, res, helpers) =>
      helpers.json(GET_PARENT, { 'Zotero-Server-ID': 'S1' }),
    )
    mock.route('GET', '/api/users/0/items/ABCD1234/children', (req, res, helpers) =>
      helpers.json(CHILD_ROWS),
    )
    mock.route('GET', '/api/users/0/items/WXYZ6789/children', (req, res, helpers) =>
      helpers.json(ATTACHMENT_CHILD_ROWS),
    )
    mock.route('GET', '/api/users/0/collections', (req, res, helpers) =>
      helpers.json([
        { key: 'COLL1234', version: 1, data: { key: 'COLL1234', version: 1, name: 'LLM Papers' } },
      ]),
    )
    const result = await runTool('zotero_get', {
      ref: 'zotero://user/0/item/ABCD1234',
      include: ['notes', 'annotations', 'attachments'],
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('unreachable')
    // The parent, its children, the attachment-level annotation walk, and one
    // collections listing — the two independent arms may interleave.
    const paths = mock.requests.map((request) => request.pathname)
    expect(paths[0]).toBe('/api/users/0/items/ABCD1234')
    expect(paths.slice(1).sort()).toEqual(
      [
        '/api/users/0/items/ABCD1234/children',
        '/api/users/0/items/WXYZ6789/children',
        '/api/users/0/collections',
      ].sort(),
    )
    const value = result.value as {
      collections: { ref: string; name?: string }[]
      notes: { returned: number }
      annotations: { returned: number }
      attachments: { returned: number }
      bestAttachment: { title: string; contentType: string }
    }
    expect(value.collections).toEqual([
      { ref: 'zotero://user/0/collection/COLL1234?server=S1', name: 'LLM Papers' },
      { ref: 'zotero://user/0/collection/COLL9999?server=S1' },
    ])
    expect(value.notes.returned).toBe(1)
    expect(value.annotations.returned).toBe(1)
    expect(value.attachments.returned).toBe(1)
    expect(value.bestAttachment).toEqual({
      ref: 'zotero://user/0/attachment/WXYZ6789?server=S1',
      title: 'Full Text PDF',
      contentType: 'application/pdf',
    })
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain(
      'Children: 3 total (1 of 1 notes; 1 of 1 annotations; 1 of 1 attachments)',
    )
    expect(text).toContain('Collections: LLM Papers, zotero://user/0/collection/COLL9999?server=S1')
    expect(text).toContain(
      'Best attachment: zotero://user/0/attachment/WXYZ6789?server=S1 (application/pdf)',
    )
  })

  it('flags truncated abstracts and attachment content types without a label', async () => {
    const longAbstract = 'a'.repeat(3001)
    mock.route('GET', '/api/users/0/items/ABCD1234', (req, res, helpers) =>
      helpers.json({
        ...GET_PARENT,
        links: {
          attachment: {
            href: 'http://localhost:23119/api/users/0/items/WXYZ6789',
            type: 'application/json',
          },
        },
        data: {
          ...GET_PARENT.data,
          collections: [],
          creators: [],
          abstractNote: longAbstract,
          publicationTitle: '',
          DOI: '',
          url: '',
          date: '',
          tags: [],
        },
      }),
    )
    const result = await runTool('zotero_get', { ref: 'zotero://user/0/item/ABCD1234' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('unreachable')
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('Abstract (truncated): ')
    expect(text).toContain('Best attachment: zotero://user/0/attachment/WXYZ6789 (unknown type)')
    expect(text).not.toContain('Creators:')
    expect(text).not.toContain('Tags:')
    expect(text).not.toContain('URL:')
  })

  it('rejects malformed and wrong-kind refs before any request', async () => {
    const malformed = await runTool('zotero_get', { ref: 'ABCD1234' })
    expect(malformed.isError).toBe(true)
    if (!malformed.isError) throw new Error('unreachable')
    expect((malformed.content[0] as { text: string }).text).toContain('Invalid Zotero reference')

    const wrongKind = await runTool('zotero_get', { ref: 'zotero://user/0/collection/COLL1234' })
    expect(wrongKind.isError).toBe(true)
    if (!wrongKind.isError) throw new Error('unreachable')
    expect((wrongKind.content[0] as { text: string }).text).toContain('Expected a item reference')

    expect(mock.requests).toEqual([])
  })

  it('declares itself concurrency-safe for valid arguments', () => {
    expect(
      ctx.tools.get('zotero_get')!.isConcurrencySafe?.({ ref: 'zotero://user/0/item/ABCD1234' }),
    ).toBe(true)
  })
})

describe('zotero_children tool', () => {
  it('registers and exposes its schema to the assembly', () => {
    expect(ctx.tools.get('zotero_children')).toBeDefined()
    expect(ctx.tools.schemas().some((schema) => schema.name === 'zotero_children')).toBe(true)
  })

  it('explores an item graph end to end and renders the three sections', async () => {
    mock.route('GET', '/api/users/0/items/ABCD1234', (req, res, helpers) =>
      helpers.json(
        { key: 'ABCD1234', version: 3, data: { itemType: 'journalArticle', title: 'T' } },
        { 'Zotero-Server-ID': 'S1' },
      ),
    )
    mock.route('GET', '/api/users/0/items/ABCD1234/children', (req, res, helpers) =>
      helpers.json(CHILD_ROWS),
    )
    mock.route('GET', '/api/users/0/items/WXYZ6789/children', (req, res, helpers) =>
      helpers.json(ATTACHMENT_CHILD_ROWS),
    )
    const result = await runTool('zotero_children', {
      ref: 'zotero://user/0/item/ABCD1234',
      include: ['notes', 'attachments', 'annotations'],
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('unreachable')
    const value = result.value as {
      annotations?: { total: number; items: { parentRef?: string }[] }
      itemType?: string
      serverId?: string
    }
    expect(value.itemType).toBe('journalArticle')
    expect(value.serverId).toBe('S1')
    // The annotation's provenance points at its real parent attachment.
    expect(value.annotations?.items[0]?.parentRef).toBe(
      'zotero://user/0/attachment/WXYZ6789?server=S1',
    )
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('zotero://user/0/item/ABCD1234?server=S1 (journalArticle)')
    expect(text).toContain('Notes: 1 of 1')
    expect(text).toContain('Attachments: 1 of 1')
    expect(text).toContain('Annotations: 1 of 1')
  })

  it('returns an attachment own annotations from an attachment ref', async () => {
    mock.route('GET', '/api/users/0/items/WXYZ6789', (req, res, helpers) =>
      helpers.json({
        key: 'WXYZ6789',
        data: { itemType: 'attachment', title: 'Full Text PDF', contentType: 'application/pdf' },
      }),
    )
    mock.route('GET', '/api/users/0/items/WXYZ6789/children', (req, res, helpers) =>
      helpers.json(ATTACHMENT_CHILD_ROWS),
    )
    const result = await runTool('zotero_children', {
      ref: 'zotero://user/0/attachment/WXYZ6789',
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('unreachable')
    const value = result.value as { itemType?: string; notes?: unknown; annotations?: unknown }
    expect(value.itemType).toBe('attachment')
    expect(value.notes).toBeUndefined()
    expect(value.annotations).toBeDefined()
  })

  it('rejects annotation refs and non-attachment targets before any request', async () => {
    const annotationRef = await runTool('zotero_children', {
      ref: 'zotero://user/0/annotation/ANNO1111',
    })
    expect(annotationRef.isError).toBe(true)
    if (!annotationRef.isError) throw new Error('unreachable')
    expect((annotationRef.content[0] as { text: string }).text).toContain(
      'Expected a item or attachment reference',
    )

    mock.route('GET', '/api/users/0/items/ABCD1234', (req, res, helpers) =>
      helpers.json({ key: 'ABCD1234', data: { itemType: 'journalArticle' } }),
    )
    const wrongTarget = await runTool('zotero_children', {
      ref: 'zotero://user/0/attachment/ABCD1234',
    })
    expect(wrongTarget.isError).toBe(true)
    if (!wrongTarget.isError) throw new Error('unreachable')
    expect((wrongTarget.content[0] as { text: string }).text).toContain('not an attachment')
  })

  it('renders an empty result without sections', async () => {
    const text = renderChildren(
      { ref: 'zotero://user/0/item/ABCD1234' },
      { ref: 'zotero://user/0/item/ABCD1234' },
    )
    expect((text[0] as { text: string }).text).toContain('No child kinds requested.')
  })

  it('renders annotations without page labels bare', async () => {
    const text = renderChildren(
      { ref: 'zotero://user/0/item/ABCD1234' },
      {
        ref: 'zotero://user/0/item/ABCD1234',
        annotations: {
          total: 1,
          returned: 1,
          items: [{ ref: 'zotero://user/0/annotation/A1', type: 'highlight', text: 't' }],
        },
      },
    )
    expect((text[0] as { text: string }).text).toContain('- zotero://user/0/annotation/A1: t')
  })

  it('rejects an explicit empty include before any request', async () => {
    const result = await runTool('zotero_children', {
      ref: 'zotero://user/0/item/ABCD1234',
      include: [],
    })
    expect(result.isError).toBe(true)
    if (!result.isError) throw new Error('unreachable')
    expect((result.content[0] as { text: string }).text).toContain(
      'include must list at least one child kind',
    )
    expect(mock.requests).toEqual([])
  })
})

describe('zotero_attachment tool', () => {
  const FILE_ATTACHMENT = {
    key: 'WXYZ6789',
    version: 1,
    data: {
      itemType: 'attachment',
      title: 'Full Text PDF',
      contentType: 'application/pdf',
      linkMode: 'imported_file',
    },
  }

  it('registers and exposes its schema to the assembly', () => {
    expect(ctx.tools.get('zotero_attachment')).toBeDefined()
    expect(ctx.tools.schemas().some((schema) => schema.name === 'zotero_attachment')).toBe(true)
  })

  it('resolves a file attachment to a verified on-disk path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-zotero-'))
    try {
      const filePath = join(dir, 'paper.pdf')
      writeFileSync(filePath, '%PDF stub')
      mock.route('GET', '/api/users/0/items/WXYZ6789', (req, res, helpers) =>
        helpers.json(FILE_ATTACHMENT),
      )
      mock.route('GET', '/api/users/0/items/WXYZ6789/file/view/url', (req, res, helpers) =>
        helpers.text(pathToFileURL(filePath).href),
      )
      const result = await runTool('zotero_attachment', {
        ref: 'zotero://user/0/attachment/WXYZ6789',
      })
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('unreachable')
      expect(result.value).toEqual({
        ref: 'zotero://user/0/attachment/WXYZ6789',
        title: 'Full Text PDF',
        contentType: 'application/pdf',
        kind: 'file',
        path: filePath,
      })
      expect((result.content[0] as { text: string }).text).toBe(
        `Full Text PDF (zotero://user/0/attachment/WXYZ6789) application/pdf → ${filePath}`,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects a file location no local path can express', async () => {
    mock.route('GET', '/api/users/0/items/WXYZ6789', (req, res, helpers) =>
      helpers.json(FILE_ATTACHMENT),
    )
    mock.route('GET', '/api/users/0/items/WXYZ6789/file/view/url', (req, res, helpers) =>
      helpers.text('file://otherhost/shared/paper.pdf'),
    )
    const result = await runTool('zotero_attachment', {
      ref: 'zotero://user/0/attachment/WXYZ6789',
    })
    expect(result.isError).toBe(true)
    if (!result.isError) throw new Error('unreachable')
    expect((result.content[0] as { text: string }).text).toContain('not a usable local path')
  })

  it('resolves an item ref to its best attachment', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-zotero-'))
    try {
      const filePath = join(dir, 'paper.pdf')
      writeFileSync(filePath, '%PDF stub')
      mock.route('GET', '/api/users/0/items/ABCD1234', (req, res, helpers) =>
        helpers.json({
          key: 'ABCD1234',
          version: 3,
          links: {
            attachment: {
              href: 'http://localhost:23119/api/users/0/items/WXYZ6789',
              type: 'application/json',
              attachmentType: 'application/pdf',
            },
          },
          data: { itemType: 'journalArticle', title: 'FlashAttention-2' },
        }),
      )
      mock.route('GET', '/api/users/0/items/WXYZ6789', (req, res, helpers) =>
        helpers.json(FILE_ATTACHMENT),
      )
      mock.route('GET', '/api/users/0/items/WXYZ6789/file/view/url', (req, res, helpers) =>
        helpers.text(pathToFileURL(filePath).href),
      )
      const result = await runTool('zotero_attachment', { ref: 'zotero://user/0/item/ABCD1234' })
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('unreachable')
      expect(mock.requests.map((request) => request.pathname)).toEqual([
        '/api/users/0/items/ABCD1234',
        '/api/users/0/items/WXYZ6789',
        '/api/users/0/items/WXYZ6789/file/view/url',
      ])
      expect(result.value).toEqual({
        ref: 'zotero://user/0/attachment/WXYZ6789',
        title: 'Full Text PDF',
        contentType: 'application/pdf',
        kind: 'file',
        path: filePath,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('serves linked-URL attachments without a file request', async () => {
    mock.route('GET', '/api/users/0/items/WXYZ6789', (req, res, helpers) =>
      helpers.json({
        key: 'WXYZ6789',
        version: 1,
        data: {
          itemType: 'attachment',
          title: 'Preprint',
          contentType: 'application/pdf',
          linkMode: 'linked_url',
          url: 'https://arxiv.org/pdf/2307.08691',
        },
      }),
    )
    const result = await runTool('zotero_attachment', {
      ref: 'zotero://user/0/attachment/WXYZ6789',
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('unreachable')
    expect(mock.requests).toHaveLength(1)
    expect(result.value).toEqual({
      ref: 'zotero://user/0/attachment/WXYZ6789',
      title: 'Preprint',
      contentType: 'application/pdf',
      kind: 'url',
      url: 'https://arxiv.org/pdf/2307.08691',
    })
    expect((result.content[0] as { text: string }).text).toBe(
      'Preprint (zotero://user/0/attachment/WXYZ6789) application/pdf → https://arxiv.org/pdf/2307.08691',
    )
  })

  it('renders untitled attachments by ref with an unknown-type label', async () => {
    mock.route('GET', '/api/users/0/items/WXYZ6789', (req, res, helpers) =>
      helpers.json({
        key: 'WXYZ6789',
        version: 1,
        data: { itemType: 'attachment', linkMode: 'linked_url', url: 'https://example.com/doc' },
      }),
    )
    const result = await runTool('zotero_attachment', {
      ref: 'zotero://user/0/attachment/WXYZ6789',
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('unreachable')
    expect((result.content[0] as { text: string }).text).toBe(
      'zotero://user/0/attachment/WXYZ6789 unknown type → https://example.com/doc',
    )
  })

  it('surfaces a missing file as a typed error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-zotero-'))
    try {
      mock.route('GET', '/api/users/0/items/WXYZ6789', (req, res, helpers) =>
        helpers.json(FILE_ATTACHMENT),
      )
      mock.route('GET', '/api/users/0/items/WXYZ6789/file/view/url', (req, res, helpers) =>
        helpers.text(pathToFileURL(join(dir, 'gone.pdf')).href),
      )
      const result = await runTool('zotero_attachment', {
        ref: 'zotero://user/0/attachment/WXYZ6789',
      })
      expect(result.isError).toBe(true)
      if (!result.isError) throw new Error('unreachable')
      expect((result.content[0] as { text: string }).text).toContain('missing from disk')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects malformed and wrong-kind refs before any request', async () => {
    const malformed = await runTool('zotero_attachment', { ref: 'not-a-ref' })
    expect(malformed.isError).toBe(true)
    if (!malformed.isError) throw new Error('unreachable')
    expect((malformed.content[0] as { text: string }).text).toContain('Invalid Zotero reference')

    const wrongKind = await runTool('zotero_attachment', {
      ref: 'zotero://user/0/collection/COLL1234',
    })
    expect(wrongKind.isError).toBe(true)
    if (!wrongKind.isError) throw new Error('unreachable')
    expect((wrongKind.content[0] as { text: string }).text).toContain(
      'Expected a item or attachment reference',
    )

    expect(mock.requests).toEqual([])
  })

  it('declares itself concurrency-safe for valid arguments', () => {
    expect(
      ctx.tools
        .get('zotero_attachment')!
        .isConcurrencySafe?.({ ref: 'zotero://user/0/attachment/WXYZ6789' }),
    ).toBe(true)
  })
})

const RETRIEVE_PARENT = {
  key: 'ABCD1234',
  version: 3,
  links: {
    self: { href: 'http://localhost:23119/api/users/0/items/ABCD1234', type: 'application/json' },
    attachment: {
      href: 'http://localhost:23119/api/users/0/items/WXYZ6789',
      type: 'application/json',
      attachmentType: 'application/pdf',
    },
  },
  meta: { parsedDate: '2023-07-28', numChildren: 1 },
  data: {
    itemType: 'journalArticle',
    title: 'FlashAttention-2',
    abstractNote: 'FlashAttention speeds up transformer training.',
    collections: [],
  },
}

const RETRIEVE_CHILDREN = [
  {
    key: 'WXYZ6789',
    data: {
      itemType: 'attachment',
      title: 'Full Text PDF',
      contentType: 'application/pdf',
      linkMode: 'imported_file',
    },
  },
]

/** Annotations live under the PDF attachment (`WXYZ6789`), not under the parent. */
const RETRIEVE_ATTACHMENT_CHILDREN = [
  {
    key: 'ANNO1111',
    data: {
      itemType: 'annotation',
      annotationType: 'highlight',
      annotationText: 'flash attention avoids materializing the matrix',
      annotationSortIndex: '00001',
      parentItem: 'WXYZ6789',
    },
  },
]

describe('zotero_retrieve tool', () => {
  it('registers and exposes its schema to the assembly', () => {
    expect(ctx.tools.get('zotero_retrieve')).toBeDefined()
    expect(ctx.tools.schemas().some((schema) => schema.name === 'zotero_retrieve')).toBe(true)
  })

  it('returns ranked evidence and coverage', async () => {
    mock.route('GET', '/api/users/0/items/ABCD1234', (req, res, helpers) =>
      helpers.json(RETRIEVE_PARENT, { 'Zotero-Server-ID': 'S1' }),
    )
    mock.route('GET', '/api/users/0/items/ABCD1234/children', (req, res, helpers) =>
      helpers.json(RETRIEVE_CHILDREN),
    )
    mock.route('GET', '/api/users/0/items/WXYZ6789/children', (req, res, helpers) =>
      helpers.json(RETRIEVE_ATTACHMENT_CHILDREN),
    )
    mock.route('GET', '/api/users/0/items/WXYZ6789/fulltext', (req, res, helpers) =>
      helpers.json({
        content: 'Flash attention is fast. Attention is all you need.',
        indexedChars: 100,
        totalChars: 100,
      }),
    )
    const result = await runTool('zotero_retrieve', {
      ref: 'zotero://user/0/item/ABCD1234',
      query: 'flash attention',
      passages: 3,
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('unreachable')
    const value = result.value as {
      evidence: { source: string; text: string }[]
      coverage: { complete: boolean }
      truncated: boolean
    }
    expect(value.evidence.length).toBeGreaterThan(0)
    expect(value.coverage.complete).toBe(true)
    expect(value.truncated).toBe(false)
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('zotero://user/0/item/ABCD1234?server=S1')
    expect(text).toContain('fulltext')
  })

  it('searches My Publications end to end through the tool', async () => {
    mock.route('GET', '/api/users/0/publications/items/top', (req, res, helpers) =>
      helpers.json([ITEM], { 'Total-Results': '1' }),
    )
    const result = await runTool('zotero_search', { scope: { kind: 'publications' } })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('unreachable')
    expect(mock.requests[0]!.pathname).toBe('/api/users/0/publications/items/top')
    const value = result.value as { scope: { kind: string } }
    expect(value.scope.kind).toBe('publications')
  })

  it('rejects empty queries and out-of-range passage counts before any request', async () => {
    const empty = await runTool('zotero_retrieve', {
      ref: 'zotero://user/0/item/ABCD1234',
      query: '   ',
    })
    expect(empty.isError).toBe(true)
    if (!empty.isError) throw new Error('unreachable')
    expect((empty.content[0] as { text: string }).text).toContain('query')

    const tooMany = await runTool('zotero_retrieve', {
      ref: 'zotero://user/0/item/ABCD1234',
      query: 'x',
      passages: 5,
    })
    expect(tooMany.isError).toBe(true)
    if (!tooMany.isError) throw new Error('unreachable')
    expect((tooMany.content[0] as { text: string }).text).toContain('passages')

    expect(mock.requests).toEqual([])
  })

  it('validates attachment policy pairings before any request', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [
        {
          ref: 'zotero://user/0/item/ABCD1234',
          query: 'x',
          attachmentPolicy: 'specified',
        },
        'requires at least one attachmentRef',
      ],
      [
        {
          ref: 'zotero://user/0/item/ABCD1234',
          query: 'x',
          attachmentRefs: ['zotero://user/0/attachment/WXYZ6789'],
        },
        'only valid with attachmentPolicy="specified"',
      ],
      [
        {
          ref: 'zotero://group/7/item/ABCD1234',
          query: 'x',
          attachmentPolicy: 'specified',
          attachmentRefs: ['zotero://group/8/attachment/WXYZ6789'],
        },
        'same library',
      ],
      [
        {
          ref: 'zotero://user/0/item/ABCD1234',
          query: 'x',
          attachmentPolicy: 'specified',
          attachmentRefs: ['zotero://user/0/item/WXYZ6789'],
        },
        'Expected a attachment reference',
      ],
    ]
    for (const [args, message] of cases) {
      const result = await runTool('zotero_retrieve', args)
      expect(result.isError).toBe(true)
      if (!result.isError) throw new Error('unreachable')
      expect((result.content[0] as { text: string }).text).toContain(message)
    }
    expect(mock.requests).toEqual([])
  })

  it('rejects an empty sources list', async () => {
    const result = await runTool('zotero_retrieve', {
      ref: 'zotero://user/0/item/ABCD1234',
      query: 'x',
      sources: [],
    })
    expect(result.isError).toBe(true)
    if (!result.isError) throw new Error('unreachable')
    expect((result.content[0] as { text: string }).text).toContain('sources must list')
    expect(mock.requests).toEqual([])
  })

  it('rejects malformed refs before any request', async () => {
    const result = await runTool('zotero_retrieve', { ref: 'nope', query: 'x' })
    expect(result.isError).toBe(true)
    if (!result.isError) throw new Error('unreachable')
    expect((result.content[0] as { text: string }).text).toContain('Invalid Zotero reference')
    expect(mock.requests).toEqual([])
  })

  it('declares itself concurrency-safe for valid arguments', () => {
    expect(
      ctx.tools
        .get('zotero_retrieve')!
        .isConcurrencySafe?.({ ref: 'zotero://user/0/item/ABCD1234', query: 'x' }),
    ).toBe(true)
  })
})

describe('zotero_retrieve render', () => {
  function render(value: never): string {
    return (renderRetrieve({} as never, value)[0] as { text: string }).text
  }

  it('renders a minimal single abstract passage', () => {
    const text = render({
      ref: 'zotero://user/0/item/ABCD1234',
      evidence: [
        { source: 'abstract', sourceRef: 'zotero://user/0/item/ABCD1234', text: 'abstract text' },
      ],
      truncated: false,
      sourcesSkipped: [],
    } as never)
    expect(text).toBe(
      [
        'Evidence for zotero://user/0/item/ABCD1234 (1 passage)',
        '',
        '[abstract] zotero://user/0/item/ABCD1234',
        'abstract text',
      ].join('\n'),
    )
  })

  it('renders coverage with chars, pages, unknown totals, and completeness', () => {
    const charsOnly = render({
      ref: 'zotero://user/0/item/ABCD1234',
      coverage: { indexedChars: 10, totalChars: 12, complete: false },
      evidence: [],
      truncated: false,
      sourcesSkipped: [],
    } as never)
    expect(charsOnly).toContain('Indexing coverage: 10/12 chars')

    const pagesOnly = render({
      ref: 'zotero://user/0/item/ABCD1234',
      coverage: { indexedPages: 2, totalPages: 9, complete: false },
      evidence: [],
      truncated: false,
      sourcesSkipped: [],
    } as never)
    expect(pagesOnly).toContain('Indexing coverage: , 2/9 pages')

    const unknownTotals = render({
      ref: 'zotero://user/0/item/ABCD1234',
      coverage: { indexedChars: 5, indexedPages: 3, complete: false },
      evidence: [],
      truncated: false,
      sourcesSkipped: [],
    } as never)
    expect(unknownTotals).toContain('Indexing coverage: 5/? chars, 3/? pages')

    const complete = render({
      ref: 'zotero://user/0/item/ABCD1234',
      coverage: { indexedChars: 5, totalChars: 5, complete: true },
      evidence: [],
      truncated: false,
      sourcesSkipped: [],
    } as never)
    expect(complete).toContain('(complete)')
  })

  it('renders annotation page labels and comments', () => {
    const text = render({
      ref: 'zotero://user/0/item/ABCD1234',
      evidence: [
        {
          source: 'annotation',
          sourceRef: 'zotero://user/0/item/ANNO1111',
          text: 'insight',
          comment: 'double-check',
          pageLabel: '7',
        },
      ],
      truncated: false,
      sourcesSkipped: [],
    } as never)
    expect(text).toContain('[annotation (page 7)] zotero://user/0/item/ANNO1111')
    expect(text).toContain('Comment: double-check')
  })

  it('renders chunk locators and skipped sources', () => {
    const text = render({
      ref: 'zotero://user/0/item/ABCD1234',
      evidence: [
        {
          source: 'note',
          sourceRef: 'zotero://user/0/item/NOTE1111',
          text: 'later chunk',
          chunkIndex: 2,
          chunkCount: 3,
        },
      ],
      truncated: false,
      sourcesSkipped: ['fulltext'],
    } as never)
    expect(text).toContain('[note, chunk 3/3] zotero://user/0/item/NOTE1111')
    expect(text).toContain('Skipped unavailable sources: fulltext')
  })

  it('announces omitted evidence and the fulltext attachment', () => {
    const text = render({
      ref: 'zotero://user/0/item/ABCD1234',
      attachmentRef: 'zotero://user/0/attachment/WXYZ6789',
      evidence: [],
      truncated: true,
      sourcesSkipped: [],
    } as never)
    expect(text).toContain('Full text: zotero://user/0/attachment/WXYZ6789')
    expect(text).toContain(
      'More evidence was available but omitted by the passage or character budget.',
    )
    expect(text).toContain('(0 passages)')
  })
})

describe('zotero_get render', () => {
  function render(value: never): string {
    return (renderGet({} as never, value)[0] as { text: string }).text
  }

  it('omits the additional-fields line when every extra field is undefined', () => {
    const text = render({
      ref: 'zotero://user/0/item/ABCD1234',
      itemType: 'dataset',
      title: 'T',
      creators: [],
      abstractTruncated: false,
      tags: [],
      collections: [],
      children: { total: 0 },
      extraFields: { ghost: undefined },
    } as never)
    expect(text).not.toContain('Additional fields')
  })

  it('JSON-encodes non-string extra field values', () => {
    const text = render({
      ref: 'zotero://user/0/item/ABCD1234',
      itemType: 'dataset',
      title: 'T',
      creators: [],
      abstractTruncated: false,
      tags: [],
      collections: [],
      children: { total: 0 },
      extraFields: { versionNumber: 2, flags: ['a', true] },
    } as never)
    expect(text).toContain('versionNumber: 2')
    expect(text).toContain('flags: ["a",true]')
  })

  it('renders the note body with a truncation marker for note items', () => {
    const truncated = render({
      ref: 'zotero://user/0/item/NOTE1111',
      itemType: 'note',
      title: '',
      creators: [],
      abstractTruncated: false,
      tags: [],
      collections: [],
      children: { total: 0 },
      noteBody: { text: 'first line of the note', truncated: true },
    } as never)
    expect(truncated).toContain('Note (truncated): first line of the note')

    const full = render({
      ref: 'zotero://user/0/item/NOTE2222',
      itemType: 'note',
      title: '',
      creators: [],
      abstractTruncated: false,
      tags: [],
      collections: [],
      children: { total: 0 },
      noteBody: { text: 'short note', truncated: false },
    } as never)
    expect(full).toContain('Note: short note')
  })
})

describe('zotero_export tool', () => {
  it('registers and exposes its schema to the assembly', () => {
    expect(ctx.tools.get('zotero_export')).toBeDefined()
    expect(ctx.tools.schemas().some((schema) => schema.name === 'zotero_export')).toBe(true)
  })

  it('exports paired citations ordered as requested', async () => {
    mock.route('GET', '/api/users/0/items', (req, res, helpers) =>
      helpers.json([
        { key: 'BBBB1234', citation: '<span>B, 2021</span>' },
        { key: 'ABCD1234', citation: '<span>A, 2023</span>' },
      ]),
    )
    const result = await runTool('zotero_export', {
      refs: ['zotero://user/0/item/ABCD1234', 'zotero://user/0/item/BBBB1234'],
      format: 'citation',
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('unreachable')
    expect(result.value).toEqual({
      format: 'citation',
      style: 'apa',
      locale: 'en-US',
      citations: [
        { ref: 'zotero://user/0/item/ABCD1234', text: '<span>A, 2023</span>' },
        { ref: 'zotero://user/0/item/BBBB1234', text: '<span>B, 2021</span>' },
      ],
    })
    expect((result.content[0] as { text: string }).text).toBe(
      [
        'zotero://user/0/item/ABCD1234: <span>A, 2023</span>',
        'zotero://user/0/item/BBBB1234: <span>B, 2021</span>',
      ].join('\n'),
    )
  })

  it('passes explicit style and locale through to the export', async () => {
    mock.route('GET', '/api/users/0/items', (req, res, helpers) =>
      helpers.json([{ key: 'ABCD1234', citation: 'x' }]),
    )
    const result = await runTool('zotero_export', {
      refs: ['zotero://user/0/item/ABCD1234'],
      format: 'citation',
      style: 'chicago-note-bibliography',
      locale: 'de-DE',
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('unreachable')
    expect(mock.requests[0]!.search.get('style')).toBe('chicago-note-bibliography')
    expect(mock.requests[0]!.search.get('locale')).toBe('de-DE')
    expect(result.value).toEqual({
      format: 'citation',
      style: 'chicago-note-bibliography',
      locale: 'de-DE',
      citations: [{ ref: 'zotero://user/0/item/ABCD1234', text: 'x' }],
    })
  })

  it('renders opaque bibliography text verbatim', async () => {
    mock.route('GET', '/api/users/0/items', (req, res, helpers) => helpers.text('entry-a\nentry-b'))
    const result = await runTool('zotero_export', {
      refs: ['zotero://user/0/item/ABCD1234'],
      format: 'bibliography',
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('unreachable')
    expect((result.content[0] as { text: string }).text).toBe('entry-a\nentry-b')
  })

  it('itemizes each translator document with its batch citation key and title', async () => {
    const batchText =
      '@article{batchPan2022,\n  title = {Carbon price forecasting},\n}\n\n' +
      '@article{batchZheng2025,\n  title = {Insight into heterogeneous risks},\n}\n'
    const secondStart = batchText.indexOf('@article{batchZheng2025,')
    mock.route('GET', '/api/users/0/items', (req, res, helpers, search) => {
      const keys = (search.get('itemKey') ?? '').split(',')
      if (keys.length > 1) {
        helpers.text(batchText)
        return
      }
      // The single-item context generates different citation keys; the
      // mapping pairs the entries by content regardless.
      helpers.text(
        keys[0] === 'ABCD1234'
          ? '@article{singlePan2022,\n  title = {Carbon price forecasting},\n}\n'
          : '@article{singleZheng2025,\n  title = {Insight into heterogeneous risks},\n}\n',
      )
    })
    const result = await runTool('zotero_export', {
      refs: ['zotero://user/0/item/ABCD1234', 'zotero://user/0/item/BBBB1234'],
      format: 'bibtex',
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('unreachable')
    expect(result.value).toEqual({
      format: 'bibtex',
      text: batchText,
      items: [
        {
          ref: 'zotero://user/0/item/ABCD1234',
          key: 'batchPan2022',
          title: 'Carbon price forecasting',
          start: 0,
          end: secondStart,
        },
        {
          ref: 'zotero://user/0/item/BBBB1234',
          key: 'batchZheng2025',
          title: 'Insight into heterogeneous risks',
          start: secondStart,
          end: batchText.length,
        },
      ],
    })
    // The model-visible render stays the merged body, not the itemization.
    expect((result.content[0] as { text: string }).text).toBe(batchText)
  })

  it('rejects empty ref lists, malformed refs, and blank styles before any request', async () => {
    const empty = await runTool('zotero_export', { refs: [], format: 'bibtex' })
    expect(empty.isError).toBe(true)
    if (!empty.isError) throw new Error('unreachable')
    expect((empty.content[0] as { text: string }).text).toContain('refs')

    const malformed = await runTool('zotero_export', { refs: ['nope'], format: 'bibtex' })
    expect(malformed.isError).toBe(true)
    if (!malformed.isError) throw new Error('unreachable')
    expect((malformed.content[0] as { text: string }).text).toContain('Invalid Zotero reference')

    const blankStyle = await runTool('zotero_export', {
      refs: ['zotero://user/0/item/ABCD1234'],
      format: 'citation',
      style: '  ',
    })
    expect(blankStyle.isError).toBe(true)
    if (!blankStyle.isError) throw new Error('unreachable')
    expect((blankStyle.content[0] as { text: string }).text).toContain('style')

    const blankLocale = await runTool('zotero_export', {
      refs: ['zotero://user/0/item/ABCD1234'],
      format: 'citation',
      locale: '  ',
    })
    expect(blankLocale.isError).toBe(true)
    if (!blankLocale.isError) throw new Error('unreachable')
    expect((blankLocale.content[0] as { text: string }).text).toContain('locale')

    expect(mock.requests).toEqual([])
  })

  it('rejects ref lists above the configured export cap before any request', async () => {
    const refs = Array.from(
      { length: 1001 },
      (_, i) => `zotero://user/0/item/${String(i).padStart(4, '0')}ABCD`,
    )
    const result = await runTool('zotero_export', { refs, format: 'bibtex' })
    expect(result.isError).toBe(true)
    if (!result.isError) throw new Error('unreachable')
    expect((result.content[0] as { text: string }).text).toContain('export in batches')
    expect(mock.requests).toEqual([])
  })

  it('accepts exactly the capped ref count', async () => {
    const refs = Array.from(
      { length: 50 },
      (_, i) => `zotero://user/0/item/${String(i).padStart(4, '0')}ABCD`,
    )
    mock.route('GET', '/api/users/0/items', (req, res, helpers, search) =>
      helpers.json((search.get('itemKey') ?? '').split(',').map((key) => ({ key, citation: 'x' }))),
    )
    const result = await runTool('zotero_export', { refs, format: 'citation' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('unreachable')
    expect((result.value as { citations: unknown[] }).citations).toHaveLength(50)
  })

  it('declares itself concurrency-safe for valid arguments', () => {
    expect(
      ctx.tools
        .get('zotero_export')!
        .isConcurrencySafe?.({ refs: ['zotero://user/0/item/ABCD1234'], format: 'bibtex' }),
    ).toBe(true)
  })
})

describe('zotero_changes tool', () => {
  it('registers and exposes its schema to the assembly', () => {
    expect(ctx.tools.get('zotero_changes')).toBeDefined()
    expect(ctx.tools.schemas().some((schema) => schema.name === 'zotero_changes')).toBe(true)
  })

  it('takes a baseline reading end to end and mints the cursor', async () => {
    mock.route('GET', '/api/users/0/items/top', (req, res, helpers, search) => {
      expect(search.get('limit')).toBe('1')
      helpers.json([], { 'Last-Modified-Version': '42', 'Zotero-Server-ID': 'S1' })
    })
    const result = await runTool('zotero_changes', {})
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('unreachable')
    const value = result.value as {
      cursor?: { serverId: string; library: unknown; version: number }
      changed: Record<string, unknown>
    }
    expect(value.cursor).toEqual({
      serverId: 'S1',
      library: { type: 'user', id: 0 },
      version: 42,
    })
    expect(value.changed).toEqual({})
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('Baseline reading: library is at version 42 on instance S1')
    expect(text).toContain('Pass that cursor back as since')
  })

  it('round-trips the minted cursor through a diff and carries the claim', async () => {
    let probes = 0
    mock.route('GET', '/api/users/0/items/top', (req, res, helpers, search) => {
      if (search.get('limit') === '1') {
        probes += 1
        // The baseline reads the library as it was (42); by the time the diff
        // probes, it has advanced to 50.
        helpers.json([], {
          'Last-Modified-Version': probes === 1 ? '42' : '50',
          'Zotero-Server-ID': 'S1',
        })
        return
      }
      expect(search.get('since')).toBe('42')
      helpers.json({ ABCD1234: 44 }, { 'Total-Results': '1', 'Last-Modified-Version': '50' })
    })
    const baseline = await runTool('zotero_changes', {})
    if (baseline.isError) throw new Error('unreachable')
    const cursor = (baseline.value as { cursor: unknown }).cursor
    mock.requests.length = 0
    const diff = await runTool('zotero_changes', { since: cursor, include: ['items'] })
    expect(diff.isError).toBe(false)
    if (diff.isError) throw new Error('unreachable')
    const value = diff.value as { fromVersion?: number; cursor?: { version: number } }
    expect(value.fromVersion).toBe(42)
    expect(value.cursor?.version).toBe(50)
    // The cursor's instance travels on every request of the diff, so a server
    // that is no longer that instance refuses it.
    for (const request of mock.requests) {
      expect(request.headers['zotero-server-id']).toBe('S1')
    }
  })

  it('refuses a cursor this plugin would diff against the wrong counter', async () => {
    const cursor = { serverId: 'S1', library: { type: 'user', id: 0 }, version: 42 }
    // A version is a counter of one library, so a cursor from user/0 says
    // nothing about group/42; the mix-up is refused before any read.
    const crossLibrary = await runTool('zotero_changes', {
      library: { type: 'group', id: 42 },
      since: cursor,
    })
    expect(crossLibrary.isError).toBe(true)
    if (!crossLibrary.isError) throw new Error('unreachable')
    expect((crossLibrary.content[0] as { text: string }).text).toContain('belongs to user/0')
    // The schema owns the shape; the constraints it cannot express fail here.
    for (const since of [
      { ...cursor, serverId: '  ' },
      { ...cursor, version: -1 },
      { ...cursor, library: { type: 'user', id: 5 } },
    ]) {
      const result = await runTool('zotero_changes', { since, include: ['items'] })
      expect(result.isError).toBe(true)
      expect(mock.requests).toHaveLength(0)
    }
  })

  it('diffs from a cursor and renders per-resource sections', async () => {
    mock.route('GET', '/api/users/0/items/top', (req, res, helpers, search) => {
      // The pre-read version probe and the items diff share this path.
      if (search.get('limit') === '1') {
        helpers.json([], { 'Last-Modified-Version': '50', 'Zotero-Server-ID': 'S1' })
        return
      }
      expect(search.get('since')).toBe('42')
      expect(search.get('format')).toBe('versions')
      helpers.json({ ABCD1234: 44 }, { 'Total-Results': '1', 'Last-Modified-Version': '50' })
    })
    mock.route('GET', '/api/users/0/deleted', (req, res, helpers, search) => {
      expect(search.get('since')).toBe('42')
      helpers.json({ items: ['EEEE0001'], collections: [], searches: [] })
    })
    const result = await runTool('zotero_changes', {
      since: { serverId: 'S1', library: { type: 'user', id: 0 }, version: 42 },
      include: ['items', 'deleted'],
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('unreachable')
    const value = result.value as {
      fromVersion?: number
      cursor?: { version: number }
      deleted?: { items?: string[] }
      totals?: { items?: number; deletedItems?: number; deletedSavedSearches?: number }
    }
    expect(value.fromVersion).toBe(42)
    expect(value.cursor?.version).toBe(50)
    expect(value.deleted?.items).toEqual(['EEEE0001'])
    expect(value.totals?.items).toBe(1)
    expect(value.totals?.deletedItems).toBe(1)
    expect(value.totals?.deletedSavedSearches).toBe(0)
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('Changes 42 → 50')
    expect(text).toContain('- ABCD1234 (v44)')
    expect(text).toContain('Items: 1 changed')
    expect(text).toContain('Deleted items: 1')
  })

  it('diffs a group library through its own prefix and pins the cursor to it', async () => {
    mock.route('GET', '/api/groups/42/items/top', (req, res, helpers, search) => {
      if (search.get('limit') === '1') {
        helpers.json([], { 'Last-Modified-Version': '9', 'Zotero-Server-ID': 'S2' })
        return
      }
      helpers.json({ ABCD1234: 7 }, { 'Total-Results': '1', 'Last-Modified-Version': '9' })
    })
    const result = await runTool('zotero_changes', {
      library: { type: 'group', id: 42 },
      since: { serverId: 'S2', library: { type: 'group', id: 42 }, version: 3 },
      include: ['items'],
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('unreachable')
    const value = result.value as {
      library?: { type: string; id: number }
      cursor?: { serverId: string; library: { type: string; id: number }; version: number }
    }
    expect(value.library).toEqual({ type: 'group', id: 42 })
    expect(value.cursor).toEqual({
      serverId: 'S2',
      library: { type: 'group', id: 42 },
      version: 9,
    })
  })

  it('diffs the default resource set without the full-text listing', async () => {
    // The fulltext endpoint answers in the index's own version counter, so a
    // plain diff must not read it: a 404 there would surface as `unsupported`.
    mock.route('GET', '/api/users/0/items/top', (req, res, helpers, search) => {
      if (search.get('limit') === '1') {
        helpers.json([], { 'Last-Modified-Version': '50', 'Zotero-Server-ID': 'S1' })
        return
      }
      helpers.json({ ABCD1234: 44 }, { 'Total-Results': '1', 'Last-Modified-Version': '50' })
    })
    for (const path of ['/api/users/0/collections', '/api/users/0/searches']) {
      mock.route('GET', path, (req, res, helpers) =>
        helpers.json({}, { 'Total-Results': '0', 'Last-Modified-Version': '50' }),
      )
    }
    mock.route('GET', '/api/users/0/deleted', (req, res, helpers) =>
      helpers.json({ items: [], collections: [], searches: [] }),
    )
    const result = await runTool('zotero_changes', {
      since: { serverId: 'S1', library: { type: 'user', id: 0 }, version: 42 },
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('unreachable')
    const value = result.value as {
      unsupported?: string[]
      changed: { fulltextAttachments?: unknown }
      cursor?: { version: number }
    }
    expect(value.changed.fulltextAttachments).toBeUndefined()
    // Every kind the diff did read was served, so nothing is named unavailable.
    expect(value.unsupported).toBeUndefined()
    expect(value.cursor?.version).toBe(50)
    expect(mock.requests.some((request) => request.pathname.endsWith('/fulltext'))).toBe(false)
  })

  it('rejects an invalid library shape before any request', async () => {
    const result = await runTool('zotero_changes', {
      library: { type: 'user', id: 5 },
    })
    expect(result.isError).toBe(true)
    if (!result.isError) throw new Error('unreachable')
    expect((result.content[0] as { text: string }).text).toContain('Only user/0 is supported')
    expect(mock.requests).toEqual([])
  })

  it('rejects an explicit empty include before any request', async () => {
    const result = await runTool('zotero_changes', {
      since: { serverId: 'S1', library: { type: 'user', id: 0 }, version: 42 },
      include: [],
    })
    expect(result.isError).toBe(true)
    if (!result.isError) throw new Error('unreachable')
    expect((result.content[0] as { text: string }).text).toContain(
      'include must list at least one resource kind',
    )
    expect(mock.requests).toEqual([])
  })

  it('renders digests, withheld cursors, and unserved resources honestly', () => {
    // Three baseline outcomes, three texts: a cursor, a version without an
    // instance, and no version at all. The last one names the cause instead of
    // leaving the model to guess why no cursor came back.
    const noVersion = renderChanges({}, { changed: {}, versionUnavailable: true } as never)
    expect((noVersion[0] as { text: string }).text).toContain(
      'this Zotero build reports no library version',
    )
    const noInstance = renderChanges({}, { changed: {} } as never)
    expect((noInstance[0] as { text: string }).text).toContain(
      'named no instance to pin a cursor to',
    )
    const based = renderChanges({}, {
      changed: {},
      cursor: { serverId: 'S1', library: { type: 'user', id: 0 }, version: 42 },
    } as never)
    expect((based[0] as { text: string }).text).toContain(
      'Baseline reading: library is at version 42 on instance S1',
    )

    // A diff whose build reported no version says so instead of blaming the range.
    const noVersionDiff = renderChanges({}, {
      fromVersion: 1,
      changed: {},
      versionUnavailable: true,
    } as never)
    expect((noVersionDiff[0] as { text: string }).text).toContain(
      'this Zotero build reported no library version for this read',
    )

    // A capped listing is a digest: the cursor still stands and totals carries
    // the counts behind the rows that were dropped.
    const digest = renderChanges({}, {
      fromVersion: 1,
      cursor: { serverId: 'S1', library: { type: 'user', id: 0 }, version: 220 },
      changed: {
        items: Array.from({ length: 50 }, (_, i) => ({
          key: `KEY${String(i).padStart(4, '0')}`,
          version: i + 2,
        })),
      },
      totals: { items: 120 },
      truncated: true,
    } as never)
    const digestText = (digest[0] as { text: string }).text
    expect(digestText).toContain('Changes 1 → 220')
    expect(digestText).toContain('Items: 120 changed — 50 newest listed')
    expect(digestText).toContain('… 100 more')
    expect(digestText).not.toContain('KEY0049')

    const incomplete = renderChanges({}, {
      fromVersion: 1,
      changed: {
        items: Array.from({ length: 25 }, (_, i) => ({
          key: `KEY${String(i).padStart(4, '0')}`,
          version: i + 2,
        })),
      },
      deleted: {
        items: Array.from({ length: 22 }, (_, i) => `GONE${String(i).padStart(4, '0')}`),
      },
      truncated: true,
    } as never)
    const text = (incomplete[0] as { text: string }).text
    expect(text).toContain('version not advanced: the read did not verify the whole range')
    expect(text).toContain('Items: 25 changed')
    expect(text).toContain('… 5 more')
    expect(text).not.toContain('KEY0024')
    expect(text).toContain('Deleted items: 22')
    expect(text).toContain('… 2 more')

    const moved = renderChanges({}, {
      fromVersion: 1,
      libraryChanged: true,
      changed: { items: [] },
      unsupported: ['deleted'],
    } as never)
    const movedText = (moved[0] as { text: string }).text
    expect(movedText).toContain('the library changed while this call was reading — re-run')
    expect(movedText).toContain('Not served by this Zotero build: deleted')

    const cappedDeleted = renderChanges({}, {
      fromVersion: 1,
      cursor: { serverId: 'S1', library: { type: 'user', id: 0 }, version: 220 },
      changed: { items: [] },
      deleted: {
        items: Array.from({ length: 50 }, (_, i) => `GONE${String(i).padStart(4, '0')}`),
        collections: [],
        savedSearches: [],
      },
      totals: { deletedItems: 540 },
      truncated: true,
    } as never)
    expect((cappedDeleted[0] as { text: string }).text).toContain('Deleted items: 540 — 50 listed')

    const fulltext = renderChanges({}, {
      fromVersion: 1,
      cursor: { serverId: 'S1', library: { type: 'user', id: 0 }, version: 220 },
      changed: { fulltextAttachments: [{ key: 'WXYZ6789', version: 90071 }] },
      totals: { fulltextAttachments: 1 },
    } as never)
    expect((fulltext[0] as { text: string }).text).toContain(
      'index versions are a counter of their own',
    )
  })
})

describe('zotero_browse validation', () => {
  it('rejects malformed libraries, ranges, and kinds through execute', async () => {
    const cases = [
      { args: { kind: 'libraries', library: { type: 'bad', id: 0 } }, contains: 'library.type' },
      { args: { kind: 'tags', library: { type: 'user', id: 'x' } }, contains: 'library.id' },
      { args: { kind: 'tags', library: { type: 'user', id: 1 } }, contains: 'Only user/0' },
      {
        args: { kind: 'tags', library: { type: 'group', id: 0 } },
        contains: 'group id must be positive',
      },
      { args: { kind: 'tags', offset: -1 }, contains: 'offset' },
      { args: { kind: 'tags', limit: 9999 }, contains: 'limit' },
      { args: { kind: 'unsupported' }, contains: 'kind' },
      // match is only meaningful alongside q
      { args: { kind: 'tags', match: 'contains' }, contains: 'match requires q' },
      // blank free text is invalid wherever it is meaningful
      { args: { kind: 'tags', q: '   ' }, contains: 'q must be a non-empty string' },
      {
        args: { kind: 'tags', tagScope: 'library', itemQuery: '  ' },
        contains: 'itemQuery must be a non-empty string',
      },
      {
        args: { kind: 'tags', tagScope: 'collection', tagCollection: ' ' },
        contains: 'tagCollection must be a non-empty string',
      },
      // the global kinds refuse a library parameter
      {
        args: { kind: 'libraries', library: { type: 'group', id: 1 } },
        contains: 'library is not allowed',
      },
    ]
    for (const c of cases) {
      const result = await runTool('zotero_browse', c.args)
      expect(result.isError).toBe(true)
      if (!result.isError) throw new Error('unreachable')
      expect((result.content[0] as { text: string }).text).toContain(c.contains)
    }
  })
})

describe('parseLibrary', () => {
  it('returns undefined for an absent library', () => {
    expect(parseLibrary(undefined)).toBeUndefined()
    expect(parseLibrary(null)).toBeUndefined()
  })

  it('fails closed on malformed shapes with model-facing messages', () => {
    expect(() => parseLibrary({ type: 'shelves', id: 1 })).toThrow(
      'library.type must be user or group',
    )
    expect(() => parseLibrary({ type: 'user', id: 0.5 })).toThrow('library.id must be integer')
    expect(() => parseLibrary({ type: 'user', id: 123 })).toThrow('Only user/0')
    expect(() => parseLibrary({ type: 'group', id: 0 })).toThrow(
      'group id must be positive integer',
    )
    expect(() => parseLibrary({ type: 'user', id: -3 })).toThrow('Only user/0')
  })

  it('accepts user/0 and positive groups', () => {
    expect(parseLibrary({ type: 'user', id: 0 })).toEqual({ type: 'user', id: 0 })
    expect(parseLibrary({ type: 'group', id: 42 })).toEqual({ type: 'group', id: 42 })
  })
})

describe('requireLibrary', () => {
  it('carries the parsed library through and rejects an absent one', () => {
    // The cursor's library has no meaningful absent case: without it the
    // version cannot say which counter it belongs to.
    expect(requireLibrary({ type: 'group', id: 42 })).toEqual({ type: 'group', id: 42 })
    expect(() => requireLibrary(undefined)).toThrow('library is required here')
    expect(() => requireLibrary({ type: 'user', id: 9 })).toThrow('Only user/0')
  })
})

describe('zotero_search validation', () => {
  it('rejects domain-invalid tag filters and libraries through execute', async () => {
    // Shapes the parameter schema already rejects (unknown library type,
    // non-integer ids, invalid tagMatch enums) never reach these handlers;
    // these cases cover the domain constraints beyond the schema.
    const cases = [
      {
        args: { includeTrashed: true, scope: { kind: 'collection', refOrName: 'x' } },
        contains: 'includeTrashed is only allowed with library scope',
      },
      { args: { library: { type: 'user', id: 1 } }, contains: 'Only user/0' },
      { args: { library: { type: 'group', id: 0 } }, contains: 'group id must be positive' },
    ]
    for (const c of cases) {
      const result = await runTool('zotero_search', c.args)
      expect(result.isError).toBe(true)
      if (!result.isError) throw new Error('unreachable')
      expect((result.content[0] as { text: string }).text).toContain(c.contains)
    }
  })
})

describe('zotero_browse render', () => {
  it('renders tag rows and skips unknown row shapes without leaking undefined', () => {
    const out = renderBrowse({ kind: 'tags', offset: 0, limit: 10 }, {
      kind: 'tags',
      total: 2,
      returned: 2,
      offset: 0,
      items: [{ tag: 'a' }, { itemType: 'book' }],
    } as never)
    expect((out[0] as { text: string }).text).toContain('a')
  })

  it('falls back to ref-only lines for rows missing names or refs', () => {
    const out = renderBrowse({ kind: 'libraries', offset: 0, limit: 10 }, {
      kind: 'libraries',
      total: 3,
      returned: 3,
      offset: 0,
      items: [
        { library: { type: 'group', id: 9 } },
        { path: ['Root'] },
        { conditions: [{ condition: 'unread' }] },
      ],
    } as never)
    const text = (out[0] as { text: string }).text
    expect(text).toContain('group/9 — group/9')
    expect(text).toContain('Root')
    expect(text).not.toContain('undefined')
  })

  it('renders itemFields rows with and without localized labels', () => {
    const out = renderBrowse({ kind: 'itemFields', offset: 0, limit: 10 }, {
      kind: 'itemFields',
      total: 3,
      returned: 3,
      offset: 0,
      items: [
        { field: 'repository', localized: 'Repository' },
        { field: 'archive' },
        { creatorType: 'author' },
      ],
    } as never)
    const text = (out[0] as { text: string }).text
    expect(text).toContain('field repository (Repository)')
    expect(text).toContain('field archive')
    expect(text).toContain('creatorType author')
  })

  it('points at browse again when a next page exists', () => {
    const out = renderBrowse({ kind: 'tags', offset: 0, limit: 10 }, {
      kind: 'tags',
      total: 10,
      returned: 2,
      offset: 0,
      nextOffset: 2,
      items: [{ tag: 'a' }],
    } as never)
    expect((out[0] as { text: string }).text).toContain('More: browse again')
  })
})

describe('tool presentation', () => {
  function definition(name: string): ToolDefinition {
    const tool = ctx.tools.get(name)
    if (tool === undefined) throw new Error(`tool ${name} not registered`)
    return tool
  }

  it('declares a pending card for every tool', () => {
    expect(
      definition('zotero_search').presentCall!({ query: 'attention', scope: { kind: 'library' } }),
    ).toEqual({
      card: 'generic',
      kind: 'search',
      title: 'Search Zotero library',
      rawInput: 'attention',
    })
    expect(definition('zotero_search').presentCall!({})).toMatchObject({ rawInput: '(browse)' })
    expect(definition('zotero_get').presentCall!({ ref: 'zotero://user/0/item/ABCD1234' })).toEqual(
      {
        card: 'generic',
        kind: 'read',
        title: 'Read Zotero item',
        rawInput: 'zotero://user/0/item/ABCD1234',
      },
    )
    expect(
      definition('zotero_attachment').presentCall!({ ref: 'zotero://user/0/attachment/WXYZ6789' }),
    ).toEqual({
      card: 'generic',
      kind: 'read',
      title: 'Resolve Zotero attachment',
      rawInput: 'zotero://user/0/attachment/WXYZ6789',
    })
    expect(
      definition('zotero_children').presentCall!({ ref: 'zotero://user/0/item/ABCD1234' }),
    ).toEqual({
      card: 'generic',
      kind: 'read',
      title: 'Read Zotero children',
      rawInput: 'zotero://user/0/item/ABCD1234',
    })
    expect(definition('zotero_children').isConcurrencySafe?.({})).toBe(false)
    expect(
      definition('zotero_children').isConcurrencySafe?.({ ref: 'zotero://user/0/item/ABCD1234' }),
    ).toBe(true)
    expect(
      definition('zotero_retrieve').presentCall!({
        ref: 'zotero://user/0/item/ABCD1234',
        query: 'tiling',
      }),
    ).toEqual({
      card: 'generic',
      kind: 'search',
      title: 'Retrieve Zotero evidence',
      rawInput: 'tiling',
    })
    expect(
      definition('zotero_export').presentCall!({
        refs: ['zotero://user/0/item/ABCD1234'],
        format: 'bibliography',
      }),
    ).toEqual({
      card: 'generic',
      title: 'Export Zotero citations',
      rawInput: '1 refs · bibliography',
    })
    expect(definition('zotero_browse').presentCall!({ kind: 'collections' })).toEqual({
      card: 'generic',
      kind: 'search',
      title: 'Browse Zotero collections',
      rawInput: 'collections',
    })
    expect(definition('zotero_browse').isConcurrencySafe?.({ kind: 'tags' })).toBe(true)
    expect(definition('zotero_changes').presentCall!({})).toEqual({
      card: 'generic',
      kind: 'read',
      title: 'Read Zotero changes',
      rawInput: 'baseline',
    })
    const cursor = { serverId: 'S1', library: { type: 'user', id: 0 }, version: 42 }
    expect(definition('zotero_changes').presentCall!({ since: cursor })).toMatchObject({
      rawInput: '42',
    })
    expect(definition('zotero_changes').isConcurrencySafe?.({ since: cursor })).toBe(true)
  })

  it('projects replayable search page facts and renders the completed card', () => {
    const tool = definition('zotero_search')
    const value = {
      scope: { kind: 'library' as const, library: { type: 'user' as const, id: 0 as const } },
      items: [],
      total: 42,
      offset: 0,
      returned: 10,
      nextOffset: 10,
    }
    expect(tool.output.presentationMeta!({}, value)).toEqual({
      returned: 10,
      total: 42,
      nextOffset: 10,
      displayed: 0,
      omitted: 10,
      noteMatches: null,
      items: [],
      scope: { kind: 'library', library: { type: 'user', id: 0 } },
      library: { type: 'user', id: 0 },
    })
    // A final page omits nextOffset; the projector records it as null so the
    // projection stays lossless JSON.
    expect(
      tool.output.presentationMeta!(
        {},
        {
          scope: { kind: 'library', library: { type: 'user', id: 0 } },
          items: [],
          total: 42,
          offset: 0,
          returned: 10,
        },
      ),
    ).toEqual({
      returned: 10,
      total: 42,
      nextOffset: null,
      displayed: 0,
      omitted: 10,
      noteMatches: null,
      items: [],
      scope: { kind: 'library', library: { type: 'user', id: 0 } },
      library: { type: 'user', id: 0 },
    })
    const result: ToolResult = {
      content: [{ type: 'text', text: 'x' }],
      isError: false,
      meta: { returned: 10, total: 42, nextOffset: null },
    }
    expect(tool.presentResult!({}, result)).toEqual({
      card: 'generic',
      title: 'Zotero search: found 10 of 42 results',
    })
    const withNotes: ToolResult = {
      content: [{ type: 'text', text: 'x' }],
      isError: false,
      meta: { returned: 10, total: 42, nextOffset: null, noteMatches: 3 },
    }
    expect(tool.presentResult!({}, withNotes)).toEqual({
      card: 'generic',
      title: 'Zotero search: found 10 of 42 results (+3 note matches)',
    })
  })

  it.each([
    [
      'zotero_get',
      { ref: 'zotero://user/0/item/ABCD1234' },
      { title: 'FlashAttention-2', year: 2023 },
      'Zotero item: FlashAttention-2 (2023)',
    ],
    [
      'zotero_get',
      { ref: 'zotero://user/0/item/ABCD1234' },
      { title: 'Paper' },
      'Zotero item: Paper',
    ],
    [
      'zotero_children',
      { ref: 'zotero://user/0/item/ABCD1234' },
      { notes: { total: 2, returned: 2 }, attachments: { total: 1, returned: 1 } },
      'Zotero children: 2 notes, 1 attachments',
    ],
    [
      'zotero_attachment',
      { ref: 'zotero://user/0/item/ABCD1234' },
      { title: 'paper.pdf', kind: 'file' },
      'Zotero attachment: paper.pdf (file)',
    ],
    [
      'zotero_retrieve',
      { ref: 'zotero://user/0/item/ABCD1234', query: 'tiling' },
      { count: 4, truncated: true },
      'Zotero evidence: 4 passages (truncated)',
    ],
    [
      'zotero_export',
      { refs: ['zotero://user/0/item/ABCD1234'], format: 'citation' },
      { format: 'citation', count: 2 },
      'Zotero export: 2 citations',
    ],
    [
      'zotero_export',
      { refs: ['zotero://user/0/item/ABCD1234'], format: 'bibtex' },
      { format: 'bibtex', requested: 3 },
      'Zotero export: 3 refs as bibtex',
    ],
    [
      'zotero_browse',
      { kind: 'tags' },
      { kind: 'tags', returned: 5, total: 20 },
      'Zotero browse: tags (5 of 20)',
    ],
    [
      'zotero_changes',
      {},
      { changed: { items: [{ key: 'A', version: 2 }] }, deleted: { items: [] } },
      'Zotero changes: 1 changed or deleted',
    ],
    [
      'zotero_changes',
      {},
      { cursor: { serverId: 'S1', library: { type: 'user', id: 0 }, version: 7 } },
      'Zotero changes: baseline at version 7',
    ],
    [
      'zotero_changes',
      {},
      {
        fromVersion: 3,
        cursor: { serverId: 'S1', library: { type: 'user', id: 0 }, version: 7 },
      },
      'Zotero changes: 3 → 7',
    ],
    [
      'zotero_changes',
      {},
      { changed: { items: [] }, totals: { items: 120, deletedItems: 4 } },
      'Zotero changes: 124 changed or deleted',
    ],
    [
      'zotero_changes',
      {},
      { changed: { items: [] }, totals: { items: 3, bogus: 'x' } },
      'Zotero changes: 3 changed or deleted',
    ],
    // A record without totals (a replay) counts its rows, tolerating a section
    // that is missing or carries something that is not a row array.
    [
      'zotero_changes',
      {},
      { changed: { items: [{ key: 'A', version: 2 }], junk: 'x' } },
      'Zotero changes: 1 changed or deleted',
    ],
  ])('renders a completed card for %s', (name, args, meta, title) => {
    const result: ToolResult = {
      content: [{ type: 'text', text: 'x' }],
      isError: false,
      meta: meta as ToolResult['meta'],
    }
    expect(definition(name).presentResult!(args, result)).toEqual({ card: 'generic', title })
  })

  it('falls back to the generic card for the other tools on bad metadata', () => {
    const err = (meta: unknown): ToolResult => ({
      content: [{ type: 'text', text: 'Error: x' }],
      isError: true,
      ...(meta === undefined ? {} : { meta: meta as ToolResult['meta'] }),
    })
    const ok = (meta: unknown): ToolResult => ({
      content: [{ type: 'text', text: 'x' }],
      isError: false,
      ...(meta === undefined ? {} : { meta: meta as ToolResult['meta'] }),
    })
    const argsFor: Record<string, Record<string, unknown>> = {
      zotero_get: { ref: 'zotero://user/0/item/ABCD1234' },
      zotero_children: { ref: 'zotero://user/0/item/ABCD1234' },
      zotero_attachment: { ref: 'zotero://user/0/item/ABCD1234' },
      zotero_retrieve: { ref: 'zotero://user/0/item/ABCD1234', query: 'tiling' },
      zotero_export: { refs: ['zotero://user/0/item/ABCD1234'], format: 'citation' },
      zotero_browse: { kind: 'tags' },
      zotero_changes: {},
    }
    for (const name of Object.keys(argsFor)) {
      const tool = definition(name)
      const args = argsFor[name]
      expect(tool.presentResult).toBeDefined()
      expect(tool.presentResult!(args, err({}))).toBeUndefined()
      expect(tool.presentResult!(args, ok(undefined))).toBeUndefined()
      expect(tool.presentResult!(args, ok('junk'))).toBeUndefined()
      expect(tool.presentResult!(args, ok([]))).toBeUndefined()
    }
    const getArgs = argsFor.zotero_get
    expect(definition('zotero_get').presentResult!(getArgs, ok({}))).toBeUndefined()
    expect(definition('zotero_get').presentResult!(getArgs, ok({ title: '' }))).toBeUndefined()
    const childrenArgs = argsFor.zotero_children
    expect(definition('zotero_children').presentResult!(childrenArgs, ok({}))).toBeUndefined()
    expect(
      definition('zotero_children').presentResult!(childrenArgs, ok({ notes: { total: 'x' } })),
    ).toBeUndefined()
    expect(
      definition('zotero_children').presentResult!(childrenArgs, ok({ notes: 'x' })),
    ).toBeUndefined()
    const attachmentArgs = argsFor.zotero_attachment
    expect(
      definition('zotero_attachment').presentResult!(
        attachmentArgs,
        ok({ title: 'a', kind: 'other' }),
      ),
    ).toBeUndefined()
    expect(
      definition('zotero_attachment').presentResult!(attachmentArgs, ok({ kind: 'file' })),
    ).toBeUndefined()
    const retrieveArgs = argsFor.zotero_retrieve
    expect(definition('zotero_retrieve').presentResult!(retrieveArgs, ok({}))).toBeUndefined()
    expect(definition('zotero_retrieve').presentResult!(retrieveArgs, ok({ count: 2 }))).toEqual({
      card: 'generic',
      title: 'Zotero evidence: 2 passages',
    })
    const exportArgs = argsFor.zotero_export
    expect(definition('zotero_export').presentResult!(exportArgs, ok({}))).toBeUndefined()
    expect(
      definition('zotero_export').presentResult!(exportArgs, ok({ format: 'citation' })),
    ).toBeUndefined()
    expect(
      definition('zotero_export').presentResult!(exportArgs, ok({ format: '', requested: 1 })),
    ).toBeUndefined()
    expect(
      definition('zotero_export').presentResult!(exportArgs, ok({ format: 'ris' })),
    ).toBeUndefined()
    const browseArgs = argsFor.zotero_browse
    expect(definition('zotero_browse').presentResult!(browseArgs, ok({}))).toBeUndefined()
    expect(
      definition('zotero_browse').presentResult!(browseArgs, ok({ kind: 'tags', returned: 1 })),
    ).toBeUndefined()
    const changesArgs = argsFor.zotero_changes
    expect(definition('zotero_changes').presentResult!(changesArgs, ok({}))).toBeUndefined()
  })
})

describe('connectivity failure ask', () => {
  it('asks the user once and retries the request when Zotero is unreachable', async () => {
    const down = await MockZotero.start()
    const downUrl = down.baseUrl
    await down.close()

    const askCtx = new Context()
    await askCtx.plugin(SystemPrompt, {})
    await askCtx.plugin(ToolRuntime, {})
    await askCtx.plugin(UserQuestionService)
    const asked: unknown[] = []
    // The alpha.1 ask seam is a scope-filtered waterfall: the listener claims
    // the request by returning an answer; the plugin's ask flow consumes the
    // same request/answer contract the old provider registration served.
    const retryOption = 'I started Zotero, retry (Recommended)'
    askCtx.on('user-questions/request', async (request, _next) => {
      asked.push(request)
      return { answers: [{ id: 'zotero-failure', selected: [retryOption] }] }
    })
    await askCtx.plugin(ZoteroService, { baseUrl: downUrl })

    const result = await askCtx.tools.execute({
      callId: ToolCallId('tool-ask-connectivity'),
      name: 'zotero_search',
      arguments: { query: 'flash attention', limit: 5 },
      signal: new AbortController().signal,
    })
    expect(result.isError).toBe(true)
    if (!result.isError) throw new Error('unreachable')
    // The retry hit the same unreachable instance and surfaced the typed
    // error; the user was asked exactly once, never looped.
    expect((result.content[0] as { text: string }).text).toContain('not running')
    expect(asked).toHaveLength(1)
    const request = asked[0] as { questions: { id: string; options: { label: string }[] }[] }
    expect(request.questions[0]!.id).toBe('zotero-failure')
    expect(request.questions[0]!.options![0]!.label).toBe(retryOption)
  })
})
