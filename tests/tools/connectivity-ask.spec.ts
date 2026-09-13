/**
 * The connectivity failure path: one tool call against an unreachable Zotero
 * asks the user once and retries, surfacing the typed not-running error
 * without looping.
 * @module tests/tools/connectivity-ask
 */

import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import ZoteroService from '../../src/index.js'
import { type HostLane, setupHostLane } from '../helpers/lanes/host-lane.js'
import { MockZotero } from '../helpers/mock-zotero.js'

let lane: HostLane

beforeEach(async () => {
  lane = await setupHostLane()
})

afterEach(async () => {
  await lane.teardown()
})

describe('connectivity failure ask', () => {
  it('asks the user once and retries the request when Zotero is unreachable', async () => {
    const down = await MockZotero.start()
    const downUrl = down.baseUrl
    await down.close()

    const askCtx = new Context()
    await askCtx.plugin(SystemPrompt, {})
    await askCtx.plugin(ToolRuntime, {})
    await askCtx.plugin(UserQuestionService)
    const asked: unknown[] = []
    // The alpha.1 ask seam is a scope-filtered waterfall: the listener claims
    // the request by returning an answer; the plugin's ask flow consumes the
    // same request/answer contract the old provider registration served.
    const retryOption = 'I started Zotero, retry (Recommended)'
    askCtx.on('user-questions/request', async (request, _next) => {
      asked.push(request)
      return { answers: [{ id: 'zotero-failure', selected: [retryOption] }] }
    })
    await askCtx.plugin(ZoteroService, { baseUrl: downUrl })

    const result = await askCtx.tools.execute({
      callId: ToolCallId('tool-ask-connectivity'),
      name: 'zotero_search',
      arguments: { query: 'flash attention', limit: 5 },
      signal: new AbortController().signal,
    })
    expect(result.isError).toBe(true)
    if (!result.isError) throw new Error('unreachable')
    // The retry hit the same unreachable instance and surfaced the typed
    // error; the user was asked exactly once, never looped.
    expect((result.content[0] as { text: string }).text).toContain('not running')
    expect(asked).toHaveLength(1)
    const request = asked[0] as { questions: { id: string; options: { label: string }[] }[] }
    expect(request.questions[0]!.id).toBe('zotero-failure')
    expect(request.questions[0]!.options![0]!.label).toBe(retryOption)
  })
})
