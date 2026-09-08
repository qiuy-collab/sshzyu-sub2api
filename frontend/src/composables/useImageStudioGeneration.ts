import { computed, onScopeDispose, getCurrentScope, ref, watch } from 'vue'
import { keysAPI } from '@/api/keys'
import {
  cancelBatchImageJob,
  getBatchImageItemContent,
  getBatchImageJob,
  listBatchImageItems,
  listBatchImageModels,
  submitBatchImageJob,
  type BatchImageModel,
  type BatchImageSubmitRequest,
} from '@/api/batchImage'
import type { ApiKey } from '@/types'
import { batchImageMimeTypes, keyAllowsBatchImage, openAIImageSizes } from '@/utils/batchImage'
import { loadImageStudioRun, saveImageStudioRun, type ImageStudioRun } from '@/utils/imageStudioRunStore'

export type { ImageStudioRun } from '@/utils/imageStudioRunStore'

export interface ImageStudioGenerationInput {
  prompt: string
  model: string
  imageSize: string
  aspectRatio: string
  reference?: Blob
  references?: Blob[]
  contextId?: string
}

export interface ImageStudioImageMeta {
  batchId: string
  customId: string
  prompt: string
  model: string
  contextId?: string
}

export interface ImageStudioGenerationOptions {
  userId: number
  preferredKeyId?: number
  onImage: (blob: Blob, meta: ImageStudioImageMeta) => Promise<void>
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'output_deleted'])
const POLL_INTERVAL = 8000

export function imageStudioReferenceLimit(model: string): number {
  const normalized = model.trim().toLowerCase()
  if (normalized.startsWith('gpt-image-')) return 1
  if (normalized.includes('pro-image')) return 14
  if (normalized.includes('flash-image')) return 3
  return 0
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String((error as { message?: string })?.message || '操作失败，请稍后重试。')
}

function blobBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error || new Error('参考图读取失败。'))
    reader.onload = () => {
      const result = String(reader.result || '')
      const comma = result.indexOf(',')
      if (comma < 0) reject(new Error('参考图读取失败。'))
      else resolve(result.slice(comma + 1))
    }
    reader.readAsDataURL(blob)
  })
}

export function useImageStudioGeneration(options: ImageStudioGenerationOptions) {
  const keys = ref<ApiKey[]>([])
  const selectedKeyId = ref(0)
  const models = ref<BatchImageModel[]>([])
  const loading = ref(false)
  const loadingModels = ref(false)
  const error = ref('')
  const run = ref<ImageStudioRun | null>(null)
  const submitting = ref(false)
  const polling = ref(false)
  const cancelling = ref(false)
  const initialized = ref(false)
  const preparing = ref(false)
  const busy = computed(() => preparing.value || submitting.value || cancelling.value || Boolean(run.value && (
    !TERMINAL.has(run.value.status) || (run.value.status === 'completed' && !run.value.delivered)
  )))
  const selectedKey = computed(() => keys.value.find(key => key.id === Number(selectedKeyId.value)) || null)
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let modelSequence = 0
  let stateSequence = 0
  let loadedModelKeyId = 0
  let modelPromise: Promise<void> | null = null
  let modelPromiseKeyId = 0
  let refreshPromise: Promise<void> | null = null
  let ownedKeys: ApiKey[] = []

  function stopPolling() {
    if (timer) clearTimeout(timer)
    timer = null
  }

  function schedulePolling() {
    stopPolling()
    if (disposed || submitting.value || cancelling.value || !run.value?.batchId || TERMINAL.has(run.value.status)) return
    timer = setTimeout(() => { void refresh() }, POLL_INTERVAL)
  }

  async function save(next: ImageStudioRun) {
    // Keep a received job id in memory even if the subsequent disk commit fails.
    // The pre-submit ledger still permits recovery with the original idempotency key.
    run.value = next
    await saveImageStudioRun(next, next.idempotencyKey)
  }

  function keyForRun(current: ImageStudioRun): ApiKey {
    // A group may disable new batch generation while an already-owned result
    // remains readable. Keep active owned keys for recovery without offering
    // disallowed keys in the new-generation selector.
    const key = ownedKeys.find(item => item.id === current.keyId)
    if (!key) throw new Error('原任务的 API 密钥当前不可用，请恢复该密钥后刷新；切换密钥不能读取此任务。')
    return key
  }

  async function loadModels() {
    const key = selectedKey.value
    if (!key) {
      ++modelSequence
      models.value = []
      loadedModelKeyId = 0
      loadingModels.value = false
      return
    }
    if (loadedModelKeyId === key.id) return
    if (modelPromise && modelPromiseKeyId === key.id) return modelPromise
    const sequence = ++modelSequence
    modelPromiseKeyId = key.id
    loadedModelKeyId = 0
    loadingModels.value = true
    models.value = []
    modelPromise = (async () => {
      try {
        const response = await listBatchImageModels(key.key)
        if (disposed || sequence !== modelSequence) return
        const seen = new Set<string>()
        models.value = (response.data || []).filter(model => {
          if (!model.id || seen.has(model.id)) return false
          seen.add(model.id)
          return true
        })
        loadedModelKeyId = key.id
      } catch (cause) {
        if (!disposed && sequence === modelSequence) error.value = errorMessage(cause)
      } finally {
        if (sequence === modelSequence) {
          loadingModels.value = false
          modelPromise = null
        }
      }
    })()
    return modelPromise
  }

  const stopKeyWatch = watch(selectedKeyId, () => { void loadModels() }, { flush: 'sync' })

  async function init() {
    if (loading.value || submitting.value || preparing.value || disposed) return
    loading.value = true
    initialized.value = false
    error.value = ''
    stopPolling()
    try {
      if (!Number.isSafeInteger(options.userId) || options.userId <= 0) throw new Error('请登录后使用图片工作室。')
      const stored = await loadImageStudioRun(options.userId)
      if (disposed) return
      run.value = stored
      const allKeys: ApiKey[] = []
      for (let page = 1; ; page++) {
        const response = await keysAPI.list(page, 100, { status: 'active', sort_by: 'created_at', sort_order: 'desc' })
        if (disposed) return
        allKeys.push(...(response.items || []).filter(key => key.status === 'active'))
        if (!response.items?.length || page >= response.pages) break
      }
      ownedKeys = allKeys
      const available = allKeys.filter(keyAllowsBatchImage)
      keys.value = available
      const preferredId = options.preferredKeyId ?? stored?.keyId ?? Number(selectedKeyId.value)
      const preferredAvailable = available.some(key => key.id === preferredId)
      const fallbackId = stored?.keyId || Number(selectedKeyId.value)
      selectedKeyId.value = preferredAvailable ? preferredId
        : available.some(key => key.id === fallbackId) ? fallbackId : (available[0]?.id || 0)
      await loadModels()
      if (disposed) return
      initialized.value = true
      if (stored?.error) error.value = stored.error
      // A pre-submit/uncertain ledger never causes an automatic POST on recovery.
      if (stored?.batchId && (!TERMINAL.has(stored.status) || (stored.status === 'completed' && !stored.delivered))) {
        await refresh()
      }
      if (options.preferredKeyId !== undefined && !preferredAvailable) {
        error.value = '此入口指定的密钥当前不可用或不具备批量生图权限，请选择列表中的可用密钥。' + (error.value ? ` ${error.value}` : '')
      }
    } catch (cause) {
      error.value = errorMessage(cause)
    } finally {
      loading.value = false
    }
  }

  async function buildPayload(input: ImageStudioGenerationInput): Promise<BatchImageSubmitRequest> {
    const key = selectedKey.value
    const model = models.value.find(item => item.id === input.model)
    if (!key || !keyAllowsBatchImage(key)) throw new Error('请选择具有批量生图权限的 API 密钥。')
    if (loadingModels.value || loadedModelKeyId !== key.id || !model) throw new Error('请等待模型加载并选择可用模型。')
    const prompt = input.prompt.trim()
    if (!prompt) throw new Error('请填写或连接提示词。')
    if (new TextEncoder().encode(prompt).byteLength > 8000) throw new Error('合并后的提示词超过 8000 字节，请缩短后生成。')
    if (input.reference && input.references?.length) throw new Error('请勿重复传入参考图片。')
    const references = input.references || (input.reference ? [input.reference] : [])
    if (references.length > imageStudioReferenceLimit(input.model)) throw new Error(`此模型最多支持 ${imageStudioReferenceLimit(input.model)} 张参考图。`)
    if (references.some(blob => !batchImageMimeTypes.includes(blob.type) || blob.size <= 0 || blob.size > 10 * 1024 * 1024)) {
      throw new Error('参考图须为 PNG、JPEG 或 WebP，且每张不超过 10 MB。')
    }
    if (references.reduce((sum, blob) => sum + blob.size, 0) > 128 * 1024 * 1024) throw new Error('参考图总大小不能超过 128 MB。')
    const isOpenAI = key.group?.platform === 'openai'
    if (isOpenAI) {
      if (!openAIImageSizes[input.imageSize]?.[input.aspectRatio] ||
          (model.supported_image_sizes && !model.supported_image_sizes.includes(input.imageSize)) ||
          (model.supported_mime_types && !model.supported_mime_types.includes('image/png'))) {
        throw new Error('当前模型不支持所选尺寸、比例或 PNG 格式。')
      }
    } else if (input.imageSize !== '1K' || input.aspectRatio !== '1:1') {
      throw new Error('当前批量模型仅支持 1K、1:1 参数。')
    }
    const referenceImages = []
    for (const blob of references) {
      referenceImages.push({ mime_type: blob.type, data: await blobBase64(blob) })
    }
    return {
      model: input.model,
      task_name: `Studio ${new Date().toISOString()}`,
      image_size: input.imageSize,
      ...(isOpenAI ? { aspect_ratio: input.aspectRatio } : {}),
      response_mime_type: 'image/png',
      items: [{ custom_id: 'studio_image', prompt, output_count: 1, ...(referenceImages.length ? { reference_images: referenceImages } : {}) }],
    }
  }

  async function generate(input: ImageStudioGenerationInput) {
    if (disposed || busy.value) return
    error.value = ''
    if (!initialized.value) { error.value = '请先加载密钥与本地生成记录。'; return }
    preparing.value = true
    try {
      const keyId = selectedKey.value?.id
      const payload = await buildPayload(input)
      if (disposed) return
      if (!keyId || selectedKey.value?.id !== keyId) throw new Error('准备期间密钥已切换，请重新点击生成。')
      const timestamp = Date.now()
      const next: ImageStudioRun = {
        userId: options.userId, keyId, payload, contextId: input.contextId,
        idempotencyKey: `image-studio-${crypto.randomUUID()}`,
        batchId: null, status: 'submitting', error: null, delivered: false, job: null,
        createdAt: timestamp, updatedAt: timestamp,
      }
      await saveImageStudioRun(next, run.value?.idempotencyKey ?? null)
      run.value = next
      if (!disposed) await submitStored()
    } catch (cause) {
      error.value = errorMessage(cause)
    } finally {
      preparing.value = false
    }
  }

  async function submitStored() {
    if (disposed || submitting.value || !run.value || run.value.batchId) return
    const current = run.value
    let key: ApiKey
    try { key = keyForRun(current) }
    catch (cause) { error.value = errorMessage(cause); return }
    submitting.value = true
    error.value = ''
    try {
      await save({ ...current, status: 'submitting', error: null, updatedAt: Date.now() })
      const job = await submitBatchImageJob(key.key, current.payload, current.idempotencyKey)
      if (!job.id || typeof job.status !== 'string') throw new Error('服务器未返回有效任务编号，请用原提交记录重试确认。')
      await save({ ...current, batchId: job.id, status: job.status, job, error: null, updatedAt: Date.now() })
      if (!disposed) await refresh()
    } catch (cause) {
      const message = errorMessage(cause)
      const status = Number((cause as { status?: number })?.status)
      // Validation/auth failures are definitive. Network/server failures may have
      // created a billable task, so retain the exact request for explicit recovery.
      const definitive = [400, 401, 402, 403, 404, 413, 422].includes(status)
      const latest = run.value || current
      const next = { ...latest, status: latest.batchId ? latest.status : (definitive ? 'failed' : 'uncertain'), error: message, updatedAt: Date.now() }
      run.value = next
      try { await saveImageStudioRun(next, current.idempotencyKey) }
      catch { /* The original pre-submit ledger remains the source for safe recovery. */ }
      error.value = message
    } finally {
      submitting.value = false
      schedulePolling()
    }
  }

  async function retrySubmission() {
    if (disposed || submitting.value || preparing.value || run.value?.batchId || !run.value) return
    if (!['submitting', 'uncertain'].includes(run.value.status)) return
    await submitStored()
  }

  async function deliverImage(current: ImageStudioRun, key: ApiKey, sequence: number) {
    if (current.delivered || current.status !== 'completed' || !current.batchId) return
    const response = await listBatchImageItems(key.key, current.batchId)
    if (disposed || sequence !== stateSequence) return
    const item = response.data.find(item => item.custom_id === current.payload.items[0].custom_id &&
      (item.status === 'succeeded' || item.status === 'success') && item.image_count > 0)
    if (!item) throw new Error('任务已结束，但尚未找到成功图片，请刷新任务状态。')
    // One output per run and one refresh promise keep content downloads serial.
    const blob = await getBatchImageItemContent(key.key, current.batchId, item.custom_id, 0)
    if (disposed || sequence !== stateSequence) return
    await options.onImage(blob, {
      batchId: current.batchId, customId: item.custom_id, prompt: current.payload.items[0].prompt,
      model: current.payload.model, contextId: current.contextId,
    })
    await save({ ...current, delivered: true, error: null, updatedAt: Date.now() })
  }

  async function refresh() {
    if (disposed || cancelling.value || !run.value?.batchId) return
    if (refreshPromise) return refreshPromise
    const current = run.value
    const sequence = ++stateSequence
    polling.value = true
    stopPolling()
    refreshPromise = Promise.resolve().then(async () => {
      try {
        const key = keyForRun(current)
        const job = await getBatchImageJob(key.key, current.batchId!)
        if (disposed || sequence !== stateSequence) return
        if (job.id !== current.batchId || typeof job.status !== 'string') throw new Error('服务器返回的任务记录不匹配，请稍后刷新。')
        const next = { ...current, job, status: job.status, error: null, updatedAt: Date.now() }
        await save(next)
        if (disposed || sequence !== stateSequence) return
        error.value = ''
        await deliverImage(next, key, sequence)
      } catch (cause) {
        if (!disposed && sequence === stateSequence) {
          error.value = errorMessage(cause)
          if (run.value?.idempotencyKey === current.idempotencyKey) {
            try { await save({ ...run.value, error: error.value, updatedAt: Date.now() }) }
            catch { /* Keep the previous durable ledger; never resubmit from a GET failure. */ }
          }
        }
      } finally {
        polling.value = false
        refreshPromise = null
        schedulePolling()
      }
    })
    return refreshPromise
  }

  async function cancel() {
    if (disposed || cancelling.value || submitting.value || !run.value?.batchId || TERMINAL.has(run.value.status)) return
    const current = run.value
    const sequence = ++stateSequence
    cancelling.value = true
    stopPolling()
    try {
      const key = keyForRun(current)
      const job = await cancelBatchImageJob(key.key, current.batchId!)
      if (sequence !== stateSequence) return
      if (job.id !== current.batchId || typeof job.status !== 'string') throw new Error('服务器返回的任务记录不匹配，请刷新确认取消结果。')
      const next = { ...current, job, status: job.status, error: null, updatedAt: Date.now() }
      await save(next)
      error.value = ''
      if (!disposed) await deliverImage(next, key, sequence)
    } catch (cause) {
      error.value = errorMessage(cause)
    } finally {
      cancelling.value = false
      schedulePolling()
    }
  }

  function dispose() {
    disposed = true
    ++modelSequence
    ++stateSequence
    stopPolling()
    stopKeyWatch()
  }

  if (getCurrentScope()) onScopeDispose(dispose)
  return { keys, selectedKeyId, models, loading, loadingModels, error, run, busy, submitting, polling, cancelling, init, generate, retrySubmission, refresh, cancel, dispose }
}
