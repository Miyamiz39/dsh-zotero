/** Strict, bounded XML helpers for the Open XML parts the DOCX bridge owns. */

import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import { ZOTERO_UNEXPECTED, ZoteroError } from '../errors.js'

const MAX_XML_NODES = 500_000
const MAX_XML_DEPTH = 256
const MAX_XML_ATTRIBUTES = 256

export const XML_NS = 'http://www.w3.org/XML/1998/namespace'
export const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
export const CUSTOM_PROPERTY_NS =
  'http://schemas.openxmlformats.org/officeDocument/2006/custom-properties'
export const CUSTOM_VALUE_NS =
  'http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes'
export const PACKAGE_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
export const CONTENT_TYPES_NS = 'http://schemas.openxmlformats.org/package/2006/content-types'

/** Parse well-formed XML without declarations that can expand external data. */
export function parseXml(bytes: Uint8Array, part: string): Document {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) {
    throw new ZoteroError(
      `${part} contains a prohibited DTD or entity declaration.`,
      ZOTERO_UNEXPECTED,
    )
  }
  const errors: string[] = []
  const document = new DOMParser({
    errorHandler: {
      warning: (message) => errors.push(message),
      error: (message) => errors.push(message),
      fatalError: (message) => errors.push(message),
    },
  }).parseFromString(text, 'application/xml')
  if (errors.length > 0 || document.getElementsByTagName('parsererror').length > 0) {
    throw new ZoteroError(`${part} is not well-formed XML.`, ZOTERO_UNEXPECTED)
  }
  validateTree(document, part)
  return document
}

/** Serialize one owned XML part as UTF-8. */
export function serializeXml(document: Document): Uint8Array {
  return new TextEncoder().encode(new XMLSerializer().serializeToString(document))
}

/** Direct child elements only. */
export function childElements(parent: Node): Element[] {
  return Array.from(parent.childNodes).filter((node): node is Element => node.nodeType === 1)
}

/** Descendants in one exact namespace. */
export function descendants(
  parent: Document | Element,
  namespace: string,
  name: string,
): Element[] {
  return Array.from(parent.getElementsByTagNameNS(namespace, name))
}

/** Namespace-safe local name for library implementations that expose either spelling. */
export function localName(node: Node): string {
  const namespaced = node as Node & { readonly localName?: string | null }
  return namespaced.localName ?? node.nodeName.replace(/^.*:/, '')
}

function validateTree(document: Document, part: string): void {
  let nodes = 0
  const stack: Array<{ node: Node; depth: number }> = [{ node: document, depth: 0 }]
  while (stack.length > 0) {
    const current = stack.pop()!
    nodes += 1
    if (nodes > MAX_XML_NODES) {
      throw new ZoteroError(`${part} exceeds the XML node limit.`, ZOTERO_UNEXPECTED)
    }
    if (current.depth > MAX_XML_DEPTH) {
      throw new ZoteroError(`${part} exceeds the XML depth limit.`, ZOTERO_UNEXPECTED)
    }
    if (current.node.nodeType === 1) {
      const element = current.node as Element
      if (element.attributes.length > MAX_XML_ATTRIBUTES) {
        throw new ZoteroError(`${part} has an element with too many attributes.`, ZOTERO_UNEXPECTED)
      }
    }
    for (const child of Array.from(current.node.childNodes ?? [])) {
      stack.push({ node: child, depth: current.depth + 1 })
    }
  }
}
