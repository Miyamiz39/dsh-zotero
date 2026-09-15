import { describe, expect, it } from 'vitest'
import {
  probeZoteroCustomProperties,
  updateZoteroCustomProperties,
  ZOTERO_CUSTOM_PROPERTIES_CONTENT_TYPE,
  ZOTERO_CUSTOM_PROPERTIES_PART,
  ZOTERO_CUSTOM_RELATIONSHIP_TYPE,
  ZoteroPropertiesError,
  type ZoteroPropertiesArchive,
} from '../../src/docx/properties.js'
import {
  createZoteroDocumentPreferences,
  serializeZoteroPreferenceChunks,
} from '../../src/docx/fields.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const CP = 'http://schemas.openxmlformats.org/officeDocument/2006/custom-properties'
const VT = 'http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes'
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types'

class MemoryArchive implements ZoteroPropertiesArchive {
  readonly parts = new Map<string, Uint8Array>()
  readonly mutations: string[] = []

  constructor(parts: Record<string, string>) {
    for (const [name, value] of Object.entries(parts)) this.parts.set(name, encoder.encode(value))
  }

  has(name: string): boolean {
    return this.parts.has(name)
  }

  read(name: string): Uint8Array {
    const value = this.parts.get(name)
    if (value === undefined) throw new Error(`missing ${name}`)
    return new Uint8Array(value)
  }

  replace(name: string, bytes: Uint8Array): void {
    if (!this.parts.has(name)) throw new Error(`missing ${name}`)
    this.parts.set(name, new Uint8Array(bytes))
    this.mutations.push(`replace:${name}`)
  }

  add(name: string, bytes: Uint8Array): void {
    if (this.parts.has(name)) throw new Error(`exists ${name}`)
    this.parts.set(name, new Uint8Array(bytes))
    this.mutations.push(`add:${name}`)
  }

  text(name: string): string {
    return decoder.decode(this.read(name))
  }
}

function baseParts(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    '_rels/.rels': `<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="office" Target="word/document.xml"/></Relationships>`,
    '[Content_Types].xml': `<Types xmlns="${CT}"><Default Extension="xml" ContentType="application/xml"/></Types>`,
    ...overrides,
  }
}

function customXml(properties: string): string {
  return `<Properties xmlns="${CP}" xmlns:vt="${VT}">${properties}</Properties>`
}

function xmlText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function property(name: string, pid: number, value: string, type = 'lpwstr'): string {
  return `<property fmtid="{OTHER}" pid="${pid}" name="${name}"><vt:${type}>${xmlText(value)}</vt:${type}></property>`
}

function preferenceProperties(
  style = 'old',
  pidStart = 20,
  mutate?: (chunks: { name: string; value: string }[]) => { name: string; value: string }[],
): string {
  const prefs = createZoteroDocumentPreferences({
    style,
    locale: 'en-US',
    zoteroVersion: '7.0',
    sessionID: 'old-session',
  })
  const original = serializeZoteroPreferenceChunks(prefs).map((chunk) => ({ ...chunk }))
  const chunks = mutate?.(original) ?? original
  return chunks.map((chunk, index) => property(chunk.name, pidStart + index, chunk.value)).join('')
}

function canonicalRelationship(id = 'rIdZotero1'): string {
  return `<Relationship Id="${id}" Type="${ZOTERO_CUSTOM_RELATIONSHIP_TYPE}" Target="docProps/custom.xml"/>`
}

function canonicalOverride(): string {
  return `<Override PartName="/docProps/custom.xml" ContentType="${ZOTERO_CUSTOM_PROPERTIES_CONTENT_TYPE}"/>`
}

function codeOf(run: () => unknown): string | undefined {
  try {
    run()
  } catch (error) {
    return error instanceof ZoteroPropertiesError ? error.code : undefined
  }
  return undefined
}

const OPTIONS = {
  style: 'apa',
  locale: 'zh-CN',
  zoteroVersion: '7.0.15',
  sessionID: 'new-session',
} as const

describe('updateZoteroCustomProperties', () => {
  it('creates custom properties and missing singleton package declarations', () => {
    const archive = new MemoryArchive(baseParts())
    const result = updateZoteroCustomProperties(archive, OPTIONS)

    expect(result.customPropertiesCreated).toBe(true)
    expect(result.relationshipCreated).toBe(true)
    expect(result.contentTypeCreated).toBe(true)
    expect(result.relationship).toEqual({
      relationshipId: 'rIdZotero1',
      target: 'docProps/custom.xml',
      type: ZOTERO_CUSTOM_RELATIONSHIP_TYPE,
    })
    expect(archive.mutations).toEqual([
      'add:docProps/custom.xml',
      'replace:_rels/.rels',
      'replace:[Content_Types].xml',
    ])
    expect(archive.text('_rels/.rels')).toContain(canonicalRelationship())
    expect(archive.text('[Content_Types].xml')).toContain(canonicalOverride())
    expect(probeZoteroCustomProperties(archive).preferences).toEqual(result.preferences)
  })

  it('preserves unrelated properties, PIDs, value types, relationships, and content types', () => {
    const existing = customXml(
      property('UnrelatedText', 7, 'keep me') +
        property('UnrelatedNumber', 12, '42', 'i4') +
        preferenceProperties(),
    )
    const archive = new MemoryArchive(
      baseParts({
        [ZOTERO_CUSTOM_PROPERTIES_PART]: existing,
        '_rels/.rels': `<Relationships xmlns="${REL}"><Relationship Id="rId7" Type="office" Target="word/document.xml"/>${canonicalRelationship('rId8')}</Relationships>`,
        '[Content_Types].xml': `<Types xmlns="${CT}"><Default Extension="xml" ContentType="application/xml"/>${canonicalOverride()}</Types>`,
      }),
    )

    const result = updateZoteroCustomProperties(archive, OPTIONS)
    const output = archive.text(ZOTERO_CUSTOM_PROPERTIES_PART)
    expect(result.customPropertiesCreated).toBe(false)
    expect(result.relationshipCreated).toBe(false)
    expect(result.contentTypeCreated).toBe(false)
    expect(output).toContain('name="UnrelatedText"')
    expect(output).toContain('pid="7"')
    expect(output).toContain('<vt:lpwstr>keep me</vt:lpwstr>')
    expect(output).toContain('name="UnrelatedNumber"')
    expect(output).toContain('pid="12"')
    expect(output).toContain('<vt:i4>42</vt:i4>')
    expect(output).not.toContain('old-session')
    expect(archive.mutations).toEqual(['replace:docProps/custom.xml'])
    expect(probeZoteroCustomProperties(archive).preferences.sessionID).toBe('new-session')
  })

  it('allocates new preference PIDs above every preserved PID', () => {
    const archive = new MemoryArchive(
      baseParts({
        [ZOTERO_CUSTOM_PROPERTIES_PART]: customXml(
          property('HighPid', 500, 'kept') + preferenceProperties('old', 10),
        ),
        '_rels/.rels': `<Relationships xmlns="${REL}">${canonicalRelationship()}</Relationships>`,
        '[Content_Types].xml': `<Types xmlns="${CT}">${canonicalOverride()}</Types>`,
      }),
    )
    updateZoteroCustomProperties(archive, OPTIONS)
    const output = archive.text(ZOTERO_CUSTOM_PROPERTIES_PART)
    expect(output).toContain('name="HighPid"')
    expect(output).toMatch(/pid="501" name="ZOTERO_PREF_1"/)
  })

  it('chooses a non-conflicting deterministic relationship id', () => {
    const archive = new MemoryArchive(
      baseParts({
        '_rels/.rels': `<Relationships xmlns="${REL}"><Relationship Id="rIdZotero1" Type="x" Target="x"/><Relationship Id="rIdZotero2" Type="y" Target="y"/></Relationships>`,
      }),
    )
    expect(updateZoteroCustomProperties(archive, OPTIONS).relationship.relationshipId).toBe(
      'rIdZotero3',
    )
  })

  const invalidCustomProperties: ReadonlyArray<readonly [string, string]> = [
    [
      customXml(property('Same', 2, 'a') + property('Same', 3, 'b')),
      'DOCX_CUSTOM_PROPERTY_DUPLICATE',
    ],
    [customXml(property('A', 2, 'a') + property('B', 2, 'b')), 'DOCX_CUSTOM_PROPERTY_PID_INVALID'],
    [customXml(property('ZOTERO_PREF_1', 2, 'x', 'i4')), 'DOCX_CUSTOM_PROPERTY_TYPE_INVALID'],
    [
      customXml(
        preferenceProperties('old', 20, (chunks) =>
          chunks.map((chunk, index) => ({ ...chunk, name: `ZOTERO_PREF_${index + 2}` })),
        ),
      ),
      'DOCX_CUSTOM_PROPERTY_SEQUENCE_INVALID',
    ],
  ]

  it.each(invalidCustomProperties)(
    'rejects invalid existing custom properties before mutation',
    (xml, code) => {
      const archive = new MemoryArchive(
        baseParts({
          [ZOTERO_CUSTOM_PROPERTIES_PART]: xml,
          '_rels/.rels': `<Relationships xmlns="${REL}">${canonicalRelationship()}</Relationships>`,
          '[Content_Types].xml': `<Types xmlns="${CT}">${canonicalOverride()}</Types>`,
        }),
      )
      expect(codeOf(() => updateZoteroCustomProperties(archive, OPTIONS))).toBe(code)
      expect(archive.mutations).toEqual([])
    },
  )

  it('rejects duplicate, external, and mistargeted custom relationships', () => {
    const cases = [
      `${canonicalRelationship('rId2')}${canonicalRelationship('rId3')}`,
      `<Relationship Id="rId2" Type="${ZOTERO_CUSTOM_RELATIONSHIP_TYPE}" Target="https://evil.example/custom.xml" TargetMode="External"/>`,
      `<Relationship Id="rId2" Type="${ZOTERO_CUSTOM_RELATIONSHIP_TYPE}" Target="custom.xml"/>`,
    ]
    expect(
      cases.map((relationships) => {
        const archive = new MemoryArchive(
          baseParts({
            '_rels/.rels': `<Relationships xmlns="${REL}">${relationships}</Relationships>`,
          }),
        )
        return codeOf(() => updateZoteroCustomProperties(archive, OPTIONS))
      }),
    ).toEqual([
      'DOCX_CUSTOM_RELATIONSHIP_DUPLICATE',
      'DOCX_CUSTOM_RELATIONSHIP_INVALID',
      'DOCX_CUSTOM_RELATIONSHIP_INVALID',
    ])
  })

  it('rejects duplicate and wrong custom content-type overrides', () => {
    const cases = [
      `${canonicalOverride()}${canonicalOverride()}`,
      '<Override PartName="/docProps/custom.xml" ContentType="text/plain"/>',
    ]
    expect(
      cases.map((overrides) => {
        const archive = new MemoryArchive(
          baseParts({
            '[Content_Types].xml': `<Types xmlns="${CT}">${overrides}</Types>`,
          }),
        )
        return codeOf(() => updateZoteroCustomProperties(archive, OPTIONS))
      }),
    ).toEqual(['DOCX_CUSTOM_CONTENT_TYPE_DUPLICATE', 'DOCX_CUSTOM_CONTENT_TYPE_INVALID'])
  })
})

describe('probeZoteroCustomProperties', () => {
  function completeArchive(): MemoryArchive {
    const archive = new MemoryArchive(baseParts())
    updateZoteroCustomProperties(archive, OPTIONS)
    archive.mutations.length = 0
    return archive
  }

  it('returns preferences, ordered chunks, and relationship consistency without mutation', () => {
    const archive = completeArchive()
    const probe = probeZoteroCustomProperties(archive)
    expect(probe.preferences.sessionID).toBe('new-session')
    expect(probe.chunks.map(({ name }) => name)).toEqual(
      probe.chunks.map((_, index) => `ZOTERO_PREF_${index + 1}`),
    )
    expect(probe.relationship.target).toBe('docProps/custom.xml')
    expect(probe.contentType.contentType).toBe(ZOTERO_CUSTOM_PROPERTIES_CONTENT_TYPE)
    expect(archive.mutations).toEqual([])
  })

  it('fails when the custom part or either package declaration is missing', () => {
    expect(codeOf(() => probeZoteroCustomProperties(new MemoryArchive(baseParts())))).toBe(
      'DOCX_CUSTOM_PROPERTIES_INVALID',
    )

    const missingRelationship = completeArchive()
    missingRelationship.parts.set('_rels/.rels', encoder.encode(`<Relationships xmlns="${REL}"/>`))
    expect(codeOf(() => probeZoteroCustomProperties(missingRelationship))).toBe(
      'DOCX_CUSTOM_RELATIONSHIP_INVALID',
    )

    const missingOverride = completeArchive()
    missingOverride.parts.set('[Content_Types].xml', encoder.encode(`<Types xmlns="${CT}"/>`))
    expect(codeOf(() => probeZoteroCustomProperties(missingOverride))).toBe(
      'DOCX_CUSTOM_CONTENT_TYPE_INVALID',
    )
  })

  it('fails on missing preference chunks and on wrong property types', () => {
    const noPrefs = completeArchive()
    noPrefs.parts.set(
      ZOTERO_CUSTOM_PROPERTIES_PART,
      encoder.encode(customXml(property('Unrelated', 2, 'x'))),
    )
    expect(codeOf(() => probeZoteroCustomProperties(noPrefs))).toBe(
      'DOCX_CUSTOM_PROPERTY_SEQUENCE_INVALID',
    )

    const wrongType = completeArchive()
    wrongType.parts.set(
      ZOTERO_CUSTOM_PROPERTIES_PART,
      encoder.encode(customXml(property('ZOTERO_PREF_1', 2, 'x', 'i4'))),
    )
    expect(codeOf(() => probeZoteroCustomProperties(wrongType))).toBe(
      'DOCX_CUSTOM_PROPERTY_TYPE_INVALID',
    )
  })
})
