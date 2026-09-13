/**
 * Minimal command registry stand-in so the plugin's optional `/zotero`
 * command path can be exercised: the host lane composes it when a spec wants
 * the command registered, and the Loader composition maps it onto
 * `test-stub-commands` so the shipped patch's row-dependent inject resolves.
 * One definition, because two structurally identical copies would have to be
 * kept in step by hand.
 * @module tests/helpers/stub-commands
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'

/** Minimal command registry stand-in the plugin's command path registers into. */
export class StubCommands extends Service {
  readonly registered: CommandDefinition[] = []

  constructor(ctx: Context) {
    super(ctx, 'commands')
  }

  register(definition: CommandDefinition): () => void {
    const registered = this.registered
    // Effect-scoped like the real registry: the registration lives in the
    // scope that called register(), so a disposed injection unwinds it.
    return this.ctx.effect(() => {
      registered.push(definition)
      return () => {
        const index = registered.indexOf(definition)
        if (index >= 0) registered.splice(index, 1)
      }
    }, 'StubCommands.register()')
  }
}
