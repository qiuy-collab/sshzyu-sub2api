import { reactive } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ImageStudioView from '../ImageStudioView.vue'
import { connectNodes, createStudioDocument, createStudioNode, sanitizeStudioDocument, type ImageStudioDocument } from '@/utils/imageStudioGraph'
import type { ImageStudioGenerationOptions } from '@/composables/useImageStudioGeneration'
import type { ImageStudioStorage } from '@/utils/imageStudioStorage'
import type { ImageStudioRun } from '@/utils/imageStudioRunStore'
import type { ApiKey } from '@/types'
import type { BatchImageModel } from '@/api/batchImage'

const mocks = vi.hoisted(() => ({
  generation: vi.fn(), storage: vi.fn(), acquireLock: vi.fn(), saveBlob: vi.fn(),
  auth: { user: { id: 42 } }, route: { query: {} as Record<string, unknown> },
  guards: [] as Array<() => Promise<boolean>>,
}))

vi.mock('@/components/layout/AppLayout.vue', () => ({ default: { template: '<main><slot /></main>' } }))
vi.mock('@/components/icons/Icon.vue', () => ({ default: { template: '<svg aria-hidden="true" />' } }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => mocks.auth }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('vue-router', () => ({
  useRoute: () => mocks.route,
  onBeforeRouteLeave: (guard: () => Promise<boolean>) => mocks.guards.push(guard),
}))
vi.mock('@/utils/imageStudioStorage', () => ({
  createImageStudioStorage: mocks.storage, IMAGE_STUDIO_MAX_PORTABLE_JSON_BYTES: 80 * 1024 * 1024,
}))
vi.mock('@/utils/imageStudioTabLock', () => ({ acquireImageStudioTabLock: mocks.acquireLock }))
vi.mock('@/composables/useImageStudioGeneration', () => ({
  useImageStudioGeneration: mocks.generation,
  imageStudioReferenceLimit: (model: string) => model.startsWith('gpt-image-') ? 1 : 14,
}))
vi.mock('@/api/batchImage', () => ({ saveBlob: mocks.saveBlob }))

function eligibleKey(id: number, platform: 'openai' | 'gemini'): ApiKey {
  return { id, name: `${platform}-${id}`, key: `synthetic-key-${id}`, status: 'active',
    group: { platform, allow_batch_image_generation: true, allow_image_generation: true } } as ApiKey
}

function createGeneration() {
  // The composable owns account/permission filtering; this view receives only eligible keys.
  return reactive({
    keys: [eligibleKey(1, 'openai'), eligibleKey(2, 'gemini')], selectedKeyId: 1,
    models: [{ id: 'gpt-image-2', supported_image_sizes: ['1K', '2K'] }] as BatchImageModel[],
    loading: false, loadingModels: false, busy: false, submitting: false, polling: false,
    cancelling: false, receiving: false, retryingDelivery: false, outputFailed: false,
    run: null as ImageStudioRun | null, error: '',
    init: vi.fn().mockResolvedValue(undefined), dispose: vi.fn(),
    generate: vi.fn().mockResolvedValue(undefined), retrySubmission: vi.fn(), refresh: vi.fn(), cancel: vi.fn(),
  })
}

function createStorage() {
  return {
    loadDocument: vi.fn<ImageStudioStorage['loadDocument']>().mockResolvedValue(null),
    saveDocument: vi.fn<ImageStudioStorage['saveDocument']>().mockResolvedValue(undefined),
    deleteDocument: vi.fn<ImageStudioStorage['deleteDocument']>().mockResolvedValue(undefined),
    getAsset: vi.fn<ImageStudioStorage['getAsset']>().mockResolvedValue(null),
    putAsset: vi.fn<ImageStudioStorage['putAsset']>().mockResolvedValue({
      kind: 'asset', id: 'image-result', assetId: 'asset-result', mimeType: 'image/png', width: 640, height: 480,
    }),
    exportPortableDocument: vi.fn<ImageStudioStorage['exportPortableDocument']>().mockResolvedValue('{}'),
    importPortableDocument: vi.fn<ImageStudioStorage['importPortableDocument']>(),
    deleteAsset: vi.fn<ImageStudioStorage['deleteAsset']>().mockResolvedValue(undefined),
    clear: vi.fn<ImageStudioStorage['clear']>().mockResolvedValue(undefined),
    close: vi.fn(),
  } satisfies ImageStudioStorage
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

let generation: ReturnType<typeof createGeneration>
let storage: ReturnType<typeof createStorage>
let options: ImageStudioGenerationOptions
let release: ReturnType<typeof vi.fn>
const wrappers = new Set<VueWrapper>()
const NativeURL = globalThis.URL

async function render() {
  const wrapper = mount(ImageStudioView, {
    attachTo: document.body,
    global: { stubs: { RouterLink: { props: ['to'], template: '<a :href="to"><slot /></a>' } } },
  })
  wrappers.add(wrapper)
  await flushPromises()
  return wrapper
}

async function unmount(wrapper: VueWrapper) {
  wrapper.unmount()
  wrappers.delete(wrapper)
  await flushPromises()
}

function seededGenerator(): ImageStudioDocument {
  const board = createStudioDocument('default', 'Test canvas')
  board.nodes.push(createStudioNode('generate', { x: 80, y: 80 }, {
    prompt: 'A quiet studio', model: 'gpt-image-2', imageSize: '1K', aspectRatio: '1:1',
  }, 'Image generator'))
  return board
}

function runningTask(contextId: string): ImageStudioRun {
  return { userId: 42, keyId: 1, contextId, idempotencyKey: 'synthetic-run-a',
    batchId: 'synthetic-batch-a', status: 'running', delivered: false, error: null, job: null,
    payload: { model: 'gpt-image-2', image_size: '1K', aspect_ratio: '1:1',
      items: [{ custom_id: 'synthetic-image-a', prompt: 'A quiet studio', output_count: 1 }] },
    createdAt: Date.now() - 65000, updatedAt: Date.now() }
}

function resultMeta(contextId: string) {
  return { batchId: 'synthetic-batch-a', customId: 'synthetic-image-a', prompt: 'A quiet studio', model: 'gpt-image-2', contextId }
}

function imageAsset() {
  return { kind: 'asset' as const, id: 'image-result', assetId: 'asset-result', mimeType: 'image/png' as const, width: 640, height: 480 }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.guards.length = 0
  mocks.route.query = {}
  mocks.auth.user = { id: 42 }
  generation = createGeneration()
  storage = createStorage()
  release = vi.fn()
  mocks.storage.mockReturnValue(storage)
  mocks.generation.mockImplementation((value: ImageStudioGenerationOptions) => {
    options = value
    return generation
  })
  mocks.acquireLock.mockResolvedValue({ acquired: true, release })
  vi.stubGlobal('URL', class extends NativeURL {
    static createObjectURL = vi.fn(() => 'blob:synthetic-studio-image')
    static revokeObjectURL = vi.fn()
  })
  vi.stubGlobal('Image', class {
    src = ''
    naturalWidth = 640
    naturalHeight = 480
    decode = vi.fn().mockResolvedValue(undefined)
  })
})

afterEach(async () => {
  for (const wrapper of [...wrappers]) await unmount(wrapper)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('image studio view integration', () => {
  it('starts an editable prompt-to-image workflow without submitting a paid task', async () => {
    const wrapper = await render()
    await wrapper.get('[data-testid="start-image-workflow"]').trigger('click')

    expect(wrapper.findAll('[data-node-type="text"]')).toHaveLength(1)
    expect(wrapper.findAll('[data-node-type="generate"]')).toHaveLength(1)
    expect(wrapper.findAll('.studio-edge-hit')).toHaveLength(1)
    expect(document.activeElement).toBe(wrapper.get('.studio-note-text').element)
    expect(generation.generate).not.toHaveBeenCalled()
  })

  it('combines connected text in the preview and generates only on explicit form submission', async () => {
    const wrapper = await render()
    await wrapper.get('.studio-palette [aria-label="imageStudio.addText"]').trigger('click')
    await wrapper.get('.studio-note-text').setValue('Morning light through the window.')
    await wrapper.get('.studio-document-actions .studio-primary').trigger('click')
    const generator = wrapper.get('[data-node-type="generate"]')
    const generatorId = generator.attributes('data-node-id')
    await wrapper.get('.studio-palette [aria-label="imageStudio.addText"]').trigger('click')
    const notes = wrapper.findAll('[data-node-type="text"]')
    await notes[1].get('textarea').setValue('A ceramic cup on an oak desk.')
    await notes[1].get('.studio-port-out').trigger('click')
    await generator.get('.studio-port-in').trigger('click')
    await generator.get('.studio-generator-action').trigger('click')
    await wrapper.get('.studio-inspector textarea').setValue('Soft editorial photography.')

    const prompt = wrapper.get('.studio-prompt-preview p').text()
    expect(prompt).toContain('Morning light through the window.')
    expect(prompt).toContain('A ceramic cup on an oak desk.')
    expect(prompt).toContain('Soft editorial photography.')
    expect(prompt.indexOf('Morning light')).toBeLessThan(prompt.indexOf('A ceramic cup'))
    expect(wrapper.findAll('.studio-edge-hit')).toHaveLength(2)
    expect(generation.generate).not.toHaveBeenCalled()

    await wrapper.get('.studio-inspector form').trigger('submit')
    await flushPromises()
    expect(generation.generate).toHaveBeenCalledOnce()
    expect(generation.generate).toHaveBeenCalledWith({
      prompt, model: 'gpt-image-2', imageSize: '1K', aspectRatio: '1:1', references: [], contextId: generatorId,
    })
    expect(storage.saveDocument).toHaveBeenCalled()
    expect(storage.saveDocument.mock.invocationCallOrder[0]).toBeLessThan(generation.generate.mock.invocationCallOrder[0])
  })

  it('offers supported OpenAI sizes and resets size/ratio when switching to a Gemini key', async () => {
    storage.loadDocument.mockResolvedValue(seededGenerator())
    const wrapper = await render()
    await wrapper.get('.studio-generator-action').trigger('click')
    const selects = wrapper.findAll('.studio-inspector select')
    const optionValues = (index: number) => selects[index].findAll('option').map(option => option.attributes('value'))
    expect(optionValues(0)).toEqual(['1', '2'])
    expect(optionValues(2)).toEqual(['1K', '2K'])
    expect(optionValues(3)).not.toContain('16:9')
    await selects[2].setValue('2K')
    await selects[3].setValue('16:9')
    expect((selects[3].element as HTMLSelectElement).value).toBe('16:9')

    await selects[0].setValue('2')
    generation.models = [{ id: 'gemini-3-pro-image-preview', supported_image_sizes: ['1K', '2K', '4K'] }] as BatchImageModel[]
    await flushPromises()
    expect(optionValues(2)).toEqual(['1K'])
    expect(optionValues(3)).toEqual(['1:1'])
    expect((selects[1].element as HTMLSelectElement).value).toBe('gemini-3-pro-image-preview')
    expect((selects[2].element as HTMLSelectElement).value).toBe('1K')
    expect((selects[3].element as HTMLSelectElement).value).toBe('1:1')
    expect(generation.generate).not.toHaveBeenCalled()
    await wrapper.get('.studio-inspector form').trigger('submit')
    await flushPromises()
    expect(generation.generate).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gemini-3-pro-image-preview', imageSize: '1K', aspectRatio: '1:1',
    }))
  })

  it('keeps editing available without eligible batch-image keys but blocks paid submission', async () => {
    generation.keys = []
    generation.selectedKeyId = 0
    generation.models = []
    storage.loadDocument.mockResolvedValue(seededGenerator())
    const wrapper = await render()
    await wrapper.get('.studio-generator-action').trigger('click')
    await wrapper.get('.studio-inspector textarea').setValue('An editable draft')
    expect(wrapper.get('.studio-no-key').text()).toContain('imageStudio.noKey')
    expect(wrapper.get('.studio-no-key a').attributes('href')).toBe('/keys')
    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeDefined()
    await wrapper.get('.studio-inspector form').trigger('submit')
    await flushPromises()
    expect(generation.generate).not.toHaveBeenCalled()
  })

  it('hands off only a positive safe key ID from the route, never a token or ambiguous query', async () => {
    for (const [query, expected] of [
      ['2', 2], [['2'], undefined], ['0', undefined], ['2.5', undefined],
      ['9007199254740992', undefined], ['sk-synthetic-secret', undefined],
    ] as const) {
      mocks.route.query = { keyId: query, key: 'sk-ignored-query', token: 'ignored-token' }
      const wrapper = await render()
      expect(options).toEqual({ userId: 42, preferredKeyId: expected, onImage: expect.any(Function) })
      expect(generation.generate).not.toHaveBeenCalled()
      await unmount(wrapper)
    }
  })

  it('does not initialize generation, read the board, or allow editing when the tab lock is denied', async () => {
    for (const [reason, label] of [['locked', 'imageStudio.otherTab'], ['unsupported', 'imageStudio.storageRequired']]) {
      mocks.acquireLock.mockResolvedValue({ acquired: false, reason, release: vi.fn() })
      const wrapper = await render()
      expect(mocks.acquireLock).toHaveBeenCalledWith(42)
      expect(wrapper.get('.studio-empty').text()).toBe(label)
      expect(wrapper.get('[aria-label="imageStudio.boardName"]').attributes('disabled')).toBeDefined()
      expect(wrapper.get('.studio-document-actions .studio-primary').attributes('disabled')).toBeDefined()
      expect(wrapper.find('.studio-palette').exists()).toBe(false)
      expect(wrapper.find('[data-node-id]').exists()).toBe(false)
      expect(storage.loadDocument).not.toHaveBeenCalled()
      expect(storage.saveDocument).not.toHaveBeenCalled()
      expect(generation.init).not.toHaveBeenCalled()
      expect(generation.generate).not.toHaveBeenCalled()
      await unmount(wrapper)
    }
  })

  it('blocks route departure while a portable export is running and permits it after completion', async () => {
    const exported = deferred<string>()
    storage.exportPortableDocument.mockReturnValue(exported.promise)
    const wrapper = await render()
    await wrapper.get('[title="imageStudio.export"]').trigger('click')
    expect(storage.exportPortableDocument).toHaveBeenCalledOnce()
    expect(await mocks.guards[0]()).toBe(false)
    expect(wrapper.get('[aria-label="imageStudio.newBoard"]').attributes('disabled')).toBeDefined()
    expect(mocks.saveBlob).not.toHaveBeenCalled()
    exported.resolve('{"fixture":true}')
    await flushPromises()
    expect(await mocks.guards[0]()).toBe(true)
    expect(mocks.saveBlob).toHaveBeenCalledOnce()
    expect(mocks.saveBlob).toHaveBeenCalledWith(expect.any(Blob), 'imageStudio.untitled.sshzyu.json')
    expect(generation.generate).not.toHaveBeenCalled()
  })

  it('prevents duplicate submits and route changes while awaiting durable pre-generation storage', async () => {
    const saved = deferred<void>()
    storage.loadDocument.mockResolvedValue(seededGenerator())
    storage.saveDocument.mockReturnValue(saved.promise)
    const wrapper = await render()
    await wrapper.get('.studio-generator-action').trigger('click')
    await wrapper.get('.studio-inspector form').trigger('submit')
    await flushPromises()
    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('.studio-inspector select').attributes('disabled')).toBeDefined()
    expect(await mocks.guards[0]()).toBe(false)
    await wrapper.get('.studio-inspector form').trigger('submit')
    expect(storage.saveDocument).toHaveBeenCalledOnce()
    expect(generation.generate).not.toHaveBeenCalled()
    saved.resolve(undefined)
    await flushPromises()
    expect(generation.generate).toHaveBeenCalledOnce()
    expect(await mocks.guards[0]()).toBe(true)
  })

  it('retries a failed result save and restores the same paid result without duplicate nodes or assets', async () => {
    const board = seededGenerator()
    storage.loadDocument.mockResolvedValue(board)
    storage.saveDocument.mockRejectedValueOnce(new Error('Storage quota exceeded'))
    const wrapper = await render()
    const blob = new Blob(['synthetic image bytes'], { type: 'image/png' })
    const meta = { batchId: 'paid-job', customId: 'paid-image', prompt: 'A quiet studio',
      model: 'gpt-image-2', contextId: board.nodes[0].id }
    await expect(options.onImage(blob, meta)).rejects.toThrow('imageStudio.saveFailed')
    expect(wrapper.findAll('[data-node-type="result"]')).toHaveLength(1)
    expect(storage.putAsset).toHaveBeenCalledOnce()
    await options.onImage(blob, meta)
    await flushPromises()
    expect(wrapper.findAll('[data-node-type="result"]')).toHaveLength(1)
    expect(storage.putAsset).toHaveBeenCalledOnce()
    const persisted = JSON.parse(JSON.stringify(storage.saveDocument.mock.lastCall![0])) as ImageStudioDocument
    expect(persisted.nodes.filter(node => node.type === 'result')).toHaveLength(1)
    await unmount(wrapper)
    expect(release).toHaveBeenCalledOnce()

    storage.loadDocument.mockResolvedValue(persisted)
    storage.getAsset.mockResolvedValue(blob)
    const restored = await render()
    await options.onImage(blob, meta)
    await flushPromises()
    expect(restored.findAll('[data-node-type="result"]')).toHaveLength(1)
    expect(restored.get('[data-node-type="result"] img').attributes('src')).toBe('blob:synthetic-studio-image')
    expect(storage.putAsset).toHaveBeenCalledOnce()
    expect(generation.generate).not.toHaveBeenCalled()
  })

  it('keeps a new generator editable while A runs and shows activity only on A without resubmitting', async () => {
    const board = seededGenerator()
    const sourceId = board.nodes[0].id
    generation.models.push({ id: 'gpt-image-1', supported_image_sizes: ['1K', '2K'] } as BatchImageModel)
    storage.loadDocument.mockResolvedValue(board)
    generation.generate.mockImplementationOnce(async () => {
      generation.run = runningTask(sourceId)
      generation.busy = true
    })
    const wrapper = await render()
    await wrapper.get('.studio-generator-action').trigger('click')
    await wrapper.get('.studio-inspector form').trigger('submit')
    await flushPromises()
    expect(generation.generate).toHaveBeenCalledOnce()

    await wrapper.get('.studio-document-actions .studio-primary').trigger('click')
    const nodes = wrapper.findAll('[data-node-type="generate"]')
    const draftId = nodes[1].attributes('data-node-id')
    const prompt = wrapper.get('.studio-inspector textarea')
    await prompt.setValue('Draft B remains editable while A is running')
    const selects = wrapper.findAll('.studio-inspector select')
    expect(selects[0].attributes('disabled')).toBeDefined()
    for (const select of selects.slice(1)) expect(select.attributes('disabled')).toBeUndefined()
    await selects[1].setValue('gpt-image-1')
    await selects[2].setValue('2K')
    await selects[3].setValue('16:9')
    expect((prompt.element as HTMLTextAreaElement).value).toBe('Draft B remains editable while A is running')
    expect((selects[1].element as HTMLSelectElement).value).toBe('gpt-image-1')
    expect((selects[3].element as HTMLSelectElement).value).toBe('16:9')
    expect(wrapper.get(`[data-node-id="${draftId}"]`).classes()).toContain('is-selected')
    expect(nodes[0].classes()).toContain('is-generating')
    expect(nodes[1].classes()).not.toContain('is-generating')
    expect(nodes[0].find('.studio-node-progress .studio-spinner').exists()).toBe(true)
    expect(nodes[1].find('.studio-node-progress').exists()).toBe(false)
    expect(wrapper.find('.studio-task-status .studio-spinner').exists()).toBe(true)
    expect(wrapper.find('.studio-task-status [role="status"]').exists()).toBe(true)
    expect(wrapper.find('.studio-inspector .studio-run').exists()).toBe(false)
    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeDefined()
    await wrapper.get('.studio-inspector form').trigger('submit')
    await flushPromises()
    expect(generation.generate).toHaveBeenCalledOnce()
    expect(generation.run?.payload.model).toBe('gpt-image-2')
    expect(generation.run?.payload.items[0].prompt).toBe('A quiet studio')
  })

  it('opens the clicked generator and closes the old inspector when adding or focusing text', async () => {
    let board = seededGenerator()
    const sourceId = board.nodes[0].id
    const draft = createStudioNode('generate', { x: 480, y: 80 }, { prompt: 'Draft B', model: 'gpt-image-2' }, 'Generator B')
    const note = createStudioNode('text', { x: 80, y: 480 }, { text: 'Existing note' }, 'Existing note')
    board.nodes.push(draft, note)
    board = connectNodes(board, note.id, sourceId)
    storage.loadDocument.mockResolvedValue(board)
    generation.run = runningTask(sourceId)
    generation.busy = true
    const wrapper = await render()
    await wrapper.get(`[data-node-id="${sourceId}"] .studio-generator-action`).trigger('click')
    await wrapper.get(`[data-node-id="${draft.id}"] .studio-generator-body`).trigger('click')
    expect(wrapper.get('.studio-inspector h2').text()).toBe('Generator B')
    expect((wrapper.get('.studio-inspector textarea').element as HTMLTextAreaElement).value).toBe('Draft B')

    await wrapper.get('.studio-edge-hit').trigger('click')
    await wrapper.get('.studio-palette [aria-label="imageStudio.addText"]').trigger('click')
    await flushPromises()
    const created = wrapper.findAll('[data-node-type="text"]')[1]
    expect(wrapper.find('.studio-inspector').exists()).toBe(false)
    expect(document.activeElement).toBe(created.get('textarea').element)
    expect(created.classes()).toContain('is-selected')
    expect(wrapper.find('.studio-edge.is-selected').exists()).toBe(false)
    await wrapper.get('.studio-palette [aria-label="imageStudio.delete"]').trigger('click')
    expect(wrapper.findAll('[data-node-type="text"]')).toHaveLength(1)
    expect(wrapper.findAll('.studio-edge-hit')).toHaveLength(1)

    await wrapper.get(`[data-node-id="${sourceId}"] .studio-generator-action`).trigger('click')
    const existing = wrapper.get(`[data-node-id="${note.id}"]`)
    ;(existing.get('textarea').element as HTMLTextAreaElement).focus()
    await flushPromises()
    expect(existing.classes()).toContain('is-selected')
    expect(wrapper.find('.studio-inspector').exists()).toBe(false)
    expect(generation.generate).not.toHaveBeenCalled()
  })

  it('adds A’s result without changing B’s draft, selection, inspector or viewport until View result is clicked', async () => {
    const board = seededGenerator()
    const sourceId = board.nodes[0].id
    const draft = createStudioNode('generate', { x: 520, y: 160 }, { prompt: 'Draft B', model: 'gpt-image-2' }, 'Generator B')
    board.nodes.push(draft)
    board.viewport = { x: -100, y: 50, zoom: 0.8 }
    storage.loadDocument.mockResolvedValue(board)
    generation.run = runningTask(sourceId)
    generation.busy = true
    const wrapper = await render()
    await wrapper.get(`[data-node-id="${draft.id}"] .studio-generator-body`).trigger('click')
    await wrapper.get('.studio-inspector textarea').setValue('B edited while awaiting A')
    const viewport = wrapper.get('.studio-world').attributes('style')
    const pendingAsset = deferred<ReturnType<typeof imageAsset>>()
    storage.putAsset.mockReturnValueOnce(pendingAsset.promise)
    const delivery = options.onImage(new Blob(['synthetic image'], { type: 'image/png' }), resultMeta(sourceId))
    await flushPromises()
    await wrapper.get('.studio-inspector textarea').setValue('B edited again during image storage')
    pendingAsset.resolve(imageAsset())
    await delivery
    generation.run = { ...generation.run!, status: 'completed', delivered: true }
    generation.busy = false
    await flushPromises()
    expect(wrapper.findAll('[data-node-type="result"]')).toHaveLength(1)
    expect(wrapper.get(`[data-node-id="${draft.id}"]`).classes()).toContain('is-selected')
    expect(wrapper.get('.studio-inspector h2').text()).toBe('Generator B')
    expect((wrapper.get('.studio-inspector textarea').element as HTMLTextAreaElement).value).toBe('B edited again during image storage')
    expect(wrapper.get('.studio-world').attributes('style')).toBe(viewport)
    const persisted = storage.saveDocument.mock.lastCall![0]
    expect(persisted.nodes.find(node => node.id === draft.id)?.data).toMatchObject({ prompt: 'B edited again during image storage' })
    expect(() => sanitizeStudioDocument(persisted)).not.toThrow()
    const reveal = wrapper.findAll('.studio-task-actions button').find(button => button.text().includes('imageStudio.viewResult'))!
    expect(reveal).toBeDefined()
    await reveal.trigger('click')
    expect(wrapper.get('[data-node-type="result"]').classes()).toContain('is-selected')
    expect(wrapper.find('.studio-inspector').exists()).toBe(false)
    expect(generation.generate).not.toHaveBeenCalled()
  })

  it('stores a standalone result when its source is deleted while the image asset is being saved', async () => {
    const board = seededGenerator()
    const sourceId = board.nodes[0].id
    storage.loadDocument.mockResolvedValue(board)
    generation.run = runningTask(sourceId)
    generation.busy = true
    const wrapper = await render()
    const pendingAsset = deferred<ReturnType<typeof imageAsset>>()
    storage.putAsset.mockReturnValueOnce(pendingAsset.promise)
    const delivery = options.onImage(new Blob(['synthetic image'], { type: 'image/png' }), resultMeta(sourceId))
    await flushPromises()
    expect(storage.putAsset).toHaveBeenCalledOnce()
    await wrapper.get('[data-node-type="generate"] .studio-generator-body').trigger('click')
    await wrapper.get('.studio-palette [aria-label="imageStudio.delete"]').trigger('click')
    expect(wrapper.find('[data-node-type="generate"]').exists()).toBe(false)
    pendingAsset.resolve(imageAsset())
    await delivery
    await flushPromises()
    expect(wrapper.findAll('[data-node-type="result"]')).toHaveLength(1)
    const persisted = storage.saveDocument.mock.lastCall![0]
    const result = persisted.nodes.find(node => node.type === 'result')!
    expect(result.data).not.toHaveProperty('generateNodeId')
    expect(result.data).toMatchObject({ batchId: 'synthetic-batch-a', customId: 'synthetic-image-a' })
    expect(() => sanitizeStudioDocument(persisted)).not.toThrow()
    expect(wrapper.find('.studio-save-state.is-error').exists()).toBe(false)
  })

  it('does not insert node 201 when editing fills the last slot during asynchronous result storage', async () => {
    const board = seededGenerator()
    const sourceId = board.nodes[0].id
    while (board.nodes.length < 199) board.nodes.push(createStudioNode('text', { x: 500, y: 500 }, { text: 'Draft' }, 'Draft'))
    storage.loadDocument.mockResolvedValue(board)
    generation.run = runningTask(sourceId)
    generation.busy = true
    const wrapper = await render()
    const pendingAsset = deferred<ReturnType<typeof imageAsset>>()
    storage.putAsset.mockReturnValueOnce(pendingAsset.promise)
    const delivery = options.onImage(new Blob(['synthetic image'], { type: 'image/png' }), resultMeta(sourceId))
    const rejected = expect(delivery).rejects.toThrow('imageStudio.maxNodes')
    await flushPromises()
    await wrapper.get('.studio-palette [aria-label="imageStudio.addText"]').trigger('click')
    expect(wrapper.findAll('[data-node-id]')).toHaveLength(200)
    pendingAsset.resolve(imageAsset())
    await rejected
    await flushPromises()
    expect(wrapper.findAll('[data-node-id]')).toHaveLength(200)
    expect(wrapper.find('[data-node-type="result"]').exists()).toBe(false)
    for (const [saved] of storage.saveDocument.mock.calls) expect(() => sanitizeStudioDocument(saved)).not.toThrow()
    expect(wrapper.find('.studio-save-state.is-error').exists()).toBe(false)
    expect(generation.generate).not.toHaveBeenCalled()
  })

  it('deduplicates overlapping delivery callbacks as well as later retries for the same image', async () => {
    const board = seededGenerator()
    const sourceId = board.nodes[0].id
    storage.loadDocument.mockResolvedValue(board)
    generation.run = runningTask(sourceId)
    generation.busy = true
    const wrapper = await render()
    const pendingAsset = deferred<ReturnType<typeof imageAsset>>()
    storage.putAsset.mockReturnValue(pendingAsset.promise)
    const image = new Blob(['synthetic image'], { type: 'image/png' })
    const first = options.onImage(image, resultMeta(sourceId))
    const second = options.onImage(image, resultMeta(sourceId))
    await flushPromises()
    pendingAsset.resolve(imageAsset())
    await Promise.all([first, second])
    await options.onImage(image, resultMeta(sourceId))
    await flushPromises()
    expect(wrapper.findAll('[data-node-type="result"]')).toHaveLength(1)
    const persisted = storage.saveDocument.mock.lastCall![0]
    expect(persisted.nodes.filter(node => node.type === 'result')).toHaveLength(1)
    expect(() => sanitizeStudioDocument(persisted)).not.toThrow()
    expect(generation.generate).not.toHaveBeenCalled()
  })

  it('offers retry/cancel only for actionable states and retains refresh while a completed result needs recovery', async () => {
    const board = seededGenerator()
    const sourceId = board.nodes[0].id
    storage.loadDocument.mockResolvedValue(board)
    generation.run = { ...runningTask(sourceId), batchId: null, status: 'failed' }
    const wrapper = await render()
    await wrapper.get('.studio-generator-body').trigger('click')
    const retryButtons = () => wrapper.findAll('.studio-task-actions button,.studio-run-actions button')
      .filter(button => button.text() === 'imageStudio.retry')
    const cancelButtons = () => wrapper.findAll('.studio-run-actions button')
      .filter(button => button.text() === 'imageStudio.cancel')
    expect(retryButtons()).toHaveLength(0)
    expect(cancelButtons()).toHaveLength(0)
    expect(generation.retrySubmission).not.toHaveBeenCalled()

    generation.run = { ...generation.run!, status: 'uncertain' }
    generation.busy = true
    await flushPromises()
    expect(retryButtons()).toHaveLength(2)
    await retryButtons()[0].trigger('click')
    expect(generation.retrySubmission).toHaveBeenCalledOnce()

    generation.run = { ...generation.run!, batchId: 'synthetic-batch-a', status: 'completed', delivered: false }
    generation.error = 'Synthetic result storage needs recovery'
    await flushPromises()
    expect(retryButtons()).toHaveLength(0)
    expect(cancelButtons()).toHaveLength(0)
    const refresh = wrapper.findAll('.studio-run-actions button').find(button => button.text() === 'imageStudio.refresh')!
    expect(refresh).toBeDefined()
    expect(refresh.attributes('disabled')).toBeUndefined()
    await refresh.trigger('click')
    expect(generation.refresh).toHaveBeenCalledOnce()
    expect(generation.cancel).not.toHaveBeenCalled()

    generation.run = { ...generation.run!, status: 'running' }
    generation.error = ''
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await flushPromises()
    expect(cancelButtons()).toHaveLength(1)
    await cancelButtons()[0].trigger('click')
    expect(generation.cancel).toHaveBeenCalledOnce()
    expect(generation.generate).not.toHaveBeenCalled()
  })

  it('shows a new generator’s pre-ledger failure even when an unrelated old run remains stored', async () => {
    const board = seededGenerator()
    storage.loadDocument.mockResolvedValue(board)
    generation.run = { ...runningTask('old-node-no-longer-on-board'), idempotencyKey: 'previous-completed-run', status: 'completed', delivered: true }
    const previousRun = JSON.parse(JSON.stringify(generation.run))
    const message = 'Synthetic pre-submit validation failed before creating a new run'
    generation.generate.mockImplementationOnce(async () => { generation.error = message })
    const wrapper = await render()
    await wrapper.get('.studio-generator-body').trigger('click')
    await wrapper.get('.studio-inspector textarea').setValue('A new request after the old board was cleared')
    await wrapper.get('.studio-inspector form').trigger('submit')
    await flushPromises()
    expect(generation.generate).toHaveBeenCalledOnce()
    expect(generation.run).toEqual(previousRun)
    const messages = wrapper.findAll('.studio-inspector .studio-error,.studio-toast').map(element => element.text())
    expect(messages.some(text => text.includes(message))).toBe(true)
    expect(wrapper.get('.studio-inspector .studio-error').text()).toBe(message)
    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeUndefined()
    expect(generation.retrySubmission).not.toHaveBeenCalled()
  })

  it('retains failed/cancelled task feedback after deleting its source and clears it when starting a new board', async () => {
    for (const status of ['failed', 'cancelled']) {
      const board = seededGenerator()
      const sourceId = board.nodes[0].id
      storage.loadDocument.mockResolvedValue(board)
      generation.run = null
      generation.busy = false
      generation.error = ''
      const wrapper = await render()
      // A real composable establishes the run after the view has mounted.
      generation.run = runningTask(sourceId)
      generation.busy = true
      await flushPromises()
      expect(wrapper.find('.studio-task-status').exists()).toBe(true)
      await wrapper.get('.studio-generator-body').trigger('click')
      await wrapper.get('.studio-palette [aria-label="imageStudio.delete"]').trigger('click')
      expect(wrapper.find('[data-node-type="generate"]').exists()).toBe(false)
      generation.run = { ...generation.run!, status }
      generation.busy = false
      generation.error = status === 'failed' ? 'Synthetic provider failed after the source was removed' : ''
      await flushPromises()
      const task = wrapper.get('.studio-task-status')
      expect(task.get('[role="status"]').text()).toBe(status === 'failed' ? 'imageStudio.generationFailed' : 'imageStudio.cancelled')
      if (generation.error) expect(task.get('[role="alert"]').text()).toBe(generation.error)
      expect(task.find('.studio-spinner').exists()).toBe(false)
      expect(task.find('a[href="/batch-image"]').exists()).toBe(true)
      await wrapper.get('[aria-label="imageStudio.newBoard"]').trigger('click')
      await flushPromises()
      expect(wrapper.find('.studio-task-status').exists()).toBe(false)
      expect(wrapper.find('[data-node-id]').exists()).toBe(false)
      expect(generation.run?.status).toBe(status)
      expect(generation.generate).not.toHaveBeenCalled()
      await unmount(wrapper)
    }
  })
})
