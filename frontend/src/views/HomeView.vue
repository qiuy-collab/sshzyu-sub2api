<template>
  <!-- Administrator-provided content takes precedence over both built-in home modes. -->
  <div v-if="hasHomeContent" class="min-h-screen">
    <iframe v-if="isHomeContentUrl" :src="homeContent.trim()" :title="siteName" class="h-screen w-full border-0" allowfullscreen></iframe>
    <!-- SECURITY: homeContent is an administrator-only setting. -->
    <div v-else v-html="homeContent"></div>
  </div>

  <div v-else :data-testid="compactHomeEnabled ? 'compact-home' : undefined" class="brand-home" :class="{ 'compact-home': compactHomeEnabled }">
    <header class="home-header">
      <nav class="home-nav" :aria-label="copy.navigation">
        <div class="home-brand">
          <img :src="siteLogo || BRAND_LOGO" alt="" class="home-brand-mark" />
          <span>{{ siteName }}</span>
        </div>
        <div class="home-nav-actions">
          <a v-if="!compactHomeEnabled" href="#home-title" class="home-nav-link home-current-link">{{ copy.home }}</a>
          <LocaleSwitcher />
          <a v-if="docUrl" :href="docUrl" target="_blank" rel="noopener noreferrer" class="home-nav-link" :title="t('home.viewDocs')" :aria-label="t('home.viewDocs')">
            <Icon name="book" size="md" class="sm:hidden" /><span class="hidden sm:inline">{{ t('home.docs') }}</span>
          </a>
          <router-link v-if="showModelPlazaEntry" to="/model-plaza" class="home-nav-link" :title="t('nav.modelPlaza')">
            <Icon name="grid" size="md" class="sm:hidden" /><span class="hidden sm:inline">{{ t('nav.modelPlaza') }}</span>
          </router-link>
          <button type="button" class="home-icon-link" :title="isDark ? t('home.switchToLight') : t('home.switchToDark')" :aria-label="isDark ? t('home.switchToLight') : t('home.switchToDark')" @click="toggleTheme">
            <Icon v-if="isDark" name="sun" size="md" /><Icon v-else name="moon" size="md" />
          </button>
          <router-link :to="isAuthenticated ? dashboardPath : '/login'" class="home-nav-console">
            <span v-if="isAuthenticated && userInitial" class="home-user-initial">{{ userInitial }}</span>
            {{ isAuthenticated ? t('home.dashboard') : t('home.login') }}<Icon name="arrowRight" size="sm" />
          </router-link>
        </div>
      </nav>
    </header>

    <main v-if="compactHomeEnabled" class="compact-main">
      <div class="compact-content">
        <img :src="siteLogo || BRAND_LOGO" alt="" class="compact-mark" />
        <h1>{{ siteName }}</h1><p>{{ siteSubtitle }}</p>
        <router-link :to="isAuthenticated ? dashboardPath : '/login'" class="home-primary-action">{{ isAuthenticated ? t('home.goToDashboard') : t('home.login') }}<Icon name="arrowRight" size="md" /></router-link>
      </div>
    </main>

    <main v-else>
      <section class="home-hero" aria-labelledby="home-title">
        <div class="hero-intro">
          <div class="hero-emblem" aria-hidden="true">
            <svg v-if="!siteLogo" viewBox="0 0 380 264" fill="none">
              <circle class="emblem-orbit" cx="190" cy="132" r="118" />
              <path class="emblem-orbit" d="M310 55a143 143 0 0 1 0 154M70 209a143 143 0 0 1 0-154" />
              <path class="emblem-secondary" d="M240 71h-71a40 40 0 0 0 0 80h37a19 19 0 0 1 0 38h-69" />
              <path class="emblem-primary" d="M137 189h69a40 40 0 0 0 0-80h-37a19 19 0 0 1 0-38h71" />
              <circle class="emblem-node" cx="246" cy="71" r="5.5" />
              <path class="emblem-tick" d="M190 7v8M190 249v8M65 132h8M307 132h8" />
            </svg>
            <img v-else :src="siteLogo" alt="" class="hero-custom-logo" />
          </div>
          <p class="hero-welcome">{{ copy.welcome }}</p>
          <h1 id="home-title">{{ siteName }}</h1>
          <p class="hero-subtitle">{{ siteSubtitle }}</p>
          <p class="hero-description">{{ copy.description }}</p>
          <div class="hero-actions">
            <router-link :to="isAuthenticated ? dashboardPath : '/login'" class="home-primary-action">{{ isAuthenticated ? t('home.goToDashboard') : t('home.getStarted') }}<Icon name="arrowRight" size="md" /></router-link>
            <a v-if="docUrl" :href="docUrl" target="_blank" rel="noopener noreferrer" class="home-text-action">{{ t('home.viewDocs') }}<Icon name="arrowRight" size="sm" /></a>
          </div>
        </div>
        <a class="hero-explore" href="#connections">{{ copy.explore }}<Icon name="arrowDown" size="sm" /></a>
        <nav class="hero-section-nav" :aria-label="copy.sections">
          <a href="#home-title" class="is-current" :aria-label="copy.home" :title="copy.home"></a>
          <a href="#connections" :aria-label="t('home.features.unifiedGateway')" :title="t('home.features.unifiedGateway')"></a>
          <a href="#workspace" :aria-label="copy.workspaceLabel" :title="copy.workspaceLabel"></a>
        </nav>
      </section>

      <section class="provider-band" :aria-label="t('home.providers.title')">
        <div class="section-inner provider-list">
          <div v-for="provider in providers" :key="provider" class="provider-item">
            <span>{{ provider }}</span><span class="provider-supported"><Icon name="check" size="sm" />{{ t('home.providers.supported') }}</span>
          </div>
        </div>
      </section>

      <section id="connections" class="home-connections section-inner" aria-labelledby="connections-title">
        <div class="section-heading">
          <p class="home-eyebrow"><span>01</span>{{ copy.connectionLabel }}</p>
          <h2 id="connections-title">{{ t('home.features.unifiedGateway') }}</h2><p>{{ t('home.features.unifiedGatewayDesc') }}</p>
        </div>
        <!-- Conceptual connection diagram, not simulated traffic or service metrics. -->
        <div class="connection-visual terminal-container" role="img" :aria-label="copy.diagramDescription">
          <svg class="connection-lines" viewBox="0 0 560 248" fill="none" aria-hidden="true">
            <path class="connection-track" d="M102 124H246M314 124H363Q384 124 384 104V40Q384 22 404 22H441M384 80H441M384 168H441M363 124Q384 124 384 144V208Q384 226 404 226H441" />
            <path class="connection-active" d="M102 124H246M314 124H363Q384 124 384 104V40Q384 22 404 22H441" /><circle cx="175" cy="124" r="3" class="connection-dot" />
          </svg>
          <div class="connection-origin"><span aria-hidden="true">&lt;/&gt;</span><small>{{ copy.yourApplication }}</small></div>
          <div class="connection-hub"><img :src="siteLogo || BRAND_LOGO" alt="" /></div>
          <div class="connection-destinations" aria-hidden="true"><span>Claude</span><span>GPT</span><span>Gemini</span><span>Antigravity</span></div>
          <span class="connection-caption">{{ copy.oneConnection }}</span>
        </div>
      </section>

      <section id="workspace" class="home-workspace">
        <div class="section-inner workspace-inner">
          <div class="section-heading"><p class="home-eyebrow"><span>02</span>{{ copy.workspaceLabel }}</p><h2>{{ copy.workspaceTitle }}</h2><p>{{ copy.workspaceDescription }}</p></div>
          <div class="capability-list">
            <article class="capability-row"><Icon name="users" size="lg" class="capability-icon" /><div><h3>{{ t('home.features.multiAccount') }}</h3><p>{{ t('home.features.multiAccountDesc') }}</p></div></article>
            <article class="capability-row"><Icon name="chart" size="lg" class="capability-icon" /><div><h3>{{ t('home.features.balanceQuota') }}</h3><p>{{ t('home.features.balanceQuotaDesc') }}</p></div></article>
            <div class="workspace-details">
              <span><Icon name="swap" size="sm" />{{ t('home.tags.subscriptionToApi') }}</span><span><Icon name="shield" size="sm" />{{ t('home.tags.stickySession') }}</span><span><Icon name="chart" size="sm" />{{ t('home.tags.realtimeBilling') }}</span>
            </div>
          </div>
        </div>
      </section>

      <section class="home-closing section-inner">
        <p class="home-eyebrow">{{ siteName }}</p><h2>{{ copy.closingTitle }}</h2>
        <router-link :to="isAuthenticated ? dashboardPath : '/login'" class="home-primary-action">{{ isAuthenticated ? t('home.goToDashboard') : t('home.getStarted') }}<Icon name="arrowRight" size="md" /></router-link>
        <p class="providers-more">{{ t('home.providers.description') }}<br />{{ t('home.providers.more') }} · {{ t('home.providers.soon') }}</p>
      </section>
    </main>

    <footer v-if="compactHomeEnabled" class="compact-footer">&copy; {{ currentYear }} {{ siteName }}</footer>
    <footer v-else class="home-footer">
      <div class="section-inner footer-inner"><p>&copy; {{ currentYear }} {{ siteName }}. {{ t('home.footer.allRightsReserved') }}</p><div><a v-if="docUrl" :href="docUrl" target="_blank" rel="noopener noreferrer">{{ t('home.docs') }}</a><a :href="githubUrl" target="_blank" rel="noopener noreferrer">GitHub</a></div></div>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore, useAppStore } from '@/stores'
import LocaleSwitcher from '@/components/common/LocaleSwitcher.vue'
import Icon from '@/components/icons/Icon.vue'
import { sanitizeUrl } from '@/utils/url'
import { FeatureFlags, isFeatureFlagEnabled } from '@/utils/featureFlags'
import { BRAND_LOGO, resolveBrandName, resolveBrandSubtitle } from '@/utils/brandIdentity'

const { t, locale } = useI18n()
const authStore = useAuthStore()
const appStore = useAppStore()
const siteName = computed(() => resolveBrandName(appStore.cachedPublicSettings?.site_name || appStore.siteName))
const siteLogo = computed(() => sanitizeUrl(appStore.cachedPublicSettings?.site_logo || appStore.siteLogo || '', { allowRelative: true, allowDataUrl: true }))
const siteSubtitle = computed(() => resolveBrandSubtitle(appStore.cachedPublicSettings?.site_subtitle))
const docUrl = computed(() => sanitizeUrl(appStore.cachedPublicSettings?.doc_url || appStore.docUrl || ''))
const homeContent = computed(() => appStore.cachedPublicSettings?.home_content || '')
const hasHomeContent = computed(() => homeContent.value.trim().length > 0)
const compactHomeEnabled = computed(() => appStore.cachedPublicSettings?.compact_home_enabled === true)
const modelPlazaEnabled = computed(() => isFeatureFlagEnabled(FeatureFlags.modelPlaza))
const isHomeContentUrl = computed(() => {
  const content = homeContent.value.trim()
  return content.startsWith('http://') || content.startsWith('https://')
})
const copy = computed(() => (locale?.value || 'zh').startsWith('zh') ? {
  navigation: '主导航', sections: '页面章节', home: '首页', welcome: '欢迎使用',
  description: '连接所需的模型，专注想做的事。', explore: '向下探索', connectionLabel: '统一接入',
  yourApplication: '你的应用', oneConnection: '一个 API 入口',
  diagramDescription: '你的应用通过统一 API 入口连接 Claude、GPT、Gemini 和 Antigravity。',
  workspaceLabel: '日常工作台', workspaceTitle: '连接有序，管理自如。',
  workspaceDescription: '从模型接入到用量查看，让日常操作清晰、直接。', closingTitle: '开始你的下一次连接。',
} : {
  navigation: 'Main navigation', sections: 'Page sections', home: 'Home', welcome: 'WELCOME TO',
  description: 'Connect to the models you need. Focus on what you create.', explore: 'Explore', connectionLabel: 'ONE CONNECTION',
  yourApplication: 'Your application', oneConnection: 'One API gateway',
  diagramDescription: 'Your application connects to Claude, GPT, Gemini and Antigravity through one API gateway.',
  workspaceLabel: 'YOUR WORKSPACE', workspaceTitle: 'Connected. Under control.',
  workspaceDescription: 'Connect models, manage access, and understand your usage in one place.', closingTitle: 'Your next connection starts here.',
})
const providers = computed(() => [t('home.providers.claude'), 'GPT', t('home.providers.gemini'), t('home.providers.antigravity')])
const isDark = ref(document.documentElement.classList.contains('dark'))
const githubUrl = 'https://github.com/Wei-Shaw/sub2api'
const isAuthenticated = computed(() => authStore.isAuthenticated)
const modelPlazaRequiresAuth = computed(() => appStore.cachedPublicSettings?.model_plaza_require_auth === true)
const showModelPlazaEntry = computed(() => modelPlazaEnabled.value && (isAuthenticated.value || !modelPlazaRequiresAuth.value))
const isAdmin = computed(() => authStore.isAdmin)
const dashboardPath = computed(() => isAdmin.value ? '/admin/dashboard' : '/dashboard')
const userInitial = computed(() => {
  const user = authStore.user
  if (!user || !user.email) return ''
  return user.email.charAt(0).toUpperCase()
})
const currentYear = computed(() => new Date().getFullYear())
function toggleTheme() {
  isDark.value = !isDark.value
  document.documentElement.classList.toggle('dark', isDark.value)
  localStorage.setItem('theme', isDark.value ? 'dark' : 'light')
}
function initTheme() {
  const savedTheme = localStorage.getItem('theme')
  if (savedTheme === 'dark' || (!savedTheme && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    isDark.value = true
    document.documentElement.classList.add('dark')
  }
}
onMounted(() => {
  initTheme()
  authStore.checkAuth()
  if (!appStore.publicSettingsLoaded) appStore.fetchPublicSettings()
})
</script>

<style scoped>
.brand-home { --home-canvas: #fafaf8; --home-soft: #f3f3f1; --home-ink: #1d1d1f; --home-muted: #72726e; --home-line: #e3e3df; --home-grid: rgb(70 70 60 / 3%); --home-accent: #0071e3; min-height: 100vh; overflow: clip; background: var(--home-canvas); color: var(--home-ink); font-family: 'PingFang SC', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif; -webkit-font-smoothing: antialiased; }
:global(.dark .brand-home) { --home-canvas: #18181a; --home-soft: #1e1e20; --home-ink: #f5f5f7; --home-muted: #a1a1a6; --home-line: #343437; --home-grid: rgb(220 220 210 / 3%); --home-accent: #2997ff; }
.home-header { position: relative; z-index: 20; border-bottom: 1px solid var(--home-line); }
.home-nav { max-width: 1400px; min-height: 68px; margin: 0 auto; padding: 10px 40px; display: flex; align-items: center; justify-content: space-between; gap: 24px; }
.home-brand { min-width: 0; display: flex; align-items: center; gap: 10px; font-size: 18px; font-weight: 600; letter-spacing: -.5px; }
.home-brand > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.home-brand-mark { width: 30px; height: 30px; object-fit: contain; flex: none; border-radius: 9px; }
.home-nav-actions { display: flex; flex: none; align-items: center; gap: 7px; }
.home-nav-link, .home-icon-link { display: inline-flex; align-items: center; justify-content: center; min-height: 40px; padding: 0 10px; gap: 6px; border-radius: 10px; font-size: 12px; font-weight: 500; color: var(--home-muted); transition: color 160ms, background 160ms; }
.home-icon-link { width: 38px; padding: 0; }
.home-nav-link:hover, .home-icon-link:hover { color: var(--home-ink); background: var(--home-soft); }
.home-current-link { color: var(--home-ink); }
.home-nav-console { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 36px; margin-left: 5px; padding: 8px 14px; border-radius: 11px; background: var(--home-ink); color: var(--home-canvas); font-size: 12px; font-weight: 500; transition: opacity 160ms; }
.home-nav-console:hover { opacity: .82; }
.home-user-initial { display: flex; width: 18px; height: 18px; align-items: center; justify-content: center; border: 1px solid currentColor; border-radius: 50%; font-size: 10px; }
.home-hero { position: relative; width: 100%; min-height: min(830px, calc(100svh - 68px)); display: flex; align-items: center; justify-content: center; padding: 35px 0 98px; text-align: center; background-image: linear-gradient(var(--home-grid) 1px, transparent 1px), linear-gradient(90deg, var(--home-grid) 1px, transparent 1px); background-size: 28px 28px; }
.hero-intro { width: min(900px, 100%); margin: 0 auto; padding: 0 24px; animation: home-enter 600ms both; }
.hero-emblem { width: clamp(235px, 28vw, 340px); height: clamp(165px, 19.5vw, 236px); margin: 0 auto 21px; display: flex; align-items: center; justify-content: center; }
.hero-emblem svg { width: 100%; height: 100%; overflow: visible; }
.hero-custom-logo { width: 130px; height: 130px; object-fit: contain; }
.emblem-orbit, .emblem-tick { stroke: var(--home-line); stroke-width: 1; }
.emblem-primary { stroke: var(--home-ink); stroke-width: 7; stroke-linecap: round; stroke-dasharray: 470; animation: emblem-draw 1000ms 100ms both; }
.emblem-secondary { stroke: var(--home-ink); stroke-opacity: .28; stroke-width: 2; stroke-linecap: round; }
.emblem-node { fill: var(--home-accent); }
.hero-welcome { margin: 0 0 11px; color: var(--home-accent); font-size: 11px; font-weight: 500; letter-spacing: .13em; }
.home-hero h1 { margin: 0; font-family: 'Iowan Old Style', 'Palatino Linotype', 'Book Antiqua', Georgia, 'PingFang SC', serif; font-size: clamp(57px, 6.4vw, 84px); line-height: 1.07; font-weight: 500; letter-spacing: -.045em; overflow-wrap: anywhere; }
.hero-subtitle { margin: 20px auto 0; max-width: 650px; font-size: clamp(18px, 2.1vw, 22px); line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
.hero-description { margin: 11px auto 0; color: var(--home-muted); font-size: 13px; line-height: 1.8; }
.hero-actions { margin-top: 28px; display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 24px; }
.home-primary-action { display: inline-flex; justify-content: center; align-items: center; gap: 12px; min-height: 46px; padding: 12px 20px; border-radius: 13px; background: #0071e3; color: #fff; font-size: 13px; font-weight: 500; line-height: 1.45; transition: background 160ms, transform 160ms; }
.home-primary-action:hover { background: #0062c6; }
.home-primary-action:active { transform: scale(.985); }
.home-primary-action :deep(svg), .home-text-action :deep(svg), .hero-explore :deep(svg) { transition: transform 180ms; }
.home-primary-action:hover :deep(svg), .home-text-action:hover :deep(svg) { transform: translateX(3px); }
.home-text-action { min-height: 44px; display: inline-flex; align-items: center; justify-content: center; gap: 8px; color: var(--home-accent); font-size: 13px; font-weight: 500; }
.hero-explore { position: absolute; bottom: 27px; left: 50%; transform: translateX(-50%); display: inline-flex; align-items: center; flex-direction: column; gap: 10px; padding: 8px 12px; color: var(--home-muted); font-size: 10px; letter-spacing: .08em; }
.hero-explore:hover :deep(svg) { transform: translateY(3px); }
.hero-section-nav { position: absolute; right: 33px; top: 50%; display: flex; flex-direction: column; gap: 8px; }
.hero-section-nav a { position: relative; display: block; width: 24px; height: 24px; }
.hero-section-nav a::after { content: ''; position: absolute; inset: 9px; border-radius: 50%; background: var(--home-line); transition: background 160ms; }
.hero-section-nav .is-current::after, .hero-section-nav a:hover::after { background: var(--home-accent); }
.section-inner { width: min(1152px, 100%); margin: 0 auto; padding-left: 32px; padding-right: 32px; }
.provider-band { padding: 28px 0; border-top: 1px solid var(--home-line); border-bottom: 1px solid var(--home-line); }
.provider-list { display: grid; grid-template-columns: repeat(4, 1fr); }
.provider-item { display: flex; flex-direction: column; align-items: center; gap: 9px; border-right: 1px solid var(--home-line); }
.provider-item:last-child { border: 0; }
.provider-item > span:first-child { font-size: 23px; line-height: 1.3; font-weight: 500; letter-spacing: -.7px; }
.provider-supported { display: inline-flex; align-items: center; gap: 5px; color: var(--home-muted); font-size: 10px; }
.home-connections { display: grid; grid-template-columns: .85fr 1.15fr; gap: 70px; align-items: center; padding-top: 92px; padding-bottom: 92px; scroll-margin-top: 36px; }
.home-eyebrow { display: flex; align-items: center; gap: 12px; margin: 0 0 22px; color: var(--home-muted); font-size: 11px; font-weight: 500; letter-spacing: .04em; }
.home-eyebrow > span { color: var(--home-accent); font-variant-numeric: tabular-nums; }
.section-heading h2 { margin: 0; font-size: clamp(27px, 3vw, 37px); font-weight: 500; line-height: 1.3; letter-spacing: -.05em; }
.section-heading > p:last-child { margin-top: 21px; max-width: 350px; color: var(--home-muted); font-size: 14px; line-height: 1.9; }
.connection-visual { position: relative; width: 100%; aspect-ratio: 560 / 248; }
.connection-lines { position: absolute; inset: 0; width: 100%; height: 100%; }
.connection-track { stroke: var(--home-line); stroke-width: 1.5; }
.connection-active { stroke: var(--home-accent); stroke-width: 1.5; }
.connection-dot { fill: var(--home-accent); }
.connection-origin { position: absolute; left: 8%; top: 50%; transform: translate(-50%, -50%); display: flex; flex-direction: column; gap: 10px; align-items: center; color: var(--home-muted); white-space: nowrap; }
.connection-origin > span { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; color: var(--home-ink); font-size: 27px; letter-spacing: -3px; line-height: 1; }
.connection-origin small { font-size: 10px; }
.connection-hub { position: absolute; left: 50%; top: 50%; display: flex; width: 68px; height: 68px; padding: 16px; align-items: center; justify-content: center; transform: translate(-50%, -50%); background: var(--home-soft); border: 1px solid var(--home-line); border-radius: 20px; }
.connection-hub img { width: 100%; height: 100%; object-fit: contain; border-radius: 9px; }
.connection-destinations { position: absolute; top: 4%; bottom: 4%; left: 81%; display: flex; flex-direction: column; justify-content: space-between; font-size: 15px; font-weight: 500; letter-spacing: -.3px; line-height: 22px; }
.connection-caption { position: absolute; top: calc(50% + 48px); left: 50%; transform: translateX(-50%); font-size: 10px; white-space: nowrap; color: var(--home-muted); }
.home-workspace { background: var(--home-soft); border-top: 1px solid var(--home-line); border-bottom: 1px solid var(--home-line); padding: 78px 0; scroll-margin-top: 36px; }
.workspace-inner { display: grid; grid-template-columns: .85fr 1.15fr; gap: 70px; }
.capability-row { display: flex; align-items: flex-start; gap: 23px; padding: 27px 0; border-bottom: 1px solid var(--home-line); }
.capability-row:first-child { padding-top: 0; }
.capability-row h3 { margin: 0; font-size: 17px; line-height: 1.5; font-weight: 500; letter-spacing: -.35px; }
.capability-row p { margin: 9px 0 0; color: var(--home-muted); font-size: 13px; line-height: 1.8; }
.capability-icon { flex: none; margin-top: 2px; color: var(--home-muted); }
.workspace-details { display: flex; flex-wrap: wrap; gap: 14px 24px; padding-top: 23px; }
.workspace-details > span { display: inline-flex; align-items: center; gap: 6px; color: var(--home-muted); font-size: 10px; }
.home-closing { padding-top: 75px; padding-bottom: 65px; text-align: center; }
.home-closing .home-eyebrow { justify-content: center; margin-bottom: 16px; }
.home-closing h2 { margin: 0 0 29px; font-size: clamp(25px, 3vw, 36px); font-weight: 500; letter-spacing: -.8px; line-height: 1.4; }
.providers-more { margin: 28px auto 0; color: var(--home-muted); font-size: 10px; line-height: 1.9; }
.home-footer { border-top: 1px solid var(--home-line); }
.footer-inner { display: flex; justify-content: space-between; align-items: center; gap: 20px; min-height: 86px; color: var(--home-muted); font-size: 10px; }
.footer-inner > div { display: flex; gap: 24px; }
.home-footer a { display: inline-block; padding: 12px 0; transition: color 160ms; }
.home-footer a:hover { color: var(--home-ink); }
.compact-home { display: flex; flex-direction: column; background: var(--home-soft); }
.compact-main { display: flex; flex: 1; align-items: center; justify-content: center; padding: 64px 24px; }
.compact-content { width: min(100%, 640px); text-align: center; animation: home-enter 500ms both; }
.compact-mark { width: 72px; height: 72px; margin: 0 auto 28px; object-fit: contain; border-radius: 20px; }
.compact-content h1 { font-size: clamp(38px, 7vw, 64px); font-weight: 600; letter-spacing: -.04em; line-height: 1.15; overflow-wrap: anywhere; }
.compact-content p { margin: 22px auto 32px; font-size: 17px; color: var(--home-muted); line-height: 1.8; white-space: pre-wrap; overflow-wrap: anywhere; }
.compact-footer { padding: 24px; border-top: 1px solid var(--home-line); text-align: center; font-size: 12px; color: var(--home-muted); overflow-wrap: anywhere; }
.brand-home a:focus-visible, .brand-home button:focus-visible { outline: 3px solid var(--home-accent); outline-offset: 4px; }
@keyframes home-enter { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
@keyframes emblem-draw { from { stroke-dashoffset: 470; } to { stroke-dashoffset: 0; } }
@media (max-width: 1000px) {
  .home-nav { padding-left: 24px; padding-right: 24px; gap: 12px; }
  .home-brand { max-width: 220px; }
  .home-nav-actions { gap: 1px; }
  .home-nav-link { padding: 0 8px; }
  .home-connections, .workspace-inner { gap: 40px; }
  .connection-destinations { font-size: 13px; }
  .connection-hub { width: 60px; height: 60px; padding: 14px; border-radius: 18px; }
}
@media (max-width: 640px) {
  .home-nav { flex-wrap: wrap; padding: 10px 16px; gap: 6px 8px; min-height: 64px; }
  .home-brand { max-width: 100%; font-size: 15px; gap: 8px; flex: 1; }
  .home-brand-mark { width: 26px; height: 26px; border-radius: 8px; }
  .home-nav-actions { margin-left: auto; }
  .home-current-link { display: none; }
  .home-nav-link, .home-icon-link { width: 32px; padding: 0; }
  .home-nav-console { min-height: 34px; padding: 7px 10px; font-size: 11px; gap: 5px; }
  .home-user-initial, .home-nav-console > :deep(svg) { display: none; }
  .home-hero { min-height: calc(100svh - 64px); padding-top: 29px; padding-bottom: 91px; }
  .hero-emblem { width: 235px; height: 163px; margin-bottom: 24px; }
  .hero-welcome { font-size: 10px; }
  .home-hero h1 { font-size: clamp(49px, 13.5vw, 70px); }
  .hero-subtitle { font-size: 18px; margin-top: 17px; }
  .hero-description { font-size: 12px; max-width: 260px; margin-top: 11px; }
  .hero-actions { margin-top: 24px; gap: 18px; }
  .hero-section-nav { display: none; }
  .hero-explore { bottom: 19px; }
  .home-primary-action { min-height: 44px; padding: 12px 17px; font-size: 12px; border-radius: 12px; }
  .home-text-action { font-size: 12px; }
  .section-inner { padding-left: 24px; padding-right: 24px; }
  .provider-band { padding-top: 23px; padding-bottom: 23px; }
  .provider-list { grid-template-columns: repeat(2, 1fr); gap: 25px 0; }
  .provider-item:nth-child(2) { border-right: 0; }
  .provider-item > span:first-child { font-size: 23px; }
  .home-connections { grid-template-columns: 1fr; gap: 36px; padding-top: 48px; padding-bottom: 43px; }
  .home-eyebrow { margin-bottom: 16px; }
  .section-heading h2 { font-size: 29px; }
  .section-heading > p:last-child { max-width: 100%; margin-top: 16px; font-size: 13px; }
  .connection-visual { max-width: 480px; margin: 0 auto; }
  .connection-origin > span { font-size: 24px; }
  .connection-origin small { font-size: 9px; }
  .connection-hub { width: 55px; height: 55px; padding: 13px; border-radius: 17px; }
  .connection-destinations { font-size: 12px; }
  .connection-caption { font-size: 9px; top: calc(50% + 40px); }
  .home-workspace { padding-top: 46px; padding-bottom: 42px; }
  .workspace-inner { grid-template-columns: 1fr; gap: 32px; }
  .capability-row { gap: 17px; padding: 22px 0; }
  .capability-row h3 { font-size: 16px; }
  .capability-row p { font-size: 13px; }
  .capability-icon { width: 22px; height: 22px; }
  .workspace-details { gap: 13px 19px; }
  .home-closing { padding-top: 48px; padding-bottom: 43px; }
  .home-closing h2 { font-size: 25px; margin-bottom: 24px; }
  .footer-inner { min-height: 100px; flex-direction: column; justify-content: center; align-items: flex-start; gap: 5px; padding-top: 20px; padding-bottom: 20px; line-height: 1.6; }
  .compact-main { padding-top: 48px; padding-bottom: 48px; }
}
@media (max-height: 720px) and (min-width: 641px) {
  .home-hero { min-height: 650px; }
  .hero-emblem { width: 265px; height: 184px; margin-bottom: 16px; }
}
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
</style>
