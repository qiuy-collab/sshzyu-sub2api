import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStudioDocument, createStudioNode, type ImageStudioAssetRef } from '../imageStudioGraph'
import {
  createImageStudioStorage, IMAGE_STUDIO_DATABASE_NAME, IMAGE_STUDIO_MAX_ASSET_BYTES,
  type ImageStudioStorage,
} from '../imageStudioStorage'

type Row = { userId: string; id: string; document?: unknown; blob?: Blob }
type Request = { result?: any; error?: DOMException; onsuccess?: () => void; onerror?: () => void }

/** Small asynchronous IDB double: compound keys, commit/abort and user indexes.
 * It deliberately separates request success from transaction completion.
 */
class MemoryIndexedDB {
  stores = new Map<string, Map<string, Row>>()
  failNextCommit: string | undefined
  holdCommits = false
  held: (() => void)[] = []
  open = vi.fn(() => {
    const request: Request & { onupgradeneeded?: () => void; onblocked?: () => void } = {}
    queueMicrotask(() => {
      request.result = {
        objectStoreNames: { contains: (name: string) => this.stores.has(name) },
        createObjectStore: (name: string) => {
          this.stores.set(name, new Map())
          return { createIndex: vi.fn() }
        },
        transaction: (names: string[], mode: string) => this.transaction(names, mode),
        close: vi.fn(), onversionchange: null,
      }
      if (!this.stores.size) request.onupgradeneeded?.()
      request.onsuccess?.()
    })
    return request
  })
  asFactory() { return this as unknown as IDBFactory }
  rows(owner: string) { return [...this.stores.values()].flatMap(store => [...store.values()]).filter(row => row.userId === owner) }
  release() { this.holdCommits = false; for (const finish of this.held.splice(0)) finish() }

  private transaction(names: string[], mode: string) {
    const working = new Map(names.map(name => [name, new Map(this.stores.get(name))]))
    let pending = 0, finished = false, scheduled = false
    const tx: any = { error: null, oncomplete: null, onabort: null, onerror: null }
    const abort = (error = new DOMException('Aborted', 'AbortError')) => {
      if (finished) return
      finished = true; tx.error = error
      queueMicrotask(() => tx.onabort?.())
    }
    const finish = () => {
      if (pending || finished) return
      if (mode === 'readwrite' && this.failNextCommit) {
        const error = this.failNextCommit; this.failNextCommit = undefined
        abort(new DOMException('Commit rejected', error)); return
      }
      finished = true
      if (mode === 'readwrite') for (const [name, values] of working) this.stores.set(name, values)
      tx.oncomplete?.()
    }
    const schedule = () => {
      if (scheduled || pending || finished) return
      scheduled = true
      queueMicrotask(() => {
        scheduled = false
        if (this.holdCommits && mode === 'readwrite') this.held.push(finish)
        else finish()
      })
    }
    const request = (action: () => unknown) => {
      const result: Request = {}; pending++
      queueMicrotask(() => {
        if (finished) return
        try { result.result = action(); result.onsuccess?.() }
        catch (error) { result.error = error as DOMException; result.onerror?.(); abort(error as DOMException) }
        pending--; schedule()
      })
      return result
    }
    tx.abort = () => abort()
    tx.objectStore = (name: string) => {
      const values = working.get(name)!
      const key = (value: unknown) => JSON.stringify(value)
      const write = (row: Row, add: boolean) => request(() => {
        const id = key([row.userId, row.id])
        if (add && values.has(id)) throw new DOMException('Duplicate key', 'ConstraintError')
        values.set(id, { ...row, ...(row.document ? { document: JSON.parse(JSON.stringify(row.document)) } : {}) })
        return [row.userId, row.id]
      })
      return {
        get: (id: unknown) => request(() => values.get(key(id))),
        put: (row: Row) => write(row, false), add: (row: Row) => write(row, true),
        delete: (id: unknown) => request(() => values.delete(key(id))),
        index: () => ({ getAllKeys: (owner: string) => request(() => [...values.values()]
          .filter(row => row.userId === owner).map(row => [row.userId, row.id])) }),
      }
    }
    queueMicrotask(schedule)
    return tx
  }
}

function png(tail = 1) { return new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, tail])], { type: 'image/png' }) }
function documentWithImage(reference: ImageStudioAssetRef) {
  const document = createStudioDocument()
  document.nodes.push(createStudioNode('reference', { x: 0, y: 0 }, { images: [reference] }, '参考图'))
  return document
}
const sessions: ImageStudioStorage[] = []
function session(idb: MemoryIndexedDB, user: string) {
  const storage = createImageStudioStorage(user, { indexedDB: idb.asFactory(), origin: 'https://sshzyu.com' })
  sessions.push(storage)
  return storage
}
afterEach(() => { sessions.splice(0).forEach(storage => storage.close()); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('imageStudioStorage durability and isolation', () => {
  it('isolates identical document and asset IDs across users, including clear()', async () => {
    const idb = new MemoryIndexedDB(), alice = session(idb, 'alice'), bob = session(idb, 'bob')
    const aliceRef = await alice.putAsset(png(1), { id: 'same-asset' })
    const bobRef = await bob.putAsset(png(2), { id: 'same-asset' })
    await alice.saveDocument({ ...documentWithImage(aliceRef), title: 'Alice' })
    await bob.saveDocument({ ...documentWithImage(bobRef), title: 'Bob' })
    expect((await alice.loadDocument())?.title).toBe('Alice')
    expect((await bob.loadDocument())?.title).toBe('Bob')
    const aliceJson = await alice.exportPortableDocument((await alice.loadDocument())!)
    const bobJson = await bob.exportPortableDocument((await bob.loadDocument())!)
    expect(JSON.parse(aliceJson).assets[0].base64).not.toBe(JSON.parse(bobJson).assets[0].base64)
    await alice.clear()
    expect(await alice.loadDocument()).toBeNull()
    expect(await alice.getAsset('same-asset')).toBeNull()
    expect((await bob.loadDocument())?.title).toBe('Bob')
    expect(await bob.getAsset('same-asset')).not.toBeNull()
    expect(idb.open).toHaveBeenCalledWith(IMAGE_STUDIO_DATABASE_NAME, 1)
  })

  it('does not report saved before transaction commit and retains previous data after quota abort', async () => {
    const idb = new MemoryIndexedDB(), storage = session(idb, 'alice')
    await storage.saveDocument(createStudioDocument('default', 'Original'))
    idb.holdCommits = true
    let saved = false
    const promise = storage.saveDocument(createStudioDocument('default', 'Pending')).then(() => { saved = true })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(saved).toBe(false)
    idb.release(); await promise
    expect(saved).toBe(true)
    idb.failNextCommit = 'QuotaExceededError'
    await expect(storage.saveDocument(createStudioDocument('default', 'Lost'))).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })
    expect((await storage.loadDocument())?.title).toBe('Pending')
  })

  it('stores only schema fields and Blobs, without tokens, localStorage or fetch', async () => {
    const localWrite = vi.spyOn(globalThis.localStorage, 'setItem'), fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const idb = new MemoryIndexedDB(), storage = session(idb, 'alice')
    const ref = await storage.putAsset(png())
    await storage.saveDocument(Object.assign(documentWithImage(ref), { token: 'SECRET_TOKEN', apiKey: 'SECRET_KEY' }))
    expect(JSON.stringify(idb.rows('alice'))).not.toContain('SECRET_')
    expect((await storage.getAsset(ref.assetId)) instanceof Blob).toBe(true)
    await storage.exportPortableDocument((await storage.loadDocument())!)
    expect(localWrite).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects duplicate asset writes, unsupported/spoofed images, and files above 10 MiB', async () => {
    const idb = new MemoryIndexedDB(), storage = session(idb, 'alice')
    await storage.putAsset(png(), { id: 'existing' })
    await expect(storage.putAsset(png(2), { id: 'existing' })).rejects.toMatchObject({ code: 'ASSET_EXISTS' })
    await expect(storage.putAsset(new Blob(['<svg/>'], { type: 'image/svg+xml' }))).rejects.toMatchObject({ code: 'INVALID_IMAGE_TYPE' })
    await expect(storage.putAsset(new Blob(['<html>'], { type: 'image/png' }))).rejects.toMatchObject({ code: 'INVALID_IMAGE_CONTENT' })
    const huge = png(); Object.defineProperty(huge, 'size', { value: IMAGE_STUDIO_MAX_ASSET_BYTES + 1 })
    await expect(storage.putAsset(huge)).rejects.toMatchObject({ code: 'ASSET_SIZE' })
  })

  it('reports unavailable or closed storage instead of silently falling back', async () => {
    vi.stubGlobal('indexedDB', undefined)
    const unavailable = createImageStudioStorage('alice')
    await expect(unavailable.loadDocument()).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' })
    const storage = session(new MemoryIndexedDB(), 'alice'); storage.close()
    await expect(storage.loadDocument()).rejects.toMatchObject({ code: 'STORAGE_CLOSED' })
    expect(() => createImageStudioStorage('')).toThrow()
  })
})

describe('imageStudioStorage portable files', () => {
  it('embeds each referenced Blob once and imports into another user with fresh asset IDs', async () => {
    const idb = new MemoryIndexedDB(), alice = session(idb, 'alice'), bob = session(idb, 'bob')
    const ref = await alice.putAsset(png(), { name: 'reference.png', width: 1, height: 1 })
    const document = documentWithImage(ref)
    document.nodes.push(createStudioNode('result', { x: 400, y: 0 }, { images: [ref], prompt: '原始提示' }))
    const exported = await alice.exportPortableDocument(document)
    expect(JSON.parse(exported).assets).toHaveLength(1)
    const imported = await bob.importPortableDocument(exported, { documentId: 'imported' })
    const importedRef = (imported.nodes[0].data as { images: ImageStudioAssetRef[] }).images[0]
    expect(importedRef.assetId).not.toBe(ref.assetId)
    expect(await bob.getAsset(ref.assetId)).toBeNull()
    expect(await bob.getAsset(importedRef.assetId)).not.toBeNull()
    expect(await bob.loadDocument('imported')).toEqual(imported)
    const reexported = await bob.exportPortableDocument(imported)
    expect(JSON.parse(reexported).assets[0].base64).toBe(JSON.parse(exported).assets[0].base64)
  })

  it('fails missing local images instead of exporting a board that silently loses them', async () => {
    const storage = session(new MemoryIndexedDB(), 'alice')
    const reference: ImageStudioAssetRef = { id: 'image-missing', kind: 'asset', assetId: 'missing', mimeType: 'image/png' }
    await expect(storage.exportPortableDocument(documentWithImage(reference))).rejects.toMatchObject({ code: 'MISSING_ASSET' })
  })

  it('validates all imported data before writing and rejects prototype fields or unsafe URLs', async () => {
    const idb = new MemoryIndexedDB(), storage = session(idb, 'alice')
    const ref = await storage.putAsset(png())
    const data = JSON.parse(await storage.exportPortableDocument(documentWithImage(ref)))
    const before = idb.rows('alice').length
    const malformed = structuredClone(data); malformed.assets[0].base64 = 'javascript:alert(1)'
    await expect(storage.importPortableDocument(JSON.stringify(malformed))).rejects.toMatchObject({ code: 'INVALID_ASSET_DATA' })
    const dangerous = JSON.parse(JSON.stringify(data)); dangerous.ignored = JSON.parse('{"__proto__":{"polluted":true}}')
    await expect(storage.importPortableDocument(JSON.stringify(dangerous))).rejects.toMatchObject({ code: 'UNSAFE_DATA' })
    const unsafe = structuredClone(data)
    unsafe.document.nodes[0].data.images = [{ id: 'evil', kind: 'url', url: 'javascript:alert(1)' }]
    unsafe.assets = []
    await expect(storage.importPortableDocument(JSON.stringify(unsafe))).rejects.toMatchObject({ code: 'UNSAFE_URL' })
    expect(idb.rows('alice')).toHaveLength(before)
  })

  it('aborts document and assets together when the portable import cannot commit', async () => {
    const idb = new MemoryIndexedDB(), alice = session(idb, 'alice'), bob = session(idb, 'bob')
    const ref = await alice.putAsset(png())
    const exported = await alice.exportPortableDocument(documentWithImage(ref))
    idb.failNextCommit = 'QuotaExceededError'
    await expect(bob.importPortableDocument(exported)).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })
    expect(idb.rows('bob')).toEqual([])
    expect(await bob.loadDocument()).toBeNull()
  })

  it('enforces the 50 MiB aggregate export budget without allocating large test files', async () => {
    const storage = session(new MemoryIndexedDB(), 'alice'), document = createStudioDocument()
    for (let index = 0; index < 6; index++) {
      const blob = png(index)
      Object.defineProperty(blob, 'size', { value: IMAGE_STUDIO_MAX_ASSET_BYTES })
      const reference = await storage.putAsset(blob)
      document.nodes.push(createStudioNode('reference', { x: index, y: 0 }, { images: [reference] }))
    }
    await expect(storage.exportPortableDocument(document)).rejects.toMatchObject({ code: 'PORTABLE_SIZE' })
  })
})
