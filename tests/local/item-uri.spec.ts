import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseRef } from '../../src/refs.js'
import {
  setupProvider,
  teardownProvider,
  type ProviderHarness,
} from '../helpers/provider-harness.js'
import { apiPath, GROUP_ID, GROUP_LIBRARY, ITEM_KEY } from '../helpers/server/keys.js'
import { item } from '../helpers/server/objects.js'

let harness: ProviderHarness

beforeEach(async () => {
  harness = await setupProvider()
})

afterEach(async () => {
  await teardownProvider(harness)
})

describe('authoritative canonical item URI', () => {
  it('uses Zotero alternate metadata to recover the real personal-library user id', async () => {
    harness.mock.route('GET', `${apiPath()}/items/${ITEM_KEY}`, (_req, _res, helpers) => {
      helpers.json(
        item({
          links: {
            alternate: {
              href: `https://www.zotero.org/users/123456/items/${ITEM_KEY}`,
              type: 'text/html',
            },
          },
        }),
      )
    })
    await expect(
      harness.provider.canonicalItemUri(parseRef(`zotero://user/0/item/${ITEM_KEY}`)),
    ).resolves.toBe(`http://zotero.org/users/123456/items/${ITEM_KEY}`)
  })

  it('keeps a matching group id authoritative', async () => {
    harness.mock.route(
      'GET',
      `${apiPath(GROUP_LIBRARY)}/items/${ITEM_KEY}`,
      (_req, _res, helpers) => {
        helpers.json(
          item({
            links: {
              alternate: {
                href: `https://www.zotero.org/groups/${GROUP_ID}/items/${ITEM_KEY}`,
                type: 'text/html',
              },
            },
          }),
        )
      },
    )
    await expect(
      harness.provider.canonicalItemUri(parseRef(`zotero://group/${GROUP_ID}/item/${ITEM_KEY}`)),
    ).resolves.toBe(`http://zotero.org/groups/${GROUP_ID}/items/${ITEM_KEY}`)
  })

  it('rejects a mismatched alternate library identity', async () => {
    harness.mock.route('GET', `${apiPath()}/items/${ITEM_KEY}`, (_req, _res, helpers) => {
      helpers.json(
        item({
          links: {
            alternate: {
              href: `https://www.zotero.org/groups/${GROUP_ID}/items/${ITEM_KEY}`,
              type: 'text/html',
            },
          },
        }),
      )
    })
    await expect(
      harness.provider.canonicalItemUri(parseRef(`zotero://user/0/item/${ITEM_KEY}`)),
    ).rejects.toThrow(/authoritative alternate item URI/)
  })
})
