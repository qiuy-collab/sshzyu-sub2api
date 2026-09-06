import { defineComponent, nextTick } from 'vue'
import zhBatchImage from '@/i18n/locales/zh/batchImage'
import enBatchImage from '@/i18n/locales/en/batchImage'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import BatchImageGuideView from '../BatchImageGuideView.vue'
import { keyAllowsBatchImage, openAIImageSizes, supportsBatchImagePlatform } from '@/utils/batchImage'
import type { ApiKey } from '@/types'

const { listKeys, listModels, listJobs, listItems, submitJob, retryInput, showError } = vi.hoisted(() => ({
  listKeys: vi.fn(), listModels: vi.fn(), listJobs: vi.fn(), listItems: vi.fn(), submitJob: vi.fn(), retryInput: vi.fn(), showError: vi.fn()
}))
vi.mock('@/api', () => ({ keysAPI: { list: listKeys } }))
vi.mock('@/api/batchImage', async importOriginal => ({
  ...await importOriginal<object>(), listBatchImageModels: listModels, listBatchImageJobs: listJobs, listBatchImageItems: listItems, submitBatchImageJob: submitJob, getBatchImageRetryInput: retryInput
}))
vi.mock('@/stores/app', () => ({ useAppStore: () => ({
  showError, fetchPublicSettings: vi.fn(), publicSettings: {}
}) }))
vi.mock('vue-i18n', async importOriginal => ({
  ...await importOriginal<object>(),
  useI18n: () => ({ t: (key: string) => key, locale: { value: 'en' } })
}))

function key(id: number, platform: string, enabled = true, status = 'active') {
  return { id, name: `${platform}-${id}`, key: `test-key-${id}`, status,
    group: { platform, name: platform, allow_batch_image_generation: enabled, allow_image_generation: true } } as ApiKey
}
const openai = key(1, 'openai')
const gemini = key(2, 'gemini')
const keys = [openai, gemini, key(3, 'anthropic'), key(4, 'openai', false), key(5, 'gemini', true, 'inactive')]
const SlotStub = defineComponent({ template: '<div><slot /><slot name="filters" /><slot name="table" /><slot name="pagination" /></div>' })
const DialogStub = defineComponent({ props: ['show'], template: '<div v-if="show"><slot /><slot name="footer" /></div>' })

beforeEach(() => {
  vi.clearAllMocks()
  listKeys.mockResolvedValue({ items: keys, pages: 1 })
  listModels.mockImplementation(async (token: string) => ({ data: [{ id: token === openai.key ? 'gpt-image-1' : 'gemini-3-pro-image-preview' }] }))
  listJobs.mockResolvedValue({ data: [], has_more: false })
})
afterEach(() => vi.restoreAllMocks())

describe('batch image full results', () => {
  it('provides Chinese and English labels', () => {
    expect(zhBatchImage.batchImage.detail.viewFullResult).toBe('查看完整结果')
    expect(enBatchImage.batchImage.detail.viewFullResult).toBe('View full result')
    expect(zhBatchImage.batchImage.detail.fullResult).toContain('{id}')
    expect(enBatchImage.batchImage.detail.fullResult).toContain('{id}')
  })

  it('expands complete errors as safe, selectable text without changing jobs', async () => {
    const wrapper = mount(BatchImageGuideView, { attachTo: document.body, global: { stubs: {
      AppLayout: SlotStub, TablePageLayout: SlotStub, DataTable: true,
      BaseDialog: DialogStub, Select: true, SearchInput: true, Icon: true, 'i18n-t': true
    } } })
    try {
      await flushPromises()
      const message = '<img src=x onerror="alert(1)">\n' + 'unbroken-error'.repeat(500) + '\nEND'
      const state = wrapper.vm.$.setupState as unknown as {
        currentJob: Record<string, unknown>
        items: Record<string, unknown>[]
      }
      state.currentJob = { id: 'test-job', status: 'failed', success_count: 1, fail_count: 1, actual_cost: 0 }
      state.items = [
        { batch_id: 'test-job', custom_id: 'failed', status: 'failed', image_count: 0, error: { code: 'PROVIDER_ITEM_FAILED', message } },
        { batch_id: 'test-job', custom_id: 'success', status: 'succeeded', image_count: 0 },
        { batch_id: 'test-job', custom_id: 'waiting', status: 'pending', image_count: 0 },
        { batch_id: 'test-job', custom_id: 'code-only', status: 'failed', image_count: 0, error: { code: 'CUSTOM_ERROR', message: '' } },
      ]
      await nextTick()
      const disclosures = wrapper.findAll('[data-testid="item-full-result"]')
      expect(disclosures).toHaveLength(4)
      const disclosure = disclosures[0]
      const details = disclosure.element as HTMLDetailsElement
      expect(details.open).toBe(false)
      const summary = disclosure.get('summary')
      expect(summary.text()).toBe('batchImage.detail.viewFullResult')
      // Native summary supplies Enter/Space behavior in browsers; jsdom tests click activation.
      ;(summary.element as HTMLElement).focus()
      expect(document.activeElement).toBe(summary.element)
      await summary.trigger('click')
      expect(details.open).toBe(true)
      const content = disclosure.get('[role="region"]')
      expect(content.element.textContent).toBe('batchImage.itemResult.providerItemFailed\nPROVIDER_ITEM_FAILED\n' + message)
      expect(content.find('img').exists()).toBe(false)
      expect(content.attributes('tabindex')).toBe('0')
      expect(content.attributes('aria-label')).toBe('batchImage.detail.fullResult')
      expect(content.classes()).toEqual(expect.arrayContaining(['max-h-64', 'overflow-y-auto', 'whitespace-pre-wrap', 'select-text', '[overflow-wrap:anywhere]']))
      ;(content.element as HTMLElement).focus()
      expect(document.activeElement).toBe(content.element)
      await summary.trigger('click')
      expect(details.open).toBe(false)
      expect(disclosures[1].get('[role="region"]').text()).toBe('batchImage.itemResult.readyDownload')
      expect(disclosures[2].get('[role="region"]').text()).toBe('batchImage.itemResult.waiting')
      expect(disclosures[3].get('[role="region"]').text()).toBe('CUSTOM_ERROR')
      expect(submitJob).not.toHaveBeenCalled()
      expect(retryInput).not.toHaveBeenCalled()
      expect(listItems).not.toHaveBeenCalled()
    } finally { wrapper.unmount() }
  })
})

describe('batch image platform support', () => {
  it('uses valid GPT Image 2 dimensions in their actual billing tiers', () => {
    for (const [tier, ratios] of Object.entries(openAIImageSizes)) {
      for (const dimensions of Object.values(ratios)) {
        const [width, height] = dimensions.split('x').map(Number)
        expect(width % 16).toBe(0)
        expect(height % 16).toBe(0)
        expect(Math.max(width, height)).toBeLessThanOrEqual(3840)
        expect(width * height).toBeGreaterThanOrEqual(655360)
        expect(width * height).toBeLessThanOrEqual(8294400)
        expect(Math.max(width, height) / Math.min(width, height)).toBeLessThanOrEqual(3)
        expect(Math.max(width, height) <= 1024 ? '1K' : Math.max(width, height) <= 2048 ? '2K' : '4K').toBe(tier)
      }
    }
    expect(openAIImageSizes['1K']['16:9']).toBeUndefined()
    expect(openAIImageSizes['4K']['1:1']).toBe('2880x2880')
  })

  it('offers provider-specific sizes, resets invalid ratios, and preserves Gemini UI', async () => {
    listModels.mockImplementation(async (token: string) => ({ data: [{
      id: token === openai.key ? 'gpt-image-2' : 'gemini-3-pro-image-preview',
      supported_image_sizes: ['1K', '2K'], supported_mime_types: ['image/png', 'image/jpeg', 'image/webp']
    }] }))
    const wrapper = mount(BatchImageGuideView, { global: { stubs: {
      AppLayout: SlotStub, TablePageLayout: SlotStub, DataTable: true,
      BaseDialog: DialogStub, Select: true, SearchInput: true, Icon: true, 'i18n-t': true
    } } })
    try {
      await flushPromises()
      await wrapper.findAll('button').find(button => button.text().includes('batchImage.actions.createJob'))!.trigger('click')
      await flushPromises()
      const sizes = wrapper.get('[data-testid="image-size"]')
      expect(sizes.findAll('option').map(option => option.attributes('value'))).toEqual(['1K', '2K'])
      expect(wrapper.get('[data-testid="aspect-ratio"]').text()).not.toContain('16:9')
      await sizes.setValue('2K')
      await wrapper.get('[data-testid="aspect-ratio"]').setValue('16:9')
      expect(wrapper.get('[data-testid="aspect-ratio"]').text()).toContain('2048x1152')
      const mimeSelect = wrapper.findAll('select').find(select => select.findAll('option').some(option => option.attributes('value') === 'image/jpeg'))!
      await mimeSelect.setValue('image/jpeg')
      await wrapper.find('textarea').setValue('A test landscape')
      // Reject after capturing the payload: no polling or external request is needed.
      submitJob.mockRejectedValueOnce(new Error('test capture'))
      await wrapper.findAll('button').find(button => button.text().includes('batchImage.actions.submitJob'))!.trigger('click')
      await flushPromises()
      expect(submitJob).toHaveBeenCalledWith(openai.key, expect.objectContaining({
        model: 'gpt-image-2', image_size: '2K', aspect_ratio: '16:9', response_mime_type: 'image/jpeg',
      }), expect.any(String))
      await sizes.setValue('1K')
      expect((wrapper.get('[data-testid="aspect-ratio"]').element as HTMLSelectElement).value).toBe('1:1')
      const keySelect = wrapper.findAll('select').find(select => select.findAll('option').some(option => option.text().includes('gemini-2')))!
      await keySelect.setValue('2')
      await flushPromises()
      expect(wrapper.find('[data-testid="image-size"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="aspect-ratio"]').exists()).toBe(false)
      expect(wrapper.text()).toContain('WebP')
    } finally { wrapper.unmount() }
  })

  it('retries with the original specification rather than the current create form', async () => {
    const wrapper = mount(BatchImageGuideView, { global: { stubs: {
      AppLayout: SlotStub, TablePageLayout: SlotStub, DataTable: true,
      BaseDialog: DialogStub, Select: true, SearchInput: true, Icon: true, 'i18n-t': true
    } } })
    try {
      await flushPromises()
      const references = [{ mime_type: 'image/png', data: 'b3JpZ2luYWw=' }]
      retryInput.mockResolvedValue({ model: 'gpt-image-2', provider: 'openai', image_size: '4K', aspect_ratio: '16:9', response_mime_type: 'image/webp', items: [{ custom_id: 'failed-1', prompt: 'Original prompt', reference_images: references }] })
      submitJob.mockRejectedValueOnce(new Error('test capture'))
      const state = wrapper.vm.$.setupState as unknown as {
        retryFailedJob: (job: Record<string, unknown>) => Promise<void>
      }
      await state.retryFailedJob({
        id: 'original', api_key_id: 1, model: 'gpt-image-2', provider: 'openai',
        status: 'failed', fail_count: 1, image_size: '4K', aspect_ratio: '16:9', response_mime_type: 'image/webp'
      })
      expect(submitJob).toHaveBeenCalledWith(openai.key, expect.objectContaining({
        model: 'gpt-image-2', provider: 'openai', parent_batch_id: 'original',
        image_size: '4K', aspect_ratio: '16:9', response_mime_type: 'image/webp',
        items: [expect.objectContaining({ prompt: 'Original prompt', reference_images: references })]
      }), expect.any(String))
    } finally { wrapper.unmount() }
  })

  it('blocks unavailable original inputs and asks for re-upload without submitting previews', async () => {
    const wrapper = mount(BatchImageGuideView, { global: { stubs: {
      AppLayout: SlotStub, TablePageLayout: SlotStub, DataTable: true,
      BaseDialog: DialogStub, Select: true, SearchInput: true, Icon: true, 'i18n-t': true
    } } })
    try {
      await flushPromises()
      retryInput.mockRejectedValue(Object.assign(new Error('unavailable'), { code: 'BATCH_IMAGE_RETRY_INPUT_UNAVAILABLE' }))
      const state = wrapper.vm.$.setupState as unknown as { retryFailedJob: (job: Record<string, unknown>) => Promise<void> }
      await state.retryFailedJob({ id: 'expired', api_key_id: 1, status: 'failed', fail_count: 1 })
      expect(submitJob).not.toHaveBeenCalled()
      expect(listItems).not.toHaveBeenCalled()
      expect(showError).toHaveBeenCalledWith(expect.stringContaining('re-upload the original reference images'))
    } finally { wrapper.unmount() }
  })

  it('fails closed when an older backend returns only item previews', async () => {
    const api = await vi.importActual<typeof import('@/api/batchImage')>('@/api/batchImage')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ data: [{ prompt_preview: 'not an original input' }] }) } as Response)
    await expect(api.getBatchImageRetryInput('test-token', 'task/id')).rejects.toMatchObject({ code: 'BATCH_IMAGE_RETRY_INPUT_UNAVAILABLE' })
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('task%2Fid/items?retry_input=true'), expect.objectContaining({ cache: 'no-store' }))
  })

  it('allows enabled active OpenAI and Gemini keys only', () => {
    expect(keys.filter(keyAllowsBatchImage)).toEqual([openai, gemini])
    expect(supportsBatchImagePlatform(undefined)).toBe(false)
    expect(keyAllowsBatchImage({ ...openai, group: null } as ApiKey)).toBe(false)
    expect(keyAllowsBatchImage({ ...openai, group: { ...openai.group, allow_image_generation: false } } as ApiKey)).toBe(false)
    expect(keyAllowsBatchImage({ ...gemini, group: { ...gemini.group, allow_image_generation: false } } as ApiKey)).toBe(true)
  })

  it('offers both platforms and reloads models for the selected key', async () => {
    const wrapper = mount(BatchImageGuideView, { global: { stubs: {
      AppLayout: SlotStub, TablePageLayout: SlotStub, DataTable: true,
      BaseDialog: DialogStub, Select: true, SearchInput: true, Icon: true, 'i18n-t': true
    } } })
    try {
      await flushPromises()
      const create = wrapper.findAll('button').find(button => button.text().includes('batchImage.actions.createJob'))!
      await create.trigger('click')
      await flushPromises()
      const keySelect = wrapper.findAll('select').find(select => select.findAll('option').some(option => option.attributes('value') === '1'))!
      expect(keySelect.text()).toContain('openai-1')
      expect(keySelect.text()).toContain('gemini-2')
      expect(keySelect.text()).not.toContain('anthropic-3')
      expect(keySelect.text()).not.toContain('openai-4')
      expect(keySelect.text()).not.toContain('gemini-5')
      expect(listModels).toHaveBeenCalledWith(openai.key)
      expect(wrapper.text()).toContain('gpt-image-1')
      await keySelect.setValue('2')
      await flushPromises()
      expect(listModels).toHaveBeenLastCalledWith(gemini.key)
      expect(wrapper.text()).toContain('gemini-3-pro-image-preview')
      expect(wrapper.text()).not.toContain('gpt-image-1')
    } finally {
      wrapper.unmount()
    }
  })
})
