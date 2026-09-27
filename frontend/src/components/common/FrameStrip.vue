<script setup lang="ts">
/**
 * 帧序横向条带：每格按自己的张数显示「已拍 / 废片 / 待拍」台账进度，
 * 支持点击选中与拖拽换序；选中帧后可就地修改张数、曝光参数与道具位移量。
 * 格子身份为 uid：换序、切镜头、重开页面都不影响实拍记录对应关系。
 */
import { computed, ref } from 'vue';
import type { FrameEntry } from '../../types/frame';
import { frameColor, type FrameColorInput } from '../../utils/frameMath';
import type { FrameLedger } from '../../utils/ledger';

interface Props {
  frames: FrameEntry[];
  selected?: number | null;
  /** uid → 单格台账（由 ledgerStore.ledgerOfUid 提供） */
  ledgers?: Record<string, FrameLedger>;
  readonly?: boolean;
  colorBy?: 'offset' | 'exposure';
}

const props = withDefaults(defineProps<Props>(), {
  selected: null,
  ledgers: () => ({}),
  readonly: false,
  colorBy: 'offset',
});

const emit = defineEmits<{
  (e: 'update:selected', frameNo: number | null): void;
  (e: 'reorder', from: number, to: number): void;
  (e: 'patch', frameNo: number, patch: Partial<FrameEntry>): void;
}>();

const dragFrom = ref<number | null>(null);

function colorOf(frame: FrameEntry): string {
  const input: FrameColorInput = {
    propOffsetMm: props.colorBy === 'offset' ? frame.propOffsetMm : 0,
    exposureSec: props.colorBy === 'exposure' ? frame.exposureSec : 0.25,
  };
  return frameColor(input);
}

function onSelect(frameNo: number) {
  emit('update:selected', props.selected === frameNo ? null : frameNo);
}

function onDragStart(index: number, ev: DragEvent) {
  if (props.readonly) return;
  dragFrom.value = index;
  ev.dataTransfer?.setData('text/plain', String(index));
}

function onDrop(index: number) {
  if (props.readonly) return;
  const from = dragFrom.value;
  dragFrom.value = null;
  if (from === null || from === index) return;
  emit('reorder', from, index);
}

function patchSelected(patch: Partial<FrameEntry>) {
  if (props.selected === null || props.selected === undefined) return;
  emit('patch', props.selected, patch);
}

const selectedFrame = computed(() => props.frames.find((f) => f.frameNo === props.selected) ?? null);
const selectedLedger = computed(() => (selectedFrame.value ? props.ledgers[selectedFrame.value.uid] : undefined));

const totalOffset = computed(() =>
  Math.round(props.frames.reduce((sum, f) => sum + (f.propOffsetMm || 0), 0) * 100) / 100,
);

/** 格子状态徽标：拍齐 / 拍摄中 / 有废片 / 待拍 */
function cellState(ledger?: FrameLedger): 'done' | 'wasted' | 'shooting' | 'idle' {
  if (!ledger || ledger.taken === 0) return 'idle';
  if (ledger.done) return 'done';
  if (ledger.wasted > 0) return 'wasted';
  return 'shooting';
}
</script>

<template>
  <div class="frame-strip" data-testid="frame-strip">
    <div class="strip-meta">
      <span>帧序条带：{{ frames.length }} 格</span>
      <span>位移合计 {{ totalOffset }} mm</span>
      <span v-if="!readonly" class="hint">点击选中 · 拖拽换序</span>
    </div>

    <div class="strip-track">
      <div
        v-for="(frame, index) in frames"
        :key="frame.uid"
        class="strip-cell"
        :class="['state-' + cellState(ledgers[frame.uid]), { active: frame.frameNo === selected, readonly }]"
        :style="{ background: colorOf(frame) }"
        :draggable="!readonly"
        :data-testid="`strip-cell-${frame.frameNo}`"
        :title="`${frame.label}（第 ${frame.frameNo} 格）· 计划 ${frame.shotCount} 张 · ${frame.exposureSec}s · f/${frame.aperture} · ISO${frame.iso} · 位移 ${frame.propOffsetMm}mm`"
        @click="onSelect(frame.frameNo)"
        @dragstart="onDragStart(index, $event)"
        @dragover.prevent
        @drop="onDrop(index)"
      >
        <span class="cell-no">{{ frame.frameNo }}</span>
        <span class="cell-label">{{ frame.label }}</span>
        <span v-if="ledgers[frame.uid]" class="cell-ledger">
          <span>拍 {{ ledgers[frame.uid].taken }}</span>
          <span :class="{ bad: ledgers[frame.uid].wasted > 0 }">废 {{ ledgers[frame.uid].wasted }}</span>
          <span :class="{ over: ledgers[frame.uid].excess > 0 }">待 {{ ledgers[frame.uid].remaining }}</span>
        </span>
        <span v-else class="cell-sub">{{ frame.shotCount }}张</span>
      </div>
      <div v-if="!frames.length" class="strip-empty">当前镜头还没有帧条目，请先插入一格</div>
    </div>
    <div class="strip-legend">
      <span><i class="dot state-done"></i>已拍齐</span>
      <span><i class="dot state-shooting"></i>拍摄中</span>
      <span><i class="dot state-wasted"></i>有废片（已重计待拍）</span>
      <span><i class="dot state-idle"></i>未拍</span>
    </div>

    <div v-if="selectedFrame && !readonly" class="strip-editor" data-testid="strip-editor">
      <div class="editor-title">
        {{ selectedFrame.label }}（第 {{ selectedFrame.frameNo }} 格）参数
        <span v-if="selectedLedger" class="editor-ledger">
          已拍 {{ selectedLedger.taken }} · 废片 {{ selectedLedger.wasted }} · 好张 {{ selectedLedger.good }}
          / 计划 {{ selectedLedger.required }} · 待拍 {{ selectedLedger.remaining }}
          <em v-if="selectedLedger.excess > 0" class="over">超量 {{ selectedLedger.excess }} 张已进补拍清单</em>
        </span>
      </div>
      <div class="editor-grid">
        <label class="field">
          <span>该格张数</span>
          <input
            type="number"
            min="1"
            max="99"
            step="1"
            :value="selectedFrame.shotCount"
            :data-testid="`strip-shotcount-${selectedFrame.frameNo}`"
            @change="patchSelected({ shotCount: Number(($event.target as HTMLInputElement).value) })"
          />
        </label>
        <label class="field">
          <span>曝光时间 s</span>
          <input
            type="number"
            min="0.008"
            max="8"
            step="0.008"
            :value="selectedFrame.exposureSec"
            @change="patchSelected({ exposureSec: Number(($event.target as HTMLInputElement).value) })"
          />
        </label>
        <label class="field">
          <span>光圈 f</span>
          <input
            type="number"
            min="1.4"
            max="22"
            step="0.1"
            :value="selectedFrame.aperture"
            @change="patchSelected({ aperture: Number(($event.target as HTMLInputElement).value) })"
          />
        </label>
        <label class="field">
          <span>ISO</span>
          <input
            type="number"
            min="100"
            max="3200"
            step="100"
            :value="selectedFrame.iso"
            @change="patchSelected({ iso: Number(($event.target as HTMLInputElement).value) })"
          />
        </label>
        <label class="field">
          <span>快门角度 °</span>
          <input
            type="number"
            min="45"
            max="360"
            step="1"
            :value="selectedFrame.shutterAngle"
            @change="patchSelected({ shutterAngle: Number(($event.target as HTMLInputElement).value) })"
          />
        </label>
        <label class="field">
          <span>道具位移 mm</span>
          <input
            type="number"
            min="-200"
            max="200"
            step="0.5"
            :value="selectedFrame.propOffsetMm"
            :data-testid="`strip-offset-${selectedFrame.frameNo}`"
            @change="patchSelected({ propOffsetMm: Number(($event.target as HTMLInputElement).value) })"
          />
        </label>
      </div>
    </div>
  </div>
</template>

<style scoped>
.frame-strip {
  border: 1px solid #d8dee9;
  border-radius: 10px;
  padding: 12px;
  background: #fbfcfe;
}
.strip-meta {
  display: flex;
  gap: 16px;
  font-size: 12px;
  color: #5a6472;
  margin-bottom: 10px;
}
.strip-meta .hint {
  color: #8a94a6;
}
.strip-track {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  padding-bottom: 6px;
}
.strip-cell {
  min-width: 76px;
  min-height: 88px;
  border-radius: 8px;
  color: #fff;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
  cursor: pointer;
  user-select: none;
  border: 2px solid transparent;
  flex: 0 0 auto;
  padding: 4px 6px;
  transition: transform 0.12s ease;
}
.strip-cell:hover {
  transform: translateY(-2px);
}
.strip-cell.active {
  border-color: #1f2d3d;
  box-shadow: 0 0 0 2px rgba(31, 45, 61, 0.18);
}
.strip-cell.readonly {
  cursor: default;
}
/* 台账状态角标：左侧 3px 色条 */
.strip-cell.state-done {
  box-shadow: inset 4px 0 0 rgba(255, 255, 255, 0.95);
}
.strip-cell.state-shooting {
  box-shadow: inset 4px 0 0 #ffd36b;
}
.strip-cell.state-wasted {
  box-shadow: inset 4px 0 0 #ff8a8a;
}
.cell-no {
  font-weight: 700;
  font-size: 14px;
}
.cell-label {
  font-size: 10px;
  opacity: 0.92;
  max-width: 64px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cell-sub {
  font-size: 11px;
  opacity: 0.92;
}
.cell-ledger {
  display: flex;
  flex-direction: column;
  font-size: 10px;
  line-height: 1.35;
  margin-top: 2px;
  font-variant-numeric: tabular-nums;
}
.cell-ledger .bad {
  color: #ffd9d9;
  font-weight: 700;
}
.cell-ledger .over {
  color: #ffe7a3;
  font-weight: 700;
}
.strip-legend {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
  font-size: 11px;
  color: #8a94a6;
  margin-top: 8px;
}
.strip-legend .dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 2px;
  margin-right: 4px;
}
.dot.state-done {
  background: #fff;
  outline: 1px solid #b9c2d0;
}
.dot.state-shooting {
  background: #ffd36b;
}
.dot.state-wasted {
  background: #ff8a8a;
}
.dot.state-idle {
  background: #b9c2d0;
}
.strip-empty {
  color: #8a94a6;
  font-size: 13px;
  padding: 18px 4px;
}
.strip-editor {
  margin-top: 12px;
  border-top: 1px dashed #d8dee9;
  padding-top: 10px;
}
.editor-title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: baseline;
}
.editor-ledger {
  font-weight: 400;
  font-size: 12px;
  color: #5a6472;
}
.editor-ledger .over {
  color: #b36a00;
  font-style: normal;
  margin-left: 4px;
}
.editor-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 8px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: #5a6472;
}
.field input,
.field select {
  height: 30px;
  border: 1px solid #cfd6e0;
  border-radius: 6px;
  padding: 0 8px;
  font-size: 13px;
  background: #fff;
  color: #1f2d3d;
}
</style>
