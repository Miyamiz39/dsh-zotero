import { afterEach, describe, expect, it } from 'vitest'
import { setupHostLane, type HostLane } from '../helpers/lanes/host-lane.js'

const RESEARCH_TOOLS = [
  'zotero_search',
  'zotero_get',
  'zotero_children',
  'zotero_attachment',
  'zotero_retrieve',
  'zotero_export',
  'zotero_browse',
  'zotero_changes',
]

describe('selective Zotero tool surfaces', () => {
  let lane: HostLane | undefined

  afterEach(async () => {
    await lane?.teardown()
  })

  it('keeps the upstream research-only surface by default', async () => {
    lane = await setupHostLane()
    for (const name of RESEARCH_TOOLS) expect(lane.tool(name), name).toBeDefined()
    expect(lane.tool('zotero_docx_finalize')).toBeUndefined()
    expect(lane.tool('zotero_docx_probe')).toBeUndefined()
  })

  it('registers research plus DOCX for paper', async () => {
    lane = await setupHostLane({ docxEnabled: true })
    for (const name of RESEARCH_TOOLS) expect(lane.tool(name), name).toBeDefined()
    expect(lane.tool('zotero_docx_finalize')).toBeDefined()
    expect(lane.tool('zotero_docx_probe')).toBeDefined()
  })

  it('registers exactly the two DOCX tools for office', async () => {
    lane = await setupHostLane({ researchEnabled: false, docxEnabled: true })
    for (const name of RESEARCH_TOOLS) expect(lane.tool(name), name).toBeUndefined()
    expect(lane.tool('zotero_docx_finalize')).toBeDefined()
    expect(lane.tool('zotero_docx_probe')).toBeDefined()
  })

  it('does not register write tools when research is disabled', async () => {
    lane = await setupHostLane({
      researchEnabled: false,
      docxEnabled: true,
      writeEnabled: true,
      writeConfirm: false,
    })
    expect(lane.tool('zotero_create_note')).toBeUndefined()
    expect(lane.tool('zotero_add_tags')).toBeUndefined()
    expect(lane.tool('zotero_add_to_collection')).toBeUndefined()
  })
})
