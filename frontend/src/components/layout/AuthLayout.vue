<template>
  <div class="auth-shell">
    <header class="auth-header">
      <router-link to="/" class="auth-home-link" :aria-label="siteName">
        <img :src="siteLogo || BRAND_LOGO" alt="" />
        <span>{{ siteName }}</span>
      </router-link>
      <LocaleSwitcher />
    </header>
    <main class="auth-main">
      <div class="auth-content">
        <div class="auth-brand" :class="{ 'auth-brand-pending': !settingsLoaded }">
          <template v-if="settingsLoaded">
            <img :src="siteLogo || BRAND_LOGO" alt="" class="auth-brand-mark" />
            <h1>{{ siteName }}</h1>
            <p>{{ siteSubtitle }}</p>
          </template>
        </div>
        <div class="auth-form-surface"><slot /></div>
        <div class="auth-footer-links"><slot name="footer" /></div>
      </div>
    </main>
    <footer class="auth-copyright">&copy; {{ currentYear }} {{ siteName }}. {{ t('home.footer.allRightsReserved') }}</footer>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '@/stores'
import { sanitizeUrl } from '@/utils/url'
import LocaleSwitcher from '@/components/common/LocaleSwitcher.vue'
import { BRAND_LOGO, resolveBrandName, resolveBrandSubtitle } from '@/utils/brandIdentity'

const appStore = useAppStore()
const { t } = useI18n()

const siteName = computed(() => resolveBrandName(appStore.siteName))
const siteLogo = computed(() => sanitizeUrl(appStore.siteLogo || '', { allowRelative: true, allowDataUrl: true }))
const siteSubtitle = computed(() => resolveBrandSubtitle(appStore.cachedPublicSettings?.site_subtitle))
const settingsLoaded = computed(() => appStore.publicSettingsLoaded)

const currentYear = computed(() => new Date().getFullYear())

onMounted(() => {
  appStore.fetchPublicSettings()
})
</script>

<style scoped>
.auth-shell { --auth-ink: #1d1d1f; --auth-muted: #6e6e73; --auth-line: #e5e5e7; --auth-surface: #fff; --auth-canvas: #f5f5f7; display: flex; min-height: 100svh; flex-direction: column; background: var(--auth-canvas); color: var(--auth-ink); font-family: 'PingFang SC', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif; -webkit-font-smoothing: antialiased; }
:global(.dark .auth-shell) { --auth-ink: #f5f5f7; --auth-muted: #a1a1a6; --auth-line: #343437; --auth-surface: #232325; --auth-canvas: #18181a; }
.auth-header { display: flex; align-items: center; justify-content: space-between; min-height: 72px; padding: 16px 36px; }
.auth-home-link { display: inline-flex; align-items: center; gap: 9px; min-width: 0; color: var(--auth-ink); font-size: 15px; font-weight: 600; letter-spacing: -.35px; }
.auth-home-link img { width: 27px; height: 27px; object-fit: contain; border-radius: 8px; flex: none; }
.auth-home-link span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.auth-main { display: flex; flex: 1; align-items: center; justify-content: center; padding: 22px 24px 32px; }
.auth-content { width: min(100%, 440px); animation: auth-enter 450ms both; }
.auth-brand { margin-bottom: 26px; text-align: center; }
.auth-brand-pending { min-height: 144px; }
.auth-brand-mark { display: block; width: 52px; height: 52px; margin: 0 auto 17px; border-radius: 16px; object-fit: contain; }
.auth-brand h1 { margin: 0; font-size: 28px; font-weight: 600; line-height: 1.2; letter-spacing: -.8px; overflow-wrap: anywhere; }
.auth-brand p { margin: 10px auto 0; color: var(--auth-muted); font-size: 13px; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
.auth-form-surface { padding: 32px; background: var(--auth-surface); border: 1px solid var(--auth-line); border-radius: 24px; box-shadow: 0 5px 20px rgb(0 0 0 / 2%); }
.auth-form-surface :deep(h2) { color: var(--auth-ink); font-size: 22px; font-weight: 600; line-height: 1.35; letter-spacing: -.6px; }
.auth-form-surface :deep(.input) { min-height: 46px; border-radius: 12px; font-size: 14px; box-shadow: none; transition: border-color 160ms, box-shadow 160ms; }
.auth-form-surface :deep(.input-label) { color: var(--auth-ink); font-size: 12px; font-weight: 500; margin-bottom: 8px; }
.auth-form-surface :deep(.btn) { min-height: 46px; border-radius: 12px; font-size: 13px; font-weight: 500; box-shadow: none; }
.auth-form-surface :deep(.btn-primary) { background-image: none; background-color: #0071e3; border-color: #0071e3; color: #fff; }
.auth-form-surface :deep(.btn-primary:hover:not(:disabled)) { background-color: #0062c6; border-color: #0062c6; }
.auth-form-surface :deep(.btn-secondary) { background-image: none; background-color: var(--auth-surface); border: 1px solid var(--auth-line); color: var(--auth-ink); }
.auth-form-surface :deep(.btn-secondary:hover:not(:disabled)) { background-color: var(--auth-canvas); }
.auth-footer-links { margin-top: 24px; text-align: center; font-size: 13px; line-height: 1.75; }
.auth-copyright { padding: 19px 24px 26px; text-align: center; color: var(--auth-muted); font-size: 10px; line-height: 1.7; overflow-wrap: anywhere; }
.auth-home-link:focus-visible { outline: 3px solid #0071e3; outline-offset: 5px; border-radius: 5px; }
@keyframes auth-enter { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
@media (max-width: 640px) { .auth-header { min-height: 62px; padding: 12px 20px; } .auth-main { padding: 18px 20px 26px; } .auth-brand { margin-bottom: 24px; } .auth-brand-mark { width: 46px; height: 46px; border-radius: 14px; margin-bottom: 15px; } .auth-brand h1 { font-size: 25px; } .auth-form-surface { padding: 27px 23px; border-radius: 21px; } .auth-copyright { padding-bottom: 20px; } }
@media (prefers-reduced-motion: reduce) { .auth-content { animation: none; } .auth-form-surface :deep(*) { transition: none !important; } }
</style>
