import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { useImageStudioGeneration } from '../useImageStudioGeneration'
import type { ImageStudioRun } from '@/utils/imageStudioRunStore'

const mocks = vi.hoisted(() => ({
  listKeys: vi.fn(), listModels: vi.fn(), submit: vi.fn(), getJob: vi.fn(),
  listItems: vi.fn(), content: vi.fn(), cancel: vi.fn(), load: vi.fn(), save: vi.fn(),
  ledger: new Map<number, ImageStudioRun>(),
}))

vi.mock('@/api/keys', () => ({ keysAPI: { list: mocks.listKeys } }))
vi.mock('@/api/batchImage', () => ({
  listBatchImageModels: mocks.listModels, submitBatchImageJob: mocks.submit,
  getBatchImageJob: mocks.getJob, listBatchImageItems: mocks.listItems,
  getBatchImageItemContent: mocks.content, cancelBatchImageJob: mocks.cancel,
}))
vi.mock('@/utils/imageStudioRunStore', () => ({ loadImageStudioRun: mocks.load, saveImageStudioRun: mocks.save }))

const key = (id = 1, allowed = true) => ({
  id, key: `test-key-${id}`, name: `Key ${id}`, status: 'active',
  group: { platform: 'openai', allow_batch_image_generation: allowed, allow_image_generation: true },
})
const model = { id: 'gpt-image-2', provider: 'openai', supported_image_sizes: ['1K', '2K'], supported_mime_types: ['image/png'] }
const input = { prompt: 'A quiet garden', model: 'gpt-image-2', imageSize: '1K', aspectRatio: '1:1', contextId: 'generator-a' }
const job = (status = 'queued') => ({ id: 'batch-test', status, success_count: status === 'completed' ? 1 : 0 })
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const controllers: ReturnType<typeof useImageStudioGeneration>[] = []

function create(onImage = vi.fn().mockResolvedValue(undefined), userId = 41, preferredKeyId?: number) {
  const controller = useImageStudioGeneration({ userId, onImage, preferredKeyId })
  controllers.push(controller)
  return { controller, onImage }
}

function storedRun(overrides: Partial<ImageStudioRun> = {}): ImageStudioRun {
  return {
    userId: 41, keyId: 1, idempotencyKey: 'stable-submit-id',
    payload: { model: input.model, task_name: 'Stable task name', image_size: '1K', aspect_ratio: '1:1', response_mime_type: 'image/png', items: [{ custom_id: 'studio_image', prompt: input.prompt, output_count: 1 }] },
    contextId: 'saved-generator', batchId: null, status: 'uncertain', error: null,
    delivered: false, job: null, createdAt: 100, updatedAt: 100, ...overrides,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  mocks.ledger.clear()
  mocks.listKeys.mockResolvedValue({ items: [key()], pages: 1 })
  mocks.listModels.mockResolvedValue({ data: [model] })
  mocks.submit.mockResolvedValue(job())
  mocks.getJob.mockResolvedValue(job())
  mocks.listItems.mockResolvedValue({ data: [{ custom_id: 'studio_image', status: 'succeeded', image_count: 1 }], has_more: false })
  mocks.content.mockResolvedValue(new Blob(['image'], { type: 'image/png' }))
  mocks.cancel.mockResolvedValue(job('cancelled'))
  mocks.load.mockImplementation(async (userId: number) => copy(mocks.ledger.get(userId) || null))
  mocks.save.mockImplementation(async (run: ImageStudioRun, expectedId: string | null) => {
    if ((mocks.ledger.get(run.userId)?.idempotencyKey || null) !== expectedId) throw new Error('Ledger conflict')
    mocks.ledger.set(run.userId, copy(run))
  })
})

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('image studio generation', () => {
  it('selects a handed-off eligible key from the signed-in account without submitting', async () => {
    mocks.listKeys.mockResolvedValueOnce({ items: [key(1)], pages: 2 })
      .mockResolvedValueOnce({ items: [key(2)], pages: 2 })
    const { controller } = create(undefined, 41, 2)
    await controller.init()
    expect(controller.selectedKeyId.value).toBe(2)
    expect(mocks.listModels).toHaveBeenCalledWith('test-key-2')
    expect(mocks.submit).not.toHaveBeenCalled()
  })

  it.each([2, 999])('explains an unavailable handed-off key %s and offers an owned eligible fallback', async (preferred) => {
    mocks.listKeys.mockResolvedValue({ items: [key(1), key(2, false)], pages: 1 })
    const { controller } = create(undefined, 41, preferred)
    await controller.init()
    expect(controller.selectedKeyId.value).toBe(1)
    expect(controller.error.value).toContain('此入口指定的密钥当前不可用')
    expect(mocks.listModels).toHaveBeenCalledWith('test-key-1')
    expect(mocks.submit).not.toHaveBeenCalled()
  })

  it('keeps recovery bound to its original key when a different key is handed off', async () => {
    mocks.ledger.set(41, storedRun({ batchId: 'batch-test', status: 'running' }))
    mocks.listKeys.mockResolvedValue({ items: [key(1), key(2)], pages: 1 })
    const { controller } = create(undefined, 41, 2)
    await controller.init()
    expect(controller.selectedKeyId.value).toBe(2)
    expect(mocks.getJob).toHaveBeenCalledWith('test-key-1', 'batch-test')
    expect(mocks.submit).not.toHaveBeenCalled()
  })

  it('loads all key pages and only exposes eligible keys with real model options', async () => {
    mocks.listKeys.mockResolvedValueOnce({ items: [key(1, false)], pages: 2 })
      .mockResolvedValueOnce({ items: [key(2)], pages: 2 })
    const { controller } = create()
    await controller.init()
    expect(mocks.listKeys).toHaveBeenCalledTimes(2)
    expect(controller.keys.value.map(key => key.id)).toEqual([2])
    expect(controller.selectedKeyId.value).toBe(2)
    expect(controller.models.value).toEqual([model])
    expect(mocks.listModels).toHaveBeenCalledWith('test-key-2')
    expect(mocks.submit).not.toHaveBeenCalled()
  })

  it('never submits when the durable pre-submit record cannot commit', async () => {
    const { controller } = create()
    await controller.init()
    mocks.save.mockRejectedValueOnce(new Error('Storage quota exceeded'))
    await controller.generate(input)
    expect(mocks.submit).not.toHaveBeenCalled()
    expect(controller.run.value).toBeNull()
    expect(controller.error.value).toContain('Storage quota exceeded')
    expect(controller.busy.value).toBe(false)
  })

  it('does not apply stale model results when switching keys back during a pending load', async () => {
    let resolveOther!: (value: { data: typeof model[] }) => void
    mocks.listKeys.mockResolvedValue({ items: [key(1), key(2)], pages: 1 })
    mocks.listModels.mockImplementation((apiKey: string) => apiKey === 'test-key-2'
      ? new Promise(resolve => { resolveOther = resolve })
      : Promise.resolve({ data: [model] }))
    const { controller } = create()
    await controller.init()
    controller.selectedKeyId.value = 2
    await nextTick()
    controller.selectedKeyId.value = 1
    await nextTick()
    resolveOther({ data: [{ ...model, id: 'other-key-model' }] })
    await nextTick()
    expect(controller.models.value).toEqual([model])
    await controller.generate(input)
    expect(mocks.submit).toHaveBeenCalledWith('test-key-1', expect.anything(), expect.any(String))
  })

  it('persists before posting and blocks duplicate clicks', async () => {
    let resolveSubmit!: (value: ReturnType<typeof job>) => void
    mocks.submit.mockImplementation(() => new Promise(resolve => { resolveSubmit = resolve }))
    const { controller } = create()
    await controller.init()
    const first = controller.generate(input)
    await vi.waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1))
    const recorded = mocks.ledger.get(41)!
    expect(recorded.payload.items).toEqual([{ custom_id: 'studio_image', prompt: input.prompt, output_count: 1 }])
    expect(recorded.contextId).toBe('generator-a')
    expect(JSON.stringify(recorded)).not.toContain('test-key-1')
    await controller.generate(input)
    expect(mocks.submit).toHaveBeenCalledTimes(1)
    resolveSubmit(job())
    await first
    expect(controller.run.value?.batchId).toBe('batch-test')
  })

  it('retains the exact payload and idempotency key across an ambiguous failure and explicit retry', async () => {
    mocks.submit.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const { controller } = create()
    await controller.init()
    await controller.generate(input)
    const original = copy(controller.run.value!)
    expect(original.status).toBe('uncertain')
    expect(controller.busy.value).toBe(true)
    await vi.advanceTimersByTimeAsync(60000)
    expect(mocks.submit).toHaveBeenCalledTimes(1)
    await controller.retrySubmission()
    expect(mocks.submit).toHaveBeenLastCalledWith('test-key-1', original.payload, original.idempotencyKey)
    expect(mocks.submit).toHaveBeenCalledTimes(2)
  })

  it('restores an uncertain submission without automatically sending it', async () => {
    mocks.ledger.set(41, storedRun({ status: 'submitting' }))
    const { controller } = create()
    await controller.init()
    await vi.advanceTimersByTimeAsync(60000)
    expect(controller.busy.value).toBe(true)
    expect(mocks.submit).not.toHaveBeenCalled()
    expect(mocks.getJob).not.toHaveBeenCalled()
    await controller.retrySubmission()
    expect(mocks.submit).toHaveBeenCalledWith('test-key-1', storedRun().payload, 'stable-submit-id')
  })

  it('restores a known batch with GET only and delivers to its original context', async () => {
    mocks.ledger.set(41, storedRun({ batchId: 'batch-test', status: 'running' }))
    mocks.getJob.mockResolvedValue(job('completed'))
    const { controller, onImage } = create()
    await controller.init()
    expect(mocks.submit).not.toHaveBeenCalled()
    expect(mocks.content).toHaveBeenCalledWith('test-key-1', 'batch-test', 'studio_image', 0)
    expect(onImage).toHaveBeenCalledWith(expect.any(Blob), {
      batchId: 'batch-test', customId: 'studio_image', prompt: input.prompt,
      model: input.model, contextId: 'saved-generator',
    })
    expect(mocks.ledger.get(41)?.delivered).toBe(true)
    await controller.refresh()
    expect(onImage).toHaveBeenCalledTimes(1)
    expect(controller.busy.value).toBe(false)
  })

  it('does not mark delivery until the board callback succeeds and can retry GET delivery', async () => {
    mocks.ledger.set(41, storedRun({ batchId: 'batch-test', status: 'completed' }))
    mocks.getJob.mockResolvedValue(job('completed'))
    const onImage = vi.fn().mockRejectedValueOnce(new Error('Board storage full')).mockResolvedValue(undefined)
    const { controller } = create(onImage)
    await controller.init()
    expect(mocks.ledger.get(41)?.delivered).toBe(false)
    expect(controller.error.value).toBe('Board storage full')
    await vi.advanceTimersByTimeAsync(30000)
    expect(onImage).toHaveBeenCalledTimes(1)
    await controller.refresh()
    expect(mocks.ledger.get(41)?.delivered).toBe(true)
    expect(mocks.submit).not.toHaveBeenCalled()
  })

  it('binds polling and cancellation to the original key after the selection changes', async () => {
    mocks.listKeys.mockResolvedValue({ items: [key(1), key(2)], pages: 1 })
    const { controller } = create()
    await controller.init()
    await controller.generate(input)
    controller.selectedKeyId.value = 2
    await nextTick()
    await controller.refresh()
    await controller.cancel()
    expect(mocks.getJob).toHaveBeenLastCalledWith('test-key-1', 'batch-test')
    expect(mocks.cancel).toHaveBeenCalledWith('test-key-1', 'batch-test')
  })

  it('can recover an owned task after its group stops allowing new generation', async () => {
    mocks.ledger.set(41, storedRun({ batchId: 'batch-test', status: 'running' }))
    mocks.listKeys.mockResolvedValue({ items: [key(1, false)], pages: 1 })
    const { controller } = create()
    await controller.init()
    expect(controller.keys.value).toEqual([])
    expect(mocks.getJob).toHaveBeenCalledWith('test-key-1', 'batch-test')
    expect(mocks.submit).not.toHaveBeenCalled()
  })

  it('does not assume a cancellation request has finished while the server still reports running', async () => {
    mocks.cancel.mockResolvedValue(job('running'))
    const { controller } = create()
    await controller.init()
    await controller.generate(input)
    await controller.cancel()
    expect(controller.run.value?.status).toBe('running')
    expect(controller.busy.value).toBe(true)
    await vi.advanceTimersByTimeAsync(8000)
    expect(mocks.getJob).toHaveBeenCalledTimes(2)
  })

  it('rejects oversized UTF-8 prompts and invalid dimensions before creating a ledger or sending', async () => {
    const { controller } = create()
    await controller.init()
    await controller.generate({ ...input, prompt: '图'.repeat(2667) })
    expect(controller.error.value).toContain('8000')
    await controller.generate({ ...input, imageSize: '4K' })
    expect(controller.error.value).toContain('尺寸')
    expect(mocks.save).not.toHaveBeenCalled()
    expect(mocks.submit).not.toHaveBeenCalled()
  })

  it('rejects excess or unsupported references without silently dropping inputs', async () => {
    const { controller } = create()
    await controller.init()
    const png = new Blob(['image'], { type: 'image/png' })
    await controller.generate({ ...input, references: [png, png] })
    expect(controller.error.value).toContain('最多支持 1')
    await controller.generate({ ...input, reference: new Blob(['svg'], { type: 'image/svg+xml' }) })
    expect(controller.error.value).toContain('PNG')
    expect(mocks.submit).not.toHaveBeenCalled()
  })

  it('encodes an accepted image as raw base64 and keeps it in the exact durable payload', async () => {
    vi.useRealTimers()
    const { controller } = create()
    await controller.init()
    await controller.generate({ ...input, reference: new Blob(['image'], { type: 'image/png' }) })
    const references = mocks.submit.mock.calls[0][1].items[0].reference_images
    expect(references).toEqual([{ mime_type: 'image/png', data: 'aW1hZ2U=' }])
    expect(mocks.ledger.get(41)?.payload.items[0].reference_images).toEqual(references)
  })

  it('persists a late submit response after disposal without delivering to an unmounted board', async () => {
    let resolveSubmit!: (value: ReturnType<typeof job>) => void
    mocks.submit.mockImplementation(() => new Promise(resolve => { resolveSubmit = resolve }))
    const { controller, onImage } = create()
    await controller.init()
    const submission = controller.generate(input)
    await vi.waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1))
    controller.dispose()
    resolveSubmit(job('completed'))
    await submission
    expect(mocks.ledger.get(41)?.batchId).toBe('batch-test')
    expect(mocks.ledger.get(41)?.delivered).toBe(false)
    expect(onImage).not.toHaveBeenCalled()
    expect(mocks.getJob).not.toHaveBeenCalled()
  })

  it('uses only the signed-in user ledger and refuses a concurrent tab claim before POST', async () => {
    mocks.ledger.set(99, storedRun({ userId: 99 }))
    const { controller } = create()
    await controller.init()
    expect(controller.run.value).toBeNull()
    mocks.ledger.set(41, storedRun())
    await controller.generate(input)
    expect(controller.error.value).toContain('Ledger conflict')
    expect(mocks.submit).not.toHaveBeenCalled()
  })

  it('stops timers on dispose without cancelling or resubmitting the server task', async () => {
    const { controller } = create()
    await controller.init()
    await controller.generate(input)
    controller.dispose()
    await vi.advanceTimersByTimeAsync(60000)
    expect(mocks.getJob).toHaveBeenCalledTimes(1)
    expect(mocks.submit).toHaveBeenCalledTimes(1)
    expect(mocks.cancel).not.toHaveBeenCalled()
    expect(mocks.ledger.get(41)?.batchId).toBe('batch-test')
  })
})
