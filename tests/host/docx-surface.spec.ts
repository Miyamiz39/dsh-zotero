import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
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
  let root: string | undefined

  afterEach(async () => {
    await lane?.teardown()
    if (root !== undefined) await rm(root, { recursive: true, force: true })
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

  it('executes the offline probe through the optional fs service without a proxy guard', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-zotero-docx-exec-'))
    await writeFile(join(root, 'invalid.docx'), Buffer.from('not a zip'))
    lane = await setupHostLane(
      { researchEnabled: false, docxEnabled: true },
      {
        compose: async (ctx) => {
          await ctx.plugin(LocalFileSystem, { cwd: root })
        },
      },
    )
    const definition = lane.tool('zotero_docx_probe')
    expect(definition).toBeDefined()
    await expect(
      definition?.execute(
        { input_path: 'invalid.docx' },
        {
          callId: 'docx-execution-test' as never,
          rootCallId: 'docx-execution-test' as never,
          name: 'zotero_docx_probe',
          arguments: { input_path: 'invalid.docx' },
          signal: new AbortController().signal,
          agent: { session: { header: { cwd: root } } } as never,
          token: {} as never,
          deferContext() {},
          concludeTurn() {},
        },
      ),
    ).rejects.toThrow(/ZIP/)
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
