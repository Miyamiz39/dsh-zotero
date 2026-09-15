/** Model-facing native Zotero DOCX finalizer and offline probe. */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool, type InferArgs, type InferValue } from '@deepseek-ai/dsh-tools'
import { withConnectivityAsk } from '../ask.js'
import type { ZoteroService } from '../service.js'
import { finalizeDocxBytes, probeDocxBytes } from './package.js'
import { prepareWorkspaceOutput, publishDocxExclusive, readWorkspaceDocx } from './workspace.js'

const FINALIZE_PARAMETERS = {
  input_path: {
    type: 'string',
    required: true,
    description:
      'Workspace-relative Univer-exported .docx containing canonical {{zotero-cite:zotero://user/0/item/ABCD1234}} markers.',
  },
  output_name: {
    type: 'string',
    description:
      'Optional plain sibling .docx basename. Defaults to <input>.zotero.docx and never overwrites.',
  },
  style: {
    type: 'string',
    description: 'CSL style id; defaults to the Zotero plugin configuration.',
  },
  locale: {
    type: 'string',
    description: 'CSL locale; defaults to the Zotero plugin configuration.',
  },
} as const

type FinalizeArgs = InferArgs<typeof FINALIZE_PARAMETERS>

const FINALIZE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    outputPath: { type: 'string', required: true },
    citationCount: { type: 'number', required: true },
    refs: { type: 'array', items: { type: 'string' }, required: true },
    bibliographyAdded: { type: 'boolean', required: true },
    valid: { type: 'boolean', required: true },
    sha256: { type: 'string', required: true },
    warnings: { type: 'array', items: { type: 'string' }, required: true },
  },
} as const

type FinalizeValue = InferValue<typeof FINALIZE_OUTPUT_SCHEMA>

const PROBE_PARAMETERS = {
  input_path: {
    type: 'string',
    required: true,
    description: 'Workspace-relative .docx to validate without contacting Zotero.',
  },
} as const

const PROBE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    filePath: { type: 'string', required: true },
    valid: { type: 'boolean', required: true },
    citationCount: { type: 'number', required: true },
    bibliographyCount: { type: 'number', required: true },
    hasDocumentPreferences: { type: 'boolean', required: true },
    unresolvedMarkers: { type: 'number', required: true },
    sha256: { type: 'string', required: true },
    warnings: { type: 'array', items: { type: 'string' }, required: true },
  },
} as const

type ProbeValue = InferValue<typeof PROBE_OUTPUT_SCHEMA>

/** Register both tools as effects of the service's agent-scoped Cordis fiber. */
export function registerDocxTools(ctx: Context, service: ZoteroService): void {
  ctx.tools.register(
    defineTool({
      name: 'zotero_docx_finalize',
      description:
        'After an approved Univer worktree is exported to DOCX, replace explicit Zotero markers with native Word ADDIN fields and add a dynamic bibliography. Creates a distinct file, independently probes it, and never overwrites. Open the result in desktop Word and run Zotero Refresh before final delivery.',
      parameters: FINALIZE_PARAMETERS,
      output: {
        schema: FINALIZE_OUTPUT_SCHEMA,
        render: renderFinalize,
      },
      presentCall: (args) => ({
        card: 'generic',
        kind: 'edit',
        title: 'Finalize Zotero DOCX',
        rawInput: args.input_path,
      }),
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const config = service.config
        const input = await readWorkspaceDocx(ctx, args.input_path, config.docxMaxBytes, exec)
        const output = await prepareWorkspaceOutput(ctx, input, args.output_name, exec.signal)
        const finalized = await withConnectivityAsk(ctx, service.recovery, exec, () =>
          finalizeDocxBytes(
            input.inputBytes,
            service,
            {
              style: nonBlank(args.style) ?? config.defaultStyle,
              locale: nonBlank(args.locale) ?? config.defaultLocale,
              legacyMarkers: config.docxLegacyMarkers,
              maxArchiveBytes: config.docxMaxBytes,
            },
            exec.signal,
          ),
        )
        await publishDocxExclusive(output, finalized.bytes, exec.signal)
        const reopened = await readWorkspaceDocx(
          ctx,
          output.relativePath,
          config.docxMaxBytes,
          exec,
        )
        const probe = probeDocxBytes(reopened.inputBytes, {
          legacyMarkers: config.docxLegacyMarkers,
          maxArchiveBytes: config.docxMaxBytes,
        })
        if (!probe.valid || probe.citationCount !== finalized.citationCount) {
          throw new Error('Published DOCX failed independent reopen validation.')
        }
        return {
          outputPath: output.relativePath,
          citationCount: finalized.citationCount,
          refs: [...finalized.refs],
          bibliographyAdded: finalized.bibliographyAdded,
          valid: probe.valid,
          sha256: sha256(reopened.inputBytes),
          warnings: [...new Set([...finalized.warnings, ...probe.warnings])],
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'zotero_docx_probe',
      description:
        'Offline read-only validation of a workspace DOCX for balanced native Zotero citation fields, exactly one bibliography, document preferences, package integrity, and unresolved markers. Never contacts Zotero.',
      parameters: PROBE_PARAMETERS,
      output: {
        schema: PROBE_OUTPUT_SCHEMA,
        render: renderProbe,
      },
      presentCall: (args) => ({
        card: 'generic',
        kind: 'read',
        title: 'Probe Zotero DOCX',
        rawInput: args.input_path,
      }),
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const config = service.config
        const input = await readWorkspaceDocx(ctx, args.input_path, config.docxMaxBytes, exec)
        const probe = probeDocxBytes(input.inputBytes, {
          legacyMarkers: config.docxLegacyMarkers,
          maxArchiveBytes: config.docxMaxBytes,
        })
        return {
          filePath: input.relativeInputPath,
          ...probe,
          warnings: [...probe.warnings],
          sha256: sha256(input.inputBytes),
        }
      },
    }),
  )

  if (!service.config.researchEnabled) {
    ctx.systemPrompt.section({
      name: 'zotero:docx-policy',
      order: 10_100,
      text: 'Zotero DOCX workflow: use zotero_docx_finalize only when the user requests native Zotero fields and only after the Univer worktree is approved and exported. Use its documented canonical zotero-cite marker syntax with complete zotero:// item refs, finalize to a distinct DOCX, probe it, then tell the user to open desktop Microsoft Word and run Zotero Refresh. Never claim compatibility from marker text alone.',
    })
  }
}

function renderFinalize(_args: FinalizeArgs, value: FinalizeValue): ContentBlock[] {
  return [
    {
      type: 'text',
      text: `Created ${value.outputPath} with ${value.citationCount} native Zotero citation field(s). Probe: ${value.valid ? 'valid' : 'invalid'}. Open it in desktop Microsoft Word and run Zotero Refresh before final delivery.${value.warnings.length === 0 ? '' : `\nWarnings: ${value.warnings.join('; ')}`}`,
    },
  ]
}

function renderProbe(_args: InferArgs<typeof PROBE_PARAMETERS>, value: ProbeValue): ContentBlock[] {
  return [
    {
      type: 'text',
      text: `${value.filePath}: ${value.valid ? 'valid Zotero DOCX' : 'not finalized'}; citations=${value.citationCount}, bibliography=${value.bibliographyCount}, preferences=${value.hasDocumentPreferences}, unresolved markers=${value.unresolvedMarkers}.${value.warnings.length === 0 ? '' : `\nWarnings: ${value.warnings.join('; ')}`}`,
    },
  ]
}

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
