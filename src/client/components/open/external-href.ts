/**
 * Shared open-link destination props: external `http(s)` targets open in a
 * new tab with the safe rel; `zotero://` and malformed URLs stay in place
 * (OS protocol handler, or no navigation for unparseable values).
 * @module dsh-zotero/client/components/open/external-href
 */

/**
 * Anchor props for one destination URL.
 * @param url - the destination the row is about to open.
 * @returns `target`/`rel` when the URL is an external http(s) destination.
 */
export function externalHrefProps(url: string): {
  readonly target?: '_blank'
  readonly rel?: 'noopener noreferrer'
} {
  try {
    const protocol = new URL(url).protocol
    if (protocol === 'http:' || protocol === 'https:') {
      return { target: '_blank', rel: 'noopener noreferrer' }
    }
  } catch {
    // Unparseable URLs stay in-place; callers still render the href.
  }
  return {}
}
