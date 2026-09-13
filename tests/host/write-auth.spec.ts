import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import type {
  CredentialInfo,
  CredentialKey,
  CredentialRecord,
  CredentialRecordEntry,
  CredentialRecordInfo,
  CredentialRef,
  ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { WRITE_APP_NAME, WRITE_KEY_RECORD, WriteAuthorizer } from '../../src/write-auth.js'
import { ZoteroWriteHttpClient } from '../../src/write-http.js'
import { WRITE_AUTH_DENIED_MESSAGE, ZOTERO_WRITE_UNAUTHORIZED } from '../../src/errors.js'
import { MockZotero } from '../helpers/mock-zotero.js'
import { deferred } from '../helpers/sync.js'

const SERVER_ID = 'srv-auth-spec-0001'
const OTHER_SERVER_ID = 'srv-other-00002'
const ISSUED_KEY = 'K'.repeat(32)
const AUTHORIZE_PATH = '/api/local/authorize'

/**
 * The smallest real credentials seam: an in-memory record map, so the spec
 * observes exactly what the authorizer persists and deletes.
 */
class MemoryCredentials extends CredentialProvider {
  readonly records = new Map<string, CredentialRecord>()
  readonly deletions: string[] = []

  constructor(ctx: Context) {
    super(ctx)
  }

  async resolve(_ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    return undefined
  }

  async describe(_ref: CredentialRef): Promise<CredentialInfo> {
    return { configured: false, writable: true }
  }

  async set(_ref: CredentialRef, _value: string): Promise<void> {}

  async unset(_ref: CredentialRef): Promise<void> {}

  async readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    return this.records.get(String(key))
  }

  async describeRecord(_key: CredentialKey): Promise<CredentialRecordInfo> {
    return { configured: false, writable: true }
  }

  async listRecords(): Promise<readonly CredentialRecordEntry[]> {
    return []
  }

  async modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    const next = await mutate(this.records.get(String(key)))
    if (next === undefined) return this.records.get(String(key))
    this.records.set(String(key), next)
    return next
  }

  async deleteRecord(key: CredentialKey): Promise<void> {
    this.deletions.push(String(key))
    this.records.delete(String(key))
  }
}

function grantBody(key: string, remember: boolean): string {
  return JSON.stringify({ key, remember })
}

function storedGrant(key: string, serverId = SERVER_ID): CredentialRecord {
  return {
    kind: 'grant',
    payload: { key, serverId, appName: WRITE_APP_NAME, authorizedAt: '2026-09-13T00:00:00.000Z' },
  }
}

/** Register the authorize dialog answer the current test needs. */
function authorizeOnce(remember: boolean): void {
  mock.route('POST', AUTHORIZE_PATH, (_req, res, helpers) => {
    authorizeCalls += 1
    helpers.raw(200, { 'Zotero-Server-ID': SERVER_ID }, grantBody(ISSUED_KEY, remember))
  })
}

let mock: MockZotero
let client: ZoteroWriteHttpClient
let credentials: MemoryCredentials
let authorizeCalls: number

function authorizer(persistKey = true): WriteAuthorizer {
  return new WriteAuthorizer({
    client,
    credentials,
    persistKey: () => persistKey,
  })
}

function authorizerWithoutSeam(): WriteAuthorizer {
  return new WriteAuthorizer({ client, persistKey: () => true })
}

beforeEach(async () => {
  mock = await MockZotero.start()
  client = new ZoteroWriteHttpClient({
    baseUrl: mock.baseUrl,
    timeoutMs: 5000,
    maxResponseBytes: 1024 * 1024,
  })
  const ctx = new Context()
  const fiber: Fiber = ctx.plugin(MemoryCredentials)
  await fiber
  credentials = ctx.get('credentials') as MemoryCredentials
  authorizeCalls = 0
})

afterEach(async () => {
  await mock.close()
})

describe('persisted grants', () => {
  beforeEach(() => authorizeOnce(true))

  it('persists an Always-Allow grant and reuses it without another dialog', async () => {
    const writer = authorizer()
    const first = await writer.keyFor(SERVER_ID)
    expect(first).toEqual({ key: ISSUED_KEY, oneTime: false })
    expect(authorizeCalls).toBe(1)
    const stored = credentials.records.get(String(WRITE_KEY_RECORD))
    expect(stored).toMatchObject({
      kind: 'grant',
      payload: { key: ISSUED_KEY, serverId: SERVER_ID },
    })
    const second = await writer.keyFor(SERVER_ID)
    expect(second.key).toBe(ISSUED_KEY)
    expect(authorizeCalls).toBe(1)
    expect(mock.requests).toHaveLength(1)
  })

  it('reuses a grant the user already stored without consulting Zotero', async () => {
    credentials.records.set(String(WRITE_KEY_RECORD), storedGrant('stored-key-01'))
    const writer = authorizer()
    const key = await writer.keyFor(SERVER_ID)
    expect(key).toEqual({ key: 'stored-key-01', oneTime: false })
    expect(authorizeCalls).toBe(0)
    expect(mock.requests).toHaveLength(0)
  })

  it('does not persist when the setting is off, and still reuses the grant in-process', async () => {
    const writer = authorizer(false)
    await writer.keyFor(SERVER_ID)
    expect(credentials.records.size).toBe(0)
    const second = await writer.keyFor(SERVER_ID)
    expect(second.key).toBe(ISSUED_KEY)
    expect(authorizeCalls).toBe(1)
  })

  it('keeps working when no credentials service is composed', async () => {
    const writer = authorizerWithoutSeam()
    const first = await writer.keyFor(SERVER_ID)
    expect(first.oneTime).toBe(false)
    const second = await writer.keyFor(SERVER_ID)
    expect(second.key).toBe(first.key)
    expect(authorizeCalls).toBe(1)
  })

  it('drops a stored grant that names another Zotero instance and re-authorizes', async () => {
    credentials.records.set(String(WRITE_KEY_RECORD), storedGrant('stale-key-999', OTHER_SERVER_ID))
    const writer = authorizer()
    const key = await writer.keyFor(SERVER_ID)
    expect(key.key).toBe(ISSUED_KEY)
    expect(credentials.deletions).toContain(String(WRITE_KEY_RECORD))
    const rebound = credentials.records.get(String(WRITE_KEY_RECORD))
    expect(rebound).toMatchObject({
      kind: 'grant',
      payload: { key: ISSUED_KEY, serverId: SERVER_ID },
    })
  })
})

describe('one-time keys', () => {
  it('reuses the one-time key inside the process but never persists it', async () => {
    authorizeOnce(false)
    const writer = authorizer()
    const first = await writer.keyFor(SERVER_ID)
    expect(first.oneTime).toBe(true)
    const second = await writer.keyFor(SERVER_ID)
    expect(second.key).toBe(ISSUED_KEY)
    expect(credentials.records.size).toBe(0)
  })

  it('forgets a one-time key when the domain settles the write', async () => {
    authorizeOnce(false)
    const writer = authorizer()
    const first = await writer.keyFor(SERVER_ID)
    writer.forget(first.key)
    await writer.keyFor(SERVER_ID)
    expect(authorizeCalls).toBe(2)
  })

  it('authorizes once for concurrent callers', async () => {
    const release = deferred<void>()
    mock.route('POST', AUTHORIZE_PATH, async (_req, res, helpers) => {
      authorizeCalls += 1
      await release.promise
      helpers.raw(200, { 'Zotero-Server-ID': SERVER_ID }, grantBody(ISSUED_KEY, false))
    })
    const writer = authorizer()
    const first = writer.keyFor(SERVER_ID)
    const second = writer.keyFor(SERVER_ID)
    release.resolve()
    const [a, b] = await Promise.all([first, second])
    expect(authorizeCalls).toBe(1)
    expect(a.key).toBe(b.key)
  })
})

describe('hasGrant (status fact)', () => {
  it('reports the in-memory grant for the connected instance', async () => {
    authorizeOnce(true)
    const writer = authorizer()
    await writer.keyFor(SERVER_ID)
    expect(await writer.hasGrant(SERVER_ID)).toBe(true)
    expect(await writer.hasGrant(OTHER_SERVER_ID)).toBe(false)
  })

  it('reports a persisted grant bound to the asking instance only', async () => {
    credentials.records.set(String(WRITE_KEY_RECORD), storedGrant('stored-key-02'))
    const writer = authorizer()
    expect(await writer.hasGrant(SERVER_ID)).toBe(true)
    expect(await writer.hasGrant(OTHER_SERVER_ID)).toBe(false)
  })

  it('reports no grant without a credentials seam or an in-process key', async () => {
    const authorizer = authorizerWithoutSeam()
    expect(await authorizer.hasGrant(SERVER_ID)).toBe(false)
  })
})

describe('authorization refusals', () => {
  it('surfaces a declined dialog as the typed unauthorized error', async () => {
    mock.route('POST', AUTHORIZE_PATH, (_req, res, helpers) =>
      helpers.raw(403, { 'Content-Type': 'application/json' }, '{"denied": true}'),
    )
    let thrown: unknown
    try {
      await authorizer().keyFor(SERVER_ID)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toBe(WRITE_AUTH_DENIED_MESSAGE)
    expect((thrown as { code?: string }).code).toBe(ZOTERO_WRITE_UNAUTHORIZED)
  })

  it('does not offer a memory key that belongs to another instance', async () => {
    authorizeOnce(true)
    const writer = authorizer()
    await writer.keyFor(SERVER_ID)
    writer.forget(ISSUED_KEY)
    await writer.keyFor(OTHER_SERVER_ID)
    expect(authorizeCalls).toBe(2)
  })
})
