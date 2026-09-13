/**
 * The write-authorization state of the plugin. Zotero 10 issues local write
 * keys through its own `/api/local/authorize` dialog — Allow (one write),
 * Always Allow (persistent), Deny — and consumes single-use keys at
 * authentication time, before the write runs. This module owns what that
 * implies for the plugin:
 *
 * - the persisted grant lives in the host credentials seam as a `grant`
 *   record bound to the Zotero instance id it was granted by; a record that
 *   names another instance is stale and is dropped, never used;
 * - a one-time key lives only in this process's memory and is forgotten as
 *   soon as the write it authorized settles — the server has consumed it
 *   either way;
 * - concurrent callers share one in-flight authorization. The dialog is the
 *   scarcest resource in the loop, and Zotero rate-limits the endpoint at
 *   five requests per minute.
 *
 * There is no key material in the plugin config and no key caching past the
 * semantics above: the credentials seam is re-read per operation by its own
 * discipline, and the memory slot only bridges the one-write lifetime of a
 * single-use grant.
 * @module dsh-zotero/write-auth
 */

import { credentialKey, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { asRecord, asString } from './json.js'
import { ZoteroWriteHttpClient } from './write-http.js'

/**
 * The name Zotero's authorization dialog shows the user for this plugin.
 * A stable, recognizable name: the user decides on it, not on a request.
 */
export const WRITE_APP_NAME = 'dsh (Zotero plugin)'

/**
 * The credentials record that carries this plugin's persistent write grant,
 * keyed under the plugin's own registered scope.
 */
export const WRITE_KEY_RECORD = credentialKey('dsh-zotero', 'local-write-key')

/** The grant payload this plugin stores; opaque to the credentials seam. */
export interface ZoteroWriteGrantPayload {
  /** The local API key Zotero issued. */
  readonly key: string
  /** The Zotero instance id the dialog that granted the key was served by. */
  readonly serverId: string
  /** The app name shown in the granting dialog, kept for the audit trail. */
  readonly appName: string
  /** When the dialog granted the key (ISO 8601). */
  readonly authorizedAt: string
}

export interface WriteAuthorizerDeps {
  /** The write transport; the authorize call rides it. */
  readonly client: ZoteroWriteHttpClient
  /** The host credentials seam; absent compositions keep grants in memory only. */
  readonly credentials?: CredentialProvider
  /**
   * Live read of the persist-grant setting. A live read, not a captured
   * boolean: a settings commit applies to the next authorization without a
   * rebuild.
   */
  readonly persistKey: () => boolean
}

/** One key for one write lifecycle: usable now, and either reusable or spent. */
export interface ZoteroWriteKey {
  readonly key: string
  /** True when Zotero will consume the key at authentication time. */
  readonly oneTime: boolean
}

/**
 * Resolve and maintain the plugin's write authorization for the connected
 * Zotero instance. `keyFor` is the entry point the write domain calls before
 * every batch: it answers with the persisted grant while it is bound to the
 * connected instance, else with this process's own grant, else it runs the
 * authorize dialog and answers with what the user granted.
 */
export class WriteAuthorizer {
  private memoryKey: string | undefined
  private memoryServerId: string | undefined
  private memoryOneTime: boolean
  private authorizing: Promise<ZoteroWriteKey> | undefined

  constructor(private readonly deps: WriteAuthorizerDeps) {
    this.memoryOneTime = false
  }

  /**
   * The key to write with for this Zotero instance.
   * @param serverId - the instance id the plugin last read from; grants are
   *   bound to it, so a write follows the instance the reads saw.
   * @param signal - caller cancellation, forwarded to the authorize request.
   * @returns the key plus whether Zotero will consume it on first use.
   */
  async keyFor(serverId: string, signal?: AbortSignal): Promise<ZoteroWriteKey> {
    const stored = await this.storedKey(serverId)
    if (stored !== undefined) return { key: stored, oneTime: false }
    if (this.memoryKey !== undefined && this.memoryServerId === serverId) {
      return { key: this.memoryKey, oneTime: this.memoryOneTime }
    }
    if (this.authorizing === undefined) {
      this.authorizing = this.authorize(serverId, signal).finally(() => {
        this.authorizing = undefined
      })
    }
    return await this.authorizing
  }

  /**
   * Whether a grant for this Zotero instance is already available — the
   * in-memory key of this process, or a persisted grant bound to the
   * instance. A status fact for the settings card and the command output;
   * never a capability: {@link keyFor} still runs the full resolution.
   */
  async hasGrant(serverId: string): Promise<boolean> {
    if (this.memoryKey !== undefined && this.memoryServerId === serverId) return true
    const credentials = this.deps.credentials
    if (credentials === undefined) return false
    const record = await credentials.readRecord(WRITE_KEY_RECORD)
    if (record?.kind !== 'grant') return false
    const payload = asRecord(record.payload)
    const key = payload === undefined ? undefined : asString(payload.key)
    const boundTo = payload === undefined ? undefined : asString(payload.serverId)
    return key !== undefined && key !== '' && boundTo === serverId
  }

  /**
   * Forget this process's copy of a key. Called by the domain when the write
   * a one-time key authorized has settled — the server consumed the key at
   * authentication whether the write succeeded or failed, so the memory slot
   * must never answer with it again. Persisted grants are untouched.
   * @param key - the one-time key the domain is done with.
   */
  forget(key: string): void {
    if (this.memoryKey === key) {
      this.memoryKey = undefined
      this.memoryServerId = undefined
    }
  }

  /**
   * The persisted grant for this instance, or undefined. The record is
   * re-read on every call (the credentials seam's own discipline: never
   * cache a secret across operations), and a grant bound to another Zotero
   * instance is deleted rather than used — the next authorization then
   * re-binds to the instance actually connected.
   */
  private async storedKey(serverId: string): Promise<string | undefined> {
    const credentials = this.deps.credentials
    if (credentials === undefined) return undefined
    const record = await credentials.readRecord(WRITE_KEY_RECORD)
    if (record?.kind !== 'grant') return undefined
    const payload = asRecord(record.payload)
    const key = payload === undefined ? undefined : asString(payload.key)
    const boundTo = payload === undefined ? undefined : asString(payload.serverId)
    if (key === undefined || key === '') return undefined
    if (boundTo !== serverId) {
      await credentials.deleteRecord(WRITE_KEY_RECORD)
      return undefined
    }
    return key
  }

  /**
   * Run the authorize dialog. A grant the user marked Always Allow is
   * persisted into the credentials seam — bound to this instance — when the
   * seam is composed and the setting allows it; every grant is also kept in
   * memory so the immediate next write does not re-open the dialog.
   */
  private async authorize(serverId: string, signal?: AbortSignal): Promise<ZoteroWriteKey> {
    const grant = await this.deps.client.authorize(WRITE_APP_NAME, { serverId, signal })
    this.memoryKey = grant.key
    this.memoryServerId = serverId
    this.memoryOneTime = !grant.remember
    if (grant.remember && this.deps.persistKey() && this.deps.credentials !== undefined) {
      const payload: ZoteroWriteGrantPayload = {
        key: grant.key,
        serverId,
        appName: WRITE_APP_NAME,
        authorizedAt: new Date().toISOString(),
      }
      await this.deps.credentials.modifyRecord(WRITE_KEY_RECORD, async () => ({
        kind: 'grant',
        payload,
      }))
    }
    return { key: grant.key, oneTime: !grant.remember }
  }
}
