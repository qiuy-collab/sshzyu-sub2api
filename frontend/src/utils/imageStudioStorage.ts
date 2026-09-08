import {
  assertSafeStudioData, createStudioId, IMAGE_STUDIO_IMAGE_MIME_TYPES, IMAGE_STUDIO_LIMITS,
  ImageStudioGraphError, sanitizeStudioDocument, sanitizeStudioImageRef,
  type ImageStudioAssetRef, type ImageStudioDocument, type ImageStudioImageRef,
  type ImageStudioSanitizeOptions,
} from './imageStudioGraph'

export const IMAGE_STUDIO_DATABASE_NAME = 'sshzyu-image-studio-v1'
export const IMAGE_STUDIO_MAX_ASSET_BYTES = 10 * 1024 * 1024
export const IMAGE_STUDIO_MAX_PORTABLE_BYTES = 50 * 1024 * 1024
export const IMAGE_STUDIO_MAX_PORTABLE_JSON_BYTES = 80 * 1024 * 1024
const DOCUMENTS = 'documents', ASSETS = 'assets'

export interface ImageStudioAssetMetadata { id?: string; name?: string; width?: number; height?: number }
export interface ImageStudioStorageOptions extends ImageStudioSanitizeOptions { indexedDB?: IDBFactory }
export interface ImageStudioStorage {
  loadDocument(id?: string): Promise<ImageStudioDocument | null>
  saveDocument(document: ImageStudioDocument): Promise<void>
  deleteDocument(id?: string): Promise<void>
  putAsset(blob: Blob, metadata?: ImageStudioAssetMetadata): Promise<ImageStudioAssetRef>
  getAsset(assetId: string): Promise<Blob | null>
  deleteAsset(assetId: string): Promise<void>
  clear(): Promise<void>
  close(): void
  exportPortableDocument(document: ImageStudioDocument): Promise<string>
  importPortableDocument(json: string, options?: { documentId?: string }): Promise<ImageStudioDocument>
}

export class ImageStudioStorageError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'ImageStudioStorageError'
  }
}
function ensure(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new ImageStudioStorageError(code, message)
}
function storageError(error: unknown): Error {
  if (error instanceof ImageStudioStorageError || error instanceof ImageStudioGraphError) return error
  const name = error && typeof error === 'object' && 'name' in error ? error.name : ''
  if (name === 'QuotaExceededError') return new ImageStudioStorageError('QUOTA_EXCEEDED', 'Local image storage is full')
  if (name === 'ConstraintError') return new ImageStudioStorageError('ASSET_EXISTS', 'This image asset already exists')
  return new ImageStudioStorageError('STORAGE_FAILED', 'The local board could not be saved or read')
}
function safeId(value: unknown): string {
  ensure(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value), 'INVALID_ID', 'Invalid storage identifier')
  return value
}

function readBlob(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = () => reject(new ImageStudioStorageError('ASSET_READ_FAILED', 'Unable to read image data'))
    reader.readAsArrayBuffer(blob)
  })
}

/** Check MIME and the file signature; image data never goes into localStorage. */
export async function validateStudioImageBlob(blob: Blob): Promise<void> {
  ensure(blob instanceof Blob && blob.size > 0 && blob.size <= IMAGE_STUDIO_MAX_ASSET_BYTES,
    'ASSET_SIZE', 'Each image must be nonempty and at most 10 MiB')
  ensure((IMAGE_STUDIO_IMAGE_MIME_TYPES as readonly string[]).includes(blob.type),
    'INVALID_IMAGE_TYPE', 'Only PNG, JPEG and WebP images are supported')
  const bytes = new Uint8Array(await readBlob(blob.slice(0, 12)))
  const png = [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
  const webp = bytes.length >= 12 && [82, 73, 70, 70].every((value, index) => bytes[index] === value)
    && [87, 69, 66, 80].every((value, index) => bytes[index + 8] === value)
  ensure((blob.type === 'image/png' && png) || (blob.type === 'image/jpeg' && jpeg) || (blob.type === 'image/webp' && webp),
    'INVALID_IMAGE_CONTENT', 'Image content does not match its MIME type')
}

function allImages(document: ImageStudioDocument): ImageStudioImageRef[] {
  return document.nodes.flatMap(node => node.type === 'text' ? []
    : node.type === 'generate' ? node.data.referenceImages : node.data.images)
}
function remapAssets(document: ImageStudioDocument, ids: Map<string, string>): ImageStudioDocument {
  const remap = (image: ImageStudioImageRef): ImageStudioImageRef => image.kind === 'asset'
    ? { ...image, assetId: ids.get(image.assetId)! } : image
  return { ...document, nodes: document.nodes.map(node => {
    if (node.type === 'text') return node
    if (node.type === 'generate') return { ...node, data: { ...node.data, referenceImages: node.data.referenceImages.map(remap) } }
    return { ...node, data: { ...node.data, images: node.data.images.map(remap) } }
  }) }
}
async function encodeBlob(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await readBlob(blob))
  const chunks: string[] = []
  for (let index = 0; index < bytes.length; index += 32_768) {
    chunks.push(String.fromCharCode(...bytes.subarray(index, index + 32_768)))
  }
  return btoa(chunks.join(''))
}
function decodeBase64(value: unknown): Uint8Array {
  ensure(typeof value === 'string' && value.length > 0 && value.length <= Math.ceil(IMAGE_STUDIO_MAX_ASSET_BYTES / 3) * 4
    && value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value), 'INVALID_ASSET_DATA', 'Invalid embedded image data')
  const size = value.length / 4 * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0)
  ensure(size <= IMAGE_STUDIO_MAX_ASSET_BYTES, 'ASSET_SIZE', 'Embedded image exceeds 10 MiB')
  let binary: string
  try { binary = atob(value) } catch { throw new ImageStudioStorageError('INVALID_ASSET_DATA', 'Invalid embedded image data') }
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

export function createImageStudioStorage(userId: string | number, options: ImageStudioStorageOptions = {}): ImageStudioStorage {
  const owner = safeId(typeof userId === 'number' && Number.isSafeInteger(userId) && userId >= 0 ? String(userId) : userId)
  let opening: Promise<IDBDatabase> | undefined
  let database: IDBDatabase | undefined
  let closed = false

  function open(): Promise<IDBDatabase> {
    if (closed) return Promise.reject(new ImageStudioStorageError('STORAGE_CLOSED', 'This board storage session is closed'))
    if (opening) return opening
    opening = new Promise<IDBDatabase>((resolve, reject) => {
      let factory: IDBFactory | undefined
      try { factory = options.indexedDB ?? globalThis.indexedDB } catch { /* private-mode access may throw */ }
      if (!factory) { reject(new ImageStudioStorageError('STORAGE_UNAVAILABLE', 'IndexedDB is unavailable')); return }
      let request: IDBOpenDBRequest
      try { request = factory.open(IMAGE_STUDIO_DATABASE_NAME, 1) } catch (error) { reject(storageError(error)); return }
      let failed = false
      request.onupgradeneeded = () => {
        for (const name of [DOCUMENTS, ASSETS]) {
          if (!request.result.objectStoreNames.contains(name)) {
            request.result.createObjectStore(name, { keyPath: ['userId', 'id'] }).createIndex('userId', 'userId', { unique: false })
          }
        }
      }
      request.onerror = () => { failed = true; reject(storageError(request.error)) }
      request.onblocked = () => { failed = true; reject(new ImageStudioStorageError('STORAGE_BLOCKED', 'Another tab is blocking local board storage')) }
      request.onsuccess = () => {
        if (failed || closed) {
          request.result.close()
          reject(new ImageStudioStorageError('STORAGE_CLOSED', 'This board storage session is closed'))
          return
        }
        database = request.result
        database.onversionchange = () => { database?.close(); database = undefined; opening = undefined }
        resolve(database)
      }
    }).catch(error => { opening = undefined; throw error })
    return opening
  }

  async function transaction<T>(stores: string[], mode: IDBTransactionMode,
    action: (tx: IDBTransaction, result: (value: T) => void, fail: (error: unknown) => void) => void): Promise<T> {
    const db = await open()
    return new Promise<T>((resolve, reject) => {
      let tx: IDBTransaction
      try { tx = db.transaction(stores, mode) } catch (error) { reject(storageError(error)); return }
      let value: T
      const fail = (error: unknown) => {
        try { tx.abort() } catch { /* transaction may already have aborted */ }
        reject(storageError(error))
      }
      // A request's success precedes commit. Never report saved until oncomplete.
      tx.oncomplete = () => resolve(value)
      tx.onabort = () => reject(storageError(tx.error))
      tx.onerror = event => reject(storageError(tx.error ?? (event.target as IDBRequest | null)?.error))
      try { action(tx, result => { value = result }, fail) } catch (error) { fail(error) }
    })
  }

  const storage: ImageStudioStorage = {
    async loadDocument(documentId = 'default') {
      return transaction([DOCUMENTS], 'readonly', (tx, done, fail) => {
        const request = tx.objectStore(DOCUMENTS).get([owner, safeId(documentId)])
        request.onsuccess = () => {
          try {
            if (!request.result) { done(null); return }
            ensure(request.result.userId === owner, 'OWNER_MISMATCH', 'Board owner does not match')
            done(sanitizeStudioDocument(request.result.document, options))
          } catch (error) { fail(error) }
        }
      })
    },
    async saveDocument(document) {
      const clean = sanitizeStudioDocument(document, options)
      ensure(new TextEncoder().encode(JSON.stringify(clean)).byteLength <= IMAGE_STUDIO_LIMITS.documentBytes,
        'DOCUMENT_SIZE', 'Board document is too large')
      await transaction<void>([DOCUMENTS], 'readwrite', tx => {
        tx.objectStore(DOCUMENTS).put({ userId: owner, id: clean.id, document: clean })
      })
    },
    async deleteDocument(documentId = 'default') {
      await transaction<void>([DOCUMENTS], 'readwrite', tx => { tx.objectStore(DOCUMENTS).delete([owner, safeId(documentId)]) })
    },
    async putAsset(blob, metadata = {}) {
      assertSafeStudioData(metadata)
      await validateStudioImageBlob(blob)
      const assetId = metadata.id ? safeId(metadata.id) : createStudioId('asset')
      const reference = sanitizeStudioImageRef({ id: assetId, kind: 'asset', assetId, mimeType: blob.type,
        name: metadata.name, width: metadata.width, height: metadata.height }, options) as ImageStudioAssetRef
      await transaction<void>([ASSETS], 'readwrite', tx => {
        tx.objectStore(ASSETS).add({ userId: owner, id: assetId, blob })
      })
      return reference
    },
    async getAsset(assetId) {
      return transaction([ASSETS], 'readonly', (tx, done, fail) => {
        const request = tx.objectStore(ASSETS).get([owner, safeId(assetId)])
        request.onsuccess = () => {
          try {
            if (!request.result) { done(null); return }
            ensure(request.result.userId === owner && request.result.blob instanceof Blob, 'INVALID_ASSET', 'Invalid local image asset')
            done(request.result.blob)
          } catch (error) { fail(error) }
        }
      })
    },
    async deleteAsset(assetId) {
      await transaction<void>([ASSETS], 'readwrite', tx => { tx.objectStore(ASSETS).delete([owner, safeId(assetId)]) })
    },
    async clear() {
      await transaction<void>([DOCUMENTS, ASSETS], 'readwrite', (tx, _done, fail) => {
        for (const name of [DOCUMENTS, ASSETS]) {
          const store = tx.objectStore(name)
          const request = store.index('userId').getAllKeys(owner)
          request.onsuccess = () => {
            try { for (const key of request.result) store.delete(key) } catch (error) { fail(error) }
          }
        }
      })
    },
    close() { closed = true; database?.close(); database = undefined },
    async exportPortableDocument(document) {
      const clean = sanitizeStudioDocument(document, options)
      ensure(new TextEncoder().encode(JSON.stringify(clean)).byteLength <= IMAGE_STUDIO_LIMITS.documentBytes,
        'DOCUMENT_SIZE', 'Board document is too large')
      const references = new Map<string, ImageStudioAssetRef>()
      for (const image of allImages(clean)) if (image.kind === 'asset') references.set(image.assetId, image)
      const assets: { id: string; mimeType: string; base64: string }[] = []
      let total = 0
      for (const [assetId, reference] of references) {
        const blob = await storage.getAsset(assetId)
        ensure(blob, 'MISSING_ASSET', 'A board image is missing from this user’s local storage')
        await validateStudioImageBlob(blob)
        ensure(blob.type === reference.mimeType, 'INVALID_IMAGE_TYPE', 'Stored image MIME type does not match its reference')
        total += blob.size
        ensure(total <= IMAGE_STUDIO_MAX_PORTABLE_BYTES, 'PORTABLE_SIZE', 'Embedded images exceed the 50 MiB export limit')
        assets.push({ id: assetId, mimeType: blob.type, base64: await encodeBlob(blob) })
      }
      const json = JSON.stringify({ format: 'sshzyu-image-studio', version: 1, document: clean, assets })
      ensure(new TextEncoder().encode(json).byteLength <= IMAGE_STUDIO_MAX_PORTABLE_JSON_BYTES, 'PORTABLE_SIZE', 'Portable board file is too large')
      return json
    },
    async importPortableDocument(json, importOptions = {}) {
      ensure(typeof json === 'string' && json.length <= IMAGE_STUDIO_MAX_PORTABLE_JSON_BYTES
        && new TextEncoder().encode(json).byteLength <= IMAGE_STUDIO_MAX_PORTABLE_JSON_BYTES, 'PORTABLE_SIZE', 'Portable board file is too large')
      let parsed: unknown
      try { parsed = JSON.parse(json) } catch { throw new ImageStudioStorageError('INVALID_JSON', 'Invalid portable board JSON') }
      assertSafeStudioData(parsed)
      ensure(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'INVALID_PORTABLE', 'Invalid portable board')
      const envelope = parsed as Record<string, unknown>
      ensure(envelope.format === 'sshzyu-image-studio' && envelope.version === 1 && Array.isArray(envelope.assets),
        'SCHEMA_VERSION', 'Unsupported portable board version')
      let document = sanitizeStudioDocument(envelope.document, options)
      ensure(new TextEncoder().encode(JSON.stringify(document)).byteLength <= IMAGE_STUDIO_LIMITS.documentBytes,
        'DOCUMENT_SIZE', 'Board document is too large')
      ensure(envelope.assets.length <= IMAGE_STUDIO_LIMITS.nodes * IMAGE_STUDIO_LIMITS.imagesPerNode,
        'PORTABLE_SIZE', 'Too many embedded assets')
      const references = new Map<string, ImageStudioAssetRef>()
      for (const image of allImages(document)) if (image.kind === 'asset') references.set(image.assetId, image)
      const ids = new Map<string, string>(), rows: { userId: string; id: string; blob: Blob }[] = []
      let total = 0
      for (const input of envelope.assets) {
        ensure(input && typeof input === 'object' && !Array.isArray(input), 'INVALID_ASSET', 'Invalid embedded image')
        const item = input as Record<string, unknown>, originalId = safeId(item.id)
        const reference = references.get(originalId)
        ensure(reference && !ids.has(originalId) && item.mimeType === reference.mimeType,
          'INVALID_ASSET', 'Embedded image identifiers or MIME types do not match')
        const bytes = decodeBase64(item.base64)
        total += bytes.byteLength
        ensure(total <= IMAGE_STUDIO_MAX_PORTABLE_BYTES, 'PORTABLE_SIZE', 'Embedded images exceed the 50 MiB import limit')
        const blob = new Blob([bytes], { type: reference.mimeType })
        await validateStudioImageBlob(blob)
        const assetId = createStudioId('asset')
        ids.set(originalId, assetId)
        rows.push({ userId: owner, id: assetId, blob })
      }
      ensure(ids.size === references.size, 'MISSING_ASSET', 'The portable file does not contain every local image')
      document = remapAssets(document, ids)
      document = { ...document, id: safeId(importOptions.documentId ?? document.id), updatedAt: Date.now() }
      // Validate everything before a single atomic document + image transaction.
      await transaction<void>([DOCUMENTS, ASSETS], 'readwrite', tx => {
        for (const row of rows) tx.objectStore(ASSETS).add(row)
        tx.objectStore(DOCUMENTS).put({ userId: owner, id: document.id, document })
      })
      return document
    },
  }
  return storage
}
