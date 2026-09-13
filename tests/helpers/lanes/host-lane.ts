/**
 * The boot every host-lane spec shares: a scripted Zotero Local API, a Cordis
 * context carrying the system prompt and the tool runtime, and the plugin
 * mounted over the mock's base URL.
 *
 * The lane is returned as one object rather than installed by a global setup
 * file, so each spec calls `setupHostLane()` in its own `beforeEach` — or in
 * the test body where the boot varies per case — and `teardown()` in its own
 * `afterEach`: the wiring is visible at the call site that depends on it.
 * `runTool` keeps the call-id scheme the tool specs were written against
 * (`tool-<n>`, counted per lane), so `ctx.tools` sees the assembly it always
 * did.
 *
 * The optional compositions are the seams the host specs exercise beyond the
 * tool lane. Each one mounts before the plugin, because the plugin resolves
 * its injects at mount time: the stub command registry (`commands`), the
 * Typert registry (`typert`, whose endpoint registration has to be up while
 * the service mounts), and the in-memory settings provider (`settings`).
 * @module tests/helpers/lanes/host-lane
 */

import { Context, type Fiber } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolDefinition, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import type { Config } from '../../../src/config.js'
import ZoteroService from '../../../src/index.js'
import { MemorySettings } from '../memory-settings.js'
import { MockZotero } from '../mock-zotero.js'
import { StubCommands } from '../stub-commands.js'

/** The optional services a lane composes before the plugin mounts. */
export interface HostLaneOptions {
  /**
   * Compose the stub command registry, so the plugin's optional `/zotero`
   * command path registers; the registry itself is {@link HostLane.stub}.
   */
  readonly commands?: boolean
  /**
   * Compose the in-memory settings provider, seeded with this document (an
   * empty one when omitted), so the plugin registers its settings section
   * against a real seam instead of staying on its entry config.
   */
  readonly settings?: Record<string, unknown>
  /**
   * Compose the Typert registry before the plugin, so the host manifest
   * self-registers while the service is mounting (the optional inject waits
   * for it).
   */
  readonly typert?: boolean
}

/** One booted lane: the mounted context, the scripted server, and the call surface. */
export interface HostLane {
  /** The context the plugin is mounted on. */
  readonly ctx: Context
  /** The scripted Zotero Local API the plugin talks to. */
  readonly mock: MockZotero
  /** The plugin's own fiber; disposing it unwinds every registration. */
  readonly zoteroFiber: Fiber
  /** The stub command registry, present only when `commands` composed it. */
  readonly stub: StubCommands | undefined
  /** Execute one tool call the way the harness does, with a fresh signal and call id. */
  runTool(name: string, args: Record<string, unknown>): Promise<ToolExecutionResult>
  /** The registered definition for one tool name, if the assembly carries it. */
  tool(name: string): ToolDefinition | undefined
  /** Close the mock server; call it from the spec's `afterEach`. */
  teardown(): Promise<void>
}

/**
 * Boot the lane: a fresh mock server and a plugin mounted over it.
 * @param config - plugin config merged over the mock's base URL.
 * @param options - the optional services to compose before the plugin mounts.
 * @returns the booted lane; call {@link HostLane.teardown} when the test ends.
 */
export async function setupHostLane(
  config: Config = {},
  options: HostLaneOptions = {},
): Promise<HostLane> {
  const mock = await MockZotero.start()
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  if (options.commands === true) await ctx.plugin(StubCommands)
  if (options.typert === true) await ctx.plugin(TypertRegistry)
  if (options.settings !== undefined) await ctx.plugin(MemorySettings, options.settings)
  const zoteroFiber = ctx.plugin(ZoteroService, { baseUrl: mock.baseUrl, ...config })
  await zoteroFiber
  let callCounter = 0
  return {
    ctx,
    mock,
    zoteroFiber,
    stub: options.commands === true ? (ctx.get('commands') as unknown as StubCommands) : undefined,
    runTool(name, args) {
      return ctx.tools.execute({
        callId: ToolCallId(`tool-${++callCounter}`),
        name,
        arguments: args,
        signal: new AbortController().signal,
      })
    },
    tool(name) {
      return ctx.tools.get(name)
    },
    async teardown() {
      await mock.close()
    },
  }
}
