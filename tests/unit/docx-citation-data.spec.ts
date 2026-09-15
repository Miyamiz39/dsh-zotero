import { describe, expect, it } from 'vitest'
import { citationHtmlToText, loadWordCitationCluster } from '../../src/docx/citation-data.js'
import { parseRef } from '../../src/refs.js'
import type { ZoteroExportResult } from '../../src/types.js'

const ref = parseRef('zotero://user/0/item/ABCD1234')

function service(cslText: string, citationText = '<i>(Doe &amp; Roe, 2024)</i>') {
  return {
    async export(request: { format: 'citation' | 'csljson' }): Promise<ZoteroExportResult> {
      return request.format === 'citation'
        ? {
            format: 'citation',
            style: 'apa',
            locale: 'en-US',
            citations: [{ ref: 'zotero://user/0/item/ABCD1234', text: citationText }],
          }
        : {
            format: 'csljson',
            style: 'apa',
            locale: 'en-US',
            text: cslText,
            items: [{ ref: 'zotero://user/0/item/ABCD1234', entryIndex: 0 }],
          }
    },
  }
}

describe('DOCX Zotero citation data', () => {
  it('uses one formatted cluster and canonical CSL item URI/data', async () => {
    const data = await loadWordCitationCluster(
      service(
        JSON.stringify([
          {
            id: 'http://zotero.org/users/123456/items/ABCD1234',
            type: 'article-journal',
            title: 'Paper',
          },
        ]),
      ),
      [ref],
      'apa',
      'en-US',
    )
    expect(data.formattedText).toBe('(Doe & Roe, 2024)')
    expect(data.items[0]).toMatchObject({
      id: 'http://zotero.org/users/123456/items/ABCD1234',
      uris: ['http://zotero.org/users/123456/items/ABCD1234'],
      itemData: { type: 'article-journal', title: 'Paper' },
    })
  })

  it('fails closed instead of fabricating a canonical URI', async () => {
    await expect(
      loadWordCitationCluster(
        service(JSON.stringify([{ id: 'citation-key', type: 'book' }])),
        [ref],
        'apa',
        'en-US',
      ),
    ).rejects.toThrow(/canonical item URI/)
  })

  it('decodes visible citation HTML without treating it as markup', () => {
    expect(citationHtmlToText('<span>A&#x2013;B<br>C&nbsp;&lt;D&gt;</span>')).toBe(
      'A–B\nC\u00a0<D>',
    )
  })
})
