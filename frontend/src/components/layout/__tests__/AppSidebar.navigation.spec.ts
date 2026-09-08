import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { nextTick, reactive, ref, shallowRef } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import AppSidebar from '../AppSidebar.vue'

interface CustomMenu {
  id: string
  label: string
  visibility: 'admin' | 'user'
  sort_order: number
  icon_svg: string
}

function createAppState() {
  return reactive({
    sidebarCollapsed: false,
    mobileOpen: false,
    sidebarScrollTop: 0,
    backendModeEnabled: false,
    siteName: 'My Brand',
    siteLogo: '/custom-logo.svg',
    siteVersion: 'v1.0.0',
    publicSettingsLoaded: true,
    cachedPublicSettings: {
      channel_monitor_enabled: true,
      available_channels_enabled: true,
      model_plaza_enabled: true as boolean | undefined,
      model_plaza_require_auth: true,
      payment_enabled: true,
      affiliate_enabled: true,
      risk_control_enabled: true,
      plugin_management_enabled: true,
      custom_menu_items: [] as CustomMenu[]
    },
    setSidebarCollapsed: vi.fn((value: boolean) => { appStore.sidebarCollapsed = value }),
    toggleSidebar: vi.fn(() => { appStore.sidebarCollapsed = !appStore.sidebarCollapsed }),
    setMobileOpen: vi.fn((value: boolean) => { appStore.mobileOpen = value })
  })
}

let appStore: ReturnType<typeof createAppState>
let authStore: { isAdmin: boolean; isSimpleMode: boolean }
let adminStore: { opsMonitoringEnabled: boolean; paymentEnabled: boolean; customMenuItems: CustomMenu[]; fetch: ReturnType<typeof vi.fn> }
let locale = ref('zh-CN')
let batchAccess = ref(true)
let tourDriver = shallowRef<object | null>(null)
const nextStep = vi.fn()
const currentStep = vi.fn(() => false)
const refreshBatchImageAccess = vi.fn()

vi.mock('@/stores', () => ({
  useAppStore: () => appStore,
  useAuthStore: () => authStore,
  useAdminSettingsStore: () => adminStore,
  useOnboardingStore: () => ({
    getDriverInstance: () => tourDriver.value,
    isCurrentStep: currentStep,
    nextStep
  })
}))
vi.mock('@/stores/app', () => ({ useAppStore: () => appStore }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key, locale }) }))
vi.mock('@/components/common/VersionBadge.vue', () => ({
  default: { props: ['version'], template: '<span>{{ version }}</span>' }
}))
vi.mock('@/composables/useBatchImageAccess', () => ({
  useBatchImageAccess: () => ({ canUseBatchImage: batchAccess, refreshBatchImageAccess })
}))

const wrappers: VueWrapper[] = []
const attachedHosts: HTMLElement[] = []
let router: Router

async function renderSidebar(path = '/admin/dashboard', attachTo?: HTMLElement) {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }]
  })
  await router.push(path)
  await router.isReady()
  const wrapper = mount(AppSidebar, {
    attachTo,
    global: {
      plugins: [router],
      stubs: { VersionBadge: { props: ['version'], template: '<span>{{ version }}</span>' } }
    }
  })
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}

function navigationPaths(wrapper: VueWrapper) {
  return wrapper.findAll('nav a').map(link => link.attributes('href')).sort()
}

async function expandGroups(wrapper: VueWrapper) {
  for (const group of wrapper.findAll('.dock-nav-group')) {
    if (group.attributes('aria-expanded') === 'false') await group.trigger('click')
  }
}

function customMenu(id: string, visibility: 'admin' | 'user', sort_order = 0): CustomMenu {
  return { id, visibility, sort_order, label: `Custom ${id}`, icon_svg: '<svg viewBox="0 0 24 24"><path fill="#d22" d="M1 1h2v2z" /></svg>' }
}

beforeEach(() => {
  vi.clearAllMocks()
  appStore = createAppState()
  authStore = reactive({ isAdmin: true, isSimpleMode: false })
  adminStore = reactive({ opsMonitoringEnabled: true, paymentEnabled: true, customMenuItems: [], fetch: vi.fn() })
  locale = ref('zh-CN')
  batchAccess = ref(true)
  tourDriver = shallowRef<object | null>(null)
  currentStep.mockReturnValue(false)
  localStorage.setItem('theme', 'light')
  document.documentElement.classList.remove('dark')
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 })
})

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount()
  for (const host of attachedHosts.splice(0)) host.remove()
  document.documentElement.classList.remove('dark')
  vi.useRealTimers()
})

describe('AppSidebar Dock navigation', () => {
  it.each([false, true])('keeps the canvas and normal shortcuts while retiring the legacy image entry (admin=%s)', async (isAdmin) => {
    authStore.isAdmin = isAdmin
    const legacy = customMenu('4ac01eacf764b20a', 'user', 2)
    const guide = customMenu('55c8913fba674edc', 'user', 1)
    const recharge = customMenu('ed47558cbb4346a5', 'user', 0)
    const unrelated = customMenu('another-image-tool', 'user', 3)
    appStore.cachedPublicSettings.custom_menu_items = [legacy, guide, recharge, unrelated]
    const original = JSON.stringify(appStore.cachedPublicSettings.custom_menu_items)
    const wrapper = await renderSidebar(isAdmin ? '/admin/dashboard' : '/dashboard')
    if (isAdmin) await wrapper.get('button[aria-label="个人空间"]').trigger('click')
    const paths = navigationPaths(wrapper)
    expect(paths).not.toContain(`/custom/${legacy.id}`)
    for (const path of ['/image-studio', '/batch-image', `/custom/${guide.id}`, `/custom/${recharge.id}`, `/custom/${unrelated.id}`]) {
      expect(paths).toContain(path)
    }
    for (const item of [guide, recharge]) {
      const link = wrapper.get(`a[href="/custom/${item.id}"]`)
      expect(link.text()).toBe(item.label)
      expect(link.find('.dock-custom-icon').exists()).toBe(false)
      expect(link.get('svg').attributes('stroke')).toBe('currentColor')
      expect(link.get('svg').attributes('stroke-width')).toBe('1.5')
    }
    expect(wrapper.get(`a[href="/custom/${unrelated.id}"] .dock-custom-icon path`).attributes('fill')).toBe('#d22')
    expect(JSON.stringify(appStore.cachedPublicSettings.custom_menu_items)).toBe(original)
  })

  it('keeps every admin route reachable across task groups, including custom entries', async () => {
    adminStore.customMenuItems = [customMenu('admin-help', 'admin'), customMenu('wrong-role', 'user')]
    const wrapper = await renderSidebar()
    expect(wrapper.findAll('.dock-section-title').map(section => section.text())).toEqual([
      '概览', '用户与资源', '运营与财务', '系统', '快捷入口'
    ])
    await expandGroups(wrapper)
    expect(navigationPaths(wrapper)).toEqual([
      '/admin/dashboard', '/admin/ops', '/admin/users', '/admin/groups',
      '/admin/channels/pricing', '/admin/channels/monitor', '/admin/subscriptions',
      '/admin/accounts', '/admin/plugins', '/admin/announcements', '/admin/proxies',
      '/admin/risk-control', '/admin/prompt-audit', '/admin/redeem', '/admin/promo-codes',
      '/admin/affiliates/invites', '/admin/affiliates/rebates', '/admin/affiliates/transfers',
      '/admin/orders/dashboard', '/admin/orders', '/admin/orders/plans',
      '/admin/usage', '/admin/audit-logs', '/admin/settings', '/custom/admin-help'
    ].sort())
    expect(wrapper.find('#sidebar-channel-manage').exists()).toBe(true)
    expect(wrapper.find('#sidebar-group-manage').exists()).toBe(true)
    expect(wrapper.find('#sidebar-wallet').exists()).toBe(true)
    expect(wrapper.get('.dock-custom-icon svg path').attributes('fill')).toBe('#d22')
  })

  it('switches admin and personal presentation without changing routes or losing personal links', async () => {
    appStore.cachedPublicSettings.custom_menu_items = [customMenu('user-help', 'user'), customMenu('wrong-role', 'admin')]
    const wrapper = await renderSidebar()
    await wrapper.get('button[aria-label="个人空间"]').trigger('click')
    expect(router.currentRoute.value.path).toBe('/admin/dashboard')
    expect(navigationPaths(wrapper)).toEqual([
      '/keys', '/model-plaza?embedded=1', '/image-studio', '/batch-image', '/usage', '/available-channels', '/monitor', '/subscriptions',
      '/purchase', '/orders', '/redeem', '/affiliate', '/profile', '/custom/user-help'
    ].sort())
    expect(wrapper.get('button[aria-label="个人空间"]').attributes('aria-pressed')).toBe('true')
    await wrapper.get('button[aria-label="管理空间"]').trigger('click')
    expect(wrapper.find('a[href="/admin/settings"]').exists()).toBe(true)
  })

  it('keeps regular-user navigation separate from management and adds its dashboard', async () => {
    authStore.isAdmin = false
    const wrapper = await renderSidebar('/dashboard')
    expect(wrapper.find('.dock-space-switch').exists()).toBe(false)
    expect(navigationPaths(wrapper)).toContain('/dashboard')
    expect(navigationPaths(wrapper).some(path => path.startsWith('/admin/'))).toBe(false)
    expect(wrapper.get('[data-tour="sidebar-my-keys"]').attributes('href')).toBe('/keys')
  })

  it('continues to apply public and admin feature flags, including child-only filtering', async () => {
    Object.assign(appStore.cachedPublicSettings, {
      channel_monitor_enabled: false, available_channels_enabled: false, payment_enabled: false,
      affiliate_enabled: false, risk_control_enabled: false, plugin_management_enabled: false
    })
    adminStore.opsMonitoringEnabled = false
    adminStore.paymentEnabled = false
    batchAccess.value = false
    const wrapper = await renderSidebar()
    await expandGroups(wrapper)
    const adminPaths = navigationPaths(wrapper)
    expect(adminPaths).toContain('/admin/channels/pricing')
    for (const path of ['/admin/ops', '/admin/plugins', '/admin/channels/monitor', '/admin/risk-control', '/admin/affiliates/invites', '/admin/orders']) {
      expect(adminPaths).not.toContain(path)
    }
    await wrapper.get('button[aria-label="个人空间"]').trigger('click')
    const personalPaths = navigationPaths(wrapper)
    for (const path of ['/monitor', '/available-channels', '/purchase', '/orders', '/affiliate', '/batch-image', '/image-studio']) {
      expect(personalPaths).not.toContain(path)
    }
    expect(personalPaths).toContain('/subscriptions')
    appStore.cachedPublicSettings.available_channels_enabled = true
    batchAccess.value = true
    await nextTick()
    expect(navigationPaths(wrapper)).toContain('/available-channels')
    expect(navigationPaths(wrapper)).toContain('/batch-image')
  })

  it('retains simple-mode admin keys and removes the hidden personal workspace', async () => {
    authStore.isSimpleMode = true
    const wrapper = await renderSidebar('/keys')
    expect(wrapper.find('.dock-space-switch').exists()).toBe(false)
    const paths = navigationPaths(wrapper)
    expect(paths).toContain('/keys')
    expect(paths).toContain('/admin/accounts')
    expect(paths).toContain('/admin/settings')
    for (const path of ['/admin/users', '/admin/groups', '/admin/subscriptions', '/admin/redeem', '/profile']) {
      expect(paths).not.toContain(path)
    }
  })

  it('preserves simple and backend-only modes for regular users', async () => {
    authStore.isAdmin = false
    authStore.isSimpleMode = true
    const wrapper = await renderSidebar('/keys')
    expect(navigationPaths(wrapper)).toEqual(['/dashboard', '/keys', '/model-plaza?embedded=1', '/monitor', '/profile'].sort())
    appStore.backendModeEnabled = true
    await nextTick()
    expect(navigationPaths(wrapper)).toEqual([])
    authStore.isAdmin = true
    await nextTick()
    expect(navigationPaths(wrapper)).toContain('/admin/settings')
  })

  it('follows direct navigation and asynchronously loaded custom routes without resetting manual choices', async () => {
    const wrapper = await renderSidebar('/custom/guide')
    expect(wrapper.get('button[aria-label="管理空间"]').attributes('aria-pressed')).toBe('true')
    appStore.cachedPublicSettings.custom_menu_items = [customMenu('guide', 'user')]
    await nextTick()
    expect(wrapper.get('button[aria-label="个人空间"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.get('a[href="/custom/guide"]').attributes('aria-current')).toBe('page')
    await wrapper.get('button[aria-label="管理空间"]').trigger('click')
    adminStore.opsMonitoringEnabled = false
    await nextTick()
    expect(wrapper.get('button[aria-label="管理空间"]').attributes('aria-pressed')).toBe('true')
    await router.push('/keys')
    await flushPromises()
    expect(wrapper.get('button[aria-label="个人空间"]').attributes('aria-pressed')).toBe('true')
    await router.push('/admin/risk-control')
    await flushPromises()
    expect(wrapper.get('button[aria-label="管理空间"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.get('a[href="/admin/risk-control"]').attributes('aria-current')).toBe('page')
  })

  it.each([false, true])('exposes Model Plaza in the personal workspace with its existing embedded URL and opt-in flag (admin=%s)', async (admin) => {
    authStore.isAdmin = admin
    const wrapper = await renderSidebar('/keys')
    const plaza = wrapper.get('a[href="/model-plaza?embedded=1"]')
    expect(plaza.text()).toBe('nav.modelPlaza')
    const workLinks = wrapper.get('section[aria-label="工作空间"]').findAll('a')
    expect(workLinks[0].attributes('href')).toBe('/model-plaza?embedded=1')
    await plaza.trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/model-plaza')
    expect(router.currentRoute.value.query).toEqual({ embedded: '1' })
    if (admin) expect(wrapper.get('button[aria-label="个人空间"]').attributes('aria-pressed')).toBe('true')
    appStore.cachedPublicSettings.model_plaza_require_auth = false
    await nextTick()
    expect(wrapper.find('a[href="/model-plaza?embedded=1"]').exists()).toBe(true)
    appStore.cachedPublicSettings.model_plaza_enabled = false
    await nextTick()
    if (admin) await wrapper.get('button[aria-label="个人空间"]').trigger('click')
    expect(wrapper.find('a[href="/model-plaza?embedded=1"]').exists()).toBe(false)
    appStore.cachedPublicSettings.model_plaza_enabled = undefined
    await nextTick()
    expect(wrapper.find('a[href="/model-plaza?embedded=1"]').exists()).toBe(false)
    appStore.cachedPublicSettings.model_plaza_enabled = true
    await nextTick()
    expect(wrapper.find('a[href="/model-plaza?embedded=1"]').exists()).toBe(true)
  })

  it('adds Creative canvas without replacing Batch Image and applies the same image access permission', async () => {
    const wrapper = await renderSidebar('/image-studio')
    expect(wrapper.get('button[aria-label="个人空间"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.get('a[href="/image-studio"]').text()).toBe('创作画布')
    expect(wrapper.get('a[href="/image-studio"]').attributes('aria-current')).toBe('page')
    expect(wrapper.get('a[href="/batch-image"]').text()).toBe('nav.batchImage')
    locale.value = 'en'
    await nextTick()
    expect(wrapper.get('a[href="/image-studio"]').text()).toBe('Creative canvas')
    batchAccess.value = false
    await nextTick()
    await wrapper.get('button[aria-label="Personal"]').trigger('click')
    expect(wrapper.find('a[href="/image-studio"]').exists()).toBe(false)
    expect(wrapper.find('a[href="/batch-image"]').exists()).toBe(false)
    batchAccess.value = true
    await nextTick()
    expect(wrapper.find('a[href="/image-studio"]').exists()).toBe(true)
    expect(wrapper.find('a[href="/batch-image"]').exists()).toBe(true)
    authStore.isAdmin = false
    authStore.isSimpleMode = true
    await nextTick()
    expect(wrapper.find('a[href="/image-studio"]').exists()).toBe(false)
    expect(wrapper.find('a[href="/batch-image"]').exists()).toBe(false)
  })

  it('keeps expand-only groups on the current route and permits collapsing an active group', async () => {
    const wrapper = await renderSidebar('/admin/channels/pricing')
    const group = wrapper.findAll('.dock-nav-group').find(button => button.text().includes('nav.channelManagement'))!
    expect(group.attributes('aria-expanded')).toBe('true')
    await group.trigger('click')
    expect(group.attributes('aria-expanded')).toBe('false')
    expect(wrapper.find('a[href="/admin/channels/pricing"]').exists()).toBe(false)
    expect(router.currentRoute.value.path).toBe('/admin/channels/pricing')
    await group.trigger('click')
    await wrapper.get('a[href="/admin/channels/monitor"]').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/admin/channels/monitor')
  })

  it('gives collapsed links accessible names and unfolds groups to expose their children', async () => {
    appStore.sidebarCollapsed = true
    const wrapper = await renderSidebar()
    expect(wrapper.get('aside').classes()).toContain('dock-is-collapsed')
    const userLink = wrapper.get('nav a[href="/admin/users"]')
    expect(userLink.attributes('title')).toBe('nav.users')
    expect(userLink.attributes('aria-label')).toBe('nav.users')
    expect(userLink.find('.sidebar-label').exists()).toBe(false)
    const group = wrapper.get('button[aria-label="nav.channelManagement"]')
    expect(group.attributes('type')).toBe('button')
    await group.trigger('click')
    expect(appStore.setSidebarCollapsed).toHaveBeenCalledWith(false)
    expect(wrapper.find('a[href="/admin/channels/pricing"]').exists()).toBe(true)
    expect(router.currentRoute.value.path).toBe('/admin/dashboard')
  })

  it('shows full mobile labels despite desktop collapse and makes the closed drawer inert', async () => {
    appStore.sidebarCollapsed = true
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
    const wrapper = await renderSidebar()
    expect(wrapper.get('aside').classes()).not.toContain('dock-is-collapsed')
    expect(wrapper.get('aside').attributes('inert')).toBeDefined()
    expect(wrapper.get('aside').attributes('aria-hidden')).toBe('true')
    appStore.mobileOpen = true
    await nextTick()
    expect(wrapper.get('aside').attributes('inert')).toBeUndefined()
    expect(wrapper.get('aside').attributes('aria-hidden')).toBeUndefined()
    expect(wrapper.get('nav a[href="/admin/users"] .sidebar-label').text()).toBe('nav.users')
    await wrapper.get('.dock-mobile-close').trigger('click')
    expect(appStore.mobileOpen).toBe(false)
    expect(appStore.sidebarCollapsed).toBe(true)
  })

  it('keeps cross-workspace onboarding targets mounted and preserves advancing the tour', async () => {
    const wrapper = await renderSidebar()
    tourDriver.value = {}
    await nextTick()
    expect(wrapper.find('.dock-space-switch').exists()).toBe(false)
    for (const selector of ['#sidebar-channel-manage', '#sidebar-group-manage', '#sidebar-wallet', '[data-tour="sidebar-my-keys"]']) {
      expect(wrapper.find(selector).exists()).toBe(true)
    }
    currentStep.mockReturnValue(true)
    await wrapper.get('[data-tour="sidebar-my-keys"]').trigger('click')
    await flushPromises()
    expect(currentStep).toHaveBeenCalledWith('[data-tour="sidebar-my-keys"]')
    expect(nextStep).toHaveBeenCalledWith(500)
    tourDriver.value = null
    await nextTick()
    expect(wrapper.get('button[aria-label="个人空间"]').attributes('aria-pressed')).toBe('true')
  })

  it('focuses the mobile close control and restores its opener when Escape closes the drawer', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
    const host = document.createElement('div')
    const opener = document.createElement('button')
    opener.textContent = 'Open navigation'
    host.append(opener)
    document.body.append(host)
    attachedHosts.push(host)
    const wrapper = await renderSidebar('/admin/dashboard', host)
    opener.focus()
    appStore.mobileOpen = true
    await flushPromises()
    expect(document.activeElement).toBe(wrapper.get('.dock-mobile-close').element)
    const escape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    window.dispatchEvent(escape)
    await flushPromises()
    expect(escape.defaultPrevented).toBe(true)
    expect(appStore.mobileOpen).toBe(false)
    expect(document.activeElement).toBe(opener)
  })

  it('leaves onboarding Escape and desktop keyboard events to their existing handlers', async () => {
    const wrapper = await renderSidebar()
    appStore.mobileOpen = true
    await nextTick()
    const desktopEscape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    window.dispatchEvent(desktopEscape)
    expect(desktopEscape.defaultPrevented).toBe(false)
    expect(appStore.mobileOpen).toBe(true)
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
    window.dispatchEvent(new Event('resize'))
    tourDriver.value = {}
    await nextTick()
    const tourEscape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    window.dispatchEvent(tourEscape)
    expect(tourEscape.defaultPrevented).toBe(false)
    expect(appStore.mobileOpen).toBe(true)
    tourDriver.value = null
    await wrapper.get('.dock-mobile-close').trigger('click')
    expect(appStore.mobileOpen).toBe(false)
  })

  it('retains per-space scrolling and the original component remount scroll memory', async () => {
    appStore.sidebarScrollTop = 77
    const wrapper = await renderSidebar()
    const nav = wrapper.get('nav').element
    expect(nav.scrollTop).toBe(77)
    await wrapper.get('button[aria-label="个人空间"]').trigger('click')
    expect(nav.scrollTop).toBe(0)
    nav.scrollTop = 22
    await wrapper.get('button[aria-label="管理空间"]').trigger('click')
    expect(nav.scrollTop).toBe(77)
    await wrapper.get('button[aria-label="个人空间"]').trigger('click')
    expect(nav.scrollTop).toBe(22)
    wrapper.unmount()
    wrappers.splice(wrappers.indexOf(wrapper), 1)
    expect(appStore.sidebarScrollTop).toBe(22)
  })

  it('preserves custom branding, bilingual controls, theme switching and desktop collapse', async () => {
    locale.value = 'en'
    const wrapper = await renderSidebar()
    expect(wrapper.get('.dock-brand-name').text()).toBe('My Brand')
    expect(wrapper.get('.dock-brand-mark img').attributes('src')).toBe('/custom-logo.svg')
    expect(wrapper.get('.dock-brand-mark').attributes('href')).toBe('/admin/dashboard')
    expect(wrapper.get('button[aria-label="Admin"]').exists()).toBe(true)
    expect(wrapper.get('button[aria-label="Personal"]').exists()).toBe(true)
    await wrapper.get('.dock-theme-button').trigger('click')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(localStorage.getItem('theme')).toBe('dark')
    await wrapper.get('.dock-collapse-button').trigger('click')
    expect(appStore.toggleSidebar).toHaveBeenCalledOnce()
    expect(wrapper.get('aside').classes()).toContain('dock-is-collapsed')
  })
})
