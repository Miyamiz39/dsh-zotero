import { deflateRawSync, inflateRawSync } from 'node:zlib'

const LOCAL_FILE_SIGNATURE = 0x04034b50
const CENTRAL_FILE_SIGNATURE = 0x02014b50
const EOCD_SIGNATURE = 0x06054b50
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50
const ZIP64_EXTRA_ID = 0x0001
const UTF8_FLAG = 0x0800
const DATA_DESCRIPTOR_FLAG = 0x0008
const UNSAFE_ENCRYPTION_FLAGS = 0x0001 | 0x0020 | 0x0040 | 0x2000
const UINT16_MAX = 0xffff
const UINT32_MAX = 0xffffffff

export type OpcErrorCode =
  | 'OPC_ZIP_INVALID'
  | 'OPC_ZIP_MULTIDISK'
  | 'OPC_ZIP64_UNSUPPORTED'
  | 'OPC_ZIP_ENCRYPTED'
  | 'OPC_ZIP_METHOD_UNSUPPORTED'
  | 'OPC_ZIP_PATH_UNSAFE'
  | 'OPC_ZIP_DUPLICATE'
  | 'OPC_ZIP_PREFIX_COLLISION'
  | 'OPC_ZIP_LIMIT'
  | 'OPC_ZIP_CRC_MISMATCH'
  | 'OPC_PART_MISSING'
  | 'OPC_PART_EXISTS'

export class OpcError extends Error {
  constructor(
    message: string,
    readonly code: OpcErrorCode,
  ) {
    super(message)
    this.name = 'OpcError'
  }
}

export interface OpcArchiveLimits {
  /** Maximum compressed package size accepted and generated. */
  maxArchiveBytes: number
  /** Maximum number of central-directory entries. */
  maxEntries: number
  /** Maximum uncompressed size of one non-directory part. */
  maxPartBytes: number
  /** Maximum aggregate uncompressed size of all non-directory parts. */
  maxTotalUncompressedBytes: number
  /** Maximum uncompressed/compressed ratio of one non-empty part. */
  maxCompressionRatio: number
  /** Maximum number of parts one archive instance may add or replace. */
  maxModifiedParts: number
}

export const DEFAULT_OPC_ARCHIVE_LIMITS: Readonly<OpcArchiveLimits> = Object.freeze({
  maxArchiveBytes: 256 * 1024 * 1024,
  maxEntries: 2048,
  maxPartBytes: 64 * 1024 * 1024,
  maxTotalUncompressedBytes: 256 * 1024 * 1024,
  maxCompressionRatio: 200,
  maxModifiedParts: 8,
})

export interface OpcPartWriteOptions {
  /** New parts default to raw DEFLATE; `store` is useful for already-compressed bytes. */
  compression?: 'store' | 'deflate'
}

interface ParsedEntry {
  readonly name: string
  readonly foldedName: string
  readonly isDirectory: boolean
  readonly flags: number
  readonly method: 0 | 8
  readonly crc32: number
  readonly compressedSize: number
  readonly uncompressedSize: number
  readonly localOffset: number
  readonly dataOffset: number
  readonly rawLocalEnd: number
  readonly rawCentral: Uint8Array
  readonly rawLocal: Uint8Array
}

interface Replacement {
  readonly bytes: Uint8Array
  readonly method: 0 | 8
}

interface GeneratedEntry {
  readonly name: string
  readonly flags: number
  readonly method: 0 | 8
  readonly crc32: number
  readonly compressedSize: number
  readonly uncompressedSize: number
  readonly localOffset: number
  readonly central: Uint8Array
}

function fail(code: OpcErrorCode, message: string): never {
  throw new OpcError(message, code)
}

function applyLimits(overrides: Partial<OpcArchiveLimits>): OpcArchiveLimits {
  const limits = { ...DEFAULT_OPC_ARCHIVE_LIMITS, ...overrides }
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive safe integer.`)
    }
  }
  return limits
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function u16(view: DataView, offset: number): number {
  return view.getUint16(offset, true)
}

function u32(view: DataView, offset: number): number {
  return view.getUint32(offset, true)
}

function set16(bytes: Uint8Array, offset: number, value: number): void {
  viewOf(bytes).setUint16(offset, value, true)
}

function set32(bytes: Uint8Array, offset: number, value: number): void {
  viewOf(bytes).setUint32(offset, value >>> 0, true)
}

function checkedEnd(start: number, length: number, bound: number, label: string): number {
  const end = start + length
  if (!Number.isSafeInteger(end) || start < 0 || length < 0 || end > bound) {
    fail('OPC_ZIP_INVALID', `${label} lies outside the ZIP package.`)
  }
  return end
}

function decodeName(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    fail('OPC_ZIP_PATH_UNSAFE', 'ZIP entry name is not valid UTF-8.')
  }
}

function validateName(name: string, directoryHint = false): { folded: string; directory: boolean } {
  if (name.length === 0 || name.includes('\\') || name.startsWith('/') || name.startsWith('//')) {
    fail('OPC_ZIP_PATH_UNSAFE', `Unsafe ZIP entry name ${JSON.stringify(name)}.`)
  }
  if (/^[A-Za-z]:/.test(name) || /[\0-\x1f\x7f]/.test(name)) {
    fail('OPC_ZIP_PATH_UNSAFE', `Unsafe ZIP entry name ${JSON.stringify(name)}.`)
  }
  const directory = directoryHint || name.endsWith('/')
  const path = directory ? name.slice(0, -1) : name
  const segments = path.split('/')
  if (
    path.length === 0 ||
    segments.some(
      (segment) =>
        segment.length === 0 || segment === '.' || segment === '..' || /[. ]$/.test(segment),
    )
  ) {
    fail('OPC_ZIP_PATH_UNSAFE', `Unsafe ZIP entry name ${JSON.stringify(name)}.`)
  }
  if (directory && !name.endsWith('/')) {
    fail('OPC_ZIP_PATH_UNSAFE', `Directory ZIP entry ${JSON.stringify(name)} lacks a slash.`)
  }
  return { folded: name.toLowerCase(), directory }
}

function validateExtra(extra: Uint8Array, label: string): void {
  const view = viewOf(extra)
  let offset = 0
  while (offset < extra.length) {
    if (offset + 4 > extra.length) fail('OPC_ZIP_INVALID', `${label} has a truncated extra field.`)
    const id = u16(view, offset)
    const size = u16(view, offset + 2)
    offset += 4
    if (offset + size > extra.length)
      fail('OPC_ZIP_INVALID', `${label} has a truncated extra field.`)
    if (id === ZIP64_EXTRA_ID) {
      fail('OPC_ZIP64_UNSUPPORTED', `${label} uses unsupported ZIP64 metadata.`)
    }
    offset += size
  }
}

function findEocd(bytes: Uint8Array): number {
  if (bytes.length < 22) fail('OPC_ZIP_INVALID', 'ZIP package is shorter than an EOCD record.')
  const view = viewOf(bytes)
  const start = Math.max(0, bytes.length - (22 + UINT16_MAX))
  let found = -1
  for (let offset = bytes.length - 22; offset >= start; offset--) {
    if (u32(view, offset) !== EOCD_SIGNATURE) continue
    const commentLength = u16(view, offset + 20)
    if (offset + 22 + commentLength !== bytes.length) continue
    if (found !== -1) fail('OPC_ZIP_INVALID', 'ZIP package has ambiguous EOCD records.')
    found = offset
  }
  if (found === -1) fail('OPC_ZIP_INVALID', 'ZIP package has no valid EOCD record.')
  return found
}

function descriptorEnd(
  bytes: Uint8Array,
  offset: number,
  expectedCrc: number,
  expectedCompressed: number,
  expectedUncompressed: number,
): number {
  const view = viewOf(bytes)
  const matches = (base: number): boolean =>
    base + 12 <= bytes.length &&
    u32(view, base) === expectedCrc &&
    u32(view, base + 4) === expectedCompressed &&
    u32(view, base + 8) === expectedUncompressed
  const unsigned = matches(offset)
  const signed =
    offset + 4 <= bytes.length &&
    u32(view, offset) === DATA_DESCRIPTOR_SIGNATURE &&
    matches(offset + 4)
  if (unsigned === signed) {
    fail(
      'OPC_ZIP_INVALID',
      unsigned
        ? 'ZIP data descriptor is ambiguous.'
        : 'ZIP data descriptor disagrees with the central directory.',
    )
  }
  return offset + (signed ? 16 : 12)
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.length
  }
  return output
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < table.length; n++) {
    let value = n
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[n] = value >>> 0
  }
  return table
})()

export function opcCrc32(bytes: Uint8Array): number {
  let crc = UINT32_MAX
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ UINT32_MAX) >>> 0
}

function makeLocal(
  nameBytes: Uint8Array,
  flags: number,
  method: 0 | 8,
  crc: number,
  compressed: Uint8Array,
  uncompressedSize: number,
): Uint8Array {
  const output = new Uint8Array(30 + nameBytes.length + compressed.length)
  set32(output, 0, LOCAL_FILE_SIGNATURE)
  set16(output, 4, 20)
  set16(output, 6, flags)
  set16(output, 8, method)
  set32(output, 14, crc)
  set32(output, 18, compressed.length)
  set32(output, 22, uncompressedSize)
  set16(output, 26, nameBytes.length)
  output.set(nameBytes, 30)
  output.set(compressed, 30 + nameBytes.length)
  return output
}

function makeCentral(
  nameBytes: Uint8Array,
  flags: number,
  method: 0 | 8,
  crc: number,
  compressedSize: number,
  uncompressedSize: number,
  localOffset: number,
): Uint8Array {
  const output = new Uint8Array(46 + nameBytes.length)
  set32(output, 0, CENTRAL_FILE_SIGNATURE)
  set16(output, 4, 20)
  set16(output, 6, 20)
  set16(output, 8, flags)
  set16(output, 10, method)
  set32(output, 16, crc)
  set32(output, 20, compressedSize)
  set32(output, 24, uncompressedSize)
  set16(output, 28, nameBytes.length)
  set32(output, 42, localOffset)
  output.set(nameBytes, 46)
  return output
}

/**
 * Strict, bounded ZIP/OPC archive with lazy CRC-checked reads and raw-copy generation.
 * Untouched local records and compressed payload bytes are copied verbatim; their central
 * records are copied verbatim except for the required relative-local-header offset patch.
 */
export class OpcArchive {
  private readonly byName = new Map<string, ParsedEntry>()
  private readonly replacements = new Map<string, Replacement>()
  private readonly additions = new Map<string, Replacement>()

  private constructor(
    private readonly source: Uint8Array,
    private readonly entries: ParsedEntry[],
    private readonly limits: OpcArchiveLimits,
  ) {
    for (const entry of entries) this.byName.set(entry.name, entry)
  }

  static open(bytes: Uint8Array, limits: Partial<OpcArchiveLimits> = {}): OpcArchive {
    const applied = applyLimits(limits)
    if (bytes.length > applied.maxArchiveBytes) {
      fail(
        'OPC_ZIP_LIMIT',
        `ZIP package is ${bytes.length} bytes; maximum is ${applied.maxArchiveBytes}.`,
      )
    }
    const source = new Uint8Array(bytes)
    const view = viewOf(source)
    const eocd = findEocd(source)
    const disk = u16(view, eocd + 4)
    const centralDisk = u16(view, eocd + 6)
    const diskEntries = u16(view, eocd + 8)
    const totalEntries = u16(view, eocd + 10)
    const centralSize = u32(view, eocd + 12)
    const centralOffset = u32(view, eocd + 16)
    if (
      diskEntries === UINT16_MAX ||
      totalEntries === UINT16_MAX ||
      centralSize === UINT32_MAX ||
      centralOffset === UINT32_MAX
    ) {
      fail('OPC_ZIP64_UNSUPPORTED', 'ZIP64 packages are not supported.')
    }
    if (disk !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) {
      fail('OPC_ZIP_MULTIDISK', 'Multidisk ZIP packages are not supported.')
    }
    if (totalEntries > applied.maxEntries) {
      fail(
        'OPC_ZIP_LIMIT',
        `ZIP package has ${totalEntries} entries; maximum is ${applied.maxEntries}.`,
      )
    }
    const centralEnd = checkedEnd(
      centralOffset,
      centralSize,
      source.length,
      'ZIP central directory',
    )
    if (centralEnd !== eocd) {
      fail('OPC_ZIP_INVALID', 'ZIP central directory does not end at the EOCD record.')
    }

    const parsed: ParsedEntry[] = []
    const foldedNames = new Set<string>()
    let totalUncompressed = 0
    let cursor = centralOffset
    for (let index = 0; index < totalEntries; index++) {
      checkedEnd(cursor, 46, centralEnd, 'ZIP central entry')
      if (u32(view, cursor) !== CENTRAL_FILE_SIGNATURE) {
        fail('OPC_ZIP_INVALID', `Central entry ${index + 1} has an invalid signature.`)
      }
      const versionNeeded = u16(view, cursor + 6)
      const flags = u16(view, cursor + 8)
      const method = u16(view, cursor + 10)
      const crc = u32(view, cursor + 16)
      const compressedSize = u32(view, cursor + 20)
      const uncompressedSize = u32(view, cursor + 24)
      const nameLength = u16(view, cursor + 28)
      const extraLength = u16(view, cursor + 30)
      const commentLength = u16(view, cursor + 32)
      const startDisk = u16(view, cursor + 34)
      const externalAttributes = u32(view, cursor + 38)
      const localOffset = u32(view, cursor + 42)
      if (
        versionNeeded >= 45 ||
        compressedSize === UINT32_MAX ||
        uncompressedSize === UINT32_MAX ||
        localOffset === UINT32_MAX
      ) {
        fail('OPC_ZIP64_UNSUPPORTED', 'ZIP64 entry metadata is not supported.')
      }
      if (startDisk !== 0) fail('OPC_ZIP_MULTIDISK', 'ZIP entry starts on another disk.')
      if (flags & UNSAFE_ENCRYPTION_FLAGS) {
        fail('OPC_ZIP_ENCRYPTED', 'Encrypted or patched ZIP entries are not supported.')
      }
      if (method !== 0 && method !== 8) {
        fail('OPC_ZIP_METHOD_UNSUPPORTED', `ZIP compression method ${method} is not supported.`)
      }
      const entryEnd = checkedEnd(
        cursor,
        46 + nameLength + extraLength + commentLength,
        centralEnd,
        'ZIP central entry',
      )
      const nameStart = cursor + 46
      const nameBytes = source.subarray(nameStart, nameStart + nameLength)
      const name = decodeName(nameBytes)
      const directoryHint = (externalAttributes & 0x10) !== 0
      const validated = validateName(name, directoryHint)
      if (foldedNames.has(validated.folded)) {
        fail('OPC_ZIP_DUPLICATE', `Duplicate case-folded ZIP entry name ${JSON.stringify(name)}.`)
      }
      foldedNames.add(validated.folded)
      validateExtra(
        source.subarray(nameStart + nameLength, nameStart + nameLength + extraLength),
        `Central entry ${JSON.stringify(name)}`,
      )
      if (validated.directory && (compressedSize !== 0 || uncompressedSize !== 0)) {
        fail('OPC_ZIP_INVALID', `Directory entry ${JSON.stringify(name)} contains data.`)
      }
      if (!validated.directory) {
        if (uncompressedSize > applied.maxPartBytes) {
          fail('OPC_ZIP_LIMIT', `ZIP part ${JSON.stringify(name)} exceeds the per-part limit.`)
        }
        totalUncompressed += uncompressedSize
        if (
          !Number.isSafeInteger(totalUncompressed) ||
          totalUncompressed > applied.maxTotalUncompressedBytes
        ) {
          fail('OPC_ZIP_LIMIT', 'ZIP aggregate uncompressed size exceeds the configured limit.')
        }
        if (
          uncompressedSize > 0 &&
          (compressedSize === 0 || uncompressedSize / compressedSize > applied.maxCompressionRatio)
        ) {
          fail(
            'OPC_ZIP_LIMIT',
            `ZIP part ${JSON.stringify(name)} exceeds the compression-ratio limit.`,
          )
        }
      }

      checkedEnd(localOffset, 30, centralOffset, `Local entry ${JSON.stringify(name)}`)
      if (u32(view, localOffset) !== LOCAL_FILE_SIGNATURE) {
        fail('OPC_ZIP_INVALID', `Local entry ${JSON.stringify(name)} has an invalid signature.`)
      }
      const localVersionNeeded = u16(view, localOffset + 4)
      const localFlags = u16(view, localOffset + 6)
      const localMethod = u16(view, localOffset + 8)
      const localNameLength = u16(view, localOffset + 26)
      const localExtraLength = u16(view, localOffset + 28)
      if (localVersionNeeded >= 45) {
        fail('OPC_ZIP64_UNSUPPORTED', `Local entry ${JSON.stringify(name)} requires ZIP64.`)
      }
      if (localFlags !== flags || localMethod !== method) {
        fail(
          'OPC_ZIP_INVALID',
          `Local entry ${JSON.stringify(name)} disagrees with its central record.`,
        )
      }
      const localNameStart = localOffset + 30
      const dataOffset = checkedEnd(
        localNameStart,
        localNameLength + localExtraLength,
        centralOffset,
        `Local entry ${JSON.stringify(name)}`,
      )
      const localNameBytes = source.subarray(localNameStart, localNameStart + localNameLength)
      if (
        localNameBytes.length !== nameBytes.length ||
        localNameBytes.some((byte, byteIndex) => byte !== nameBytes[byteIndex])
      ) {
        fail('OPC_ZIP_INVALID', `Local entry ${JSON.stringify(name)} has a different name.`)
      }
      validateExtra(
        source.subarray(localNameStart + localNameLength, dataOffset),
        `Local entry ${JSON.stringify(name)}`,
      )
      if (!(flags & DATA_DESCRIPTOR_FLAG)) {
        if (
          u32(view, localOffset + 14) !== crc ||
          u32(view, localOffset + 18) !== compressedSize ||
          u32(view, localOffset + 22) !== uncompressedSize
        ) {
          fail(
            'OPC_ZIP_INVALID',
            `Local entry ${JSON.stringify(name)} disagrees with its sizes or CRC.`,
          )
        }
      }
      const dataEnd = checkedEnd(
        dataOffset,
        compressedSize,
        centralOffset,
        `Compressed data for ${JSON.stringify(name)}`,
      )
      const rawLocalEnd =
        flags & DATA_DESCRIPTOR_FLAG
          ? descriptorEnd(source, dataEnd, crc, compressedSize, uncompressedSize)
          : dataEnd
      if (rawLocalEnd > centralOffset) {
        fail(
          'OPC_ZIP_INVALID',
          `Local entry ${JSON.stringify(name)} overlaps the central directory.`,
        )
      }
      parsed.push({
        name,
        foldedName: validated.folded,
        isDirectory: validated.directory,
        flags,
        method: method as 0 | 8,
        crc32: crc,
        compressedSize,
        uncompressedSize,
        localOffset,
        dataOffset,
        rawLocalEnd,
        rawCentral: source.slice(cursor, entryEnd),
        rawLocal: source.slice(localOffset, rawLocalEnd),
      })
      cursor = entryEnd
    }
    if (cursor !== centralEnd)
      fail('OPC_ZIP_INVALID', 'ZIP central directory size is inconsistent.')

    const ranges = [...parsed].sort((a, b) => a.localOffset - b.localOffset)
    let previousEnd = 0
    for (const entry of ranges) {
      if (entry.localOffset < previousEnd) {
        fail('OPC_ZIP_INVALID', `Local entry ${JSON.stringify(entry.name)} overlaps another entry.`)
      }
      previousEnd = entry.rawLocalEnd
    }
    validatePrefixCollisions(
      parsed.map((entry) => ({
        name: entry.name,
        folded: entry.foldedName,
        directory: entry.isDirectory,
      })),
    )
    return new OpcArchive(source, parsed, applied)
  }

  names(): readonly string[] {
    return this.entries.map((entry) => entry.name)
  }

  has(name: string): boolean {
    return this.byName.has(name) || this.additions.has(name)
  }

  read(name: string, maxBytes = this.limits.maxPartBytes): Uint8Array {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new TypeError('maxBytes must be a non-negative safe integer.')
    }
    const changed = this.replacements.get(name) ?? this.additions.get(name)
    if (changed !== undefined) {
      if (changed.bytes.length > maxBytes) {
        fail('OPC_ZIP_LIMIT', `ZIP part ${JSON.stringify(name)} exceeds the requested read limit.`)
      }
      return new Uint8Array(changed.bytes)
    }
    const entry = this.byName.get(name)
    if (entry === undefined || entry.isDirectory) {
      fail('OPC_PART_MISSING', `ZIP part ${JSON.stringify(name)} does not exist.`)
    }
    if (entry.uncompressedSize > maxBytes) {
      fail('OPC_ZIP_LIMIT', `ZIP part ${JSON.stringify(name)} exceeds the requested read limit.`)
    }
    const compressed = this.source.subarray(
      entry.dataOffset,
      entry.dataOffset + entry.compressedSize,
    )
    let output: Uint8Array
    try {
      output =
        entry.method === 0
          ? new Uint8Array(compressed)
          : new Uint8Array(inflateRawSync(compressed, { maxOutputLength: maxBytes }))
    } catch (cause) {
      throw new OpcError(
        `ZIP part ${JSON.stringify(name)} could not be decompressed: ${errorMessage(cause)}`,
        'OPC_ZIP_INVALID',
      )
    }
    if (output.length !== entry.uncompressedSize) {
      fail(
        'OPC_ZIP_INVALID',
        `ZIP part ${JSON.stringify(name)} has an incorrect uncompressed size.`,
      )
    }
    if (opcCrc32(output) !== entry.crc32) {
      fail('OPC_ZIP_CRC_MISMATCH', `ZIP part ${JSON.stringify(name)} failed its CRC-32 check.`)
    }
    return output
  }

  replace(name: string, bytes: Uint8Array, options: OpcPartWriteOptions = {}): void {
    const entry = this.byName.get(name)
    if (entry === undefined || entry.isDirectory) {
      fail('OPC_PART_MISSING', `ZIP part ${JSON.stringify(name)} does not exist.`)
    }
    this.setMutation(this.replacements, name, bytes, options)
  }

  add(name: string, bytes: Uint8Array, options: OpcPartWriteOptions = {}): void {
    if (this.byName.has(name) || this.additions.has(name)) {
      fail('OPC_PART_EXISTS', `ZIP part ${JSON.stringify(name)} already exists.`)
    }
    const validated = validateName(name)
    if (validated.directory)
      fail('OPC_ZIP_PATH_UNSAFE', 'Adding directory entries is not supported.')
    const inventory = [
      ...this.entries.map((entry) => ({
        name: entry.name,
        folded: entry.foldedName,
        directory: entry.isDirectory,
      })),
      ...[...this.additions.keys()].map((candidate) => {
        const facts = validateName(candidate)
        return { name: candidate, folded: facts.folded, directory: facts.directory }
      }),
      { name, folded: validated.folded, directory: validated.directory },
    ]
    const folded = new Set<string>()
    for (const item of inventory) {
      if (folded.has(item.folded)) {
        fail(
          'OPC_ZIP_DUPLICATE',
          `Duplicate case-folded ZIP entry name ${JSON.stringify(item.name)}.`,
        )
      }
      folded.add(item.folded)
    }
    validatePrefixCollisions(inventory)
    this.setMutation(this.additions, name, bytes, options)
  }

  generate(): Uint8Array {
    const outputNames = [...this.entries.map((entry) => entry.name), ...this.additions.keys()]
    if (outputNames.length > this.limits.maxEntries || outputNames.length >= UINT16_MAX) {
      fail('OPC_ZIP_LIMIT', 'Generated ZIP package has too many entries.')
    }
    let totalUncompressed = 0
    for (const name of outputNames) {
      const replacement = this.replacements.get(name) ?? this.additions.get(name)
      const size = replacement?.bytes.length ?? this.byName.get(name)!.uncompressedSize
      totalUncompressed += size
      if (
        size > this.limits.maxPartBytes ||
        totalUncompressed > this.limits.maxTotalUncompressedBytes
      ) {
        fail('OPC_ZIP_LIMIT', 'Generated ZIP content exceeds the configured limits.')
      }
    }

    const localChunks: Uint8Array[] = []
    const generated = new Map<string, GeneratedEntry>()
    let localOffset = 0
    const physicalEntries = [...this.entries].sort((a, b) => a.localOffset - b.localOffset)
    for (const entry of physicalEntries) {
      const replacement = this.replacements.get(entry.name)
      if (replacement === undefined) {
        localChunks.push(entry.rawLocal)
        const central = new Uint8Array(entry.rawCentral)
        set32(central, 42, localOffset)
        generated.set(entry.name, {
          name: entry.name,
          flags: entry.flags,
          method: entry.method,
          crc32: entry.crc32,
          compressedSize: entry.compressedSize,
          uncompressedSize: entry.uncompressedSize,
          localOffset,
          central,
        })
        localOffset += entry.rawLocal.length
      } else {
        const made = this.makeChanged(entry.name, replacement, localOffset, entry.rawCentral)
        localChunks.push(made.local)
        generated.set(entry.name, made.entry)
        localOffset += made.local.length
      }
    }
    for (const [name, addition] of this.additions) {
      const made = this.makeChanged(name, addition, localOffset)
      localChunks.push(made.local)
      generated.set(name, made.entry)
      localOffset += made.local.length
    }

    const centralOffset = localOffset
    const centralChunks: Uint8Array[] = []
    let centralSize = 0
    for (const name of outputNames) {
      const central = generated.get(name)!.central
      centralChunks.push(central)
      centralSize += central.length
    }
    if (centralOffset > UINT32_MAX || centralSize > UINT32_MAX) {
      fail('OPC_ZIP64_UNSUPPORTED', 'Generated package would require ZIP64.')
    }
    const eocd = new Uint8Array(22)
    set32(eocd, 0, EOCD_SIGNATURE)
    set16(eocd, 8, outputNames.length)
    set16(eocd, 10, outputNames.length)
    set32(eocd, 12, centralSize)
    set32(eocd, 16, centralOffset)
    const total = centralOffset + centralSize + eocd.length
    if (total > this.limits.maxArchiveBytes) {
      fail('OPC_ZIP_LIMIT', `Generated ZIP package exceeds ${this.limits.maxArchiveBytes} bytes.`)
    }
    return concat([...localChunks, ...centralChunks, eocd], total)
  }

  private setMutation(
    target: Map<string, Replacement>,
    name: string,
    bytes: Uint8Array,
    options: OpcPartWriteOptions,
  ): void {
    const modifiedNames = new Set([...this.replacements.keys(), ...this.additions.keys(), name])
    if (modifiedNames.size > this.limits.maxModifiedParts) {
      fail('OPC_ZIP_LIMIT', `At most ${this.limits.maxModifiedParts} parts may be modified.`)
    }
    if (bytes.length > this.limits.maxPartBytes) {
      fail('OPC_ZIP_LIMIT', `ZIP part ${JSON.stringify(name)} exceeds the per-part limit.`)
    }
    const compression = options.compression ?? 'deflate'
    target.set(name, {
      bytes: new Uint8Array(bytes),
      method: compression === 'store' ? 0 : 8,
    })
  }

  private makeChanged(
    name: string,
    replacement: Replacement,
    localOffset: number,
    centralTemplate?: Uint8Array,
  ): { local: Uint8Array; entry: GeneratedEntry } {
    const nameBytes = new TextEncoder().encode(name)
    const compressed =
      replacement.method === 0
        ? replacement.bytes
        : new Uint8Array(deflateRawSync(replacement.bytes))
    if (
      replacement.bytes.length > UINT32_MAX ||
      compressed.length > UINT32_MAX ||
      localOffset > UINT32_MAX
    ) {
      fail('OPC_ZIP64_UNSUPPORTED', 'Generated part would require ZIP64.')
    }
    if (
      replacement.bytes.length > 0 &&
      (compressed.length === 0 ||
        replacement.bytes.length / compressed.length > this.limits.maxCompressionRatio)
    ) {
      fail(
        'OPC_ZIP_LIMIT',
        `Generated ZIP part ${JSON.stringify(name)} exceeds the compression-ratio limit.`,
      )
    }
    const crc = opcCrc32(replacement.bytes)
    const flags = UTF8_FLAG
    const local = makeLocal(
      nameBytes,
      flags,
      replacement.method,
      crc,
      compressed,
      replacement.bytes.length,
    )
    const central =
      centralTemplate === undefined
        ? makeCentral(
            nameBytes,
            flags,
            replacement.method,
            crc,
            compressed.length,
            replacement.bytes.length,
            localOffset,
          )
        : new Uint8Array(centralTemplate)
    if (centralTemplate !== undefined) {
      set16(central, 6, Math.max(u16(viewOf(central), 6), 20))
      set16(central, 8, flags)
      set16(central, 10, replacement.method)
      set32(central, 16, crc)
      set32(central, 20, compressed.length)
      set32(central, 24, replacement.bytes.length)
      set32(central, 42, localOffset)
    }
    return {
      local,
      entry: {
        name,
        flags,
        method: replacement.method,
        crc32: crc,
        compressedSize: compressed.length,
        uncompressedSize: replacement.bytes.length,
        localOffset,
        central,
      },
    }
  }
}

function validatePrefixCollisions(
  entries: readonly { name: string; folded: string; directory: boolean }[],
): void {
  const files = new Map(
    entries.filter((entry) => !entry.directory).map((entry) => [entry.folded, entry]),
  )
  for (const entry of entries) {
    const path = entry.directory ? entry.folded.slice(0, -1) : entry.folded
    const alias = entry.directory ? files.get(path) : undefined
    if (alias !== undefined) {
      fail(
        'OPC_ZIP_PREFIX_COLLISION',
        `ZIP file ${JSON.stringify(alias.name)} collides with directory ${JSON.stringify(entry.name)}.`,
      )
    }
    const segments = path.split('/')
    let prefix = ''
    for (let index = 0; index < segments.length - 1; index++) {
      prefix = prefix === '' ? segments[index]! : `${prefix}/${segments[index]}`
      const parent = files.get(prefix)
      if (parent !== undefined) {
        fail(
          'OPC_ZIP_PREFIX_COLLISION',
          `ZIP file ${JSON.stringify(parent.name)} collides with descendant ${JSON.stringify(entry.name)}.`,
        )
      }
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
