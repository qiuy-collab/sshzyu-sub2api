<template>
  <div class="dashboard-section dashboard-recent-usage">
    <div class="dashboard-section-heading flex items-center justify-between gap-3">
      <h2 class="text-sm font-semibold text-gray-900 dark:text-white">{{ t('dashboard.recentUsage') }}</h2>
      <span class="text-xs text-gray-500 dark:text-dark-400">{{ t('dashboard.last7Days') }}</span>
    </div>
    <div class="dashboard-usage-content">
      <div v-if="loading" class="flex items-center justify-center py-12">
        <LoadingSpinner size="lg" />
      </div>
      <div v-else-if="data.length === 0" class="py-8">
        <EmptyState :title="t('dashboard.noUsageRecords')" :description="t('dashboard.startUsingApi')" />
      </div>
      <div v-else>
        <div v-for="log in data" :key="log.id" class="dashboard-usage-row">
          <div class="flex min-w-0 items-center gap-3">
            <div class="dashboard-usage-icon flex h-8 w-8 shrink-0 items-center justify-center">
              <Icon name="beaker" size="md" class="text-gray-400 dark:text-dark-400" />
            </div>
            <div class="min-w-0">
              <p class="truncate text-sm font-medium text-gray-900 dark:text-white" :title="log.model">{{ log.model }}</p>
              <p class="text-xs text-gray-500 dark:text-dark-400">{{ formatDateTime(log.created_at) }}</p>
            </div>
          </div>
          <div class="dashboard-usage-cost text-right tabular-nums">
            <p class="text-sm font-semibold">
              <span class="text-gray-900 dark:text-white" :title="t('dashboard.actual')">${{ formatCost(log.actual_cost) }}</span>
              <span class="font-normal text-gray-400 dark:text-gray-500" :title="t('dashboard.standard')"> / ${{ formatCost(log.total_cost) }}</span>
            </p>
            <p class="text-xs text-gray-500 dark:text-dark-400">{{ (log.input_tokens + log.output_tokens).toLocaleString() }} tokens</p>
          </div>
        </div>

        <router-link to="/usage" class="flex items-center justify-center gap-2 py-3 text-sm font-medium text-primary-600 transition-colors hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300">
          {{ t('dashboard.viewAllUsage') }}
          <Icon name="arrowRight" size="sm" />
        </router-link>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import Icon from '@/components/icons/Icon.vue'
import { formatDateTime } from '@/utils/format'
import type { UsageLog } from '@/types'

defineProps<{
  data: UsageLog[]
  loading: boolean
}>()
const { t } = useI18n()
const formatCost = (c: number) => c.toFixed(4)
</script>
