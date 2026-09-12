/**
 * Zotero settings, browser half — one surface over the `zotero` namespace:
 * a page in the harness's Settings panel's left navigation
 * (`settings.section`, a sibling of General, Models, and Plugins), carrying
 * the full configuration form so a namespace this wide is never read through
 * a collapsed card.
 *
 * The page reads and writes the `zotero` namespace through the harness's own
 * settings scope (`ctx.settingsScope`) — the seam that serves every
 * registered namespace — with the staged form the harness's own settings
 * surfaces use (stage locally, write only on save, mark user-layer presence
 * as overridden). The Typert Remote namespace carries only the live
 * connectivity probe the dedicated conversation tab renders. The namespace
 * spelling comes from the shared settings-namespace module, so the two halves
 * cannot drift apart.
 * @module dsh-zotero/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only Context merges: locale (ctx.locale) arrives through its package's
// client declaration; the Remote face (ctx.remote) through the api-remotes
// assembly; ui-settings supplies the `settingsScope` service and the
// `settings.section` SlotMap row this page registers into; ui-renderer the
// `slots` registry. Cross-plugin collaboration rides services and slot
// declarations, never value imports (client bundle purity).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the `conversation.view` SlotMap row (declared by the slot's
// owning package) must be in the program for the tab registration to type.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { TypertRemoteNamespaceMap } from '@deepseek-ai/dsh-typert-protocol'
import { ZoteroSettingsSection } from './ZoteroSettingsSection.tsx'
import { SourcesTab, type SourcesTabFace } from './components/SourcesTab.tsx'
import { ZOTERO_REMOTE } from './remote.ts'
import type { ZoteroRemoteFace } from './remote.ts'
import { ZoteroCardController } from './zotero-card-controller.ts'
import { ZOTERO_SETTINGS_NAMESPACE } from '../settings-namespace.ts'
import { en, zh } from './locales.ts'

/** Dictionary namespace owned by this plugin. */
const NS = 'zotero'

/** Required services (cordis fiber inject): settingsScope's binder resolves the caller's connection and remote. */
export const inject = ['locale', 'slots', 'connection', 'settingsScope', 'remote']

/**
 * The mounted `zotero` namespace face, or `undefined` when this fiber cannot
 * reach it.
 *
 * The documented read is the traced child service (`ctx.remote.<namespace>`),
 * and it is tried first. Re-checked at dsh 0.1.5-rc.1: `$mount` still installs
 * that child service on the **gateway's own** context
 * (`api/gateway/src/client/index.ts` → `$mount` → `createNamespace` →
 * `this.ownerCtx.plugin(...)`), while the docs describe it as "for the calling
 * Cordis fiber" (`docs/api-gateway.md`). A plugin entry whose context sits on a
 * different branch of the loader's fiber tree therefore reads `undefined`
 * there. The store path (`ctx.reflect.get`) resolves the same service by key
 * across that branch, so it is the fallback — not the primary, so an upstream
 * fix of the mount context takes effect with no further edit here.
 * @param ctx - the browser plugin context.
 * @returns the namespace face, or undefined while it is unmounted.
 */
function mountedNamespace(ctx: ClientContext): ZoteroRemoteFace | undefined {
  const remote = ctx.remote as Partial<TypertRemoteNamespaceMap>
  return remote.zotero ?? (ctx.reflect.get('remote.zotero') as ZoteroRemoteFace | undefined)
}

/**
 * Mount the Zotero settings page into the Settings panel's left navigation.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-zotero: page dictionaries')
  // One binder for the namespace the host half registers; the card stages and
  // saves through it. The default decode (schema rehydrate + validate,
  // fail-closed to non-ready) is the authority — no lenient bypass. This entry
  // declares only its own dependency (`webEnabled` for the tab gate); the card
  // form owns the full field table through `ZoteroCardController` (which binds
  // the same scope as a record), so the narrow type is the entry's read
  // contract, not a truncation of the stored document.
  const scope = ctx.settingsScope.bind<{ webEnabled?: boolean }>({
    namespace: ZOTERO_SETTINGS_NAMESPACE,
  })
  const card = new ZoteroCardController(scope)
  // The nav label is shell chrome, so it is read through a bound reader at
  // registration time (the shell re-renders from the ledger bump when the
  // locale changes, not from its own subscription).
  const t = ctx.locale.bind(NS)

  // The configuration page: one left-nav entry in the Settings panel, beside
  // General, Models, and Plugins. The shell renders the nav label from these
  // options and mounts the page in its content column; `slots.inject` waits
  // for the settings shell's declaration of `settings.section`, so the page
  // survives shell reloads and vanishes atomically with this fiber. Order 25
  // keeps this page inside the shipped block (0–20) and clear of the
  // third-party sections that start at 30.
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'zotero',
        order: 25,
        label: () => t('nav'),
        locale: NS,
        inject: () => card.inject(),
      },
      ZoteroSettingsSection,
    ),
  )

  let zotero: ZoteroRemoteFace | undefined
  ctx.effect(async () => {
    const dispose = await ctx.remote.$mount(ZOTERO_REMOTE)
    zotero = mountedNamespace(ctx)
    if (zotero === undefined) {
      throw new Error('dsh-zotero: the zotero Remote namespace did not mount')
    }
    // The dedicated Sources panel (a conversation tab) registers unless the
    // `webEnabled` namespace flag is explicitly off; before the first snapshot
    // the tab stays on, so a config hiccup never blocks it. The gate is live:
    // toggling the flag in the card hides or restores the tab without a
    // reload.
    let tabDispose: (() => void) | undefined
    const tabT = ctx.locale.bind(NS)
    // Captured once the mount resolves: the tab face closes over this local,
    // never over the mutable `zotero` slot the cleanup clears — a resolve in
    // the remount gap cannot throw on a cleared namespace.
    const face: ZoteroRemoteFace = zotero
    const sync = (): void => {
      const snapshot = scope.getSnapshot()
      const enabled = snapshot.status !== 'ready' || snapshot.value?.webEnabled !== false
      if (enabled && tabDispose === undefined) {
        tabDispose = ctx.slots.inject('conversation.view', () =>
          ctx.slots.register(
            {
              name: 'conversation.view',
              id: 'zotero',
              order: 30,
              locale: NS,
              label: () => tabT('nav'),
              inject: (): SourcesTabFace => ({
                status: () => face.status(),
              }),
            },
            SourcesTab,
          ),
        )
      } else if (!enabled && tabDispose !== undefined) {
        tabDispose()
        tabDispose = undefined
      }
    }
    const unsubscribe = scope.subscribe(sync)
    sync()
    return () => {
      unsubscribe()
      tabDispose?.()
      zotero = undefined
      void dispose()
    }
  }, 'dsh-zotero: remote')
}
