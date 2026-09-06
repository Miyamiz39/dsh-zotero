<p align="right"><a href="tools.md"><b>中文</b></a></p>

# dsh-zotero Tool Reference

dsh-zotero registers 8 tools that operate on the user's library through the local Zotero HTTP API. All refs are stable identifiers in `zotero://user/0/item/<KEY>` (personal) or `zotero://group/<ID>/item/<KEY>` (group) format; personal is always `user/0` canonical.

---

## zotero_search

Discover candidate entries in the library. Metadata mode searches title/author/year; everything mode also searches the full-text index.

### Parameters

| Parameter        | Type                           | Default             | Description                                                                                               |
| ---------------- | ------------------------------ | ------------------- | --------------------------------------------------------------------------------------------------------- |
| `query`          | string                         | —                   | Free-text query; omit to browse the full library                                                          |
| `mode`           | `"metadata"` \| `"everything"` | `"metadata"`        | Search scope                                                                                              |
| `scope`          | object                         | `{kind: "library"}` | `{kind:"library"}` / `{kind:"collection", refOrName}` / `{kind:"savedSearch", refOrName}`                 |
| `library`        | object                         | —                   | Library: `{type:"user",id:0}` or `{type:"group",id}`; for name scopes selects library, for ref must match |
| `itemTypes`      | string[]                       | —                   | Zotero item type names (e.g. `journalArticle`), OR combined                                               |
| `tags`           | string[]                       | —                   | Tag names, `tagMatch` controls AND/OR                                                                     |
| `tagMatch`       | `"all"` \| `"any"`             | `"all"`             | How multiple tags combine                                                                                 |
| `excludeTags`    | string[]                       | —                   | Tags to exclude (NOT)                                                                                     |
| `includeTrashed` | boolean                        | `false`             | Include trashed items (only with `library` scope)                                                         |
| `sort`           | string                         | `"dateModified"`    | Sort field: `dateModified` / `dateAdded` / `date` / `title` / `creator`                                   |
| `direction`      | `"asc"` \| `"desc"`            | `"desc"`            | Sort direction                                                                                            |
| `offset`         | integer                        | `0`                 | Pagination offset                                                                                         |
| `limit`          | integer                        | `10`                | Max return count (capped by `maxSearchResults`, default 20)                                               |

### Output

`scope` (library scopes include `library` for pagination replay), `items` (primary hits only: ref, title, creatorSummary, year, itemType, bestAttachmentRef, bestAttachmentType), `total`, `offset`, `returned`, `nextOffset`, `supplemental` (optional: `{kind:"noteBody", items, scanned, truncated}`)

### Notes

On the first query (offset 0) with a `library`/`collection` scope (saved searches never scan), the client scans note bodies and lists the matches in `supplemental.items` (ordered by dateModified desc, filling only the page's unused headroom, capped by `maxNoteScanRecords`). `items`/`total`/`returned`/`nextOffset` describe the primary result set alone, so `returned` never exceeds `total`; under a collection scope, child notes join through their parent item's membership (child notes carry no `collections` of their own). `tagMatch` requires `tags`; the call fails otherwise.

### Example

```
zotero_search(query="transformer attention", mode="everything", tags=["deep-learning"], limit=5)
```

---

## zotero_get

Read a single item's full metadata. By default returns only metadata; specifying `include` triggers an additional `/children` call for child content.

### Parameters

| Parameter | Type                                        | Required | Description                    |
| --------- | ------------------------------------------- | -------- | ------------------------------ |
| `ref`     | string                                      | ✓        | Item ref                       |
| `include` | `("notes"\|"annotations"\|"attachments")[]` | —        | Child content types to include |

### Output

`ref`, `itemType`, `title`, `creators`, `date`, `year`, `venue`, `doi`, `url`, `abstract`, `abstractTruncated`, `noteBody` (note items), `tags`, `collections`, `children`, `bestAttachment`, `relations` (as `dc:relation` etc, `targetRef` only when provably local), plus requested `notes`/`annotations`/`attachments` (with total, returned, items)

### Example

```
zotero_get(ref="zotero://user/0/item/ABC123", include=["notes", "annotations"])
```

---

## zotero_retrieve

Collect and query-rank evidence passages for a single item. Sources include: Zotero annotations (with page labels), notes, abstract, and full-text chunks (BM25 ranked).

### Parameters

| Parameter  | Type     | Default | Description                                                           |
| ---------- | -------- | ------- | --------------------------------------------------------------------- |
| `ref`      | string   | —       | Item ref (required)                                                   |
| `query`    | string   | —       | Query terms for ranking evidence (required)                           |
| `sources`  | string[] | All 4   | `annotation` / `note` / `abstract` / `fulltext`                       |
| `passages` | integer  | `4`     | Max return passage count (capped by `maxEvidencePassages`, default 4) |

### Output

`ref`, `attachmentRef`, `attachmentContentType`, `coverage` (indexedChars/totalChars/complete etc.), `evidence` (source, sourceRef, text, chunkIndex, chunkCount, comment, pageLabel), `truncated`, `sourcesSkipped`

### Notes

- Only Zotero annotations carry page labels; full-text passages never have fabricated page numbers
- Unavailable sources are skipped and reported in `sourcesSkipped`
- Only `annotation` sources have `pageLabel`; full-text passages never carry page numbers
- `truncated` true indicates more evidence was cut off

### Example

```
zotero_retrieve(ref="zotero://user/0/item/ABC123", query="attention mechanism", sources=["annotation", "fulltext"], passages=6)
```

---

## zotero_attachment

Resolve a ref to an accessible attachment location. Accepts an item ref (auto-picks best attachment) or an attachment ref (exact target).

### Parameters

| Parameter | Type   | Required | Description                |
| --------- | ------ | -------- | -------------------------- |
| `ref`     | string | ✓        | Item ref or attachment ref |

### Output

Discriminated union type:

- `{kind: "file", path, ref, title, contentType}` — local file (verified to exist via async stat)
- `{kind: "url", url, ref, title, contentType}` — linked attachment

Item refs follow Zotero's best-attachment link first, falling back to the earliest PDF child.

### Example

```
zotero_attachment(ref="zotero://user/0/item/ABC123")
```

---

## zotero_export

Generate citations or formatted exports.

### Parameters

| Parameter | Type     | Default   | Description                                                                        |
| --------- | -------- | --------- | ---------------------------------------------------------------------------------- |
| `refs`    | string[] | —         | Item ref list (required), capped by `maxExportRefs` (default 50)                   |
| `format`  | string   | —         | `citation` / `bibliography` / `bibtex` / `biblatex` / `ris` / `csljson` (required) |
| `style`   | string   | Config    | CSL style ID (citation/bibliography only)                                          |
| `locale`  | string   | `"en-US"` | CSL locale (citation/bibliography only)                                            |

### Output

| Format                              | Output structure                                             |
| ----------------------------------- | ------------------------------------------------------------ |
| `citation`                          | `{citations: [{ref, text}]}`                                 |
| `bibliography`                      | `{text}`                                                     |
| `bibtex`/`biblatex`/`ris`/`csljson` | `{text, items: [{ref, key, title, entryIndex, start, end}]}` |

### Notes

- `citation` mode auto-batches requests per Zotero's 50-key limit
- `bibtex`/`biblatex`/`ris`/`csljson` accept up to 50 items per call; split larger sets into batches
- Export text is never truncated — exceeding `maxExportChars` (default 1M) raises an error
- One export call allows refs from only one `library`; mixing `user/0` and `group` (or different groups) raises `INVALID_ARGUMENT` with 0 HTTP

### Example

```
zotero_export(refs=["zotero://user/0/item/ABC123", "zotero://user/0/item/DEF456"], format="bibtex")
```

---

## zotero_browse

Discover library structure. Every `kind` pages with `offset/limit` (default `20`, capped by `maxBrowseResults` at 50) and returns `total/returned/nextOffset`.

Pagination honesty applies uniformly: `zotero_search` and `zotero_browse` array listings require a valid `Total-Results` header and fail the whole call with `ZOTERO_UNEXPECTED` without it, instead of guessing totals from body length. `zotero_changes` `format=versions` diffs are key→version maps where the local API omits that header (verified against a live build): a short page is complete, a full page is honestly marked `truncated`.

| Parameter | Type                                                                           | Default    | Description                                                 |
| --------- | ------------------------------------------------------------------------------ | ---------- | ----------------------------------------------------------- |
| `kind`    | `libraries`\|`collections`\|`savedSearches`\|`tags`\|`itemTypes`\|`itemFields` | —          | What to browse (`itemFields` requires `itemType`)           |
| `library` | object `{type, id}`                                                            | `user/0`   | Target library (valid for `collections/savedSearches/tags`) |
| `q`       | string                                                                         | —          | `tags` substring filter                                     |
| `match`   | `contains`\|`startsWith`                                                       | `contains` | How `q` matches tags (requires `q`)                         |
| `offset`  | integer                                                                        | `0`        | Pagination offset                                           |
| `limit`   | integer                                                                        | `20`       | Return cap                                                  |

### Output

- `libraries`: `{library, name}`
- `collections`: `{ref, name, parentRef?, path: string[], depth}` (full breadcrumb path)
- `savedSearches`: `{ref, name, conditions?}`
- `tags`: `{tag, count?}`
- `itemTypes`: `{itemType, localized?}`
- `itemFields`: `{field, localized?}` or `{creatorType, localized?}` for the given `itemType`

### Example

```
zotero_browse(kind="collections", library={type:"group", id:42}, limit=20)
zotero_browse(kind="tags", q="review", match="contains")
```

---

## zotero_children

Explore one item's or attachment's child-object graph. An item ref returns its direct notes and attachments plus the annotations living under each attachment (Zotero stores annotations as children of the PDF, not of the paper); an attachment ref returns that file's own annotations. Enumerate structure here before reading full metadata with `zotero_get`.

### Parameters

| Parameter | Type     | Required | Description                                                                                                       |
| --------- | -------- | -------- | ----------------------------------------------------------------------------------------------------------------- |
| `ref`     | string   | ✓        | Item ref or attachment ref                                                                                        |
| `include` | string[] | —        | `notes` / `attachments` / `annotations` (omitted returns all three; an explicit empty array is an argument error) |

### Output

`{ref, itemType?, serverId?, notes?, attachments?, annotations?}`, each section a `{total, returned, items}` collection. Note items carry `parentRef` (the parent item ref that produced them).

### Example

```
zotero_children(ref="zotero://user/0/item/ABC123", include=["annotations"])
```

---

## zotero_changes

See what changed in the library since a version. Zotero 10+ versions are local transaction versions — any edit, sync, or local write advances them. Call without `since` first for a baseline reading (current version only), then pass it back as `since`.

### Parameters

| Parameter | Type     | Default | Description                                                                                                       |
| --------- | -------- | ------- | ----------------------------------------------------------------------------------------------------------------- |
| `library` | object   | —       | `{type, id}`; omitted defaults to personal `user/0`                                                               |
| `since`   | integer  | —       | Library version to diff from; omitted takes a baseline reading                                                    |
| `include` | string[] | all     | `items` / `collections` / `savedSearches` / `fulltext` / `deleted` (an explicit empty array is an argument error) |

### Output

`{library, serverId?, fromVersion?, toVersion?, changed: {items?, collections?, savedSearches?, fulltextAttachments?}, deleted?: {items, collections, savedSearches}, truncated?}`. Each resource truncates at `maxChangesResults` (default 50) and honestly marks `truncated`; a resource the current build cannot serve (e.g. `/deleted` on some versions) degrades to absence instead of failing the whole read.

### Example

```
zotero_changes()
zotero_changes(since=1234, include=["items", "deleted"])
```

---

## Error codes

| Error code                      | Description                                                                                  |
| ------------------------------- | -------------------------------------------------------------------------------------------- |
| `ZOTERO_NOT_RUNNING`            | Zotero not running or local API unreachable                                                  |
| `ZOTERO_API_DISABLED`           | Zotero running but local API disabled (403)                                                  |
| `ZOTERO_API_VERSION`            | Zotero API version not supported                                                             |
| `ZOTERO_SERVER_MISMATCH`        | Ref from a different Zotero instance                                                         |
| `ZOTERO_NOT_FOUND`              | Referenced item, collection, or saved search does not exist                                  |
| `ZOTERO_NO_ATTACHMENT`          | Item has no attachment of the specified type                                                 |
| `ZOTERO_NO_FULLTEXT`            | Attachment has no full-text index                                                            |
| `ZOTERO_FILE_MISSING`           | Local file reported by Zotero does not exist on disk                                         |
| `ZOTERO_INVALID_REF`            | Ref string does not match `zotero://` syntax or references unsupported library               |
| `ZOTERO_INVALID_ARGUMENT`       | Parameter violates domain constraints not expressible in schema                              |
| `ZOTERO_SCOPE_AMBIGUOUS`        | Collection or saved search name matched multiple objects                                     |
| `ZOTERO_TIMEOUT`                | Provider internal timeout                                                                    |
| `ZOTERO_RESPONSE_TOO_LARGE`     | Response stream exceeded resource limit                                                      |
| `ZOTERO_OUTPUT_TOO_LARGE`       | Export output exceeded provider hard limit                                                   |
| `ZOTERO_CAPABILITY_UNAVAILABLE` | Provider did not declare the required capability                                             |
| `ZOTERO_PROVIDER_UNAVAILABLE`   | Configured provider not registered, or declares a capability without implementing its method |
| `ZOTERO_UNEXPECTED`             | Response could not be parsed or behaved unexpectedly                                         |
