/**
 * The session source reducer's per-call output rules: the evidence facts a
 * retrieve folds in (dedup, the merged retrieval facts, the run summary) and
 * the export artifacts a successful export produces (refs, style and locale,
 * per-document items, text), plus the operation counters no call may ever
 * turn into a fact. The item-assembly half of the same reducer — search
 * episode folding, the stable union, provenance, attachment resolution, and
 * the degradation of unusable input — lives in `reducer.spec.ts`.
 * @module tests/client/sources/reducer-outputs
 */

import { describe, expect, it } from 'vitest'
import type { ToolResultNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { settled, running } from '../helpers/blocks.ts'
import { buildSourceWorkspace } from '../../../src/client/sources/reducer.ts'

const REF = (key: string, serverId?: string): string =>
  `zotero://user/0/item/${key}${serverId === undefined ? '' : `?server=${serverId}`}`

function block(
  callId: string,
  seq: number,
  name: string,
  args: Record<string, unknown>,
  extra: Partial<ToolResultNode> = {},
): ToolResultNode {
  return settled({ callId, seq, call: { name, argsRaw: JSON.stringify(args) }, ...extra })
}

const GET_META = {
  title: 'Attention Is All You Need',
  creators: 'Vaswani',
  year: 2017,
  venue: 'NeurIPS',
  itemType: 'journalArticle',
  notesPreview: [],
  annotationsPreview: [],
}

const RETRIEVE_META = {
  count: 1,
  sources: ['annotation'],
  truncated: false,
  sourcesSkipped: [],
  items: [
    {
      source: 'annotation',
      sourceRef: 'zotero://user/0/annotation/ANN1',
      preview: 'the claim',
      previewTruncated: false,
      pageLabel: '7',
      attachmentRef: 'zotero://user/0/attachment/WXYZ6789',
    },
  ],
  attachmentRef: 'zotero://user/0/attachment/WXYZ6789',
  coverage: { indexedPages: 5, totalPages: 10, complete: false },
  sourceAvailability: { annotation: { requested: true, returnedPassages: 1, unavailable: false } },
}

describe('buildSourceWorkspace', () => {
  describe('retrieve facts and evidence merge', () => {
    it('produces evidence facts from retrieve and never export facts', () => {
      const workspace = buildSourceWorkspace([
        block('r1', 1, 'zotero_retrieve', { ref: REF('A1') }, { meta: RETRIEVE_META }),
      ])
      expect(workspace.sources[0]!.facts).toMatchObject({ evidenceCount: 1, exportCount: 0 })
      expect(workspace.exports).toEqual([])
      expect(workspace.sources[0]!.retrievalFacts?.coverage).toEqual({
        indexedPages: 5,
        totalPages: 10,
        complete: false,
      })
      expect(workspace.sources[0]!.retrievalFacts?.attachmentRef).toBe(
        'zotero://user/0/attachment/WXYZ6789',
      )
      expect(workspace.sources[0]!.evidence[0]!.attachmentRef).toBe(
        'zotero://user/0/attachment/WXYZ6789',
      )
    })

    it('summarizes retrieves with a run count, the latest event time, and the budget', () => {
      const workspace = buildSourceWorkspace([
        block('r1', 1, 'zotero_retrieve', { ref: REF('A1') }, { meta: RETRIEVE_META, time: 1000 }),
        block(
          'r2',
          2,
          'zotero_retrieve',
          { ref: REF('A1') },
          {
            meta: {
              ...RETRIEVE_META,
              count: 2,
              items: [
                ...RETRIEVE_META.items,
                {
                  source: 'annotation',
                  sourceRef: 'zotero://user/0/annotation/ANN2',
                  preview: 'another claim',
                  previewTruncated: false,
                },
              ],
              truncated: true,
            },
            time: 2000,
          },
        ),
      ])
      const summary = workspace.sources[0]!.retrievalSummary
      expect(summary).toEqual({
        runCount: 2,
        latestCallId: 'r2',
        latestRetrievedAt: 2000,
        truncated: true,
      })
      // The kept/reported counters live on facts alone — one storage path.
      expect(workspace.sources[0]!.facts.evidenceCount).toBe(2)
      expect(workspace.sources[0]!.facts.reportedEvidenceCount).toBe(3)
    })

    it('counts a repeated retrieve call id as one run', () => {
      // The same call id replayed (a duplicated block in the slice) must not
      // inflate the run count; the evidence merge still refreshes counters.
      const workspace = buildSourceWorkspace([
        block('r1', 1, 'zotero_retrieve', { ref: REF('A1') }, { meta: RETRIEVE_META }),
        block('r1', 2, 'zotero_retrieve', { ref: REF('A1') }, { meta: RETRIEVE_META }),
      ])
      expect(workspace.sources[0]!.retrievalSummary?.runCount).toBe(1)
      expect(workspace.sources[0]!.facts.evidenceCount).toBe(1)
    })

    it('counts each successful retrieve once even when its meta arrives late', () => {
      const workspace = buildSourceWorkspace([
        block(
          'r1',
          1,
          'zotero_retrieve',
          { ref: REF('A1') },
          { meta: { count: 1, items: null, truncated: false } },
        ),
        block(
          'r2',
          2,
          'zotero_retrieve',
          { ref: REF('A1') },
          { meta: { count: 1, items: null, truncated: false } },
        ),
      ])
      expect(workspace.sources[0]!.retrievalSummary?.runCount).toBe(2)
    })

    it('keeps retrievalSummary off an item with no successful retrieve', () => {
      const workspace = buildSourceWorkspace([
        block('g1', 1, 'zotero_get', { ref: REF('A1') }, { meta: GET_META }),
      ])
      expect(workspace.sources[0]!.retrievalSummary).toBeUndefined()
    })

    it('deduplicates verbatim evidence and keeps every call id', () => {
      const workspace = buildSourceWorkspace([
        block('r1', 1, 'zotero_retrieve', { ref: REF('A1') }, { meta: RETRIEVE_META }),
        block('r2', 2, 'zotero_retrieve', { ref: REF('A1') }, { meta: RETRIEVE_META }),
      ])
      expect(workspace.sources).toHaveLength(1)
      expect(workspace.sources[0]!.evidence).toHaveLength(1)
      expect(workspace.sources[0]!.evidence[0]!.callIds).toEqual(['r1', 'r2'])
      expect(workspace.sources[0]!.facts.evidenceCount).toBe(1)
    })

    it('decodes meta without the availability facts', () => {
      const workspace = buildSourceWorkspace([
        block(
          's1',
          1,
          'zotero_search',
          { query: 'attention' },
          {
            meta: {
              returned: 1,
              total: 1,
              nextOffset: null,
              displayed: 1,
              omitted: 0,
              noteMatches: null,
              items: [
                {
                  ref: REF('A1'),
                  title: 'Paper A1',
                  creatorSummary: 'Creator',
                  year: 2020,
                  itemType: 'journalArticle',
                },
              ],
            },
          },
        ),
        block(
          'r1',
          2,
          'zotero_retrieve',
          { ref: REF('A1') },
          {
            meta: {
              count: 2,
              sources: ['annotation', 'fulltext'],
              truncated: false,
              sourcesSkipped: ['note'],
              items: [
                {
                  source: 'annotation',
                  sourceRef: 'zotero://user/0/annotation/ANN1',
                  preview: 'a',
                  previewTruncated: false,
                },
                {
                  source: 'fulltext',
                  sourceRef: REF('A1'),
                  preview: 'b',
                  previewTruncated: false,
                },
              ],
            },
          },
        ),
      ])
      expect(workspace.sources[0]!.facts.evidenceCount).toBe(2)
      expect(workspace.sources[0]!.retrievalFacts?.sourceAvailability).toEqual({})
      expect(workspace.sources[0]!.retrievalFacts?.coverage).toBeUndefined()
    })

    it('ignores a retrieve whose items are malformed', () => {
      const workspace = buildSourceWorkspace([
        block('r1', 1, 'zotero_retrieve', { ref: REF('A1') }, { meta: { items: 'x' } }),
      ])
      expect(workspace.sources[0]!.retrievalFacts).toBeUndefined()
      expect(workspace.sources[0]!.facts.evidenceCount).toBe(0)
    })

    it('lets the latest retrieve facts win', () => {
      const workspace = buildSourceWorkspace([
        block('r1', 1, 'zotero_retrieve', { ref: REF('A1') }, { meta: RETRIEVE_META }),
        block(
          'r2',
          2,
          'zotero_retrieve',
          { ref: REF('A1') },
          {
            meta: {
              count: 0,
              sources: [],
              truncated: true,
              sourcesSkipped: ['fulltext'],
              items: [],
              sourceAvailability: {
                fulltext: { requested: true, returnedPassages: 0, unavailable: true },
              },
            },
          },
        ),
      ])
      expect(workspace.sources[0]!.retrievalFacts?.truncated).toBe(true)
      expect(workspace.sources[0]!.retrievalFacts?.coverage).toEqual({
        indexedPages: 5,
        totalPages: 10,
        complete: false,
      })
    })

    it('keeps the attachment content type paired with the ref it described', () => {
      const withType = { ...RETRIEVE_META, attachmentContentType: 'application/pdf' }
      const firstMeet = buildSourceWorkspace([
        block('r1', 1, 'zotero_retrieve', { ref: REF('A1') }, { meta: withType }),
      ])
      expect(firstMeet.sources[0]!.retrievalFacts?.attachmentContentType).toBe('application/pdf')

      const replaced = buildSourceWorkspace([
        block('r1', 1, 'zotero_retrieve', { ref: REF('A1') }, { meta: withType }),
        block(
          'r2',
          2,
          'zotero_retrieve',
          { ref: REF('A1') },
          { meta: { ...withType, attachmentContentType: 'text/plain' } },
        ),
      ])
      expect(replaced.sources[0]!.retrievalFacts?.attachmentContentType).toBe('text/plain')

      // A ref-less follow-up preserves the pair it already carries.
      const preserved = buildSourceWorkspace([
        block('r1', 1, 'zotero_retrieve', { ref: REF('A1') }, { meta: withType }),
        block(
          'r2',
          2,
          'zotero_retrieve',
          { ref: REF('A1') },
          {
            meta: {
              count: 0,
              sources: [],
              truncated: false,
              sourcesSkipped: [],
              items: [],
              sourceAvailability: {},
            },
          },
        ),
      ])
      expect(preserved.sources[0]!.retrievalFacts?.attachmentContentType).toBe('application/pdf')

      // A new ref without a type drops the stale pair: the deep link and its
      // type always describe the same retrieve.
      const dropped = buildSourceWorkspace([
        block('r1', 1, 'zotero_retrieve', { ref: REF('A1') }, { meta: withType }),
        block('r2', 2, 'zotero_retrieve', { ref: REF('A1') }, { meta: RETRIEVE_META }),
      ])
      expect(dropped.sources[0]!.retrievalFacts?.attachmentContentType).toBeUndefined()
    })

    it('preserves previous coverage and attachmentRef when the next retrieve carries none', () => {
      const workspace = buildSourceWorkspace([
        block('r1', 1, 'zotero_retrieve', { ref: REF('A1') }, { meta: RETRIEVE_META }),
        block(
          'r2',
          2,
          'zotero_retrieve',
          { ref: REF('A1') },
          {
            meta: {
              count: 0,
              sources: [],
              truncated: false,
              sourcesSkipped: [],
              items: [],
              sourceAvailability: {},
            },
          },
        ),
      ])
      expect(workspace.sources[0]!.retrievalFacts?.coverage).toEqual({
        indexedPages: 5,
        totalPages: 10,
        complete: false,
      })
      expect(workspace.sources[0]!.retrievalFacts?.attachmentRef).toBe(
        'zotero://user/0/attachment/WXYZ6789',
      )
    })

    it('adopts later attachmentRef and coverage when earlier retrieve had none', () => {
      const workspace = buildSourceWorkspace([
        block(
          'r1',
          1,
          'zotero_retrieve',
          { ref: REF('A1') },
          {
            meta: {
              count: 0,
              sources: [],
              truncated: false,
              sourcesSkipped: [],
              items: [],
              sourceAvailability: {},
            },
          },
        ),
        block('r2', 2, 'zotero_retrieve', { ref: REF('A1') }, { meta: RETRIEVE_META }),
      ])
      expect(workspace.sources[0]!.retrievalFacts?.attachmentRef).toBe(
        'zotero://user/0/attachment/WXYZ6789',
      )
      expect(workspace.sources[0]!.retrievalFacts?.coverage).toEqual({
        indexedPages: 5,
        totalPages: 10,
        complete: false,
      })
    })

    it('treats retrieve count as optional and does not invent reportedEvidenceCount when absent', () => {
      const workspace = buildSourceWorkspace([
        block(
          'r1',
          1,
          'zotero_retrieve',
          { ref: REF('A1') },
          {
            meta: {
              sources: ['fulltext'],
              truncated: false,
              sourcesSkipped: [],
              items: [
                {
                  source: 'fulltext',
                  sourceRef: REF('A1'),
                  preview: 'body',
                  previewTruncated: false,
                },
              ],
              sourceAvailability: {},
            },
          },
        ),
      ])
      expect(workspace.sources[0]!.facts.reportedEvidenceCount).toBe(0)
      expect(workspace.sources[0]!.facts.evidenceCount).toBe(1)
    })

    it('leaves attachmentRef and coverage unset when no retrieve provides them', () => {
      const workspace = buildSourceWorkspace([
        block(
          'r1',
          1,
          'zotero_retrieve',
          { ref: REF('A1') },
          {
            meta: {
              count: 0,
              sources: [],
              truncated: false,
              sourcesSkipped: [],
              items: [],
              sourceAvailability: {},
            },
          },
        ),
        block(
          'r2',
          2,
          'zotero_retrieve',
          { ref: REF('A1') },
          {
            meta: {
              count: 0,
              sources: [],
              truncated: false,
              sourcesSkipped: [],
              items: [],
              sourceAvailability: {},
            },
          },
        ),
      ])
      expect(workspace.sources[0]!.retrievalFacts?.attachmentRef).toBeUndefined()
      expect(workspace.sources[0]!.retrievalFacts?.coverage).toBeUndefined()
    })

    it('records retrieval facts when the byte budget dropped the items preview', () => {
      const workspace = buildSourceWorkspace([
        block(
          'r1',
          1,
          'zotero_retrieve',
          { ref: REF('A1') },
          {
            meta: {
              count: 25,
              sources: ['fulltext'],
              truncated: true,
              sourcesSkipped: [],
              detailOmitted: true,
              attachmentRef: 'zotero://user/0/attachment/WXYZ6789',
              sourceAvailability: {
                fulltext: { requested: true, returnedPassages: 25, unavailable: false },
              },
            },
          },
        ),
      ])
      expect(workspace.sources[0]!.retrievalFacts).toBeDefined()
      expect(workspace.sources[0]!.retrievalFacts?.truncated).toBe(true)
      expect(workspace.sources[0]!.retrievalFacts?.attachmentRef).toBe(
        'zotero://user/0/attachment/WXYZ6789',
      )
      expect(workspace.sources[0]!.facts.reportedEvidenceCount).toBe(25)
      expect(workspace.sources[0]!.facts.evidenceCount).toBe(0)
    })

    it('adopts the latest attachmentRef and pairs it with the latest coverage', () => {
      const workspace = buildSourceWorkspace([
        block('r1', 1, 'zotero_retrieve', { ref: REF('A1') }, { meta: RETRIEVE_META }),
        block(
          'r2',
          2,
          'zotero_retrieve',
          { ref: REF('A1') },
          {
            meta: {
              count: 1,
              sources: ['fulltext'],
              truncated: false,
              sourcesSkipped: [],
              items: [],
              attachmentRef: 'zotero://user/0/attachment/OTHER99',
              coverage: { indexedPages: 9, totalPages: 9, complete: true },
              sourceAvailability: {},
            },
          },
        ),
      ])
      expect(workspace.sources[0]!.retrievalFacts?.attachmentRef).toBe(
        'zotero://user/0/attachment/OTHER99',
      )
      expect(workspace.sources[0]!.retrievalFacts?.coverage).toEqual({
        indexedPages: 9,
        totalPages: 9,
        complete: true,
      })
    })
  })

  describe('export artifacts and attribution', () => {
    it('skips an export with neither projection refs nor usable arguments', () => {
      const workspace = buildSourceWorkspace([
        {
          ...settled(),
          callId: 'e1',
          seq: 1,
          call: { name: 'zotero_export', argsRaw: '' },
        },
      ])
      expect(workspace.sources).toEqual([])
      expect(workspace.exports).toEqual([])
    })

    it('creates an export artifact and exportCount only from a successful call', () => {
      const workspace = buildSourceWorkspace([
        block(
          'e1',
          1,
          'zotero_export',
          { refs: [REF('A1'), REF('A2')], format: 'bibtex' },
          {
            meta: { format: 'bibtex', requested: 2, refs: [REF('A1'), REF('A2')], refsOmitted: 0 },
            content: [{ type: 'text', text: '@article{a1}' }],
          },
        ),
      ])
      expect(workspace.exports).toHaveLength(1)
      expect(workspace.exports[0]).toMatchObject({
        callId: 'e1',
        format: 'bibtex',
        refs: [REF('A1'), REF('A2')],
        refsOmitted: 0,
        text: '@article{a1}',
      })
      expect(workspace.sources).toHaveLength(2)
      for (const source of workspace.sources) {
        expect(source.facts.exportCount).toBe(1)
        expect(source.exports).toEqual([workspace.exports[0]])
      }
    })

    it('carries the per-document items of a translator export onto the artifact', () => {
      const workspace = buildSourceWorkspace([
        block(
          'e1',
          1,
          'zotero_export',
          { refs: [REF('A1')], format: 'bibtex' },
          {
            meta: {
              format: 'bibtex',
              requested: 1,
              refs: [REF('A1')],
              refsOmitted: 0,
              items: [{ ref: REF('A1'), key: 'a1', title: 'Alpha' }],
            },
            content: [{ type: 'text', text: '@article{a1}' }],
          },
        ),
      ])
      expect(workspace.exports[0]!.items).toEqual([{ ref: REF('A1'), key: 'a1', title: 'Alpha' }])
    })

    it('drops malformed item rows while decoding the rest', () => {
      const workspace = buildSourceWorkspace([
        block(
          'e1',
          1,
          'zotero_export',
          { refs: [REF('A1'), REF('A2')], format: 'bibtex' },
          {
            meta: {
              format: 'bibtex',
              requested: 2,
              refs: [REF('A1'), REF('A2')],
              refsOmitted: 0,
              items: [
                { ref: REF('A1'), key: 'a1' },
                { key: 'no-ref' },
                'junk',
                { ref: REF('A2'), key: 7 },
              ],
            },
            content: [{ type: 'text', text: '@article{a1}\n@article{a2}' }],
          },
        ),
      ])
      expect(workspace.exports[0]!.items).toEqual([
        { ref: REF('A1'), key: 'a1' },
        { ref: REF('A2') },
      ])
    })

    it('keeps artifacts item-less when the projection carries no items', () => {
      const workspace = buildSourceWorkspace([
        block(
          'e1',
          1,
          'zotero_export',
          { refs: [REF('A1')], format: 'bibtex' },
          {
            meta: { format: 'bibtex', requested: 1, refs: [REF('A1')], refsOmitted: 0 },
            content: [{ type: 'text', text: '@article{a1}' }],
          },
        ),
      ])
      expect(workspace.exports[0]!).not.toHaveProperty('items')
    })

    it('counts a duplicated ref once per artifact', () => {
      const workspace = buildSourceWorkspace([
        block(
          'e1',
          1,
          'zotero_export',
          { refs: [REF('A1'), REF('A1')] },
          {
            meta: { format: 'citation', refs: [REF('A1'), REF('A1')], refsOmitted: 0 },
            content: [{ type: 'text', text: 'x' }],
          },
        ),
      ])
      expect(workspace.sources).toHaveLength(1)
      expect(workspace.sources[0]!.facts.exportCount).toBe(1)
    })

    it('attributes an export through its meta refs even with unparseable arguments', () => {
      const workspace = buildSourceWorkspace([
        {
          ...settled(),
          callId: 'e1',
          seq: 1,
          call: { name: 'zotero_export', argsRaw: '' },
          meta: { format: 'ris', requested: 1, refs: [REF('A1')] },
          content: [{ type: 'text', text: 'TY - JOUR' }],
        },
      ])
      expect(workspace.exports[0]!.refs).toEqual([REF('A1')])
      expect(workspace.exports[0]!.refsOmitted).toBe(0)
      expect(workspace.sources).toHaveLength(1)
    })

    it('falls back to the argument refs when the meta carries none', () => {
      const workspace = buildSourceWorkspace([
        block(
          'e1',
          1,
          'zotero_export',
          { refs: [REF('A1')] },
          { meta: { format: 'bibtex' }, content: [{ type: 'text', text: 'x' }] },
        ),
      ])
      expect(workspace.exports[0]!.refs).toEqual([REF('A1')])
      expect(workspace.exports[0]!.refsOmitted).toBe(0)
    })

    it('keeps the style and locale facts on an artifact', () => {
      const workspace = buildSourceWorkspace([
        block(
          'e1',
          1,
          'zotero_export',
          { refs: [REF('A1')] },
          {
            meta: {
              format: 'bibliography',
              style: 'apa',
              locale: 'en-US',
              refs: [REF('A1')],
              refsOmitted: 0,
            },
            content: [{ type: 'text', text: 'bib' }],
          },
        ),
      ])
      expect(workspace.exports[0]).toMatchObject({ style: 'apa', locale: 'en-US' })
    })

    it('still records the artifact text when the meta is absent', () => {
      const workspace = buildSourceWorkspace([
        block(
          'e1',
          1,
          'zotero_export',
          { refs: [REF('A1')] },
          { content: [{ type: 'text', text: 'raw' }] },
        ),
      ])
      expect(workspace.exports[0]).toMatchObject({ format: '', refsOmitted: 0, text: 'raw' })
    })

    it('attributes every ref of a 50-ref export from the arguments, with no phantom omitted count', () => {
      const refs = Array.from({ length: 50 }, (_, index) =>
        REF(`B${String(index).padStart(2, '0')}`),
      )
      const workspace = buildSourceWorkspace([
        block(
          'e1',
          1,
          'zotero_export',
          { refs, format: 'bibtex' },
          {
            meta: {
              format: 'bibtex',
              requested: 50,
              refs: refs.slice(0, 20),
              refsOmitted: 30,
            },
            content: [{ type: 'text', text: 'bib' }],
          },
        ),
      ])
      expect(workspace.exports[0]!.refs).toHaveLength(50)
      expect(workspace.exports[0]!.refsOmitted).toBe(0)
      expect(workspace.sources).toHaveLength(50)
      for (const source of workspace.sources) {
        expect(source.facts.exportCount).toBe(1)
      }
    })

    it('keeps the projection refsOmitted only for the meta-preview fallback', () => {
      const refs = Array.from({ length: 25 }, (_, index) =>
        REF(`C${String(index).padStart(2, '0')}`),
      )
      const workspace = buildSourceWorkspace([
        {
          ...settled(),
          callId: 'e1',
          seq: 1,
          call: { name: 'zotero_export', argsRaw: '' },
          meta: { format: 'ris', requested: 25, refs: refs.slice(0, 20), refsOmitted: 5 },
          content: [{ type: 'text', text: 'TY - JOUR' }],
        },
      ])
      expect(workspace.exports[0]!.refs).toHaveLength(20)
      expect(workspace.exports[0]!.refsOmitted).toBe(5)
    })
  })

  describe('operation counters', () => {
    it('counts running calls as operations and never as facts', () => {
      const workspace = buildSourceWorkspace([
        running({ callId: 'g1', name: 'zotero_get', argsRaw: JSON.stringify({ ref: REF('A1') }) }),
      ])
      expect(workspace.sources).toHaveLength(1)
      expect(workspace.sources[0]!.facts).toEqual({
        inspected: false,
        evidenceCount: 0,
        reportedEvidenceCount: 0,
        attachmentResolved: false,
        exportCount: 0,
      })
      expect(workspace.sources[0]!.operations).toEqual({ running: 1, failed: 0, stopped: 0 })
    })

    it('counts failed and stopped calls in operations, never as achievements', () => {
      const workspace = buildSourceWorkspace([
        block(
          'g1',
          1,
          'zotero_get',
          { ref: REF('A1') },
          { isError: true, error: { name: 'ZoteroError', code: 'ZOTERO_NOT_FOUND' } },
        ),
        block(
          'r1',
          2,
          'zotero_retrieve',
          { ref: REF('A2') },
          { isError: true, error: { name: 'Interrupted', code: 'interrupted' } },
        ),
      ])
      const failed = workspace.sources.find((item) => item.key.includes('a1'))
      const stopped = workspace.sources.find((item) => item.key.includes('a2'))
      expect(failed?.operations).toEqual({ running: 0, failed: 1, stopped: 0 })
      expect(failed?.facts.inspected).toBe(false)
      expect(stopped?.operations).toEqual({ running: 0, failed: 0, stopped: 1 })
    })

    it('creates no artifact from running, failed, stopped, or text-less exports', () => {
      const workspace = buildSourceWorkspace([
        running({
          callId: 'e1',
          name: 'zotero_export',
          argsRaw: JSON.stringify({ refs: [REF('A1')] }),
        }),
        block(
          'e2',
          2,
          'zotero_export',
          { refs: [REF('A2')] },
          { isError: true, error: { name: 'ZoteroError', code: 'ZOTERO_OUTPUT_TOO_LARGE' } },
        ),
        block('e3', 3, 'zotero_export', { refs: [REF('A3')] }, { content: [] }),
        block(
          'e4',
          4,
          'zotero_export',
          { refs: [REF('A4')] },
          { isError: true, error: { name: 'Interrupted', code: 'interrupted' } },
        ),
      ])
      expect(workspace.exports).toEqual([])
      expect(workspace.exportOperations).toEqual({ running: 1, failed: 1, stopped: 1 })
      const a1 = workspace.sources.find((item) => item.key.includes('a1'))
      const a2 = workspace.sources.find((item) => item.key.includes('a2'))
      expect(a1?.operations.running).toBe(1)
      expect(a1?.facts.exportCount).toBe(0)
      expect(a2?.operations.failed).toBe(1)
      expect(a2?.facts.exportCount).toBe(0)
    })

    it('creates no sources from a running export with unusable arguments', () => {
      const workspace = buildSourceWorkspace([
        running({ callId: 'e1', name: 'zotero_export', argsRaw: '{}' }),
      ])
      expect(workspace.sources).toEqual([])
      expect(workspace.exportOperations).toEqual({ running: 1, failed: 0, stopped: 0 })
    })
  })
})
