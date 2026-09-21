/** The `zotero_fulltext` tool: return complete indexed text for an item or attachment. */
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool, type InferArgs, type InferValue } from '@deepseek-ai/dsh-tools'
import type { ZoteroService } from '../service.js'
import { parseSupportedRef, REF_ARG_HINT } from './validate.js'

const PARAMETERS = {
  ref: {
    type: 'string',
    required: true,
    description: `An item or attachment ${REF_ARG_HINT} ref. Item refs resolve to Zotero's preferred PDF attachment.`,
  },
} as const

const OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attachmentKey: { type: 'string', required: true },
    indexedPages: { type: 'integer' },
    totalPages: { type: 'integer' },
    chars: { type: 'integer', required: true },
    content: { type: 'string', required: true },
  },
} as const

type Args = InferArgs<typeof PARAMETERS>
type Output = InferValue<typeof OUTPUT>

export function renderFulltext(_args: Args, value: Output): ContentBlock[] {
  const pages = value.totalPages === undefined ? '' : ` (${value.indexedPages ?? '?'}/${value.totalPages} pages)`
  return [{ type: 'text', text: `[Attachment ${value.attachmentKey}]${pages} — ${value.chars} indexed characters. Full content is available in the structured result.` }]
}

export function registerFulltextTool(ctx: Context, service: ZoteroService): () => void {
  return ctx.tools.register(
    defineTool({
      name: 'zotero_fulltext',
      description:
        "Return Zotero's complete indexed full text for one item or attachment. Prefer zotero_retrieve for query-focused evidence; use this tool when the complete raw indexed text is explicitly needed.",
      parameters: PARAMETERS,
      output: { schema: OUTPUT, render: renderFulltext },
      presentCall: (args) => ({ card: 'generic', kind: 'read', title: 'Read Zotero indexed full text', rawInput: args.ref }),
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return await service.fulltext(parseSupportedRef(args.ref, ['item', 'attachment']), exec.signal)
      },
    }),
  )
}
