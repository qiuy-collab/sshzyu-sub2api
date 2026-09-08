/** Serializable canvas data. Input edges do not execute generation automatically. */
export const IMAGE_STUDIO_SCHEMA_VERSION = 1 as const
export const IMAGE_STUDIO_LIMITS = {
  nodes: 200,
  edges: 500,
  imagesPerNode: 10,
  textLength: 20_000,
  titleLength: 200,
  imageDimension: 16_384,
  imagePixels: 100_000_000,
  worldCoordinate: 1_000_000,
  documentBytes: 10 * 1024 * 1024,
} as const
export const IMAGE_STUDIO_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
export type ImageStudioImageMimeType = typeof IMAGE_STUDIO_IMAGE_MIME_TYPES[number]
export type ImageStudioNodeType = 'text' | 'reference' | 'generate' | 'result'
export interface ImageStudioPoint { x: number; y: number }
export interface ImageStudioViewport extends ImageStudioPoint { zoom: number }

interface ImageMetadata {
  id: string
  name?: string
  width?: number
  height?: number
}
export interface ImageStudioAssetRef extends ImageMetadata {
  kind: 'asset'
  assetId: string
  mimeType: ImageStudioImageMimeType
}
export interface ImageStudioUrlRef extends ImageMetadata {
  kind: 'url'
  url: string
  mimeType?: ImageStudioImageMimeType
}
export type ImageStudioImageRef = ImageStudioAssetRef | ImageStudioUrlRef

interface StudioNode<T extends ImageStudioNodeType, D> {
  id: string
  type: T
  title: string
  position: ImageStudioPoint
  data: D
}
export interface ImageStudioGenerateData {
  prompt: string
  referenceImages: ImageStudioImageRef[]
  model: string
  imageSize: string
  aspectRatio: string
  outputCount: number
}
export type ImageStudioNode =
  | StudioNode<'text', { text: string }>
  | StudioNode<'reference', { images: ImageStudioImageRef[] }>
  | StudioNode<'generate', ImageStudioGenerateData>
  | StudioNode<'result', { images: ImageStudioImageRef[]; prompt?: string; batchId?: string; customId?: string; generateNodeId?: string }>
export type ImageStudioNodeFor<T extends ImageStudioNodeType> = Extract<ImageStudioNode, { type: T }>
export interface ImageStudioEdge { id: string; source: string; target: string }
export interface ImageStudioDocument {
  schemaVersion: typeof IMAGE_STUDIO_SCHEMA_VERSION
  id: string
  title: string
  viewport: ImageStudioViewport
  nodes: ImageStudioNode[]
  edges: ImageStudioEdge[]
  updatedAt: number
}
export interface ImageStudioSanitizeOptions { origin?: string }
export type ImageStudioConnectionReason = 'MISSING_NODE' | 'SELF_CONNECTION' | 'DUPLICATE_CONNECTION'
  | 'EDGE_LIMIT' | 'INCOMPATIBLE_CONNECTION' | 'CYCLE' | 'IMAGE_LIMIT' | 'TEXT_LIMIT'
export type ImageStudioConnectionCheck = { ok: true } | { ok: false; reason: ImageStudioConnectionReason }
export interface ImageStudioGenerationInputs {
  prompt: string
  images: ImageStudioImageRef[]
  sourceNodeIds: string[]
}

export class ImageStudioGraphError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'ImageStudioGraphError'
  }
}

function ensure(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new ImageStudioGraphError(code, message)
}

/** Reject accessors, custom prototypes and dangerous keys even in discarded fields. */
export function assertSafeStudioData(input: unknown): void {
  let visited = 0
  const active = new Set<object>()
  function visit(value: unknown, depth: number): void {
    ensure(++visited <= 50_000 && depth <= 32, 'DATA_LIMIT', 'Document structure is too large')
    if (value === null || typeof value !== 'object') {
      ensure(['string', 'number', 'boolean', 'undefined'].includes(typeof value) || value === null,
        'INVALID_DATA', 'Only JSON data is supported')
      return
    }
    ensure(!active.has(value), 'INVALID_DATA', 'Circular objects are not supported')
    const prototype = Object.getPrototypeOf(value)
    ensure(Array.isArray(value) ? prototype === Array.prototype : prototype === Object.prototype || prototype === null,
      'UNSAFE_DATA', 'Custom object prototypes are not supported')
    active.add(value)
    for (const key of Reflect.ownKeys(value)) {
      ensure(typeof key === 'string' && !['__proto__', 'prototype', 'constructor'].includes(key),
        'UNSAFE_DATA', 'Unsafe document field')
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!
      ensure(!descriptor.get && !descriptor.set, 'UNSAFE_DATA', 'Document accessors are not supported')
      visit(descriptor.value, depth + 1)
    }
    active.delete(value)
  }
  visit(input, 0)
}

function record(value: unknown): Record<string, unknown> {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_DOCUMENT', 'Expected an object')
  return value as Record<string, unknown>
}
function string(value: unknown, limit: number, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback
  ensure(typeof value === 'string' && value.length <= limit && !value.includes('\0'), 'TEXT_LIMIT', 'Invalid or oversized text')
  return value
}
function id(value: unknown): string {
  const result = string(value, 128)
  ensure(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(result), 'INVALID_ID', 'Invalid identifier')
  return result
}
function number(value: unknown, min: number, max: number, integer = false): number {
  ensure(typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    && (!integer || Number.isInteger(value)), 'INVALID_DIMENSION', 'Invalid numeric value')
  return value
}
function point(value: unknown): ImageStudioPoint {
  const data = record(value)
  return { x: number(data.x, -IMAGE_STUDIO_LIMITS.worldCoordinate, IMAGE_STUDIO_LIMITS.worldCoordinate),
    y: number(data.y, -IMAGE_STUDIO_LIMITS.worldCoordinate, IMAGE_STUDIO_LIMITS.worldCoordinate) }
}
function mime(value: unknown): ImageStudioImageMimeType {
  ensure(typeof value === 'string' && (IMAGE_STUDIO_IMAGE_MIME_TYPES as readonly string[]).includes(value),
    'INVALID_IMAGE_TYPE', 'Only PNG, JPEG and WebP images are supported')
  return value as ImageStudioImageMimeType
}

export function createStudioId(prefix = 'node'): string {
  const random = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return id(`${prefix}-${random}`)
}

export function normalizeStudioImageUrl(value: string, origin?: string): string | null {
  if (!value || value.length > 4096 || [...value].some(character => character.charCodeAt(0) <= 32 || character === '\\')) return null
  try {
    const currentOrigin = origin ?? (typeof location !== 'undefined' ? location.origin : undefined)
    const base = currentOrigin ? new URL(currentOrigin) : undefined
    if (base && !['http:', 'https:'].includes(base.protocol)) return null
    const url = new URL(value, base?.origin)
    if (url.username || url.password) return null
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && base?.origin === url.origin)) return null
    return url.href
  } catch {
    return null
  }
}

export function sanitizeStudioImageRef(value: unknown, options: ImageStudioSanitizeOptions = {}): ImageStudioImageRef {
  assertSafeStudioData(value)
  const data = record(value)
  const meta: ImageMetadata = { id: id(data.id) }
  if (data.name !== undefined) meta.name = string(data.name, 255)
  if (data.width !== undefined) meta.width = number(data.width, 1, IMAGE_STUDIO_LIMITS.imageDimension, true)
  if (data.height !== undefined) meta.height = number(data.height, 1, IMAGE_STUDIO_LIMITS.imageDimension, true)
  if (meta.width && meta.height) ensure(meta.width * meta.height <= IMAGE_STUDIO_LIMITS.imagePixels,
    'INVALID_DIMENSION', 'Image dimensions are too large')
  if (data.kind === 'asset') return { ...meta, kind: 'asset', assetId: id(data.assetId), mimeType: mime(data.mimeType) }
  ensure(data.kind === 'url', 'INVALID_IMAGE', 'Unsupported image reference')
  const url = normalizeStudioImageUrl(string(data.url, 4096), options.origin)
  ensure(url, 'UNSAFE_URL', 'Image URL must use HTTPS or the current origin')
  const suffix = new URL(url).pathname.toLowerCase().split('.').pop()
  const inferred = suffix === 'png' ? 'image/png' : suffix === 'jpg' || suffix === 'jpeg' ? 'image/jpeg'
    : suffix === 'webp' ? 'image/webp' : undefined
  return { ...meta, kind: 'url', url, mimeType: mime(data.mimeType ?? inferred) }
}

function images(value: unknown, options: ImageStudioSanitizeOptions): ImageStudioImageRef[] {
  ensure(Array.isArray(value) && value.length <= IMAGE_STUDIO_LIMITS.imagesPerNode,
    'IMAGE_LIMIT', 'Too many image references')
  return value.map(item => sanitizeStudioImageRef(item, options))
}

function sanitizeNode(value: unknown, options: ImageStudioSanitizeOptions): ImageStudioNode {
  const source = record(value)
  const data = record(source.data)
  const common = { id: id(source.id), title: string(source.title, IMAGE_STUDIO_LIMITS.titleLength, ''), position: point(source.position) }
  switch (source.type) {
    case 'text': return { ...common, type: 'text', data: { text: string(data.text, IMAGE_STUDIO_LIMITS.textLength, '') } }
    case 'reference': return { ...common, type: 'reference', data: { images: images(data.images, options) } }
    case 'generate': return { ...common, type: 'generate', data: {
      prompt: string(data.prompt, IMAGE_STUDIO_LIMITS.textLength, ''),
      referenceImages: images(data.referenceImages, options), model: string(data.model, 200, ''),
      imageSize: string(data.imageSize, 32, '1K'), aspectRatio: string(data.aspectRatio, 32, '1:1'),
      outputCount: number(data.outputCount ?? 1, 1, 10, true),
    } }
    case 'result': {
      const result: ImageStudioNodeFor<'result'> = { ...common, type: 'result', data: { images: images(data.images, options) } }
      if (data.prompt !== undefined) result.data.prompt = string(data.prompt, IMAGE_STUDIO_LIMITS.textLength)
      if (data.batchId !== undefined) result.data.batchId = string(data.batchId, 200)
      if (data.customId !== undefined) result.data.customId = string(data.customId, 200)
      if (data.generateNodeId !== undefined) result.data.generateNodeId = id(data.generateNodeId)
      return result
    }
    default: throw new ImageStudioGraphError('INVALID_NODE', 'Unsupported node type')
  }
}

export function createStudioDocument(idValue = 'default', title = '未命名画布'): ImageStudioDocument {
  return { schemaVersion: IMAGE_STUDIO_SCHEMA_VERSION, id: id(idValue),
    title: string(title, IMAGE_STUDIO_LIMITS.titleLength), viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [], edges: [], updatedAt: Date.now() }
}

export function createStudioNode<T extends ImageStudioNodeType>(type: T, position: ImageStudioPoint,
  data?: Partial<ImageStudioNodeFor<T>['data']>, title = ''): ImageStudioNodeFor<T> {
  const defaults = {
    text: { text: '' }, reference: { images: [] }, result: { images: [] },
    generate: { prompt: '', referenceImages: [], model: '', imageSize: '1K', aspectRatio: '1:1', outputCount: 1 },
  }
  const value = { id: createStudioId(), type, title, position, data: { ...defaults[type], ...data } }
  assertSafeStudioData(value)
  return sanitizeNode(value, {}) as ImageStudioNodeFor<T>
}

export function canConnectNodes(document: ImageStudioDocument, source: string, target: string): ImageStudioConnectionCheck {
  const from = document.nodes.find(node => node.id === source)
  const to = document.nodes.find(node => node.id === target)
  if (!from || !to) {
    return { ok: false, reason: 'MISSING_NODE' }
  }
  if (source === target) return { ok: false, reason: 'SELF_CONNECTION' }
  if (document.edges.some(edge => edge.source === source && edge.target === target)) return { ok: false, reason: 'DUPLICATE_CONNECTION' }
  if (from.type === 'generate' || to.type !== 'generate') return { ok: false, reason: 'INCOMPATIBLE_CONNECTION' }
  if (document.edges.length >= IMAGE_STUDIO_LIMITS.edges) return { ok: false, reason: 'EDGE_LIMIT' }
  const adjacency = new Map<string, string[]>()
  function add(fromId: string, toId: string) { adjacency.set(fromId, [...(adjacency.get(fromId) ?? []), toId]) }
  for (const edge of document.edges) add(edge.source, edge.target)
  for (const node of document.nodes) {
    if (node.type === 'result' && node.data.generateNodeId) add(node.data.generateNodeId, node.id)
  }
  const pending = [target], seen = new Set<string>()
  while (pending.length) {
    const current = pending.pop()!
    if (current === source) return { ok: false, reason: 'CYCLE' }
    if (seen.has(current)) continue
    seen.add(current)
    pending.push(...(adjacency.get(current) ?? []))
  }
  try {
    collectGenerationInputs({ ...document, edges: [...document.edges, { id: 'prospective', source, target }] }, target, false)
  } catch (error) {
    if (error instanceof ImageStudioGraphError && (error.code === 'IMAGE_LIMIT' || error.code === 'TEXT_LIMIT')) {
      return { ok: false, reason: error.code }
    }
    throw error
  }
  return { ok: true }
}

function collectGenerationInputs(document: ImageStudioDocument, generatorId: string, requireImages: boolean): ImageStudioGenerationInputs {
  const generator = document.nodes.find(node => node.id === generatorId)
  ensure(generator?.type === 'generate', 'MISSING_NODE', 'Generation node is missing')
  const texts = [generator.data.prompt.trim()]
  const references = [...generator.data.referenceImages]
  const sourceNodeIds: string[] = []
  for (const edge of document.edges) {
    if (edge.target !== generatorId) continue
    const node = document.nodes.find(candidate => candidate.id === edge.source)
    ensure(node && node.type !== 'generate', 'INCOMPATIBLE_CONNECTION', 'Invalid generation input')
    sourceNodeIds.push(node.id)
    if (node.type === 'text') texts.push(node.data.text.trim())
    else {
      if (requireImages) ensure(node.data.images.length > 0, 'MISSING_IMAGE', 'A connected image node has no ready images')
      references.push(...node.data.images)
    }
  }
  const prompt = [...new Set(texts.filter(Boolean))].join('\n\n')
  ensure(prompt.length <= IMAGE_STUDIO_LIMITS.textLength, 'TEXT_LIMIT', 'Combined prompt is too long')
  const unique = new Map<string, ImageStudioImageRef>()
  for (const image of references) {
    const key = image.kind === 'asset' ? 'asset:' + image.assetId : 'url:' + image.url
    if (!unique.has(key)) unique.set(key, image)
  }
  ensure(unique.size <= IMAGE_STUDIO_LIMITS.imagesPerNode, 'IMAGE_LIMIT', 'A generation can use at most ten reference images')
  return { prompt, images: [...unique.values()], sourceNodeIds: [...new Set(sourceNodeIds)] }
}

export function resolveGenerationInputs(document: ImageStudioDocument, generatorId: string): ImageStudioGenerationInputs {
  return collectGenerationInputs(document, generatorId, true)
}

export function connectNodes(document: ImageStudioDocument, source: string, target: string, edgeId = createStudioId('edge')): ImageStudioDocument {
  const check = canConnectNodes(document, source, target)
  if (!check.ok) throw new ImageStudioGraphError(check.reason, 'This connection cannot be added')
  ensure(!document.edges.some(edge => edge.id === edgeId), 'DUPLICATE_ID', 'Edge identifier already exists')
  return { ...document, edges: [...document.edges, { id: id(edgeId), source, target }], updatedAt: Date.now() }
}

export function removeStudioNode(document: ImageStudioDocument, nodeId: string): ImageStudioDocument {
  const nodes = document.nodes.filter(node => node.id !== nodeId).map(node => {
    if (node.type !== 'result' || node.data.generateNodeId !== nodeId) return node
    const data = { ...node.data }
    delete data.generateNodeId
    return { ...node, data }
  })
  return { ...document, nodes,
    edges: document.edges.filter(edge => edge.source !== nodeId && edge.target !== nodeId), updatedAt: Date.now() }
}

export function sanitizeStudioDocument(value: unknown, options: ImageStudioSanitizeOptions = {}): ImageStudioDocument {
  assertSafeStudioData(value)
  const source = record(value)
  ensure(source.schemaVersion === IMAGE_STUDIO_SCHEMA_VERSION, 'SCHEMA_VERSION', 'Unsupported board schema version')
  ensure(Array.isArray(source.nodes) && source.nodes.length <= IMAGE_STUDIO_LIMITS.nodes, 'NODE_LIMIT', 'Too many board nodes')
  ensure(Array.isArray(source.edges) && source.edges.length <= IMAGE_STUDIO_LIMITS.edges, 'EDGE_LIMIT', 'Too many board connections')
  const viewport = record(source.viewport)
  const document: ImageStudioDocument = { schemaVersion: IMAGE_STUDIO_SCHEMA_VERSION,
    id: id(source.id), title: string(source.title, IMAGE_STUDIO_LIMITS.titleLength, ''),
    viewport: { ...point(viewport), zoom: number(viewport.zoom, 0.05, 5) },
    nodes: source.nodes.map(node => sanitizeNode(node, options)), edges: [],
    updatedAt: number(source.updatedAt, 0, Number.MAX_SAFE_INTEGER, true) }
  ensure(new Set(document.nodes.map(node => node.id)).size === document.nodes.length, 'DUPLICATE_ID', 'Duplicate node identifiers')
  const assetTypes = new Map<string, ImageStudioImageMimeType>()
  for (const node of document.nodes) {
    if (node.type === 'result' && node.data.generateNodeId) ensure(
      document.nodes.some(candidate => candidate.id === node.data.generateNodeId && candidate.type === 'generate'),
      'MISSING_NODE', 'Result source generation node is missing')
    const references = node.type === 'text' ? [] : node.type === 'generate' ? node.data.referenceImages : node.data.images
    for (const image of references) {
      if (image.kind !== 'asset') continue
      ensure(!assetTypes.has(image.assetId) || assetTypes.get(image.assetId) === image.mimeType,
        'INVALID_IMAGE_TYPE', 'References to one local asset must have the same MIME type')
      assetTypes.set(image.assetId, image.mimeType)
    }
  }
  const edgeIds = new Set<string>()
  for (const input of source.edges) {
    const edge = record(input)
    const clean = { id: id(edge.id), source: id(edge.source), target: id(edge.target) }
    ensure(!edgeIds.has(clean.id), 'DUPLICATE_ID', 'Duplicate edge identifiers')
    const check = canConnectNodes(document, clean.source, clean.target)
    if (!check.ok) throw new ImageStudioGraphError(check.reason, 'Invalid imported connection')
    edgeIds.add(clean.id)
    document.edges.push(clean)
  }
  return document
}

/** Schema-only JSON; use storage.exportPortableDocument for user-facing files. */
export function exportStudioDocument(document: ImageStudioDocument, options: ImageStudioSanitizeOptions = {}): string {
  const json = JSON.stringify(sanitizeStudioDocument(document, options), null, 2)
  ensure(new TextEncoder().encode(json).byteLength <= IMAGE_STUDIO_LIMITS.documentBytes, 'DATA_LIMIT', 'Document JSON is too large')
  return json
}

export function importStudioDocument(json: string, options: ImageStudioSanitizeOptions = {}): ImageStudioDocument {
  ensure(typeof json === 'string' && json.length <= IMAGE_STUDIO_LIMITS.documentBytes
    && new TextEncoder().encode(json).byteLength <= IMAGE_STUDIO_LIMITS.documentBytes, 'DATA_LIMIT', 'Document JSON is too large')
  let parsed: unknown
  try { parsed = JSON.parse(json) } catch { throw new ImageStudioGraphError('INVALID_JSON', 'Invalid board JSON') }
  return sanitizeStudioDocument(parsed, options)
}
