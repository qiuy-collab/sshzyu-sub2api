import { reactive } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ImageStudioView from '../ImageStudioView.vue'
import { createStudioDocument, createStudioNode, type ImageStudioDocument } from '@/utils/imageStudioGraph'
import type { ImageStudioGenerationOptions } from '@/composables/useImageStudioGeneration'
import type { ImageStudioStorage } from '@/utils/imageStudioStorage'
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
    cancelling: false, run: null, error: '',
    init: vi.fn().mockResolvedValue(undefined), dispose: vi.fn(),
    generate: vi.fn().mockResolvedValue(undefined), retrySubmission: vi.fn(), refresh: vi.fn(), cancel: vi.fn(),
  })
}

function createStorage() {
  return {
    loadDocument: vi.fn<ImageStudioStorage['loadDocument']>().mockResolvedValue(null),
    saveDocument: vi.fn<ImageStudioStorage['saveDocument']>().mockResolvedValue(undefined),
    getAsset: vi.fn<ImageStudioStorage['getAsset']>().mockResolvedValue(null),
    putAsset: vi.fn<ImageStudioStorage['putAsset']>().mockResolvedValue({
      kind: 'asset', id: 'image-result', assetId: 'asset-result', mimeType: 'image/png', width: 640, height: 480,
    }),
    exportPortableDocument: vi.fn<ImageStudioStorage['exportPortableDocument']>().mockResolvedValue('{}'),
    importPortableDocument: vi.fn<ImageStudioStorage['importPortableDocument']>(),
    close: vi.fn(),
  }
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
})
