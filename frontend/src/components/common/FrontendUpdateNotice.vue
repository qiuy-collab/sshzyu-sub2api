<template>
  <aside v-if="updateEntrypoint" class="frontend-update-notice" role="status" aria-live="polite">
    <Icon name="refresh" size="sm" aria-hidden="true" />
    <div>
      <strong>{{ t('frontendUpdate.title') }}</strong>
      <p>{{ t('frontendUpdate.description') }}</p>
    </div>
    <div class="frontend-update-actions">
      <button type="button" class="frontend-update-refresh" @click="refresh">{{ t('frontendUpdate.refresh') }}</button>
      <button type="button" class="frontend-update-later" @click="dismiss">{{ t('frontendUpdate.later') }}</button>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/icons/Icon.vue'
import { currentModuleEntrypoint, probeFrontendUpdate } from '@/utils/frontendUpdate'

const { t } = useI18n()
const updateEntrypoint = ref<string | null>(null)
const currentEntrypoint = currentModuleEntrypoint()
const dismissalKey = 'sshzyu:frontend-update-dismissed'
let initialTimer: ReturnType<typeof setTimeout> | undefined
let intervalTimer: ReturnType<typeof setInterval> | undefined

function dismissedEntrypoint() {
  try { return sessionStorage.getItem(dismissalKey) } catch { return null }
}

async function checkForUpdate() {
  if (document.visibilityState !== 'visible' || updateEntrypoint.value) return
  const next = await probeFrontendUpdate({ currentEntrypoint })
  if (next && next !== dismissedEntrypoint()) updateEntrypoint.value = next
}

function onVisibilityChange() {
  if (document.visibilityState === 'visible') void checkForUpdate()
}

function dismiss() {
  if (updateEntrypoint.value) {
    try { sessionStorage.setItem(dismissalKey, updateEntrypoint.value) } catch { /* Storage is optional for this notice. */ }
  }
  updateEntrypoint.value = null
}

function refresh() { window.location.reload() }

onMounted(() => {
  initialTimer = setTimeout(() => { void checkForUpdate() }, 15_000)
  intervalTimer = setInterval(() => { void checkForUpdate() }, 5 * 60_000)
  document.addEventListener('visibilitychange', onVisibilityChange)
})

onBeforeUnmount(() => {
  clearTimeout(initialTimer)
  clearInterval(intervalTimer)
  document.removeEventListener('visibilitychange', onVisibilityChange)
})
</script>

<style scoped>
.frontend-update-notice { position: fixed; z-index: 90; right: 22px; bottom: 22px; display: flex; align-items: flex-start; gap: 10px; width: min(440px, calc(100vw - 32px)); padding: 14px; border: 1px solid var(--workspace-divider, #e6e6e6); border-radius: 14px; background: var(--workspace-surface, #fff); color: var(--workspace-ink, #1d1d1f); box-shadow: 0 12px 34px rgb(0 0 0 / 12%); }
.frontend-update-notice > svg { flex: 0 0 auto; margin-top: 2px; color: var(--workspace-accent, #1677ff); }
.frontend-update-notice > div:nth-child(2) { min-width: 0; flex: 1; }
.frontend-update-notice strong { display: block; font-size: 13px; font-weight: 600; }
.frontend-update-notice p { margin-top: 3px; color: var(--workspace-muted, #6b7280); font-size: 12px; line-height: 1.55; }
.frontend-update-actions { display: flex; flex: 0 0 auto; gap: 4px; }
.frontend-update-actions button { min-height: 31px; border-radius: 8px; padding: 0 9px; font: inherit; font-size: 12px; font-weight: 500; }
.frontend-update-refresh { border: 1px solid var(--workspace-ink, #1d1d1f); background: var(--workspace-ink, #1d1d1f); color: var(--workspace-surface, #fff); }
.frontend-update-later { border: 0; background: transparent; color: var(--workspace-muted, #6b7280); }
.frontend-update-later:hover { background: var(--workspace-soft, #f5f5f5); }
@media (max-width: 540px) { .frontend-update-notice { right: 16px; bottom: 16px; flex-wrap: wrap; } .frontend-update-actions { width: 100%; justify-content: flex-end; } }
</style>
