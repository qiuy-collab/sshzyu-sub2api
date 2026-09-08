import type { BatchImageJob, BatchImageSubmitRequest } from '@/api/batchImage'

export interface ImageStudioRun {
  userId: number
  keyId: number
  idempotencyKey: string
  payload: BatchImageSubmitRequest
  contextId?: string
  batchId: string | null
  status: string
  error: string | null
  delivered: boolean
  job: BatchImageJob | null
  createdAt: number
  updatedAt: number
}

const DB_NAME = 'sshzyu-image-studio-runs'
const STORE_NAME = 'runs'

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('浏览器无法保存生成记录，请允许本地存储后重试。'))
      return
    }
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME, { keyPath: 'userId' })
    }
    request.onerror = () => reject(request.error || new Error('无法打开生成记录。'))
    request.onblocked = () => reject(new Error('生成记录正在被其他页面占用，请关闭旧页面后重试。'))
    request.onsuccess = () => resolve(request.result)
  })
}

function validateRun(value: unknown, userId: number): ImageStudioRun | null {
  if (value === undefined) return null
  const run = value as ImageStudioRun
  if (!run || run.userId !== userId || !Number.isInteger(run.keyId) || !run.idempotencyKey ||
      !run.payload?.model || !Array.isArray(run.payload.items) || run.payload.items.length !== 1 ||
      typeof run.payload.items[0]?.prompt !== 'string' || typeof run.payload.items[0]?.custom_id !== 'string' ||
      typeof run.status !== 'string' || typeof run.delivered !== 'boolean') {
    throw new Error('本地生成记录无法读取。为避免重复扣费，请先恢复或核对原任务。')
  }
  return run
}

export async function loadImageStudioRun(userId: number): Promise<ImageStudioRun | null> {
  const db = await openDatabase()
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly')
      const request = transaction.objectStore(STORE_NAME).get(userId)
      let result: ImageStudioRun | null = null
      request.onsuccess = () => {
        try { result = validateRun(request.result, userId) }
        catch (error) { reject(error); transaction.abort() }
      }
      transaction.oncomplete = () => resolve(result)
      transaction.onabort = () => reject(transaction.error || new Error('无法读取生成记录。'))
      transaction.onerror = () => reject(transaction.error || new Error('无法读取生成记录。'))
    })
  } finally {
    db.close()
  }
}

/** Compare-and-swap prevents another tab from replacing an unresolved submission. */
export async function saveImageStudioRun(run: ImageStudioRun, expectedId: string | null): Promise<void> {
  // Vue refs are proxies; IndexedDB must receive an ordinary structured-cloneable object.
  const record: ImageStudioRun = JSON.parse(JSON.stringify(run))
  const db = await openDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite')
      const store = transaction.objectStore(STORE_NAME)
      const request = store.get(run.userId)
      request.onsuccess = () => {
        try {
          const current = validateRun(request.result, run.userId)
          if ((current?.idempotencyKey ?? null) !== expectedId) {
            reject(new Error('其他页面已更新生成任务，请刷新任务状态后继续。'))
            transaction.abort()
            return
          }
          store.put(record)
        } catch (error) {
          reject(error)
          transaction.abort()
        }
      }
      // A successful put request is insufficient: quota/disk failures can still abort commit.
      transaction.oncomplete = () => resolve()
      transaction.onabort = () => reject(transaction.error || new Error('生成记录保存失败，尚未提交的新任务不会发送。'))
      transaction.onerror = () => reject(transaction.error || new Error('生成记录保存失败。'))
    })
  } finally {
    db.close()
  }
}
