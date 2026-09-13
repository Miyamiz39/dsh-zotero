/**
 * The `zotero_children` tool surface: graph exploration for item refs,
 * annotation-only reads for attachment refs, the rendered section counts, and
 * the ref checks that fail before any request.
 * @module tests/tools/children
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { renderChildren } from '../../src/tools/children.js'
import { type HostLane, setupHostLane } from '../helpers/lanes/host-lane.js'
import { annotationRow, attachment, noteRow } from '../helpers/server/objects.js'

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

describe('zotero_children tool', () => {
  it('registers and exposes its schema to the assembly', () => {
    expect(lane.tool('zotero_children')).toBeDefined()
    expect(lane.ctx.tools.schemas().some((schema) => schema.name === 'zotero_children')).toBe(true)
  })

  it('explores an item graph end to end and renders the three sections', async () => {
    mock.route('GET', '/api/users/0/items/ABCD1234', (req, res, helpers) =>
      helpers.json(
        { key: 'ABCD1234', version: 3, data: { itemType: 'journalArticle', title: 'T' } },
        { 'Zotero-Server-ID': 'S1' },
      ),
    )
    mock.route('GET', '/api/users/0/items/ABCD1234/children', (req, res, helpers) =>
      helpers.json([noteRow(), attachment()]),
    )
    mock.route('GET', '/api/users/0/items/WXYZ6789/children', (req, res, helpers) =>
      helpers.json([annotationRow()]),
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
      helpers.json([annotationRow()]),
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
