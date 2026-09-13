/**
 * The `zotero_changes` tool: incremental awareness of the local library.
 * Zotero 10+ versions are local transaction versions — any edit, sync, or
 * local write advances them — so a `since` diff answers "what changed in my
 * library" request-driven, without the cloud and without background
 * polling. A call without `since` takes a baseline reading (current version
 * only); the model passes that version back as `since` later.
 * @module dsh-zotero/tools/changes
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import {
  defineTool,
  type InferArgs,
  type InferValue,
  type ToolResult,
  type ToolResultView,
} from '@deepseek-ai/dsh-tools'
import { withConnectivityAsk } from '../ask.js'
import { asRecord } from '../json.js'
import { boundedPresentationMeta } from '../presentation-meta.js'
import { metaRecordOf } from './present.js'
import { assertIntInRange, assertNonEmptyList, parseLibrary } from './validate.js'
import type { ZoteroChangesInclude, ZoteroChangesRequest, SupportedLocalLibrary } from '../types.js'
import type { ZoteroService } from '../service.js'

const ALL_INCLUDES: ZoteroChangesInclude[] = [
  'items',
  'collections',
  'savedSearches',
  'fulltext',
  'deleted',
]

/**
 * The kinds a call covers when the model names none. `fulltext` is excluded:
 * its endpoint answers in the full-text index's own version counter, not the
 * library version this tool diffs on, so it cannot be part of the cursor story
 * and is only read when asked for by name. Mirrors `DEFAULT_CHANGES_INCLUDES`
 * in `src/local/changes-domain.ts`.
 */
const DEFAULT_INCLUDES: ZoteroChangesInclude[] = [
  'items',
  'collections',
  'savedSearches',
  'deleted',
]

const CHANGES_PARAMETERS = {
  library: {
    type: 'object',
    additionalProperties: false,
    properties: {
      type: { type: 'string', enum: ['user', 'group'], required: true },
      id: { type: 'integer', required: true },
    },
    description: 'Library to diff; omitted defaults to personal user/0.',
  },
  since: {
    type: 'integer',
    description:
      'The library version to diff from — reuse toVersion from an earlier zotero_changes result that carried one. Never advance from a result without toVersion: that read did not verify the whole range. A version covers only the resource kinds the call that produced it included. Omit to take a baseline reading (current version, no diffs).',
  },
  include: {
    type: 'array',
    items: { type: 'string', enum: [...ALL_INCLUDES] },
    default: DEFAULT_INCLUDES,
    description:
      'Resource kinds to diff; defaults to everything but fulltext. deleted lists tombstoned keys. fulltext is a separate listing: its endpoint answers in the full-text index\u2019s own version counter, so its rows are not a delta on the library version and it is left out unless named explicitly.',
  },
} as const

type ChangesArgs = InferArgs<typeof CHANGES_PARAMETERS>

const CHANGED_OBJECT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    key: { type: 'string', required: true },
    version: { type: 'integer', required: true },
  },
} as const

const CHANGES_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    library: {
      type: 'object',
      additionalProperties: false,
      properties: {
        type: { type: 'string', required: true },
        id: { type: 'integer', required: true },
      },
    },
    serverId: { type: 'string' },
    fromVersion: { type: 'integer' },
    toVersion: { type: 'integer' },
    libraryChanged: { type: 'boolean' },
    changed: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        items: { type: 'array', items: CHANGED_OBJECT },
        collections: { type: 'array', items: CHANGED_OBJECT },
        savedSearches: { type: 'array', items: CHANGED_OBJECT },
        fulltextAttachments: { type: 'array', items: CHANGED_OBJECT },
      },
    },
    deleted: {
      type: 'object',
      additionalProperties: false,
      properties: {
        items: { type: 'array', required: true, items: { type: 'string' } },
        collections: { type: 'array', required: true, items: { type: 'string' } },
        savedSearches: { type: 'array', required: true, items: { type: 'string' } },
      },
    },
    totals: {
      type: 'object',
      additionalProperties: false,
      properties: {
        items: { type: 'integer' },
        collections: { type: 'integer' },
        savedSearches: { type: 'integer' },
        fulltextAttachments: { type: 'integer' },
        deletedItems: { type: 'integer' },
        deletedCollections: { type: 'integer' },
        deletedSavedSearches: { type: 'integer' },
      },
    },
    unsupported: { type: 'array', items: { type: 'string', enum: [...ALL_INCLUDES] } },
    truncated: { type: 'boolean' },
  },
} as const

type ChangesOutput = InferValue<typeof CHANGES_OUTPUT_SCHEMA>

function buildRequest(args: ChangesArgs): ZoteroChangesRequest {
  const library = parseLibrary((args as Record<string, unknown>).library)
  const since = args.since
  if (since !== undefined) assertIntInRange('since', since, 0, Number.MAX_SAFE_INTEGER)
  if (args.include !== undefined) {
    assertNonEmptyList(
      args.include as readonly unknown[],
      'include must list at least one resource kind when provided',
    )
  }
  const include = new Set<ZoteroChangesInclude>(
    (args.include as ZoteroChangesInclude[] | undefined) ?? DEFAULT_INCLUDES,
  )
  return {
    ...(library !== undefined ? { library: library as SupportedLocalLibrary } : {}),
    ...(since !== undefined ? { since } : {}),
    include,
  }
}

export function renderChanges(_args: ChangesArgs, value: ChangesOutput): ContentBlock[] {
  const lines = []
  if (value.fromVersion === undefined) {
    lines.push(
      `Baseline reading${value.toVersion === undefined ? '' : `: library is at version ${value.toVersion}`}. Pass it as since on a later call to see what changed.`,
    )
  } else if (value.toVersion !== undefined) {
    lines.push(`Changes ${value.fromVersion} → ${value.toVersion}`)
  } else if (value.libraryChanged === true) {
    lines.push(
      `Changes ${value.fromVersion} → version not advanced: the library changed while this call was reading — re-run for a settled cursor.`,
    )
  } else {
    lines.push(
      `Changes ${value.fromVersion} → version not advanced: the read did not verify the whole range — do not reuse a version from this call.`,
    )
  }
  const totals = value.totals
  const sections: [
    string,
    readonly { key: string; version: number }[] | undefined,
    number | undefined,
    string | undefined,
  ][] = [
    ['Items', value.changed.items, totals?.items, undefined],
    ['Collections', value.changed.collections, totals?.collections, undefined],
    ['Saved searches', value.changed.savedSearches, totals?.savedSearches, undefined],
    [
      'Full-text reindexed',
      value.changed.fulltextAttachments,
      totals?.fulltextAttachments,
      'index versions are a counter of their own, so these rows are a listing, not this version\u2019s change set',
    ],
  ]
  for (const [label, entries, total, note] of sections) {
    if (entries === undefined) continue
    const count = total ?? entries.length
    lines.push(
      `${label}: ${count} changed${count > entries.length ? ` — ${entries.length} newest listed` : ''}${note === undefined ? '' : ` — ${note}`}`,
    )
    const printed = entries.slice(0, 20)
    for (const entry of printed) {
      lines.push(`  - ${entry.key} (v${entry.version})`)
    }
    if (count > printed.length) lines.push(`  … ${count - printed.length} more`)
  }
  if (value.deleted !== undefined) {
    const deletedSections: [string, readonly string[] | undefined, number | undefined][] = [
      ['Deleted items', value.deleted.items, totals?.deletedItems],
      ['Deleted collections', value.deleted.collections, totals?.deletedCollections],
      ['Deleted saved searches', value.deleted.savedSearches, totals?.deletedSavedSearches],
    ]
    for (const [label, keys, total] of deletedSections) {
      if (keys === undefined || keys.length === 0) continue
      const count = total ?? keys.length
      lines.push(`${label}: ${count}${count > keys.length ? ` — ${keys.length} listed` : ''}`)
      const printed = keys.slice(0, 20)
      for (const key of printed) lines.push(`  - ${key}`)
      if (count > printed.length) lines.push(`  … ${count - printed.length} more`)
    }
  }
  if (value.unsupported !== undefined && value.unsupported.length > 0) {
    lines.push(
      `Not served by this Zotero build: ${value.unsupported.join(', ')} — changes of that kind (including removals) are not observable.`,
    )
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

/**
 * The completed changes card: changed/deleted counts, or the baseline
 * version when the call took a baseline reading. `meta` is absent on nested
 * code dispatch or malformed replay records, and a failed call keeps the raw
 * error content — both fall back to the generic card.
 */
function presentChangesResult(_args: ChangesArgs, result: ToolResult): ToolResultView | undefined {
  const record = metaRecordOf(result)
  if (record === undefined) return undefined
  const changed = asRecord(record.changed)
  const deleted = asRecord(record.deleted)
  if (changed === undefined && deleted === undefined) {
    // Baseline reading, or an over-budget diff whose detail rows the byte
    // budget dropped (detailOmitted): never invent counts.
    const toVersion = record.toVersion
    if (typeof toVersion !== 'number') return undefined
    const fromVersion = record.fromVersion
    if (typeof fromVersion !== 'number') {
      return { card: 'generic', title: `Zotero changes: baseline at version ${toVersion}` }
    }
    return { card: 'generic', title: `Zotero changes: ${fromVersion} → ${toVersion}` }
  }
  // The listings are capped digests; `totals` carries the true counts, so the
  // card reports what changed, not what fit. Only a record without totals (a
  // replay, or malformed meta) falls back to counting the rows it has.
  const totals = asRecord(record.totals)
  const counted = totals === undefined ? undefined : sumNumbers(totals)
  return {
    card: 'generic',
    title: `Zotero changes: ${counted ?? countArrayEntries(changed) + countArrayEntries(deleted)} changed or deleted`,
  }
}

/** The sum of one record's numeric values (absent fields count zero). */
function sumNumbers(record: Record<string, unknown>): number {
  let sum = 0
  for (const value of Object.values(record)) {
    if (typeof value === 'number') sum += value
  }
  return sum
}

/** The total entries across one changed/deleted section's arrays (a missing section counts zero). */
function countArrayEntries(section: Record<string, unknown> | undefined): number {
  let count = 0
  for (const entries of Object.values(section ?? {})) {
    if (Array.isArray(entries)) count += entries.length
  }
  return count
}

export function registerChangesTool(ctx: Context, service: ZoteroService): void {
  ctx.tools.register(
    defineTool({
      name: 'zotero_changes',
      description: [
        'See what changed in the Zotero library since a version: new/edited items, collections, saved searches, reindexed full text, and deletions.',
        'Call without since first to take a baseline reading of the current library version, then pass that version back as since later — fully local, no cloud.',
        'Listings are capped digests; totals reports the true counts behind them. A returned toVersion always accounts for every change in the range it reports, so it is safe to pass back as since; a result without toVersion is not.',
      ].join(' '),
      parameters: CHANGES_PARAMETERS,
      output: {
        schema: CHANGES_OUTPUT_SCHEMA,
        render: renderChanges,
        presentationMeta: (_args, value) => boundedPresentationMeta(value, ['changed', 'deleted']),
      },
      presentCall: (args) => ({
        card: 'generic',
        kind: 'read',
        title: 'Read Zotero changes',
        rawInput: args.since === undefined ? 'baseline' : String(args.since),
      }),
      presentResult: presentChangesResult,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return await withConnectivityAsk(ctx, exec, () =>
          service.changes(buildRequest(args), exec.signal),
        )
      },
    }),
  )
}
