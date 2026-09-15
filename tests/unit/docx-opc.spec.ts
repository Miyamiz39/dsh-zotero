import { deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { OpcArchive, OpcError, opcCrc32, type OpcArchiveLimits } from '../../src/docx/opc.js'

const LOCAL = 0x04034b50
const CENTRAL = 0x02014b50
const EOCD = 0x06054b50
const UTF8 = 0x0800

interface ZipInput {
  name: string
  bytes?: Uint8Array
  method?: 0 | 8 | number
  flags?: number
  crc?: number
  centralName?: string
  externalAttributes?: number
  centralExtra?: Uint8Array
  localExtra?: Uint8Array
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

function bytes(value: string): Uint8Array {
  return textEncoder.encode(value)
}

function set16(output: Uint8Array, offset: number, value: number): void {
  new DataView(output.buffer, output.byteOffset, output.byteLength).setUint16(offset, value, true)
}

function set32(output: Uint8Array, offset: number, value: number): void {
  new DataView(output.buffer, output.byteOffset, output.byteLength).setUint32(
    offset,
    value >>> 0,
    true,
  )
}

function get16(output: Uint8Array, offset: number): number {
  return new DataView(output.buffer, output.byteOffset, output.byteLength).getUint16(offset, true)
}

function get32(output: Uint8Array, offset: number): number {
  return new DataView(output.buffer, output.byteOffset, output.byteLength).getUint32(offset, true)
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.length
  }
  return output
}

function makeZip(inputs: readonly ZipInput[]): Uint8Array {
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let localOffset = 0
  for (const input of inputs) {
    const content = input.bytes ?? new Uint8Array()
    const method = input.method ?? 8
    const flags = input.flags ?? UTF8
    const name = bytes(input.name)
    const centralName = bytes(input.centralName ?? input.name)
    const compressed = method === 8 ? new Uint8Array(deflateRawSync(content)) : content
    const crc = input.crc ?? opcCrc32(content)
    const localExtra = input.localExtra ?? new Uint8Array()
    const centralExtra = input.centralExtra ?? new Uint8Array()
    const local = new Uint8Array(30 + name.length + localExtra.length + compressed.length)
    set32(local, 0, LOCAL)
    set16(local, 4, 20)
    set16(local, 6, flags)
    set16(local, 8, method)
    set32(local, 14, crc)
    set32(local, 18, compressed.length)
    set32(local, 22, content.length)
    set16(local, 26, name.length)
    set16(local, 28, localExtra.length)
    local.set(name, 30)
    local.set(localExtra, 30 + name.length)
    local.set(compressed, 30 + name.length + localExtra.length)

    const central = new Uint8Array(46 + centralName.length + centralExtra.length)
    set32(central, 0, CENTRAL)
    set16(central, 4, 0x0314)
    set16(central, 6, 20)
    set16(central, 8, flags)
    set16(central, 10, method)
    set32(central, 16, crc)
    set32(central, 20, compressed.length)
    set32(central, 24, content.length)
    set16(central, 28, centralName.length)
    set16(central, 30, centralExtra.length)
    set32(central, 38, input.externalAttributes ?? 0)
    set32(central, 42, localOffset)
    central.set(centralName, 46)
    central.set(centralExtra, 46 + centralName.length)
    locals.push(local)
    centrals.push(central)
    localOffset += local.length
  }
  const centralSize = centrals.reduce((sum, entry) => sum + entry.length, 0)
  const eocd = new Uint8Array(22)
  set32(eocd, 0, EOCD)
  set16(eocd, 8, inputs.length)
  set16(eocd, 10, inputs.length)
  set32(eocd, 12, centralSize)
  set32(eocd, 16, localOffset)
  return concat([...locals, ...centrals, eocd])
}

function eocdOffset(zip: Uint8Array): number {
  return zip.length - 22
}

function centralOffsets(zip: Uint8Array): Map<string, number> {
  const result = new Map<string, number>()
  const eocd = eocdOffset(zip)
  let cursor = get32(zip, eocd + 16)
  const count = get16(zip, eocd + 10)
  for (let index = 0; index < count; index++) {
    expect(get32(zip, cursor)).toBe(CENTRAL)
    const nameLength = get16(zip, cursor + 28)
    const extraLength = get16(zip, cursor + 30)
    const commentLength = get16(zip, cursor + 32)
    const name = textDecoder.decode(zip.subarray(cursor + 46, cursor + 46 + nameLength))
    result.set(name, get32(zip, cursor + 42))
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return result
}

function rawLocal(zip: Uint8Array, name: string): Uint8Array {
  const offsets = centralOffsets(zip)
  const offset = offsets.get(name)
  if (offset === undefined) throw new Error(`missing ${name}`)
  const ordered = [...offsets.values()].sort((a, b) => a - b)
  const next = ordered.find((candidate) => candidate > offset) ?? get32(zip, eocdOffset(zip) + 16)
  return zip.slice(offset, next)
}

function mutate(zip: Uint8Array, callback: (copy: Uint8Array) => void): Uint8Array {
  const copy = new Uint8Array(zip)
  callback(copy)
  return copy
}

function expectCode(run: () => unknown, code: string): void {
  let thrown: unknown
  try {
    run()
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(OpcError)
  expect((thrown as OpcError).code).toBe(code)
}

function limits(overrides: Partial<OpcArchiveLimits>): Partial<OpcArchiveLimits> {
  return overrides
}

describe('OpcArchive ordinary reads and raw-copy writes', () => {
  it('reads stored and deflated parts, replaces one, adds one, and reopens the output', () => {
    const input = makeZip([
      { name: '[Content_Types].xml', bytes: bytes('<Types/>'), method: 0 },
      { name: 'word/document.xml', bytes: bytes('<old/>'), method: 8 },
      { name: 'word/media/image.png', bytes: Uint8Array.of(1, 2, 3, 4), method: 0 },
    ])
    const archive = OpcArchive.open(input)
    expect(archive.names()).toEqual([
      '[Content_Types].xml',
      'word/document.xml',
      'word/media/image.png',
    ])
    expect(archive.has('word/document.xml')).toBe(true)
    expect(textDecoder.decode(archive.read('word/document.xml'))).toBe('<old/>')

    archive.replace('word/document.xml', bytes('<new/>'))
    archive.add('docProps/custom.xml', bytes('<Properties/>'), { compression: 'store' })
    const output = archive.generate()
    const reopened = OpcArchive.open(output)

    expect(textDecoder.decode(reopened.read('word/document.xml'))).toBe('<new/>')
    expect(textDecoder.decode(reopened.read('docProps/custom.xml'))).toBe('<Properties/>')
    expect(reopened.read('word/media/image.png')).toEqual(Uint8Array.of(1, 2, 3, 4))
  })

  it('copies every untouched local record and compressed payload byte-for-byte', () => {
    const input = makeZip([
      { name: 'word/document.xml', bytes: bytes('rewrite me'), method: 8 },
      {
        name: 'word/media/preserved.bin',
        bytes: bytes('already compressed representation stays exact'),
        method: 8,
        localExtra: Uint8Array.of(0xfe, 0xca, 0, 0),
        centralExtra: Uint8Array.of(0xfe, 0xca, 0, 0),
      },
    ])
    const preserved = rawLocal(input, 'word/media/preserved.bin')
    const archive = OpcArchive.open(input)
    archive.replace('word/document.xml', bytes('replacement'))
    const output = archive.generate()

    expect(rawLocal(output, 'word/media/preserved.bin')).toEqual(preserved)
    expect(OpcArchive.open(output).read('word/media/preserved.bin')).toEqual(
      bytes('already compressed representation stays exact'),
    )
  })

  it('copies caller and reader buffers so later mutation cannot alter archive state', () => {
    const original = bytes('original')
    const input = makeZip([{ name: 'word/document.xml', bytes: original }])
    const archive = OpcArchive.open(input)
    input.fill(0)
    expect(archive.read('word/document.xml')).toEqual(original)

    const replacement = bytes('replacement')
    archive.replace('word/document.xml', replacement)
    replacement.fill(0)
    const firstRead = archive.read('word/document.xml')
    firstRead.fill(0)
    expect(archive.read('word/document.xml')).toEqual(bytes('replacement'))
  })

  it('enforces read and mutation bounds and names missing/existing parts', () => {
    const archive = OpcArchive.open(makeZip([{ name: 'word/document.xml', bytes: bytes('1234') }]))
    expectCode(() => archive.read('word/document.xml', 3), 'OPC_ZIP_LIMIT')
    expectCode(() => archive.read('missing.xml'), 'OPC_PART_MISSING')
    expectCode(() => archive.replace('missing.xml', bytes('x')), 'OPC_PART_MISSING')
    expectCode(() => archive.add('word/document.xml', bytes('x')), 'OPC_PART_EXISTS')
    expectCode(() => archive.add('Word/DOCUMENT.XML', bytes('x')), 'OPC_ZIP_DUPLICATE')
  })
})

describe('OpcArchive integrity checks', () => {
  it('verifies CRC-32 when a part is read', () => {
    const zip = makeZip([{ name: 'word/document.xml', bytes: bytes('content'), crc: 0x12345678 }])
    const archive = OpcArchive.open(zip)
    expectCode(() => archive.read('word/document.xml'), 'OPC_ZIP_CRC_MISMATCH')
  })

  it('rejects truncated and malformed central/local offsets', () => {
    expectCode(() => OpcArchive.open(Uint8Array.of(1, 2, 3)), 'OPC_ZIP_INVALID')
    const zip = makeZip([{ name: 'word/document.xml', bytes: bytes('content') }])
    expectCode(
      () =>
        OpcArchive.open(
          mutate(zip, (copy) => set32(copy, get32(copy, eocdOffset(copy) + 16) + 42, 999999)),
        ),
      'OPC_ZIP_INVALID',
    )
    expectCode(
      () => OpcArchive.open(mutate(zip, (copy) => set32(copy, eocdOffset(copy) + 12, 1))),
      'OPC_ZIP_INVALID',
    )
  })

  it('rejects a different local and central name', () => {
    const zip = makeZip([
      { name: 'word/document.xml', centralName: 'word/otherdoc.xml', bytes: bytes('content') },
    ])
    expectCode(() => OpcArchive.open(zip), 'OPC_ZIP_INVALID')
  })
})

describe('OpcArchive hostile names', () => {
  it.each([
    '../evil.xml',
    'word/../evil.xml',
    './word.xml',
    '/word/document.xml',
    '//server/share.xml',
    'C:/word/document.xml',
    'word\\document.xml',
    'word//document.xml',
    'word/document.xml.',
    'word/folder /document.xml',
    'word/\u0000document.xml',
    'word/\u001fdocument.xml',
  ])('rejects unsafe entry name %j', (name) => {
    expectCode(() => OpcArchive.open(makeZip([{ name, bytes: bytes('x') }])), 'OPC_ZIP_PATH_UNSAFE')
  })

  it('rejects duplicate names after case folding', () => {
    expectCode(
      () =>
        OpcArchive.open(
          makeZip([
            { name: 'word/document.xml', bytes: bytes('one') },
            { name: 'WORD/DOCUMENT.XML', bytes: bytes('two') },
          ]),
        ),
      'OPC_ZIP_DUPLICATE',
    )
  })

  it('rejects a file/directory prefix collision in input and additions', () => {
    expectCode(
      () =>
        OpcArchive.open(
          makeZip([
            { name: 'word', bytes: bytes('file') },
            { name: 'word/document.xml', bytes: bytes('child') },
          ]),
        ),
      'OPC_ZIP_PREFIX_COLLISION',
    )
    const archive = OpcArchive.open(makeZip([{ name: 'word', bytes: bytes('file') }]))
    expectCode(() => archive.add('word/document.xml', bytes('child')), 'OPC_ZIP_PREFIX_COLLISION')
  })

  it('allows an explicit directory entry to prefix its children', () => {
    const archive = OpcArchive.open(
      makeZip([
        { name: 'word/', method: 0, externalAttributes: 0x10 },
        { name: 'word/document.xml', bytes: bytes('child') },
      ]),
    )
    expect(archive.names()).toEqual(['word/', 'word/document.xml'])
    expect(archive.read('word/document.xml')).toEqual(bytes('child'))
  })
})

describe('OpcArchive bounded and unsupported ZIP forms', () => {
  it('rejects entry, part, aggregate, ratio, archive, and modification limits', () => {
    const two = makeZip([
      { name: 'a.xml', bytes: bytes('1234'), method: 0 },
      { name: 'b.xml', bytes: bytes('5678'), method: 0 },
    ])
    expectCode(() => OpcArchive.open(two, limits({ maxEntries: 1 })), 'OPC_ZIP_LIMIT')
    expectCode(() => OpcArchive.open(two, limits({ maxPartBytes: 3 })), 'OPC_ZIP_LIMIT')
    expectCode(
      () => OpcArchive.open(two, limits({ maxTotalUncompressedBytes: 7 })),
      'OPC_ZIP_LIMIT',
    )
    expectCode(
      () => OpcArchive.open(two, limits({ maxArchiveBytes: two.length - 1 })),
      'OPC_ZIP_LIMIT',
    )

    const bomb = makeZip([{ name: 'bomb.bin', bytes: new Uint8Array(20_000), method: 8 }])
    expectCode(() => OpcArchive.open(bomb, limits({ maxCompressionRatio: 2 })), 'OPC_ZIP_LIMIT')

    const archive = OpcArchive.open(two, limits({ maxModifiedParts: 1 }))
    archive.replace('a.xml', bytes('a'))
    expectCode(() => archive.replace('b.xml', bytes('b')), 'OPC_ZIP_LIMIT')
  })

  it('rejects encrypted and unsupported compression methods', () => {
    expectCode(
      () => OpcArchive.open(makeZip([{ name: 'a.xml', bytes: bytes('a'), flags: UTF8 | 1 }])),
      'OPC_ZIP_ENCRYPTED',
    )
    expectCode(
      () => OpcArchive.open(makeZip([{ name: 'a.xml', bytes: bytes('a'), method: 12 }])),
      'OPC_ZIP_METHOD_UNSUPPORTED',
    )
  })

  it('rejects multidisk EOCD and per-entry disk numbers', () => {
    const zip = makeZip([{ name: 'a.xml', bytes: bytes('a') }])
    expectCode(
      () => OpcArchive.open(mutate(zip, (copy) => set16(copy, eocdOffset(copy) + 4, 1))),
      'OPC_ZIP_MULTIDISK',
    )
    expectCode(() => {
      const central = get32(zip, eocdOffset(zip) + 16)
      return OpcArchive.open(mutate(zip, (copy) => set16(copy, central + 34, 1)))
    }, 'OPC_ZIP_MULTIDISK')
  })

  it('rejects ZIP64 sentinels and ZIP64 extra fields', () => {
    const zip = makeZip([{ name: 'a.xml', bytes: bytes('a') }])
    expectCode(
      () => OpcArchive.open(mutate(zip, (copy) => set16(copy, eocdOffset(copy) + 10, 0xffff))),
      'OPC_ZIP64_UNSUPPORTED',
    )
    expectCode(
      () =>
        OpcArchive.open(
          makeZip([
            {
              name: 'a.xml',
              bytes: bytes('a'),
              centralExtra: Uint8Array.of(1, 0, 0, 0),
              localExtra: Uint8Array.of(1, 0, 0, 0),
            },
          ]),
        ),
      'OPC_ZIP64_UNSUPPORTED',
    )
  })
})
