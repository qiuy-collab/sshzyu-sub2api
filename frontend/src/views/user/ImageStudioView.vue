<template>
  <AppLayout>
    <section class="image-studio" :class="{ 'has-task': showTask }" :aria-label="t('imageStudio.title')">
      <div class="studio-topbar">
        <div class="studio-document-name">
          <input v-model="board.title" maxlength="200" :disabled="!ready" :aria-label="t('imageStudio.boardName')" @focus="remember" @blur="normalizeTitle" />
          <span class="studio-save-state" :class="{ 'is-error': saveState === 'error' }" aria-live="polite">
            <span class="studio-save-dot" />{{ t(saveState === 'error' ? 'imageStudio.saveFailed' : saveState === 'saved' ? 'imageStudio.saved' : 'imageStudio.saving') }}
          </span>
        </div>
        <div class="studio-document-actions">
          <button class="studio-button studio-icon-button" :title="t('imageStudio.newBoard')" :aria-label="t('imageStudio.newBoard')" :disabled="!ready || generation.busy || fileBusy || preparingGeneration" @click="newBoard"><Icon name="plus" /></button>
          <button class="studio-button studio-file-button" :disabled="!ready || generation.busy || fileBusy || preparingGeneration" :title="t('imageStudio.import')" @click="importInput?.click()"><Icon name="upload" /><span>{{ t('imageStudio.import') }}</span></button>
          <button class="studio-button studio-file-button" :disabled="!ready || fileBusy" :title="t('imageStudio.export')" @click="exportBoard"><Icon name="download" /><span>{{ t('imageStudio.export') }}</span></button>
          <button ref="addGeneratorButton" class="studio-button studio-primary" :disabled="!ready" @click="addGenerator()"><Icon name="plus" /><span>{{ t('imageStudio.generateNode') }}</span></button>
        </div>
      </div>

      <div v-if="showTask" class="studio-task-status" :class="{ 'is-complete': generation.run?.delivered, 'has-error': !!generation.error }">
        <span v-if="taskAnimating" class="studio-spinner" aria-hidden="true" /><Icon v-else :name="generation.run?.delivered ? 'check' : 'photograph'" />
        <div class="studio-task-copy"><div><strong role="status">{{ runStatus }}</strong><span>{{ taskNode?.title || t('imageStudio.run') }}</span><time v-if="taskBusy">{{ elapsedLabel }}</time></div><p v-if="generation.error" role="alert">{{ generation.error }}<span v-if="generation.retryingDelivery"> · {{ t('imageStudio.autoRetry') }}</span></p><p v-else>{{ taskHint }}</p></div>
        <div class="studio-task-actions">
          <button v-if="runResult" class="studio-button" @click="revealResult">{{ t('imageStudio.viewResult') }}<Icon name="arrowRight" /></button>
          <button v-else-if="taskNode" class="studio-button" @click="openGenerator(taskNode)">{{ t('imageStudio.viewTask') }}</button>
          <button v-if="generation.run?.batchId && generation.busy" class="studio-button studio-icon-button" :disabled="generation.polling" :aria-label="t('imageStudio.refresh')" :title="t('imageStudio.refresh')" @click="generation.refresh()"><Icon name="refresh" /></button>
          <button v-if="canResolveSubmission" class="studio-button" @click="generation.retrySubmission()">{{ t('imageStudio.retry') }}</button>
          <router-link v-if="!taskNode && !runResult" class="studio-button" to="/batch-image">{{ t('imageStudio.jobs') }}</router-link>
        </div>
      </div>

      <div ref="canvas" class="studio-canvas" :class="{ 'is-connecting': tool === 'connect', 'is-panning': gesture?.kind === 'pan', 'is-drag-over': dragOver }"
        :style="gridStyle" tabindex="0" :aria-label="t('imageStudio.title')"
        @pointerdown="startPan" @pointermove="pointerMove" @pointerup="endGesture" @pointercancel="endGesture"
        @wheel="wheel" @keydown="keyboard" @dragover.prevent="dragOver = true" @dragleave.self="dragOver = false" @drop.prevent="dropImages"
      >
        <div v-if="!ready" class="studio-empty"><p>{{ storageError || t('imageStudio.loading') }}</p></div>
        <template v-else>
          <div v-if="!board.nodes.length" class="studio-empty">
            <svg class="studio-empty-mark" viewBox="0 0 180 100" fill="none" aria-hidden="true"><rect x="2" y="8" width="52" height="42" rx="12"/><path d="M16 23h24M16 31h17"/><rect x="2" y="60" width="52" height="36" rx="12"/><path d="m15 84 9-11 7 8 7-7 5 10"/><path d="M55 29c34 0 26 22 58 22M55 78c34 0 26-27 58-27"/><rect x="115" y="25" width="62" height="53" rx="15"/><path d="m138 41 15 10-15 10V41Z"/></svg>
            <h2>{{ t('imageStudio.emptyTitle') }}</h2>
            <p>{{ t('imageStudio.emptyDescription') }}</p>
            <div class="studio-empty-actions"><button class="studio-button" @click="addText"><span class="studio-text-icon">T</span>{{ t('imageStudio.addText') }}</button><button class="studio-button" @click="imageInput?.click()"><Icon name="photograph" />{{ t('imageStudio.addImage') }}</button></div>
            <span class="studio-empty-flow">{{ t('imageStudio.emptyStep') }}</span>
          </div>

          <div class="studio-world" :style="worldStyle">
            <svg class="studio-connections" aria-label="Connections">
              <defs><marker id="studio-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 1 L 9 5 L 0 9" fill="none" stroke="currentColor" stroke-width="1.6" /></marker></defs>
              <g v-for="edge in renderedEdges" :key="edge.id" :class="['studio-edge', { 'is-selected': selectedEdgeId === edge.id, 'is-output': edge.output }]">
                <path :d="edge.path" class="studio-edge-line" marker-end="url(#studio-arrow)" />
                <path v-if="!edge.output" :d="edge.path" class="studio-edge-hit" tabindex="0" role="button" :aria-label="`${t('imageStudio.connection')}: ${edge.label}`" @click.stop="selectEdge(edge.id)" @keydown.enter.prevent="selectEdge(edge.id)" @keydown.delete.prevent.stop="removeEdge(edge.id)" @keydown.backspace.prevent.stop="removeEdge(edge.id)" />
              </g>
              <path v-if="previewConnection" :d="previewConnection" class="studio-edge-line studio-edge-preview" />
            </svg>
            <article v-for="node in board.nodes" :key="node.id" :data-node-id="node.id" :data-node-type="node.type"
              class="studio-node" :class="[`studio-node-${node.type}`, { 'is-selected': selectedId === node.id, 'is-source': connectSource === node.id, 'is-generating': isNodeRunning(node.id) }]"
              :style="{ transform: `translate(${node.position.x}px, ${node.position.y}px)`, height: `${studioNodeHeight(node.type)}px` }"
              tabindex="0" :aria-label="`${nodeLabel(node.type)}: ${node.title}`" @click.stop="nodeClick(node)" @keydown.enter.self.prevent="nodeClick(node)"
            >
              <div class="studio-node-header" @pointerdown.stop="startNodeDrag($event, node)">
                <span class="studio-node-kind"><span v-if="node.type === 'text'" class="studio-text-icon">T</span><Icon v-else :name="node.type === 'generate' ? 'play' : 'photograph'" /></span>
                <input v-model="node.title" maxlength="200" :aria-label="t('imageStudio.nodeTitle')" @pointerdown.stop @click.stop @focus="focusNodeEditor(node)" />
                <button class="studio-grip" :aria-label="t('imageStudio.moveNode')" :title="t('imageStudio.moveNode')" tabindex="-1">⠿</button>
              </div>
              <template v-if="node.type === 'text'">
                <textarea v-model="node.data.text" maxlength="20000" class="studio-note-text" :placeholder="t('imageStudio.textPlaceholder')" :aria-label="t('imageStudio.text')" @pointerdown.stop @click.stop @focus="focusNodeEditor(node)" />
                <div class="studio-node-footer"><span>{{ node.data.text.length }} / 20000</span><button :title="t('imageStudio.connectFrom')" @click.stop="beginConnection(node.id)"><Icon name="link" />{{ t('imageStudio.connect') }}</button></div>
              </template>
              <template v-else-if="node.type === 'generate'">
                <div class="studio-generator-body"><span class="studio-generator-label">{{ node.data.model || t('imageStudio.generateNode') }}</span><p>{{ generatorPreview(node) || t('imageStudio.generatorHint') }}</p><div v-if="isNodeRunning(node.id)" class="studio-node-progress"><span v-if="taskAnimating" class="studio-spinner" aria-hidden="true" /><strong>{{ runStatus }}</strong><time>{{ elapsedLabel }}</time><span v-if="taskAnimating" class="studio-activity-track" aria-hidden="true" /></div><div v-else class="studio-input-summary"><span>{{ incomingCount(node.id) }} {{ t('imageStudio.source') }}</span><span>{{ node.data.aspectRatio || '1:1' }}</span></div></div>
                <button class="studio-generator-action" @click.stop="openGenerator(node)"><span v-if="isNodeRunning(node.id) && taskAnimating" class="studio-spinner" aria-hidden="true" /><Icon v-else name="play" />{{ t(isNodeRunning(node.id) ? 'imageStudio.viewTask' : 'imageStudio.configure') }}</button>
              </template>
              <template v-else>
                <div class="studio-image-area">
                  <img v-if="imageSource(node.data.images[0])" :src="imageSource(node.data.images[0])" :alt="node.title" draggable="false" referrerpolicy="no-referrer" @error="onImageError" />
                  <span v-else>{{ t('imageStudio.missingImage') }}</span>
                  <span v-if="node.data.images.length > 1" class="studio-image-count">+{{ node.data.images.length - 1 }}</span>
                </div>
                <div class="studio-node-footer"><button :title="t('imageStudio.download')" :aria-label="t('imageStudio.download')" @click.stop="downloadImage(node)"><Icon name="download" /></button><button @click.stop="continueFrom(node)">{{ t('imageStudio.continue') }}<Icon name="arrowRight" /></button></div>
              </template>
              <button v-if="node.type === 'generate'" class="studio-port studio-port-in" :title="t('imageStudio.connectTo')" :aria-label="t('imageStudio.connectTo')" @click.stop="completeConnection(node.id)"><span /></button>
              <button v-else class="studio-port studio-port-out" :title="t('imageStudio.connectFrom')" :aria-label="t('imageStudio.connectFrom')" @pointerdown.stop="startConnectionDrag($event, node)" @click.stop="beginConnection(node.id)"><span /></button>
            </article>
          </div>

          <div class="studio-palette" role="toolbar" :aria-label="t('imageStudio.title')">
            <button class="studio-tool" :class="{ 'is-active': tool === 'select' }" :title="t('imageStudio.select')" :aria-label="t('imageStudio.select')" :aria-pressed="tool === 'select'" @click="tool = 'select'; connectSource = ''"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m5 3 14 10-7 1-4 7L5 3Z" /></svg></button>
            <span class="studio-tool-divider" />
            <button class="studio-tool" :title="t('imageStudio.addText')" :aria-label="t('imageStudio.addText')" @click="addText"><span class="studio-text-icon">T</span></button>
            <button class="studio-tool" :title="t('imageStudio.addImage')" :aria-label="t('imageStudio.addImage')" @click="imageInput?.click()"><Icon name="photograph" /></button>
            <button class="studio-tool" :class="{ 'is-active': tool === 'connect' }" :title="t('imageStudio.connect')" :aria-label="t('imageStudio.connect')" :aria-pressed="tool === 'connect'" @click="toggleConnect"><Icon name="link" /></button>
            <span class="studio-tool-divider" />
            <button class="studio-tool" :disabled="!undoStack.length" :title="t('imageStudio.undo')" :aria-label="t('imageStudio.undo')" @click="undo"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m8 4-5 5 5 5M3 9h11a6 6 0 0 1 0 12"/></svg></button>
            <button class="studio-tool" :disabled="!redoStack.length" :title="t('imageStudio.redo')" :aria-label="t('imageStudio.redo')" @click="redo"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m16 4 5 5-5 5m5-5H10a6 6 0 0 0 0 12"/></svg></button>
            <button class="studio-tool" :disabled="!selectedId && !selectedEdgeId" :title="t('imageStudio.delete')" :aria-label="t('imageStudio.delete')" @click="removeSelection"><Icon name="trash" /></button>
          </div>
          <div v-if="tool === 'connect'" class="studio-connect-hint" role="status"><Icon name="link" />{{ t(connectSource ? 'imageStudio.targetHint' : 'imageStudio.connectHint') }}<button :aria-label="t('imageStudio.close')" @click="tool = 'select'; connectSource = ''"><Icon name="x" /></button></div>
          <div class="studio-canvas-footer"><span class="studio-desktop-help">{{ t('imageStudio.help') }}</span><span class="studio-mobile-help">{{ t('imageStudio.helpMobile') }}</span></div>
          <div class="studio-zoom-controls"><button :title="t('imageStudio.fit')" :aria-label="t('imageStudio.fit')" @click="fit"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/></svg></button><span /><button :aria-label="t('imageStudio.zoomOut')" @click="zoomBy(0.8)">−</button><button class="studio-zoom-value" :title="t('imageStudio.resetZoom')" @click="setZoom(1)">{{ Math.round(board.viewport.zoom * 100) }}%</button><button :aria-label="t('imageStudio.zoomIn')" @click="zoomBy(1.25)">+</button></div>
        </template>

        <aside v-if="activeGenerator" class="studio-inspector" :aria-label="t('imageStudio.configure')" @pointerdown.stop @wheel.stop @keydown.stop @keydown.esc="closeInspector">
          <header><div><span>{{ t('imageStudio.generateNode') }}</span><h2>{{ activeGenerator.title }}</h2></div><button class="studio-button studio-icon-button" :aria-label="t('imageStudio.close')" @click="closeInspector"><Icon name="x" /></button></header>
          <form @submit.prevent="generateImage">
            <div class="studio-inspector-scroll">
              <label class="studio-field"><span>{{ t('imageStudio.promptExtra') }}</span><textarea v-model="activeGenerator.data.prompt" rows="3" maxlength="20000" :placeholder="t('imageStudio.promptExtraPlaceholder')" @focus="remember" /></label>
              <div class="studio-prompt-preview"><div><span>{{ t('imageStudio.preview') }}</span><span :class="{ 'is-error': promptBytes > 8000 }">{{ promptBytes }} / 8000 B</span></div><p>{{ resolvedInputs.prompt || t('imageStudio.noPrompt') }}</p></div>
              <div class="studio-references"><span>{{ t('imageStudio.inputImages') }} <small>{{ resolvedInputs.images.length }}</small></span><p v-if="!resolvedInputs.images.length">{{ t('imageStudio.noImages') }}</p><div v-else class="studio-reference-strip"><img v-for="refImage in resolvedInputs.images" :key="refImage.id" :src="imageSource(refImage)" :alt="refImage.name || t('imageStudio.reference')" referrerpolicy="no-referrer" /></div></div>
              <p v-if="inputError" class="studio-error" role="alert">{{ inputError }}</p>
              <template v-if="generation.keys.length">
                <label class="studio-field"><span>{{ t('imageStudio.key') }}</span><select v-model="generation.selectedKeyId" :disabled="generation.busy || generation.loading || preparingGeneration"><option v-for="key in generation.keys" :key="key.id" :value="key.id">{{ key.name }}</option></select></label>
                <label class="studio-field"><span>{{ t('imageStudio.model') }}</span><select v-model="activeGenerator.data.model" :disabled="generation.loading || generation.loadingModels" @focus="remember"><option v-if="!generation.models.length" value="">{{ t('imageStudio.noModels') }}</option><option v-for="model in generation.models" :key="model.id" :value="model.id">{{ model.id }}</option></select></label>
                <div class="studio-field-pair"><label class="studio-field"><span>{{ t('imageStudio.size') }}</span><select v-model="activeGenerator.data.imageSize" @focus="remember"><option v-for="size in availableSizes" :key="size" :value="size">{{ size }}</option></select></label><label class="studio-field"><span>{{ t('imageStudio.ratio') }}</span><select v-model="activeGenerator.data.aspectRatio" @focus="remember"><option v-for="ratio in availableRatios" :key="ratio" :value="ratio">{{ ratio }}</option></select></label></div>
              </template>
              <p v-else-if="!generation.loading" class="studio-no-key">{{ t('imageStudio.noKey') }} <router-link to="/keys">{{ t('imageStudio.manageKeys') }} →</router-link></p>
              <div v-if="generation.run && isActiveRun" class="studio-run"><div class="studio-run-title"><span>{{ t('imageStudio.run') }}</span><strong><span v-if="taskAnimating" class="studio-spinner" aria-hidden="true" />{{ runStatus }}</strong></div><p>{{ generation.run.batchId || t('imageStudio.uncertain') }}</p><div v-if="generation.run.job?.actual_cost != null">{{ t('imageStudio.cost') }} <strong>${{ generation.run.job.actual_cost.toFixed(4) }}</strong></div><div class="studio-run-actions"><button v-if="canResolveSubmission" type="button" @click="generation.retrySubmission()">{{ t('imageStudio.retry') }}</button><button v-if="generation.run.batchId" type="button" :disabled="generation.polling" @click="generation.refresh()">{{ t('imageStudio.refresh') }}</button><button v-if="canCancelRun" type="button" :disabled="generation.cancelling" @click="cancelRun">{{ t('imageStudio.cancel') }}</button></div></div>
              <p v-if="attemptError?.nodeId === activeGenerator.id || generation.error && (!generation.run || isActiveRun)" class="studio-error" role="alert">{{ attemptError?.nodeId === activeGenerator.id ? attemptError.message : generation.error }}</p>
              <router-link class="studio-jobs-link" to="/batch-image">{{ t('imageStudio.jobs') }}<Icon name="arrowRight" /></router-link>
            </div>
            <footer><p>{{ t('imageStudio.charge') }}</p><button class="studio-button studio-primary" type="submit" :disabled="!canGenerate"><span v-if="isNodeRunning(activeGenerator.id) && taskAnimating" class="studio-spinner" aria-hidden="true" /><Icon v-else name="play" />{{ taskBusy ? isNodeRunning(activeGenerator.id) ? runStatus : t('imageStudio.waitForTask') : t('imageStudio.generate') }}</button><small>{{ t(taskBusy ? isActiveRun ? 'imageStudio.editNextRun' : 'imageStudio.editWhileGenerating' : 'imageStudio.waitHint') }}</small></footer>
          </form>
        </aside>
      </div>
      <div class="studio-bottom-note"><span>{{ t('imageStudio.localNotice') }}</span><span>{{ t('imageStudio.nodeCount', { count: board.nodes.length }) }}</span></div>
      <div v-if="notice" class="studio-toast" role="status">{{ notice }}<button :aria-label="t('imageStudio.close')" @click="notice = ''"><Icon name="x" /></button></div>
      <input ref="imageInput" type="file" class="sr-only" accept="image/png,image/jpeg,image/webp" multiple tabindex="-1" @change="pickImages" />
      <input ref="importInput" type="file" class="sr-only" accept="application/json,.json" tabindex="-1" @change="importBoard" />
    </section>
  </AppLayout>
</template>

<script setup lang="ts">
import { computed, ref, reactive, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { onBeforeRouteLeave, useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import AppLayout from '@/components/layout/AppLayout.vue'
import Icon from '@/components/icons/Icon.vue'
import { useAuthStore } from '@/stores/auth'
import { useImageStudioGeneration, imageStudioReferenceLimit } from '@/composables/useImageStudioGeneration'
import { createStudioDocument, createStudioNode, connectNodes, removeStudioNode, resolveGenerationInputs, type ImageStudioDocument, type ImageStudioNode, type ImageStudioNodeFor, type ImageStudioImageRef } from '@/utils/imageStudioGraph'
import { createImageStudioStorage, IMAGE_STUDIO_MAX_PORTABLE_JSON_BYTES } from '@/utils/imageStudioStorage'
import { acquireImageStudioTabLock } from '@/utils/imageStudioTabLock'
import { parseImageStudioKeyId } from '@/utils/imageStudioKeyHandoff'
import { fitStudioNodes, studioNodeHeight, studioWorldPoint, studioEdgePath, zoomStudioAt, type StudioPoint } from '@/utils/imageStudioGeometry'
import { openAIImageSizes } from '@/utils/batchImage'
import { saveBlob } from '@/api/batchImage'
import '@/styles/image-studio.css'

const { t } = useI18n()
const auth = useAuthStore()
const route = useRoute()
const ownerId = auth.user!.id
const storage = createImageStudioStorage(ownerId)
const board = ref<ImageStudioDocument>(createStudioDocument('default', t('imageStudio.untitled')))
const ready = ref(false)
const storageError = ref('')
const saveState = ref<'saved' | 'saving' | 'error'>('saved')
const canvas = ref<HTMLDivElement>()
const imageInput = ref<HTMLInputElement>()
const importInput = ref<HTMLInputElement>()
const addGeneratorButton = ref<HTMLButtonElement>()
const selectedId = ref('')
const selectedEdgeId = ref('')
const inspectorId = ref('')
const connectSource = ref('')
const tool = ref<'select' | 'connect'>('select')
const dragOver = ref(false)
const fileBusy = ref(false)
const preparingGeneration = ref(false)
const preparingNodeId = ref('')
const preparingStartedAt = ref(0)
const attemptError = ref<{ nodeId: string; message: string } | null>(null)
const visibleTaskId = ref('')
const clockNow = ref(Date.now())
const notice = ref('')
const urls = reactive<Record<string, string>>({})
const undoStack = ref<string[]>([])
const redoStack = ref<string[]>([])
let saveTimer: ReturnType<typeof setTimeout> | undefined
let noticeTimer: ReturnType<typeof setTimeout> | undefined
let elapsedTimer: ReturnType<typeof setInterval> | undefined
let saveQueue: Promise<void> = Promise.resolve()
let version = 0
let disposed = false
let releaseTabLock: (() => void) | undefined
type Gesture = { kind: 'pan' | 'node' | 'connect'; pointerId: number; start: StudioPoint; origin: StudioPoint; nodeId?: string }
const gesture = ref<Gesture | null>(null)
const connectionPointer = ref<StudioPoint | null>(null)
const generation = reactive(useImageStudioGeneration({ userId: ownerId, preferredKeyId: parseImageStudioKeyId(route.query.keyId), onImage: addGeneratedImage }))
const activeGenerator = computed(() => board.value.nodes.find((n): n is ImageStudioNodeFor<'generate'> => n.id === inspectorId.value && n.type === 'generate'))
const resolved = computed(() => {
  if (!activeGenerator.value) return { value: { prompt: '', images: [] as ImageStudioImageRef[], sourceNodeIds: [] as string[] }, error: '' }
  try { return { value: resolveGenerationInputs(board.value, activeGenerator.value.id), error: '' } }
  catch (error) { return { value: { prompt: '', images: [] as ImageStudioImageRef[], sourceNodeIds: [] as string[] }, error: errorText(error) } }
})
const resolvedInputs = computed(() => resolved.value.value)
const inputError = computed(() => resolved.value.error || (activeGenerator.value?.data.model && resolvedInputs.value.images.length > imageStudioReferenceLimit(activeGenerator.value.data.model) ? t('imageStudio.tooManyReferences', { count: imageStudioReferenceLimit(activeGenerator.value.data.model) }) : ''))
const promptBytes = computed(() => new TextEncoder().encode(resolvedInputs.value.prompt).length)
const activeModel = computed(() => generation.models.find(m => m.id === activeGenerator.value?.data.model))
const isOpenAI = computed(() => generation.keys.find(k => k.id === Number(generation.selectedKeyId))?.group?.platform === 'openai')
const availableSizes = computed(() => !isOpenAI.value ? ['1K'] : activeModel.value?.supported_image_sizes?.length ? activeModel.value.supported_image_sizes.filter(size => size in openAIImageSizes) : ['1K', '2K', '4K'])
const availableRatios = computed(() => isOpenAI.value ? Object.keys(openAIImageSizes[activeGenerator.value?.data.imageSize || '1K'] || { '1:1': '' }) : ['1:1'])
const canGenerate = computed(() => ready.value && !fileBusy.value && !preparingGeneration.value && !generation.busy && !generation.loading && !generation.loadingModels && !!generation.selectedKeyId && !!activeModel.value && !!resolvedInputs.value.prompt.trim() && promptBytes.value <= 8000 && !inputError.value && board.value.nodes.length < 200 && saveState.value !== 'error')
const taskBusy = computed(() => preparingGeneration.value || generation.busy)
const taskContextId = computed(() => preparingGeneration.value ? preparingNodeId.value : generation.run?.contextId)
const taskNode = computed(() => board.value.nodes.find((node): node is ImageStudioNodeFor<'generate'> => node.type === 'generate' && node.id === taskContextId.value))
const runResult = computed(() => preparingGeneration.value ? undefined : board.value.nodes.find((node): node is ImageStudioNodeFor<'result'> => node.type === 'result' && !!generation.run?.batchId && node.data.batchId === generation.run.batchId))
const showTask = computed(() => ready.value && (taskBusy.value || !!generation.run && (!!taskNode.value || !!runResult.value || visibleTaskId.value === generation.run.idempotencyKey)))
const isActiveRun = computed(() => !!activeGenerator.value && activeGenerator.value.id === generation.run?.contextId)
const needsResultRecovery = computed(() => generation.run?.status === 'completed' && !generation.run.delivered && !generation.outputFailed && !!generation.error && !generation.receiving && !generation.retryingDelivery)
const taskAnimating = computed(() => preparingGeneration.value || taskBusy.value && !generation.outputFailed && !['uncertain', 'failed', 'cancelled', 'output_deleted'].includes(generation.run?.status || '') && !needsResultRecovery.value)
const canResolveSubmission = computed(() => !!generation.run && !generation.run.batchId && ['submitting', 'uncertain'].includes(generation.run.status) && !generation.submitting && !preparingGeneration.value)
const canCancelRun = computed(() => !!generation.run?.batchId && !['completed', 'failed', 'cancelled', 'output_deleted'].includes(generation.run.status))
const elapsedLabel = computed(() => {
  const start = preparingGeneration.value ? preparingStartedAt.value : generation.run?.createdAt || clockNow.value
  const seconds = Math.max(0, Math.floor((clockNow.value - start) / 1000))
  return t('imageStudio.elapsed', { time: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` })
})
const runStatus = computed(() => {
  if (preparingGeneration.value) return t('imageStudio.preparing')
  if (generation.cancelling) return t('imageStudio.cancelling')
  if (generation.outputFailed) return t('imageStudio.generationFailed')
  const status = generation.run?.status
  if (status === 'uncertain') return t('imageStudio.uncertainStatus')
  if (status === 'submitting') return t('imageStudio.submitting')
  if (status === 'completed') {
    if (generation.run?.delivered) return t('imageStudio.completed')
    if (generation.retryingDelivery) return t('imageStudio.retryingImage')
    if (needsResultRecovery.value) return t('imageStudio.awaitingRecovery')
    return t('imageStudio.receivingImage')
  }
  if (status === 'failed' || status === 'output_deleted') return t('imageStudio.generationFailed')
  if (status === 'cancelled') return t('imageStudio.cancelled')
  if (status === 'queued') return t('imageStudio.queued')
  if (status === 'running') return t('imageStudio.generatingImage')
  if (['indexing', 'processing_results', 'settling'].includes(status || '')) return t('imageStudio.finishingImage')
  return t('imageStudio.pending')
})
const taskHint = computed(() => {
  if (generation.run?.delivered && !preparingGeneration.value) return t('imageStudio.resultReady')
  if (generation.outputFailed) return t('imageStudio.generationFailedHint')
  if (generation.run?.status === 'uncertain') return t('imageStudio.uncertain')
  if (generation.run?.status === 'cancelled') return t('imageStudio.cancelledHint')
  if (['failed', 'output_deleted'].includes(generation.run?.status || '')) return t('imageStudio.generationFailedHint')
  return t('imageStudio.backgroundHint')
})
watch(taskBusy, busy => {
  clearInterval(elapsedTimer)
  clockNow.value = Date.now()
  if (busy) elapsedTimer = setInterval(() => { clockNow.value = Date.now() }, 1000)
}, { immediate: true })
watch([() => generation.run?.idempotencyKey, taskBusy], () => {
  if (generation.run && (taskBusy.value || taskNode.value || runResult.value)) visibleTaskId.value = generation.run.idempotencyKey
  if (preparingGeneration.value && generation.run?.contextId === preparingNodeId.value && generation.run.createdAt >= preparingStartedAt.value) preparingGeneration.value = false
})
function isNodeRunning(id: string) { return taskBusy.value && taskContextId.value === id }
const worldStyle = computed(() => ({ transform: `translate(${board.value.viewport.x}px, ${board.value.viewport.y}px) scale(${board.value.viewport.zoom})` }))
const gridStyle = computed(() => ({ backgroundSize: `${24 * board.value.viewport.zoom}px ${24 * board.value.viewport.zoom}px`, backgroundPosition: `${board.value.viewport.x}px ${board.value.viewport.y}px` }))
const renderedEdges = computed(() => {
  const edges = board.value.edges.map(e => ({ ...e, output: false }))
  for (const n of board.value.nodes) if (n.type === 'result' && n.data.generateNodeId) edges.push({ id: `output-${n.id}`, source: n.data.generateNodeId, target: n.id, output: true })
  return edges.flatMap(edge => {
    const from = board.value.nodes.find(n => n.id === edge.source), to = board.value.nodes.find(n => n.id === edge.target)
    if (!from || !to) return []
    return [{ ...edge, label: `${from.title} → ${to.title}`, path: studioEdgePath({ x: from.position.x + 280, y: from.position.y + studioNodeHeight(from.type) / 2 }, { x: to.position.x, y: to.position.y + studioNodeHeight(to.type) / 2 }) }]
  })
})
const previewConnection = computed(() => {
  const from = board.value.nodes.find(n => n.id === connectSource.value)
  return from && connectionPointer.value ? studioEdgePath({ x: from.position.x + 280, y: from.position.y + studioNodeHeight(from.type) / 2 }, connectionPointer.value) : ''
})

function errorText(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  const messages: Record<string, string> = { CYCLE: 'cycle', INCOMPATIBLE_CONNECTION: 'invalidConnection', DUPLICATE_CONNECTION: 'duplicateConnection', MISSING_IMAGE: 'missingImage', QUOTA_EXCEEDED: 'saveFailed' }
  return messages[code] ? t(`imageStudio.${messages[code]}`) : error instanceof Error ? error.message : t('imageStudio.failed')
}
function ensureActive() { if (disposed || auth.user?.id !== ownerId) throw new Error(t('imageStudio.storageRequired')) }
function notify(message: string) { notice.value = message; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { notice.value = '' }, 6500) }
function nodeLabel(type: string) { return t(`imageStudio.${type === 'generate' ? 'generateNode' : type}`) }
function snapshot() { return JSON.stringify(board.value) }
function remember() {
  const value = snapshot()
  if (undoStack.value[undoStack.value.length - 1] !== value) undoStack.value.push(value)
  if (undoStack.value.length > 30) undoStack.value.shift()
  redoStack.value = []
}
function undo() { const old = undoStack.value.pop(); if (!old) return; redoStack.value.push(snapshot()); board.value = JSON.parse(old); reconcileSelection(); void hydrateImages() }
function redo() { const next = redoStack.value.pop(); if (!next) return; undoStack.value.push(snapshot()); board.value = JSON.parse(next); reconcileSelection(); void hydrateImages() }
function reconcileSelection() { if (!board.value.nodes.some(n => n.id === selectedId.value)) selectedId.value = ''; if (!board.value.nodes.some(n => n.id === inspectorId.value)) inspectorId.value = ''; selectedEdgeId.value = ''; connectSource.value = ''; tool.value = 'select' }
function normalizeTitle() { if (!board.value.title.trim()) board.value.title = t('imageStudio.untitled') }
async function flushSave(): Promise<boolean> {
  clearTimeout(saveTimer)
  if (!ready.value) return false
  const captured = JSON.parse(snapshot()) as ImageStudioDocument
  captured.updatedAt = Date.now()
  const current = version
  saveState.value = 'saving'
  let success = true
  saveQueue = saveQueue.catch(() => {}).then(async () => {
    try { await storage.saveDocument(captured); if (current === version) saveState.value = 'saved' }
    catch (error) { success = false; saveState.value = 'error'; notify(`${t('imageStudio.saveFailed')} · ${errorText(error)}`) }
  })
  await saveQueue
  return success
}
watch(board, () => { if (!ready.value) return; version++; saveState.value = 'saving'; clearTimeout(saveTimer); saveTimer = setTimeout(() => { void flushSave() }, 400) }, { deep: true })
watch([activeGenerator, () => generation.models, availableSizes, availableRatios], () => {
  const data = activeGenerator.value?.data
  if (!data || generation.loading || generation.loadingModels) return
  if (!generation.models.some(m => m.id === data.model)) data.model = generation.models[0]?.id || ''
  if (!availableSizes.value.includes(data.imageSize)) data.imageSize = availableSizes.value[0] || '1K'
  if (!availableRatios.value.includes(data.aspectRatio)) data.aspectRatio = availableRatios.value[0] || '1:1'
})
function canvasPoint(event: { clientX: number; clientY: number }): StudioPoint { const rect = canvas.value!.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top } }
function centerPoint(): StudioPoint { return { x: (canvas.value?.clientWidth || 900) / 2 - (activeGenerator.value ? 120 : 0), y: (canvas.value?.clientHeight || 640) / 2 } }
function newPosition(): StudioPoint {
  const start = studioWorldPoint({ x: 98, y: 76 }, board.value.viewport)
  // Prefer open space in the visible canvas, then extend the board horizontally.
  for (let column = 0; column < 100; column++) for (let row = 0; row < 2; row++) {
    const p = { x: start.x + column * 370, y: start.y + row * 364 }
    if (!board.value.nodes.some(n => p.x < n.position.x + 310 && p.x + 310 > n.position.x && p.y < n.position.y + studioNodeHeight(n.type) + 28 && p.y + 340 > n.position.y)) return p
  }
  return start
}
function makeRoom() { if (board.value.nodes.length >= 200) { notify(t('imageStudio.maxNodes')); return false } return true }
function selectNode(node: ImageStudioNode) { selectedId.value = node.id; selectedEdgeId.value = ''; tool.value = 'select'; connectSource.value = ''; if (inspectorId.value !== node.id) inspectorId.value = '' }
function focusNodeEditor(node: ImageStudioNode) { selectNode(node); remember() }
function addText() { if (!ready.value || !makeRoom()) return; remember(); inspectorId.value = ''; const node = createStudioNode('text', newPosition(), { text: '' }, t('imageStudio.text')); board.value.nodes.push(node); selectNode(node); nextTick(() => canvas.value?.querySelector<HTMLTextAreaElement>(`[data-node-id="${node.id}"] textarea`)?.focus()) }
function addGenerator(position?: StudioPoint, source?: ImageStudioNode) {
  if (!ready.value || !makeRoom()) return
  remember()
  source ||= board.value.nodes.find(n => n.id === selectedId.value && n.type !== 'generate')
  const node = createStudioNode('generate', position || (source ? { x: source.position.x + 400, y: source.position.y } : newPosition()), { prompt: '', referenceImages: [], model: generation.models[0]?.id || '', imageSize: '1K', aspectRatio: '1:1', outputCount: 1 }, t('imageStudio.generateNode'))
  board.value.nodes.push(node)
  if (source) { try { board.value = connectNodes(board.value, source.id, node.id) } catch (error) { notify(errorText(error)) } }
  openGenerator(node)
  nextTick(fit)
}
function openGenerator(node: ImageStudioNodeFor<'generate'>) { selectedId.value = node.id; inspectorId.value = node.id; selectedEdgeId.value = ''; tool.value = 'select'; connectSource.value = '' }
function closeInspector() { inspectorId.value = ''; nextTick(() => addGeneratorButton.value?.focus()) }
function continueFrom(node: ImageStudioNode) { addGenerator({ x: node.position.x + 400, y: node.position.y + 24 }, node); fit() }
function nodeClick(node: ImageStudioNode) { if (tool.value === 'connect') { if (node.type === 'generate') completeConnection(node.id); else beginConnection(node.id); return } if (node.type === 'generate') openGenerator(node); else selectNode(node) }
function selectEdge(id: string) { selectedEdgeId.value = id; selectedId.value = ''; inspectorId.value = '' }
function beginConnection(id: string) { tool.value = 'connect'; connectSource.value = id; selectedId.value = id; inspectorId.value = '' }
function toggleConnect() { tool.value = tool.value === 'connect' ? 'select' : 'connect'; connectSource.value = ''; inspectorId.value = '' }
function completeConnection(id: string) {
  if (!connectSource.value) { tool.value = 'connect'; notify(t('imageStudio.connectHint')); return }
  try { const next = connectNodes(board.value, connectSource.value, id); remember(); board.value = next; tool.value = 'select'; connectSource.value = ''; notify(t('imageStudio.connected')) }
  catch (error) { notify(errorText(error)) }
}
function incomingCount(id: string) { return board.value.edges.filter(e => e.target === id).length }
function generatorPreview(node: ImageStudioNodeFor<'generate'>) { try { return resolveGenerationInputs(board.value, node.id).prompt } catch { return node.data.prompt } }
function removeEdge(id: string) { remember(); board.value.edges = board.value.edges.filter(e => e.id !== id); selectedEdgeId.value = '' }
function removeSelection() { if (selectedEdgeId.value) { removeEdge(selectedEdgeId.value); return } if (!selectedId.value) return; remember(); board.value = removeStudioNode(board.value, selectedId.value); reconcileSelection(); notify(t('imageStudio.deleted')) }
function startPan(event: PointerEvent) {
  if (event.button !== 0 && event.button !== 1) return
  if ((event.target as Element).closest('button,input,textarea,select,a,.studio-node,.studio-palette,.studio-zoom-controls,.studio-connect-hint,.studio-edge-hit')) return
  if (!ready.value) return
  event.preventDefault(); canvas.value?.focus({ preventScroll: true }); selectedId.value = ''; selectedEdgeId.value = ''
  gesture.value = { kind: 'pan', pointerId: event.pointerId, start: canvasPoint(event), origin: { ...board.value.viewport } }
  canvas.value?.setPointerCapture(event.pointerId)
}
function startNodeDrag(event: PointerEvent, node: ImageStudioNode) {
  if (event.button !== 0 || tool.value === 'connect') return
  event.preventDefault(); remember(); selectedId.value = node.id; selectedEdgeId.value = ''
  gesture.value = { kind: 'node', pointerId: event.pointerId, start: canvasPoint(event), origin: { ...node.position }, nodeId: node.id }
  canvas.value?.setPointerCapture(event.pointerId)
}
function startConnectionDrag(event: PointerEvent, node: ImageStudioNode) {
  if (event.button !== 0) return
  event.preventDefault()
  beginConnection(node.id)
  connectionPointer.value = studioWorldPoint(canvasPoint(event), board.value.viewport)
  gesture.value = { kind: 'connect', pointerId: event.pointerId, start: canvasPoint(event), origin: node.position, nodeId: node.id }
  canvas.value?.setPointerCapture(event.pointerId)
}
function pointerMove(event: PointerEvent) {
  const state = gesture.value
  if (!state || state.pointerId !== event.pointerId) return
  if (state.kind === 'connect') { connectionPointer.value = studioWorldPoint(canvasPoint(event), board.value.viewport); return }
  const p = canvasPoint(event), scale = state.kind === 'node' ? board.value.viewport.zoom : 1
  const position = { x: Math.max(-999000, Math.min(999000, state.origin.x + (p.x - state.start.x) / scale)), y: Math.max(-999000, Math.min(999000, state.origin.y + (p.y - state.start.y) / scale)) }
  if (state.kind === 'pan') board.value.viewport = { ...position, zoom: board.value.viewport.zoom }
  else { const node = board.value.nodes.find(n => n.id === state.nodeId); if (node) node.position = position }
}
function endGesture(event: PointerEvent) {
  if (gesture.value?.pointerId !== event.pointerId) return
  if (gesture.value.kind === 'connect' && event.type !== 'pointercancel') {
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-node-type="generate"]')
    if (target?.dataset.nodeId) completeConnection(target.dataset.nodeId)
  }
  gesture.value = null; connectionPointer.value = null
  if (canvas.value?.hasPointerCapture(event.pointerId)) canvas.value.releasePointerCapture(event.pointerId)
}
function wheel(event: WheelEvent) { if ((event.target as Element).closest('textarea,.studio-inspector')) return; event.preventDefault(); board.value.viewport = zoomStudioAt(board.value.viewport, canvasPoint(event), board.value.viewport.zoom * Math.exp(-event.deltaY * 0.0015)) }
function setZoom(zoom: number) { board.value.viewport = zoomStudioAt(board.value.viewport, centerPoint(), zoom) }
function zoomBy(factor: number) { setZoom(board.value.viewport.zoom * factor) }
function fit() { if (!canvas.value) return; const width = canvas.value.clientWidth - (activeGenerator.value && canvas.value.clientWidth > 720 ? 340 : 0); board.value.viewport = fitStudioNodes(board.value.nodes, width, canvas.value.clientHeight) }
function keyboard(event: KeyboardEvent) {
  if ((event.target as Element).closest('input,textarea,select,[contenteditable="true"]')) return
  if (event.key === 'Escape') { tool.value = 'select'; connectSource.value = ''; inspectorId.value = ''; return }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); return }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); return }
  if (['Delete', 'Backspace'].includes(event.key)) { event.preventDefault(); removeSelection(); return }
  const node = board.value.nodes.find(n => n.id === selectedId.value)
  if (node && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); if (!event.repeat) remember(); const step = event.shiftKey ? 20 : 4; node.position.x += event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0; node.position.y += event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0 }
}
function imageRefs() { return board.value.nodes.flatMap(n => n.type === 'reference' || n.type === 'result' ? n.data.images : n.type === 'generate' ? n.data.referenceImages : []) }
function imageSource(image?: ImageStudioImageRef) { return !image ? '' : image.kind === 'url' ? image.url : urls[image.assetId] || '' }
function onImageError(event: Event) { (event.target as HTMLImageElement).alt = t('imageStudio.missingImage') }
async function hydrateImages() { for (const refImage of imageRefs()) if (refImage.kind === 'asset' && !urls[refImage.assetId]) { const blob = await storage.getAsset(refImage.assetId); if (blob && !disposed) urls[refImage.assetId] = URL.createObjectURL(blob) } }
async function imageBlob(refImage: ImageStudioImageRef) { if (refImage.kind !== 'asset') throw new Error(t('imageStudio.localImageRequired')); const blob = await storage.getAsset(refImage.assetId); if (!blob) throw new Error(t('imageStudio.missingImage')); return blob }
async function assetFromBlob(blob: Blob, name: string) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(blob.type) || blob.size > 10 * 1024 * 1024) throw new Error(t('imageStudio.invalidImage'))
  const url = URL.createObjectURL(blob), img = new Image()
  img.src = url
  try { await img.decode(); ensureActive(); if (img.naturalWidth > 16384 || img.naturalHeight > 16384 || img.naturalWidth * img.naturalHeight > 100000000) throw new Error(t('imageStudio.invalidImage')); const refImage = await storage.putAsset(blob, { name, width: img.naturalWidth, height: img.naturalHeight }); ensureActive(); urls[refImage.assetId] = url; return refImage }
  catch (error) { URL.revokeObjectURL(url); throw error }
}
async function addFiles(files: File[], position?: StudioPoint) {
  if (!ready.value || fileBusy.value) return
  fileBusy.value = true
  inspectorId.value = ''; selectedEdgeId.value = ''; tool.value = 'select'; connectSource.value = ''
  remember()
  try { for (let i = 0; i < files.length; i++) { if (!makeRoom()) break; const file = files[i]; const asset = await assetFromBlob(file, file.name); const p = position || newPosition(); const node = createStudioNode('reference', { x: p.x + i * 312, y: p.y }, { images: [asset] }, file.name.replace(/\.[^.]+$/, '').slice(0, 200)); board.value.nodes.push(node); selectedId.value = node.id } await flushSave() }
  catch (error) { notify(errorText(error)) }
  finally { fileBusy.value = false }
}
function pickImages(event: Event) { const input = event.target as HTMLInputElement; const files = Array.from(input.files || []); input.value = ''; void addFiles(files) }
function dropImages(event: DragEvent) { dragOver.value = false; void addFiles(Array.from(event.dataTransfer?.files || []), studioWorldPoint(canvasPoint(event), board.value.viewport)) }
async function downloadImage(node: ImageStudioNode) { if (node.type !== 'result' && node.type !== 'reference') return; try { const image = node.data.images[0]; if (!image) return; const blob = await imageBlob(image); saveBlob(blob, `${node.title.replace(/[<>:"/\\|?*]/g, '_')}.${blob.type === 'image/jpeg' ? 'jpg' : blob.type.split('/')[1]}`) } catch (error) { notify(errorText(error)) } }
async function generateImage() {
  if (!canGenerate.value || !activeGenerator.value) return
  attemptError.value = null
  preparingGeneration.value = true
  const node = activeGenerator.value
  const previousRunId = generation.run?.idempotencyKey
  preparingNodeId.value = node.id
  preparingStartedAt.value = Date.now()
  const keyId = Number(generation.selectedKeyId)
  const settings = { model: node.data.model, imageSize: node.data.imageSize, aspectRatio: node.data.aspectRatio, contextId: node.id }
  try {
    const inputs = resolveGenerationInputs(board.value, node.id)
    const references: Blob[] = []
    for (const refImage of inputs.images) references.push(await imageBlob(refImage))
    if (!(await flushSave())) return
    ensureActive()
    if (Number(generation.selectedKeyId) !== keyId) throw new Error(t('imageStudio.keyChanged'))
    const pending = generation.generate({ ...settings, prompt: inputs.prompt, references })
    await pending
    if (generation.error && generation.run?.idempotencyKey === previousRunId) {
      attemptError.value = { nodeId: node.id, message: generation.error }
      notify(generation.error)
    }
  }
  catch (error) { notify(errorText(error)) }
  finally { preparingGeneration.value = false; preparingNodeId.value = '' }
}
async function addGeneratedImage(blob: Blob, meta: { batchId: string; customId: string; prompt: string; model: string; contextId?: string }) {
  if (disposed || auth.user?.id !== ownerId) throw new Error(t('imageStudio.storageRequired'))
  if (board.value.nodes.some(n => n.type === 'result' && n.data.batchId === meta.batchId && n.data.customId === meta.customId)) { if (!(await flushSave())) throw new Error(t('imageStudio.saveFailed')); return }
  if (!makeRoom()) throw new Error(t('imageStudio.maxNodes'))
  const asset = await assetFromBlob(blob, `${meta.model}-${meta.customId}`)
  // Users may edit, remove nodes or undo while the image decodes and is stored.
  if (board.value.nodes.some(n => n.type === 'result' && n.data.batchId === meta.batchId && n.data.customId === meta.customId)) { if (!(await flushSave())) throw new Error(t('imageStudio.saveFailed')); return }
  if (!makeRoom()) throw new Error(t('imageStudio.maxNodes'))
  const source = board.value.nodes.find(n => n.id === meta.contextId && n.type === 'generate')
  const preferred = source ? { x: source.position.x + 400, y: source.position.y } : newPosition()
  const overlaps = board.value.nodes.some(n => preferred.x < n.position.x + 310 && preferred.x + 310 > n.position.x && preferred.y < n.position.y + studioNodeHeight(n.type) + 28 && preferred.y + studioNodeHeight('result') + 28 > n.position.y)
  const node = createStudioNode('result', overlaps ? newPosition() : preferred, { images: [asset], prompt: meta.prompt, batchId: meta.batchId, customId: meta.customId, ...(source ? { generateNodeId: source.id } : {}) }, t('imageStudio.result'))
  remember(); board.value.nodes.push(node)
  await nextTick()
  if (!(await flushSave())) throw new Error(t('imageStudio.saveFailed'))
  // Delivery must not close a draft, change the selection, or move the viewport.
  notify(t('imageStudio.generated'))
}
function revealResult() {
  const node = runResult.value
  if (!node) return
  selectNode(node); inspectorId.value = ''
  nextTick(() => {
    const zoom = board.value.viewport.zoom
    board.value.viewport = { x: (canvas.value?.clientWidth || 900) / 2 - (node.position.x + 140) * zoom, y: (canvas.value?.clientHeight || 640) / 2 - (node.position.y + studioNodeHeight('result') / 2) * zoom, zoom }
    canvas.value?.querySelector<HTMLElement>(`[data-node-id="${node.id}"]`)?.focus({ preventScroll: true })
  })
}
async function cancelRun() { if (window.confirm(t('imageStudio.cancelConfirm'))) await generation.cancel() }
async function exportBoard() { fileBusy.value = true; try { const json = await storage.exportPortableDocument(JSON.parse(snapshot())); saveBlob(new Blob([json], { type: 'application/json' }), `${board.value.title.replace(/[<>:"/\\|?*]/g, '_') || 'canvas'}.sshzyu.json`); notify(t('imageStudio.exported')) } catch (error) { notify(errorText(error)) } finally { fileBusy.value = false } }
async function importBoard(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0]; input.value = ''
  if (!file || generation.busy || fileBusy.value || preparingGeneration.value) return
  if (file.size > IMAGE_STUDIO_MAX_PORTABLE_JSON_BYTES) { notify(t('imageStudio.fileTooLarge')); return }
  if (board.value.nodes.length && !window.confirm(t('imageStudio.importConfirm'))) return
  fileBusy.value = true
  try { await flushSave(); const json = await file.text(); ensureActive(); const imported = await storage.importPortableDocument(json, { documentId: 'default' }); ensureActive(); remember(); board.value = imported; visibleTaskId.value = ''; reconcileSelection(); await hydrateImages(); fit(); notify(t('imageStudio.imported')) }
  catch (error) { notify(errorText(error)) }
  finally { fileBusy.value = false }
}
async function newBoard() { if (generation.busy || preparingGeneration.value || (board.value.nodes.length && !window.confirm(t('imageStudio.newConfirm')))) return; remember(); board.value = createStudioDocument('default', t('imageStudio.untitled')); visibleTaskId.value = ''; reconcileSelection(); await flushSave() }
function beforeUnload(event: BeforeUnloadEvent) { if (saveState.value !== 'saved' || fileBusy.value) { event.preventDefault(); event.returnValue = ''; void flushSave() } }
onBeforeRouteLeave(async () => { if (fileBusy.value || preparingGeneration.value) { notify(t('imageStudio.fileInProgress')); return false } if (saveState.value !== 'saved' && !(await flushSave())) return window.confirm(t('imageStudio.saveFailed')); return true })
onMounted(async () => {
  window.addEventListener('beforeunload', beforeUnload)
  try {
    const lock = await acquireImageStudioTabLock(ownerId)
    if (!lock.acquired) { storageError.value = t(lock.reason === 'locked' ? 'imageStudio.otherTab' : 'imageStudio.storageRequired'); return }
    releaseTabLock = lock.release
    if (disposed) { lock.release(); return }
    const saved = await storage.loadDocument('default'); ensureActive(); if (saved) board.value = saved; await hydrateImages(); await nextTick(); ready.value = true; await generation.init()
  }
  catch (error) { storageError.value = `${t('imageStudio.storageRequired')} ${errorText(error)}`; notify(storageError.value) }
})
onBeforeUnmount(() => { disposed = true; generation.dispose(); clearTimeout(noticeTimer); clearTimeout(saveTimer); clearInterval(elapsedTimer); window.removeEventListener('beforeunload', beforeUnload); for (const url of Object.values(urls)) URL.revokeObjectURL(url); void saveQueue.finally(() => { storage.close(); releaseTabLock?.() }) })
</script>
