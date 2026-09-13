/**
 * The boot every tool spec under `tests/tools/` shares: a scripted Zotero
 * Local API, a Cordis context carrying the system prompt and the tool
 * runtime, and the plugin mounted over the mock's base URL.
 *
 * The lane is returned as one object rather than installed by a global setup
 * file, so each spec calls `setupHostLane()` in its own `beforeEach` and
 * `teardown()` in its own `afterEach` — the wiring is visible at the call
 * site that depends on it. `runTool` keeps the call-id scheme the tool specs
 * were written against (`tool-<n>`, counted per lane), so `ctx.tools` sees the
 * assembly it always did.
 * @module tests/helpers/lanes/host-lane
 */

import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolDefinition, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { Config } from '../../../src/config.js'
import ZoteroService from '../../../src/index.js'
import { MockZotero } from '../mock-zotero.js'

/** One booted tool lane: the mounted context, the scripted server, and the call surface. */
export interface HostLane {
  /** The context the plugin is mounted on. */
  readonly ctx: Context
  /** The scripted Zotero Local API the plugin talks to. */
  readonly mock: MockZotero
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
 * @returns the booted lane; call {@link HostLane.teardown} when the test ends.
 */
export async function setupHostLane(config: Config = {}): Promise<HostLane> {
  const mock = await MockZotero.start()
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  await ctx.plugin(ZoteroService, { baseUrl: mock.baseUrl, ...config })
  let callCounter = 0
  return {
    ctx,
    mock,
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
