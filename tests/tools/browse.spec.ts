/**
 * The `zotero_browse` surface: the kind, library, range, and free-text
 * validations reached through execute, and the tag, library, and itemField
 * row render.
 * @module tests/tools/browse
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { renderBrowse } from '../../src/tools/browse.js'
import { type HostLane, setupHostLane } from '../helpers/lanes/host-lane.js'

let lane: HostLane
let mock: HostLane['mock']
let runTool: HostLane['runTool']

beforeEach(async () => {
  lane = await setupHostLane()
  mock = lane.mock
  runTool = lane.runTool
})

afterEach(async () => {
  await lane.teardown()
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
