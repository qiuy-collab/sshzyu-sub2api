<template>
  <div class="card p-4 model-distribution">
    <div class="mb-4 flex items-center justify-between gap-3 model-distribution__header">
      <h3 class="text-sm font-semibold text-gray-900 dark:text-white">
        {{ !enableRankingView || activeView === 'model_distribution'
          ? t('admin.dashboard.modelDistribution')
          : t('admin.dashboard.spendingRankingTitle') }}
      </h3>
      <div class="flex flex-wrap items-center justify-end gap-2 model-distribution__toolbar">
        <div
          v-if="showSourceToggle"
          class="inline-flex rounded-lg border border-gray-200 bg-gray-50 p-0.5 dark:border-dark-700 dark:bg-dark-800 model-distribution__segment"
        >
          <button
            type="button"
            class="rounded-md px-2.5 py-1 text-xs font-medium transition-colors model-distribution__segment-button"
            :class="source === 'requested'
              ? 'bg-white text-gray-900 shadow-sm dark:bg-dark-700 dark:text-white'
              : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'"
            @click="emit('update:source', 'requested')"
          >
            {{ t('usage.requestedModel') }}
          </button>
          <button
            type="button"
            class="rounded-md px-2.5 py-1 text-xs font-medium transition-colors model-distribution__segment-button"
            :class="source === 'upstream'
              ? 'bg-white text-gray-900 shadow-sm dark:bg-dark-700 dark:text-white'
              : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'"
            @click="emit('update:source', 'upstream')"
          >
            {{ t('usage.upstreamModel') }}
          </button>
          <button
            type="button"
            class="rounded-md px-2.5 py-1 text-xs font-medium transition-colors model-distribution__segment-button"
            :class="source === 'mapping'
              ? 'bg-white text-gray-900 shadow-sm dark:bg-dark-700 dark:text-white'
              : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'"
            @click="emit('update:source', 'mapping')"
          >
            {{ t('usage.mapping') }}
          </button>
        </div>
        <div
          v-if="showMetricToggle"
          class="inline-flex rounded-lg border border-gray-200 bg-gray-50 p-0.5 dark:border-dark-700 dark:bg-dark-800 model-distribution__segment"
        >
          <button
            type="button"
            class="rounded-md px-2.5 py-1 text-xs font-medium transition-colors model-distribution__segment-button"
            :class="metric === 'tokens'
              ? 'bg-white text-gray-900 shadow-sm dark:bg-dark-700 dark:text-white'
              : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'"
            @click="emit('update:metric', 'tokens')"
          >
            {{ t('admin.dashboard.metricTokens') }}
          </button>
          <button
            type="button"
            class="rounded-md px-2.5 py-1 text-xs font-medium transition-colors model-distribution__segment-button"
            :class="metric === 'actual_cost'
              ? 'bg-white text-gray-900 shadow-sm dark:bg-dark-700 dark:text-white'
              : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'"
            @click="emit('update:metric', 'actual_cost')"
          >
            {{ t('admin.dashboard.metricActualCost') }}
          </button>
        </div>
        <div v-if="enableRankingView" class="inline-flex rounded-lg bg-gray-100 p-1 dark:bg-dark-800 model-distribution__segment">
          <button
            type="button"
            class="rounded-md px-2.5 py-1 text-xs font-medium transition-colors model-distribution__segment-button"
            :class="
              activeView === 'model_distribution'
                ? 'bg-white text-gray-900 shadow-sm dark:bg-dark-700 dark:text-white'
                : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
            "
            @click="activeView = 'model_distribution'"
          >
            {{ t('admin.dashboard.viewModelDistribution') }}
          </button>
          <button
            type="button"
            class="rounded-md px-2.5 py-1 text-xs font-medium transition-colors model-distribution__segment-button"
            :class="
              activeView === 'spending_ranking'
                ? 'bg-white text-gray-900 shadow-sm dark:bg-dark-700 dark:text-white'
                : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
            "
            @click="activeView = 'spending_ranking'"
          >
            {{ t('admin.dashboard.viewSpendingRanking') }}
          </button>
        </div>
      </div>
    </div>

    <div v-if="activeView === 'model_distribution' && loading" class="flex h-48 items-center justify-center">
      <LoadingSpinner />
    </div>
    <div
      v-else-if="activeView === 'model_distribution' && displayModelStats.length > 0 && chartData"
      class="model-distribution__content"
    >
      <div class="model-distribution__chart shrink-0">
        <Doughnut :data="chartData" :options="doughnutOptions" />
        <div class="model-distribution__chart-label" aria-hidden="true">
          <strong>{{ distributionTotalValue }}</strong>
          <span>{{ distributionTotalCaption }}</span>
        </div>
      </div>
      <div class="max-h-48 w-full min-w-0 flex-1 overflow-auto model-distribution__table-wrap">
        <table class="w-full text-xs model-distribution__table">
          <thead>
            <tr class="text-gray-500 dark:text-gray-400">
              <th class="pb-2 text-left">{{ t('admin.dashboard.model') }}</th>
              <th class="pb-2 text-right">{{ t('admin.dashboard.requests') }}</th>
              <th class="pb-2 text-right">{{ t('admin.dashboard.tokens') }}</th>
              <th class="pb-2 text-right">{{ t('admin.dashboard.actual') }}</th>
              <th v-if="showAccountCost" class="pb-2 text-right">{{ t('admin.dashboard.accountCost') }}</th>
              <th class="pb-2 text-right">{{ t('admin.dashboard.standard') }}</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="(model, index) in displayModelStats" :key="model.model">
              <tr
                class="border-t border-gray-100 transition-colors dark:border-dark-700 model-distribution__row"
                :class="enableBreakdown ? 'cursor-pointer hover:bg-gray-50 dark:hover:bg-dark-700/40' : ''"
                @click="enableBreakdown && toggleBreakdown('model', model.model)"
              >
                <td
                  class="max-w-[100px] truncate py-1.5 font-medium model-distribution__model"
                  :class="enableBreakdown ? 'text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300' : 'text-gray-900 dark:text-white'"
                  :title="model.model"
                >
                  <span class="inline-flex items-center gap-1">
                    <i class="model-distribution__swatch" :style="{ backgroundColor: chartColors[index % chartColors.length] }" />
                    <svg v-if="enableBreakdown && expandedKey === `model-${model.model}`" class="h-3 w-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
                    <svg v-else-if="enableBreakdown" class="h-3 w-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>
                    {{ model.model }}
                  </span>
                </td>
                <td class="py-1.5 text-right text-gray-600 dark:text-gray-400 model-distribution__number">
                  {{ formatNumber(model.requests) }}
                </td>
                <td class="py-1.5 text-right text-gray-600 dark:text-gray-400 model-distribution__number">
                  {{ formatTokens(model.total_tokens) }}
                </td>
                <td class="py-1.5 text-right text-green-600 dark:text-green-400 model-distribution__number model-distribution__actual">
                  ${{ formatCost(model.actual_cost) }}
                </td>
                <td v-if="showAccountCost" class="py-1.5 text-right text-orange-500 dark:text-orange-400 model-distribution__number model-distribution__cost">
                  ${{ formatCost(model.account_cost) }}
                </td>
                <td class="py-1.5 text-right text-gray-400 dark:text-gray-500 model-distribution__number model-distribution__standard">
                  ${{ formatCost(model.cost) }}
                </td>
              </tr>
              <tr v-if="expandedKey === `model-${model.model}`">
                <td :colspan="distributionColspan" class="p-0">
                  <UserBreakdownSubTable
                    :items="breakdownItems"
                    :loading="breakdownLoading"
                    :show-account-cost="showAccountCost"
                  />
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </div>
    <div
      v-else-if="activeView === 'model_distribution'"
      class="flex h-48 items-center justify-center text-sm text-gray-500 dark:text-gray-400"
    >
      {{ t('admin.dashboard.noDataAvailable') }}
    </div>

    <div v-else-if="rankingLoading" class="flex h-48 items-center justify-center">
      <LoadingSpinner />
    </div>
    <div
      v-else-if="rankingError"
      class="flex h-48 items-center justify-center text-sm text-gray-500 dark:text-gray-400"
    >
      {{ t('admin.dashboard.failedToLoad') }}
    </div>
    <div v-else-if="rankingDisplayItems.length > 0 && rankingChartData" class="model-distribution__content">
      <div class="model-distribution__chart shrink-0">
        <Doughnut :data="rankingChartData" :options="rankingDoughnutOptions" />
        <div class="model-distribution__chart-label" aria-hidden="true">
          <strong>${{ rankingTotalValue }}</strong>
          <span>{{ t('admin.dashboard.spendingRankingSpend') }}</span>
        </div>
      </div>
      <div class="max-h-48 w-full min-w-0 flex-1 overflow-auto model-distribution__table-wrap">
        <table class="w-full text-xs model-distribution__table">
          <thead>
            <tr class="text-gray-500 dark:text-gray-400">
              <th class="pb-2 text-left">{{ t('admin.dashboard.spendingRankingUser') }}</th>
              <th class="pb-2 text-right">{{ t('admin.dashboard.spendingRankingRequests') }}</th>
              <th class="pb-2 text-right">{{ t('admin.dashboard.spendingRankingTokens') }}</th>
              <th class="pb-2 text-right">{{ t('admin.dashboard.spendingRankingSpend') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(item, index) in rankingDisplayItems"
              :key="item.isOther ? 'others' : `${item.user_id}-${index}`"
              class="border-t border-gray-100 transition-colors dark:border-dark-700 model-distribution__row"
              :class="item.isOther
                ? 'bg-gray-50/70 dark:bg-dark-700/20'
                : 'cursor-pointer hover:bg-gray-50 dark:hover:bg-dark-700/40'"
              @click="item.isOther ? undefined : emit('ranking-click', item)"
            >
              <td class="py-1.5">
                <div class="flex min-w-0 items-center gap-2">
                  <span class="shrink-0 text-[11px] font-semibold text-gray-500 dark:text-gray-400">
                    {{ item.isOther ? 'Σ' : `#${index + 1}` }}
                  </span>
                  <span
                    class="block max-w-[140px] truncate font-medium text-gray-900 dark:text-white"
                    :title="getRankingRowLabel(item)"
                  >
                    {{ getRankingRowLabel(item) }}
                  </span>
                </div>
              </td>
              <td class="py-1.5 text-right text-gray-600 dark:text-gray-400 model-distribution__number">
                {{ formatNumber(item.requests) }}
              </td>
              <td class="py-1.5 text-right text-gray-600 dark:text-gray-400 model-distribution__number">
                {{ formatTokens(item.tokens) }}
              </td>
              <td class="py-1.5 text-right text-green-600 dark:text-green-400 model-distribution__number model-distribution__actual">
                ${{ formatCost(item.actual_cost) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
    <div
      v-else
      class="flex h-48 items-center justify-center text-sm text-gray-500 dark:text-gray-400"
    >
      {{ t('admin.dashboard.noDataAvailable') }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Chart as ChartJS, ArcElement, Tooltip, Legend } from 'chart.js'
import { Doughnut } from 'vue-chartjs'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import UserBreakdownSubTable from './UserBreakdownSubTable.vue'
import type { ModelStat, UserSpendingRankingItem, UserBreakdownItem } from '@/types'
import { getUserBreakdown } from '@/api/admin/dashboard'

ChartJS.register(ArcElement, Tooltip, Legend)

const { t } = useI18n()

type DistributionMetric = 'tokens' | 'actual_cost'
type ModelSource = 'requested' | 'upstream' | 'mapping'
type RankingDisplayItem = UserSpendingRankingItem & { isOther?: boolean }
const props = withDefaults(defineProps<{
  modelStats: ModelStat[]
  upstreamModelStats?: ModelStat[]
  mappingModelStats?: ModelStat[]
  source?: ModelSource
  enableRankingView?: boolean
  rankingItems?: UserSpendingRankingItem[]
  rankingTotalActualCost?: number
  rankingTotalRequests?: number
  rankingTotalTokens?: number
  loading?: boolean
  metric?: DistributionMetric
  showSourceToggle?: boolean
  showMetricToggle?: boolean
  enableBreakdown?: boolean
  showAccountCost?: boolean
  rankingLoading?: boolean
  rankingError?: boolean
  startDate?: string
  endDate?: string
  filters?: Record<string, any>
}>(), {
  upstreamModelStats: () => [],
  mappingModelStats: () => [],
  source: 'requested',
  enableRankingView: false,
  rankingItems: () => [],
  rankingTotalActualCost: 0,
  rankingTotalRequests: 0,
  rankingTotalTokens: 0,
  loading: false,
  metric: 'tokens',
  showSourceToggle: false,
  showMetricToggle: false,
  enableBreakdown: true,
  showAccountCost: true,
  rankingLoading: false,
  rankingError: false
})

const expandedKey = ref<string | null>(null)
const breakdownItems = ref<UserBreakdownItem[]>([])
const breakdownLoading = ref(false)

const toggleBreakdown = async (type: string, id: string) => {
  const key = `${type}-${id}`
  if (expandedKey.value === key) {
    expandedKey.value = null
    return
  }
  expandedKey.value = key
  breakdownLoading.value = true
  breakdownItems.value = []
  try {
    const res = await getUserBreakdown({
      ...props.filters,
      start_date: props.startDate,
      end_date: props.endDate,
      model: id,
      model_source: props.source,
    })
    breakdownItems.value = res.users || []
  } catch {
    breakdownItems.value = []
  } finally {
    breakdownLoading.value = false
  }
}

const emit = defineEmits<{
  'update:metric': [value: DistributionMetric]
  'update:source': [value: ModelSource]
  'ranking-click': [item: UserSpendingRankingItem]
}>()

const enableRankingView = computed(() => props.enableRankingView)
const showAccountCost = computed(() => props.showAccountCost)
const distributionColspan = computed(() => showAccountCost.value ? 6 : 5)
const activeView = ref<'model_distribution' | 'spending_ranking'>('model_distribution')

const chartColors = [
  '#147ce5',
  '#456276',
  '#78a9d8',
  '#91a3ae',
  '#bbc4cc',
  '#628bb2',
  '#7a9d98',
  '#ae9f8a',
  '#9099b0',
  '#526e88',
  '#aabac7',
  '#82a0b8'
]

const displayModelStats = computed(() => {
  const sourceStats = props.source === 'upstream'
    ? props.upstreamModelStats
    : props.source === 'mapping'
      ? props.mappingModelStats
      : props.modelStats
  if (!sourceStats?.length) return []

  const metricKey = props.metric === 'actual_cost' ? 'actual_cost' : 'total_tokens'
  return [...sourceStats].sort((a, b) => toFiniteNumber(b[metricKey]) - toFiniteNumber(a[metricKey]))
})

const chartData = computed(() => {
  if (!displayModelStats.value.length) return null

  return {
    labels: displayModelStats.value.map((m) => m.model),
    datasets: [
      {
        data: displayModelStats.value.map((m) => toFiniteNumber(props.metric === 'actual_cost' ? m.actual_cost : m.total_tokens)),
        backgroundColor: chartColors.slice(0, displayModelStats.value.length),
        borderWidth: 0,
        borderRadius: 4,
        hoverOffset: 3
      }
    ]
  }
})

const rankingChartData = computed(() => {
  if (!props.rankingItems?.length) return null

  const labels = props.rankingItems.map((item, index) => `#${index + 1} ${getRankingUserLabel(item)}`)
  const data = props.rankingItems.map((item) => toFiniteNumber(item.actual_cost))
  const backgroundColor = chartColors.slice(0, props.rankingItems.length)

  if (otherRankingItem.value) {
    labels.push(t('admin.dashboard.spendingRankingOther'))
    data.push(otherRankingItem.value.actual_cost)
    backgroundColor.push('#94a3b8')
  }

  return {
    labels,
    datasets: [
      {
        data,
        backgroundColor,
        borderWidth: 0,
        borderRadius: 4,
        hoverOffset: 3
      }
    ]
  }
})

const otherRankingItem = computed<RankingDisplayItem | null>(() => {
  if (!props.rankingItems?.length) return null

  const rankedActualCost = props.rankingItems.reduce((sum, item) => sum + toFiniteNumber(item.actual_cost), 0)
  const rankedRequests = props.rankingItems.reduce((sum, item) => sum + toFiniteNumber(item.requests), 0)
  const rankedTokens = props.rankingItems.reduce((sum, item) => sum + toFiniteNumber(item.tokens), 0)

  const otherActualCost = Math.max((props.rankingTotalActualCost || 0) - rankedActualCost, 0)
  const otherRequests = Math.max((props.rankingTotalRequests || 0) - rankedRequests, 0)
  const otherTokens = Math.max((props.rankingTotalTokens || 0) - rankedTokens, 0)

  if (otherActualCost <= 0.000001 && otherRequests <= 0 && otherTokens <= 0) return null

  return {
    user_id: 0,
    email: '',
    username: '',
    actual_cost: otherActualCost,
    requests: otherRequests,
    tokens: otherTokens,
    isOther: true
  }
})

const rankingDisplayItems = computed<RankingDisplayItem[]>(() => {
  if (!props.rankingItems?.length) return []
  return otherRankingItem.value
    ? [...props.rankingItems, otherRankingItem.value]
    : [...props.rankingItems]
})

const distributionTotalValue = computed(() => {
  const total = displayModelStats.value.reduce((sum, model) => {
    const value = props.metric === 'actual_cost' ? model.actual_cost : model.total_tokens
    return sum + toFiniteNumber(value)
  }, 0)
  return props.metric === 'actual_cost' ? `$${formatCost(total)}` : formatTokens(total)
})

const distributionTotalCaption = computed(() => (
  props.metric === 'actual_cost'
    ? t('admin.dashboard.actual')
    : t('admin.dashboard.tokens')
))

const rankingTotalValue = computed(() => formatCost(
  rankingDisplayItems.value.reduce((sum, item) => sum + toFiniteNumber(item.actual_cost), 0)
))

const doughnutOptions = computed(() => ({
  responsive: true,
  maintainAspectRatio: false,
  cutout: '80%',
  spacing: 1,
  plugins: {
    legend: {
      display: false
    },
    tooltip: {
      callbacks: {
        label: (context: any) => {
          const value = context.raw as number
          const total = context.dataset.data.reduce((a: number, b: number) => a + b, 0)
          const percentage = total > 0 ? ((value / total) * 100).toFixed(1) : '0.0'
          const formattedValue = props.metric === 'actual_cost'
            ? `$${formatCost(value)}`
            : formatTokens(value)
          return `${context.label}: ${formattedValue} (${percentage}%)`
        }
      }
    }
  }
}))

const rankingDoughnutOptions = computed(() => ({
  responsive: true,
  maintainAspectRatio: false,
  cutout: '80%',
  spacing: 1,
  plugins: {
    legend: {
      display: false
    },
    tooltip: {
      callbacks: {
        label: (context: any) => {
          const value = context.raw as number
          const total = context.dataset.data.reduce((a: number, b: number) => a + b, 0)
          const percentage = total > 0 ? ((value / total) * 100).toFixed(1) : '0.0'
          return `${context.label}: $${formatCost(value)} (${percentage}%)`
        }
      }
    }
  }
}))

const formatTokens = (value: number): string => {
  if (value >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(2)}B`
  } else if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(2)}M`
  } else if (value >= 1_000) {
    return `${(value / 1_000).toFixed(2)}K`
  }
  return value.toLocaleString()
}

const formatNumber = (value: number): string => {
  return toFiniteNumber(value).toLocaleString()
}

const getRankingUserLabel = (item: UserSpendingRankingItem): string => {
  if (item.username?.trim()) return item.username.trim()
  if (item.email?.trim()) return item.email.trim()
  return t('admin.redeem.userPrefix', { id: item.user_id })
}

const getRankingRowLabel = (item: RankingDisplayItem): string => {
  if (item.isOther) return t('admin.dashboard.spendingRankingOther')
  return getRankingUserLabel(item)
}

const toFiniteNumber = (value: unknown): number => {
  const numberValue = Number(value)
  return Number.isFinite(numberValue) ? numberValue : 0
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
</script>

<style scoped>
.model-distribution {
  --distribution-line: #ececf0;
  --distribution-soft: #f6f6f8;
  --distribution-ink: #1d1d1f;
  --distribution-muted: #77777f;
  --distribution-canvas: #fff;
  color: var(--distribution-ink);
}

.model-distribution__header {
  margin-bottom: 20px;
}

.model-distribution__header h3 {
  font-size: 15px;
  font-weight: 600;
  line-height: 1.35;
  letter-spacing: -.02em;
}

.model-distribution__toolbar {
  gap: 6px;
}

.model-distribution__segment {
  gap: 2px;
  padding: 3px;
  border-color: transparent;
  border-radius: 10px;
  background: var(--distribution-soft);
}

.model-distribution__segment-button {
  min-height: 28px;
  padding: 5px 10px;
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.25;
  letter-spacing: -.01em;
}

.model-distribution__content {
  display: grid;
  grid-template-columns: 176px minmax(0, 1fr);
  align-items: center;
  gap: 26px;
  min-width: 0;
}

.model-distribution__chart {
  position: relative;
  width: 176px;
  height: 176px;
}

.model-distribution__chart :deep(canvas) {
  position: relative;
  z-index: 1;
}

.model-distribution__chart-label {
  position: absolute;
  z-index: 2;
  inset: 50% auto auto 50%;
  display: flex;
  width: 88px;
  transform: translate(-50%, -50%);
  flex-direction: column;
  align-items: center;
  pointer-events: none;
  text-align: center;
}

.model-distribution__chart-label strong {
  max-width: 100%;
  overflow: hidden;
  color: var(--distribution-ink);
  font-size: 17px;
  font-weight: 600;
  line-height: 1.15;
  letter-spacing: -.04em;
  font-variant-numeric: tabular-nums;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-distribution__chart-label span {
  margin-top: 5px;
  color: var(--distribution-muted);
  font-size: 10px;
  line-height: 1.2;
}

.model-distribution__table-wrap {
  max-height: 252px;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}

.model-distribution__table {
  min-width: 500px;
  border-collapse: separate;
  border-spacing: 0;
  font-variant-numeric: tabular-nums;
}

.model-distribution__table thead {
  position: sticky;
  z-index: 3;
  top: 0;
  background: var(--distribution-canvas);
}

.model-distribution__table th {
  padding: 0 10px 10px 0;
  color: var(--distribution-muted);
  font-size: 11px;
  font-weight: 500;
  line-height: 1.3;
  letter-spacing: .015em;
  white-space: nowrap;
}

.model-distribution__table td {
  padding: 10px 10px 10px 0;
  font-size: 12px;
  line-height: 1.35;
  white-space: nowrap;
}

.model-distribution__table th:last-child,
.model-distribution__table td:last-child {
  padding-right: 4px;
}

.model-distribution__row {
  border-color: var(--distribution-line);
}

.model-distribution__row:hover {
  background: color-mix(in srgb, var(--distribution-soft) 72%, transparent);
}

.model-distribution__model {
  max-width: 180px;
  color: var(--distribution-ink) !important;
  font-weight: 500;
}

.model-distribution__model > span {
  gap: 7px;
  max-width: 100%;
}

.model-distribution__swatch {
  width: 7px;
  height: 7px;
  flex: 0 0 auto;
  border-radius: 999px;
  box-shadow: 0 0 0 2px var(--distribution-canvas);
}

.model-distribution__number {
  color: #55555b;
}

.model-distribution__actual {
  color: #247a4a !important;
  font-weight: 500;
}

.model-distribution__cost {
  color: #a46532 !important;
}

.model-distribution__standard {
  color: #929298 !important;
}

:global(.dark .model-distribution) {
  --distribution-line: #34343a;
  --distribution-soft: #242429;
  --distribution-ink: #f5f5f7;
  --distribution-muted: #a1a1a8;
  --distribution-canvas: #28282d;
}

:global(.dark .model-distribution__number) {
  color: #c5c5ca;
}

:global(.dark .model-distribution__actual) {
  color: #82c99d !important;
}

:global(.dark .model-distribution__cost) {
  color: #d7a16f !important;
}

:global(.dark .model-distribution__standard) {
  color: #85858d !important;
}

@media (max-width: 640px) {
  .model-distribution__header {
    align-items: flex-start;
    flex-direction: column;
  }

  .model-distribution__toolbar {
    width: 100%;
    justify-content: flex-start;
  }

  .model-distribution__content {
    grid-template-columns: minmax(0, 1fr);
  }

  .model-distribution__chart {
    width: 164px;
    height: 164px;
    margin: 0 auto;
  }
}

@media (prefers-reduced-motion: reduce) {
  .model-distribution__row,
  .model-distribution__segment-button {
    transition: none;
  }
}
</style>
