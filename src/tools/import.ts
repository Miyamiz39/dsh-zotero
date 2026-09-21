/** The `zotero_import` tool: approved BibTeX/RIS import through Zotero Connector. */
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool, type InferArgs, type InferValue } from '@deepseek-ai/dsh-tools'
import type { ZoteroService } from '../service.js'
import { askPlanApproval } from './write-approval.js'
import { invalid } from './validate.js'

const PARAMETERS = {
  content: {
    type: 'string',
    required: true,
    description: 'Raw BibTeX or RIS records to import. The exact content is written only after user approval.',
  },
  session_id: {
    type: 'string',
    description: 'Optional Connector session identifier (letters, digits, underscore, or hyphen; max 80 characters).',
  },
} as const

const OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: ['applied', 'declined'], required: true },
    importedCount: { type: 'integer' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          key: { type: 'string' },
          title: { type: 'string', required: true },
          itemType: { type: 'string', required: true },
        },
      },
    },
    message: { type: 'string' },
  },
} as const

type Args = InferArgs<typeof PARAMETERS>
type Output = InferValue<typeof OUTPUT>

export function importPlan(args: Args): string {
  const records = (args.content.match(/^\s*(?:@\w+\s*\{|TY\s{2}-)/gm) ?? []).length
  return [
    '**Import bibliographic records into Zotero**',
    `- Detected records: ${records || 'unknown'}`,
    `- Input size: ${args.content.length} characters`,
    '- Destination: Zotero Desktop decides the collection for this Connector import.',
    '- Retrying after an ambiguous timeout may create duplicates.',
  ].join('\n')
}

function validateArgs(args: Args): void {
  if (args.content.trim() === '') invalid('content must contain BibTeX or RIS records.')
  if (args.content.length > 2_000_000) invalid('content must not exceed 2000000 characters.')
  if (args.session_id !== undefined && !/^[A-Za-z0-9_-]{1,80}$/.test(args.session_id)) {
    invalid('session_id must contain 1-80 letters, digits, underscores, or hyphens.')
  }
}

export function renderImport(_args: Args, value: Output): ContentBlock[] {
  if (value.kind === 'declined') return [{ type: 'text', text: 'Declined: nothing was imported.' }]
  const lines = [`Imported ${value.importedCount ?? 0} record(s) into Zotero.`]
  for (const item of value.items ?? []) lines.push(`- ${item.key === undefined ? '' : `[${item.key}] `}${item.title} (${item.itemType})`)
  return [{ type: 'text', text: lines.join('\n') }]
}

export function registerImportTool(ctx: Context, service: ZoteroService): () => void {
  return ctx.tools.register(
    defineTool({
      name: 'zotero_import',
      description:
        'Import raw BibTeX or RIS records into Zotero Desktop through its Connector endpoint. This mutates the library, always shows an approval plan when write confirmation is enabled, and is never retried automatically after an ambiguous failure.',
      parameters: PARAMETERS,
      output: { schema: OUTPUT, render: renderImport },
      presentCall: () => ({ card: 'generic', kind: 'edit', title: 'Import records into Zotero' }),
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        validateArgs(args)
        if (service.config.writeConfirm) {
          const approved = await askPlanApproval(ctx, exec, importPlan(args))
          if (!approved) return { kind: 'declined' } as const
        }
        return await service.importRecords(args.content, { sessionId: args.session_id }, exec.signal)
      },
    }),
  )
}
