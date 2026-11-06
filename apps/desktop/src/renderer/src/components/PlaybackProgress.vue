<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'

const props = defineProps<{
  currentTime: number
  duration: number
  disabled: boolean
  sourceKey: string
  buffered: { start: number; end: number }[]
}>()
const emit = defineEmits<{ seek: [seconds: number] }>()
const slider = ref<HTMLElement | null>(null)
const draft = ref<number | null>(null)
const hoverRatio = ref<number | null>(null)
const focused = ref(false)
let pointerId: number | null = null
const total = computed(() => Number.isFinite(props.duration) && props.duration > 0 ? props.duration : 0)
const available = computed(() => !props.disabled && total.value > 0)
const clamp = (seconds: number) => Number.isFinite(seconds) ? Math.min(total.value, Math.max(0, seconds)) : 0
const position = computed(() => clamp(draft.value ?? props.currentTime))
const playedPercent = computed(() => total.value ? position.value / total.value * 100 : 0)
const previewTime = computed(() => draft.value ?? (hoverRatio.value !== null ? hoverRatio.value * total.value : position.value))
const previewPercent = computed(() => total.value ? clamp(previewTime.value) / total.value * 100 : 0)
const showPreview = computed(() => available.value && (draft.value !== null || hoverRatio.value !== null || focused.value))
const bufferedSegments = computed(() => total.value ? props.buffered
  .filter(range => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start)
  .map(range => ({ left: `${clamp(range.start) / total.value * 100}%`, width: `${(clamp(range.end) - clamp(range.start)) / total.value * 100}%` })) : [])

function timeLabel(seconds: number) {
  const value = Math.floor(clamp(seconds))
  return `${Math.floor(value / 60).toString().padStart(2, '0')}:${(value % 60).toString().padStart(2, '0')}`
}
function ratioAt(event: PointerEvent) {
  const bounds = slider.value!.getBoundingClientRect()
  return Math.min(1, Math.max(0, (event.clientX - bounds.left) / Math.max(1, bounds.width)))
}
function cancelDrag() {
  const captured = pointerId
  pointerId = null
  draft.value = null
  hoverRatio.value = null
  if (captured !== null && slider.value?.hasPointerCapture(captured)) slider.value.releasePointerCapture(captured)
}
function startDrag(event: PointerEvent) {
  if (!available.value || event.button !== 0 || !event.isPrimary || pointerId !== null) return
  event.preventDefault()
  slider.value!.focus({ preventScroll: true })
  focused.value = false
  slider.value!.setPointerCapture(event.pointerId)
  pointerId = event.pointerId
  hoverRatio.value = ratioAt(event)
  draft.value = hoverRatio.value * total.value
}
function movePointer(event: PointerEvent) {
  if (!available.value || pointerId !== null && pointerId !== event.pointerId) return
  hoverRatio.value = ratioAt(event)
  if (pointerId !== null) draft.value = hoverRatio.value * total.value
}
function finishDrag(event: PointerEvent) {
  if (pointerId !== event.pointerId) return
  const target = ratioAt(event) * total.value
  const canCommit = available.value
  cancelDrag()
  if (canCommit) emit('seek', target)
}
function leavePointer() { if (pointerId === null) hoverRatio.value = null }
function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && pointerId !== null) {
    event.preventDefault(); event.stopPropagation(); cancelDrag(); return
  }
  if (!available.value || pointerId !== null) return
  let target: number
  switch (event.key) {
    case 'ArrowLeft': case 'ArrowDown': target = position.value - 5; break
    case 'ArrowRight': case 'ArrowUp': target = position.value + 5; break
    case 'PageDown': target = position.value - total.value / 10; break
    case 'PageUp': target = position.value + total.value / 10; break
    case 'Home': target = 0; break
    case 'End': target = total.value; break
    default: return
  }
  event.preventDefault()
  event.stopPropagation()
  focused.value = true
  hoverRatio.value = null
  emit('seek', clamp(target))
}
function onBlur() { focused.value = false; cancelDrag() }
watch(() => props.sourceKey, cancelDrag, { flush: 'sync' })
watch(available, value => { if (!value) cancelDrag() }, { flush: 'sync' })
onMounted(() => window.addEventListener('blur', onBlur))
onUnmounted(() => { window.removeEventListener('blur', onBlur); cancelDrag() })
</script>

<template>
  <div ref="slider" class="playback-progress" :class="{ 'is-active': showPreview, 'is-dragging': draft !== null, 'is-disabled': !available }"
    role="slider" aria-label="播放进度" aria-orientation="horizontal" :tabindex="available ? 0 : -1"
    :aria-disabled="!available" :aria-valuemin="0" :aria-valuemax="total" :aria-valuenow="position"
    :aria-valuetext="`${timeLabel(position)} / ${timeLabel(total)}`"
    @pointerdown="startDrag" @pointermove="movePointer" @pointerup="finishDrag" @pointerleave="leavePointer"
    @pointercancel="cancelDrag" @lostpointercapture="cancelDrag" @keydown="onKeydown" @focus="focused = slider?.matches(':focus-visible') ?? false" @blur="onBlur">
    <div class="progress-track" aria-hidden="true">
      <span v-for="(segment, index) in bufferedSegments" :key="index" class="progress-buffer" :style="segment" />
      <span class="progress-played" :style="{ width: `${playedPercent}%` }" />
    </div>
    <span class="progress-thumb" :style="{ left: `clamp(7px, ${playedPercent}%, calc(100% - 7px))` }" aria-hidden="true" />
    <span v-if="showPreview" class="progress-tooltip" :style="{ left: `clamp(72px, ${previewPercent}%, calc(100% - 72px))` }" aria-hidden="true">
      {{ timeLabel(previewTime) }}<span>/ {{ timeLabel(total) }}</span>
    </span>
  </div>
</template>

<style scoped>
.playback-progress { position: absolute; inset: -12px 0 auto; z-index: 2; height: 24px; outline: none; cursor: pointer; touch-action: none; user-select: none; -webkit-app-region: no-drag; }
.progress-track { position: absolute; top: 50%; left: 0; right: 0; height: 3px; overflow: hidden; background: color-mix(in srgb, var(--text) 12%, var(--bg)); transform: translateY(-50%); transition: height .15s ease; }
.progress-buffer, .progress-played { position: absolute; inset: 0 auto 0 0; }
.progress-buffer { background: color-mix(in srgb, var(--text) 15%, transparent); }
.progress-played { background: var(--accent); }
.progress-thumb { position: absolute; top: 50%; width: 14px; height: 14px; border: 2px solid var(--accent); border-radius: 50%; background: #fff; box-shadow: 0 1px 6px #0004; opacity: 0; transform: translate(-50%, -50%) scale(.65); transition: opacity .15s ease, transform .15s ease; pointer-events: none; }
.is-active .progress-track, .playback-progress:focus-visible .progress-track { height: 5px; }
.is-active .progress-thumb, .playback-progress:focus-visible .progress-thumb { opacity: 1; transform: translate(-50%, -50%) scale(1); }
.is-dragging .progress-thumb { box-shadow: 0 0 0 5px var(--accent-soft), 0 1px 6px #0004; }
.playback-progress:focus-visible .progress-track { outline: 2px solid var(--accent-focus); outline-offset: 3px; }
.progress-tooltip { position: absolute; bottom: 29px; display: flex; align-items: center; gap: 5px; padding: 7px 11px; color: var(--text); background: var(--surface-raised); border: 1px solid var(--line-strong); border-radius: 20px; box-shadow: 0 4px 18px #0002; font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; pointer-events: none; transform: translateX(-50%); }
.progress-tooltip > span { color: var(--muted); font-weight: 400; }
.is-disabled { cursor: default; }
.is-disabled .progress-played, .is-disabled .progress-buffer, .is-disabled .progress-thumb { display: none; }
</style>
