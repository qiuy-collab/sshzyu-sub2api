<template>
  <AppLayout>
    <div class="admin-workspace">
      <div v-if="loading" class="admin-loading">
        <LoadingSpinner />
      </div>

      <template v-else-if="stats">
        <section class="admin-summary" :aria-label="t('admin.dashboard.description')">
          <div class="admin-summary-heading">
            <h2>{{ t('common.today') }}</h2>
            <span>{{ t('admin.dashboard.description') }}</span>
          </div>
          <div class="admin-kpi-grid">
            <article class="admin-kpi">
              <h3>{{ t('admin.dashboard.todayRequests') }}</h3>
              <p class="admin-kpi-value">{{ formatNumber(stats.today_requests) }}</p>
              <p class="admin-kpi-detail">{{ t('admin.dashboard.totalRequests') }} <strong>{{ formatNumber(stats.total_requests) }}</strong></p>
            </article>
            <article class="admin-kpi">
              <h3>{{ t('admin.dashboard.todayTokens') }}</h3>
              <p class="admin-kpi-value">{{ formatTokens(stats.today_tokens) }}</p>
              <p class="admin-kpi-detail">{{ t('admin.dashboard.totalTokens') }} <strong>{{ formatTokens(stats.total_tokens) }}</strong></p>
            </article>
            <article class="admin-kpi admin-kpi-cost">
              <h3>{{ t('admin.dashboard.todayCost') }} <span>{{ t('admin.dashboard.actual') }}</span></h3>
              <p class="admin-kpi-value"><span class="admin-currency">$</span>{{ formatCost(stats.today_actual_cost) }}</p>
              <div class="admin-kpi-costs">
                <p><span>{{ t('admin.dashboard.accountCost') }}</span> <strong>${{ formatCost(stats.today_account_cost) }}</strong></p>
                <p><span>{{ t('admin.dashboard.standard') }}</span> <strong>${{ formatCost(stats.today_cost) }}</strong></p>
              </div>
            </article>
            <article class="admin-kpi">
              <h3>{{ t('admin.dashboard.newUsersToday') }}</h3>
              <p class="admin-kpi-value"><span class="admin-number-sign">+</span>{{ formatNumber(stats.today_new_users) }}</p>
              <p class="admin-kpi-detail">{{ t('admin.dashboard.totalUsers') }} <strong>{{ formatNumber(stats.total_users) }}</strong></p>
            </article>
          </div>

          <div class="admin-performance" :aria-label="t('admin.dashboard.performance')">
            <span class="admin-performance-label"><Icon name="bolt" size="sm" />{{ t('admin.dashboard.performance') }}</span>
            <dl>
              <div><dt>RPM</dt><dd>{{ formatTokens(stats.rpm) }}</dd></div>
              <div><dt>TPM</dt><dd>{{ formatTokens(stats.tpm) }}</dd></div>
              <div><dt>{{ t('admin.dashboard.avgResponse') }}</dt><dd>{{ formatDuration(stats.average_duration_ms) }}</dd></div>
              <div><dt>{{ t('admin.dashboard.activeUsers') }}</dt><dd>{{ formatNumber(stats.active_users) }}</dd></div>
            </dl>
          </div>
        </section>

        <section class="admin-assets" :aria-label="t('admin.dashboard.description')">
          <article class="admin-asset">
            <span class="admin-asset-icon"><Icon name="key" size="md" :stroke-width="1.7" /></span>
            <div class="admin-asset-body">
              <h3>{{ t('admin.dashboard.apiKeys') }}</h3>
              <p class="admin-asset-value">{{ formatNumber(stats.total_api_keys) }}<span class="admin-state-active">{{ stats.active_api_keys }} {{ t('common.active') }}</span></p>
            </div>
          </article>
          <article class="admin-asset">
            <span class="admin-asset-icon"><Icon name="server" size="md" :stroke-width="1.7" /></span>
            <div class="admin-asset-body">
              <h3>{{ t('admin.dashboard.accounts') }}</h3>
              <p class="admin-asset-value">{{ formatNumber(stats.total_accounts) }}<span class="admin-state-active">{{ stats.normal_accounts }} {{ t('common.active') }}</span><span v-if="stats.error_accounts > 0" class="admin-state-error">{{ stats.error_accounts }} {{ t('common.error') }}</span></p>
            </div>
          </article>
          <article class="admin-asset admin-asset-spend">
            <span class="admin-asset-icon"><Icon name="database" size="md" :stroke-width="1.7" /></span>
            <div class="admin-asset-body">
              <h3>{{ t('admin.dashboard.totalCost') }}</h3>
              <dl class="admin-total-costs">
                <div><dt>{{ t('admin.dashboard.actual') }}</dt><dd>${{ formatCost(stats.total_actual_cost) }}</dd></div>
                <div><dt>{{ t('admin.dashboard.accountCost') }}</dt><dd>${{ formatCost(stats.total_account_cost) }}</dd></div>
                <div><dt>{{ t('admin.dashboard.standard') }}</dt><dd>${{ formatCost(stats.total_cost) }}</dd></div>
              </dl>
            </div>
          </article>
        </section>

        <section class="admin-analytics">
          <div class="admin-analytics-toolbar">
            <div class="admin-date-control">
              <span>{{ t('admin.dashboard.timeRange') }}</span>
              <DateRangePicker
                v-model:start-date="startDate"
                v-model:end-date="endDate"
                @change="onDateRangeChange"
              />
            </div>
            <div class="admin-chart-controls">
              <label class="admin-granularity-control">
                <span>{{ t('admin.dashboard.granularity') }}</span>
                <Select v-model="granularity" :options="granularityOptions" @change="loadChartData" />
              </label>
              <button @click="loadDashboardStats" :disabled="chartsLoading" class="btn btn-secondary admin-refresh">
                <Icon name="refresh" size="sm" :class="{ 'animate-spin': chartsLoading }" />
                {{ t('common.refresh') }}
              </button>
            </div>
          </div>

          <TokenUsageTrend class="admin-trend-panel" :trend-data="trendData" :loading="chartsLoading" />

          <div class="admin-analysis-detail">
            <ModelDistributionChart
              class="admin-distribution-panel"
              :model-stats="modelStats"
              :enable-ranking-view="true"
              :ranking-items="rankingItems"
              :ranking-total-actual-cost="rankingTotalActualCost"
              :ranking-total-requests="rankingTotalRequests"
              :ranking-total-tokens="rankingTotalTokens"
              :loading="chartsLoading"
              :ranking-loading="rankingLoading"
              :ranking-error="rankingError"
              :start-date="startDate"
              :end-date="endDate"
              @ranking-click="goToUserUsage"
            />
            <section class="admin-user-trend">
              <div class="admin-panel-heading">
                <h3>{{ t('admin.dashboard.recentUsage') }}</h3>
                <span>Top 12</span>
              </div>
              <div class="admin-user-chart">
                <div v-if="userTrendLoading" class="admin-chart-empty">
                  <LoadingSpinner size="md" />
                </div>
                <Line v-else-if="userTrendChartData" :data="userTrendChartData" :options="lineOptions" />
                <div v-else class="admin-chart-empty">{{ t('admin.dashboard.noDataAvailable') }}</div>
              </div>
            </section>
          </div>
        </section>

        <section class="admin-shortcuts" :aria-label="t('admin.dashboard.quickActions')">
          <h2>{{ t('admin.dashboard.quickActions') }}</h2>
          <div class="admin-shortcut-list">
            <button v-if="canUseBatchImage" type="button" class="admin-shortcut" @click="router.push('/batch-image')">
              <Icon name="sparkles" size="md" :stroke-width="1.7" />
              <span><strong>{{ t('admin.dashboard.batchImage') }}</strong><span>{{ t('admin.dashboard.batchImageDesc') }}</span></span>
              <Icon name="chevronRight" size="sm" />
            </button>
            <button type="button" class="admin-shortcut" @click="router.push('/admin/groups')">
              <Icon name="grid" size="md" :stroke-width="1.7" />
              <span><strong>{{ t('admin.dashboard.groupPricing') }}</strong><span>{{ t('admin.dashboard.groupPricingDesc') }}</span></span>
              <Icon name="chevronRight" size="sm" />
            </button>
          </div>
        </section>
      </template>
    </div>
  </AppLayout>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useAppStore } from '@/stores/app'

const { t } = useI18n()
import { adminAPI } from '@/api/admin'
import type {
  DashboardStats,
  TrendDataPoint,
  ModelStat,
  UserUsageTrendPoint,
  UserSpendingRankingItem
} from '@/types'
import AppLayout from '@/components/layout/AppLayout.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import Icon from '@/components/icons/Icon.vue'
import DateRangePicker from '@/components/common/DateRangePicker.vue'
import Select from '@/components/common/Select.vue'
import ModelDistributionChart from '@/components/charts/ModelDistributionChart.vue'
import TokenUsageTrend from '@/components/charts/TokenUsageTrend.vue'
import { useBatchImageAccess } from '@/composables/useBatchImageAccess'

import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Legend,
  Filler
} from 'chart.js'
import { Line } from 'vue-chartjs'

// Register Chart.js components
ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Legend,
  Filler
)

const appStore = useAppStore()
const router = useRouter()
const { canUseBatchImage, refreshBatchImageAccess } = useBatchImageAccess()
const stats = ref<DashboardStats | null>(null)
const loading = ref(false)
const chartsLoading = ref(false)
const userTrendLoading = ref(false)
const rankingLoading = ref(false)
const rankingError = ref(false)

// Chart data
const trendData = ref<TrendDataPoint[]>([])
const modelStats = ref<ModelStat[]>([])
const userTrend = ref<UserUsageTrendPoint[]>([])
const rankingItems = ref<UserSpendingRankingItem[]>([])
const rankingTotalActualCost = ref(0)
const rankingTotalRequests = ref(0)
const rankingTotalTokens = ref(0)
let chartLoadSeq = 0
let usersTrendLoadSeq = 0
let rankingLoadSeq = 0
const rankingLimit = 12

// Helper function to format date in local timezone
const formatLocalDate = (date: Date): string => {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

const getLast24HoursRangeDates = (): { start: string; end: string } => {
  const end = new Date()
  const start = new Date(end.getTime() - 24 * 60 * 60 * 1000)
  return {
    start: formatLocalDate(start),
    end: formatLocalDate(end)
  }
}

// Date range
const granularity = ref<'day' | 'hour'>('hour')
const defaultRange = getLast24HoursRangeDates()
const startDate = ref(defaultRange.start)
const endDate = ref(defaultRange.end)

// Granularity options for Select component
const granularityOptions = computed(() => [
  { value: 'day', label: t('admin.dashboard.day') },
  { value: 'hour', label: t('admin.dashboard.hour') }
])

// Dark mode detection
const isDarkMode = computed(() => {
  return document.documentElement.classList.contains('dark')
})

// Chart colors
const chartColors = computed(() => ({
  text: isDarkMode.value ? '#a1a1a8' : '#6e6e73',
  grid: isDarkMode.value ? '#3a3a40' : '#eeeeef'
}))

// Line chart options (for user trend chart)
const lineOptions = computed(() => ({
  responsive: true,
  maintainAspectRatio: false,
  elements: {
    line: { borderWidth: 2 },
    point: { radius: 1.5, hoverRadius: 4 }
  },
  interaction: {
    intersect: false,
    mode: 'index' as const
  },
  plugins: {
    legend: {
      position: 'top' as const,
      labels: {
        color: chartColors.value.text,
        usePointStyle: true,
        pointStyle: 'circle',
        boxWidth: 6,
        boxHeight: 6,
        padding: 16,
        font: {
          size: 11
        }
      }
    },
    tooltip: {
      itemSort: (a: any, b: any) => {
        const aValue = typeof a?.raw === 'number' ? a.raw : Number(a?.parsed?.y ?? 0)
        const bValue = typeof b?.raw === 'number' ? b.raw : Number(b?.parsed?.y ?? 0)
        return bValue - aValue
      },
      callbacks: {
        label: (context: any) => {
          return `${context.dataset.label}: ${formatTokens(context.raw)}`
        }
      }
    }
  },
  scales: {
    x: {
      grid: {
        color: chartColors.value.grid
      },
      ticks: {
        color: chartColors.value.text,
        font: {
          size: 10
        }
      }
    },
    y: {
      grid: {
        color: chartColors.value.grid
      },
      ticks: {
        color: chartColors.value.text,
        font: {
          size: 10
        },
        callback: (value: string | number) => formatTokens(Number(value))
      }
    }
  }
}))

// User trend chart data
const userTrendChartData = computed(() => {
  if (!userTrend.value?.length) return null

  const getDisplayName = (point: UserUsageTrendPoint): string => {
    const username = point.username?.trim()
    if (username) {
      return username
    }

    const email = point.email?.trim()
    if (email) {
      return email
    }

    return t('admin.redeem.userPrefix', { id: point.user_id })
  }

  // Group by user_id to avoid merging different users with the same display name
  const userGroups = new Map<number, { name: string; data: Map<string, number> }>()
  const allDates = new Set<string>()

  userTrend.value.forEach((point) => {
    allDates.add(point.date)
    const key = point.user_id
    if (!userGroups.has(key)) {
      userGroups.set(key, { name: getDisplayName(point), data: new Map() })
    }
    userGroups.get(key)!.data.set(point.date, point.tokens)
  })

  const sortedDates = Array.from(allDates).sort()
  const colors = [
    '#0071e3',
    '#33465f',
    '#74ace2',
    '#80949d',
    '#b0bcc8',
    '#5d8dba',
    '#69948e',
    '#a99b83',
    '#8994b1',
    '#4b6b8a',
    '#a0b7c7',
    '#789bad'
  ]

  const datasets = Array.from(userGroups.values()).map((group, idx) => ({
    label: group.name,
    data: sortedDates.map((date) => group.data.get(date) || 0),
    borderColor: colors[idx % colors.length],
    backgroundColor: `${colors[idx % colors.length]}20`,
    fill: false,
    tension: 0.3
  }))

  return {
    labels: sortedDates,
    datasets
  }
})

// Format helpers
const formatTokens = (value: number | undefined): string => {
  if (value === undefined || value === null) return '0'
  if (value >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(2)}B`
  } else if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(2)}M`
  } else if (value >= 1_000) {
    return `${(value / 1_000).toFixed(2)}K`
  }
  return value.toLocaleString()
}

const toFiniteNumber = (value: unknown): number => {
  const numberValue = Number(value)
  return Number.isFinite(numberValue) ? numberValue : 0
}

const formatNumber = (value: number | null | undefined): string => {
  return toFiniteNumber(value).toLocaleString()
}

const formatCost = (value: number | null | undefined): string => {
  const safeValue = toFiniteNumber(value)
  if (safeValue >= 1000) {
    return (safeValue / 1000).toFixed(2) + 'K'
  } else if (safeValue >= 1) {
    return safeValue.toFixed(2)
  } else if (safeValue >= 0.01) {
    return safeValue.toFixed(3)
  }
  return safeValue.toFixed(4)
}

const formatDuration = (ms: number): string => {
  if (ms >= 1000) {
    return `${(ms / 1000).toFixed(2)}s`
  }
  return `${Math.round(ms)}ms`
}

const goToUserUsage = (item: UserSpendingRankingItem) => {
  void router.push({
    path: '/admin/usage',
    query: {
      user_id: String(item.user_id),
      start_date: startDate.value,
      end_date: endDate.value
    }
  })
}

// Date range change handler
const onDateRangeChange = (range: {
  startDate: string
  endDate: string
  preset: string | null
}) => {
  // Auto-select granularity based on date range
  const start = new Date(range.startDate)
  const end = new Date(range.endDate)
  const daysDiff = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24))

  // If range is 1 day, use hourly granularity
  if (daysDiff <= 1) {
    granularity.value = 'hour'
  } else {
    granularity.value = 'day'
  }

  loadChartData()
}

// Load data
const loadDashboardSnapshot = async (includeStats: boolean) => {
  const currentSeq = ++chartLoadSeq
  if (includeStats && !stats.value) {
    loading.value = true
  }
  chartsLoading.value = true
  try {
    const response = await adminAPI.dashboard.getSnapshotV2({
      start_date: startDate.value,
      end_date: endDate.value,
      granularity: granularity.value,
      include_stats: includeStats,
      include_trend: true,
      include_model_stats: true,
      include_group_stats: false,
      include_users_trend: false
    })
    if (currentSeq !== chartLoadSeq) return
    if (includeStats && response.stats) {
      stats.value = response.stats
    }
    trendData.value = response.trend || []
    modelStats.value = response.models || []
  } catch (error) {
    if (currentSeq !== chartLoadSeq) return
    appStore.showError(t('admin.dashboard.failedToLoad'))
    console.error('Error loading dashboard snapshot:', error)
  } finally {
    if (currentSeq === chartLoadSeq) {
      loading.value = false
      chartsLoading.value = false
    }
  }
}

const loadUsersTrend = async () => {
  const currentSeq = ++usersTrendLoadSeq
  userTrendLoading.value = true
  try {
    const response = await adminAPI.dashboard.getUserUsageTrend({
      start_date: startDate.value,
      end_date: endDate.value,
      granularity: granularity.value,
      limit: 12
    })
    if (currentSeq !== usersTrendLoadSeq) return
    userTrend.value = response.trend || []
  } catch (error) {
    if (currentSeq !== usersTrendLoadSeq) return
    console.error('Error loading users trend:', error)
    userTrend.value = []
  } finally {
    if (currentSeq === usersTrendLoadSeq) {
      userTrendLoading.value = false
    }
  }
}

const loadUserSpendingRanking = async () => {
  const currentSeq = ++rankingLoadSeq
  rankingLoading.value = true
  rankingError.value = false
  try {
    const response = await adminAPI.dashboard.getUserSpendingRanking({
      start_date: startDate.value,
      end_date: endDate.value,
      limit: rankingLimit
    })
    if (currentSeq !== rankingLoadSeq) return
    rankingItems.value = response.ranking || []
    rankingTotalActualCost.value = response.total_actual_cost || 0
    rankingTotalRequests.value = response.total_requests || 0
    rankingTotalTokens.value = response.total_tokens || 0
  } catch (error) {
    if (currentSeq !== rankingLoadSeq) return
    console.error('Error loading user spending ranking:', error)
    rankingItems.value = []
    rankingTotalActualCost.value = 0
    rankingTotalRequests.value = 0
    rankingTotalTokens.value = 0
    rankingError.value = true
  } finally {
    if (currentSeq === rankingLoadSeq) {
      rankingLoading.value = false
    }
  }
}

const loadDashboardStats = async () => {
  await Promise.all([
    loadDashboardSnapshot(true),
    loadUsersTrend(),
    loadUserSpendingRanking()
  ])
}

const loadChartData = async () => {
  await Promise.all([
    loadDashboardSnapshot(false),
    loadUsersTrend(),
    loadUserSpendingRanking()
  ])
}

onMounted(() => {
  void refreshBatchImageAccess()
  loadDashboardStats()
})
</script>

<style src="@/styles/admin-workspace.css"></style>
