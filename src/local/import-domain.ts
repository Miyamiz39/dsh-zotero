/** Import BibTeX or RIS through Zotero Desktop's Connector endpoint. */
import { randomUUID } from 'node:crypto'
import { ZOTERO_UNEXPECTED, ZoteroError } from '../errors.js'
import type { ZoteroImportResult } from '../types.js'

interface ImportDeps {
  connectorBaseUrl: string
  fetchImpl?: typeof fetch
}

export async function importRecords(
  deps: ImportDeps,
  content: string,
  options: { sessionId?: string } = {},
  signal?: AbortSignal,
): Promise<ZoteroImportResult> {
  const sessionId = options.sessionId ?? `dsh-${randomUUID().replaceAll('-', '')}`
  const connectorUrl = new URL('/connector/import', deps.connectorBaseUrl)
  connectorUrl.searchParams.set('session', sessionId)
  try {
    const response = await (deps.fetchImpl ?? fetch)(connectorUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        'X-Zotero-Connector-API-Version': '3',
      },
      body: content,
      signal,
    })
    const text = await response.text()
    if (!response.ok) {
      throw new ZoteroError(
        `Zotero Connector returned HTTP ${response.status}: ${text}`,
        ZOTERO_UNEXPECTED,
      )
    }
    let raw: unknown = []
    try {
      raw = JSON.parse(text) as unknown
    } catch {
      // Some Zotero versions may return an empty/non-JSON success body.
    }
    const items = Array.isArray(raw)
      ? raw.map((entry) => {
          const item = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : {}
          const data = typeof item.data === 'object' && item.data !== null ? (item.data as Record<string, unknown>) : {}
          return {
            ...(typeof item.key === 'string' ? { key: item.key } : {}),
            title:
              typeof item.title === 'string'
                ? item.title
                : typeof data.title === 'string'
                  ? data.title
                  : 'Untitled',
            itemType:
              typeof item.itemType === 'string'
                ? item.itemType
                : typeof data.itemType === 'string'
                  ? data.itemType
                  : 'item',
          }
        })
      : []
    return {
      kind: 'applied',
      importedCount: Array.isArray(raw) ? raw.length : 1,
      items,
      message: `Imported through session ${sessionId}`,
    }
  } catch (error) {
    if (error instanceof ZoteroError) throw error
    throw new ZoteroError('Failed to import records through Zotero Connector.', ZOTERO_UNEXPECTED, {
      cause: error,
    })
  }
}
