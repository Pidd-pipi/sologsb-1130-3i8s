/**
 * 帧条目 store：条带选中、帧序数组、批量曝光、持久化。
 * 关键台账约束：
 * - 每格有永久 uid，插入/移动只新增或改 frameNo，绝不整表删除重建；
 * - 删除格子走 ledgerStore.removeCell 软删除（active=false），历史实拍与补拍留痕；
 * - 切换镜头 / 关闭页面再回来，实拍记录按 uid 对回原格。
 */
import { defineStore } from 'pinia';
import * as api from '../db/api';
import { accumulateOffsets, estimateSpeed, frameColor, framesToDuration } from '../utils/frameMath';
import type { BatchExposure, FrameEntry } from '../types/frame';
import { createEmptyFrame } from '../types/frame';

interface FrameState {
  frames: FrameEntry[];
  shotId: number | null;
  selectedUid: string | null;
  dirty: boolean;
}

export const useFrameStore = defineStore('frame', {
  state: (): FrameState => ({
    frames: [],
    shotId: null,
    selectedUid: null,
    dirty: false,
  }),
  getters: {
    count(state): number {
      return state.frames.length;
    },
    selected(state): FrameEntry | undefined {
      if (state.selectedUid === null) return undefined;
      return state.frames.find((f) => f.uid === state.selectedUid);
    },
    /** 当前选中格的位次（供旧组件按帧号交互） */
    selectedFrameNo(): number | null {
      return this.selected?.frameNo ?? null;
    },
    /** 全部帧的累计位移轨迹（mm） */
    offsets(state): number[] {
      return accumulateOffsets(state.frames.map((f) => f.propOffsetMm));
    },
    /** 整段帧序按张数折算的总时长（秒） */
    totalDuration(state): number {
      return Math.round(state.frames.reduce((sum, f) => sum + 1 / (f.shotCount || 1), 0) * 100) / 100;
    },
    /** 帧序在给定帧率下的实际时长（秒） */
    durationAtFps(state) {
      return (fps: number) => framesToDuration(state.frames.length, fps);
    },
  },
  actions: {
    async loadForShot(shotId: number) {
      this.shotId = shotId;
      this.frames = await api.listFrames(shotId);
      this.dirty = false;
      if (this.selectedUid === null || !this.frames.some((f) => f.uid === this.selectedUid)) {
        this.selectedUid = this.frames[0]?.uid ?? null;
      }
    },
    /** 按 uid 选中（切镜头/重排后仍对回同一格） */
    selectUid(uid: string | null) {
      this.selectedUid = uid;
    },
    /** 兼容旧接口：按位次选中 */
    select(frameNo: number | null) {
      if (frameNo === null) {
        this.selectedUid = null;
        return;
      }
      this.selectedUid = this.frames.find((f) => f.frameNo === frameNo)?.uid ?? null;
    },
    /** 在 index 位置插入一格（新 uid，继承邻格曝光参数） */
    async insertAt(index: number, seed?: Partial<FrameEntry>): Promise<FrameEntry | undefined> {
      if (this.shotId === null) return undefined;
      const shot = await api.getShot(this.shotId);
      const shotStart = shot?.startFrame ?? 1;
      const clamped = Math.max(0, Math.min(index, this.frames.length));
      const base = createEmptyFrame(this.shotId, shotStart + clamped);
      const anchor = this.frames[clamped - 1] ?? this.frames[clamped];
      const merged: FrameEntry = {
        ...base,
        ...(anchor
          ? {
              shotCount: anchor.shotCount,
              exposureSec: anchor.exposureSec,
              aperture: anchor.aperture,
              iso: anchor.iso,
              shutterAngle: anchor.shutterAngle,
              lighting: anchor.lighting,
            }
          : {}),
        ...seed,
        id: undefined,
        frameNo: shotStart + clamped,
        label: seed?.label || `第${shotStart + clamped}格`,
      };
      const id = await api.addFrame(merged);
      const saved: FrameEntry = { ...merged, id };

      const next = [...this.frames.slice(0, clamped), saved, ...this.frames.slice(clamped)].map((f, i) => ({
        ...f,
        frameNo: shotStart + i,
      }));
      await api.renumberFrames(next);
      this.frames = next;
      this.selectedUid = saved.uid;
      this.dirty = false;
      return saved;
    },
    /**
     * 格子从条带移除的编排由 useFrameSequence 统一处理（ledgerStore 软删除 +
     * 超量快照后调用 refresh 重新载入条带），frameStore 自身不反向依赖 ledgerStore。
     */
    async refresh(shotId?: number) {
      const id = shotId ?? this.shotId;
      if (id === null) return;
      this.shotId = id;
      this.frames = await api.listFrames(id);
      if (!this.frames.some((f) => f.uid === this.selectedUid)) {
        this.selectedUid = this.frames[0]?.uid ?? null;
      }
    },
    /** 拖拽/上下移动：仅改位次并落库 frameNo（uid 不变） */
    async move(from: number, to: number) {
      if (from === to || from < 0 || to < 0 || from >= this.frames.length || to >= this.frames.length) return;
      if (this.shotId === null) return;
      const shot = await api.getShot(this.shotId);
      const shotStart = shot?.startFrame ?? 1;
      const next = this.frames.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      this.frames = next.map((f, idx) => ({ ...f, frameNo: shotStart + idx }));
      await api.renumberFrames(this.frames);
    },
    /** 批量套用曝光参数 */
    async applyBatch(batch: BatchExposure, indexes?: number[]) {
      const target = indexes && indexes.length ? new Set(indexes) : null;
      const next = this.frames.map((f, idx) => {
        if (target && !target.has(idx)) return f;
        return { ...f, ...batch, updatedAt: Date.now() };
      });
      for (const f of next) {
        const idx = this.frames.findIndex((x) => x.uid === f.uid);
        if ((!target || target.has(idx)) && typeof f.id === 'number') {
          await api.updateFrame(f.id, batch as Partial<FrameEntry>);
        }
      }
      this.frames = next;
    },
    /** 就地更新单帧字段（镜头详情页表格 / 条带位移量） */
    async patchFrame(frameNo: number, patch: Partial<FrameEntry>) {
      const idx = this.frames.findIndex((f) => f.frameNo === frameNo);
      if (idx < 0) return;
      const next = { ...this.frames[idx], ...patch, updatedAt: Date.now() };
      this.frames = this.frames.map((f, i) => (i === idx ? next : f));
      if (typeof next.id === 'number') {
        const { id, ...rest } = next;
        await api.updateFrame(id, rest);
      }
    },
    /** 条带单帧颜色：按曝光与位移量着色 */
    colorOf(frame: FrameEntry): string {
      return frameColor({ propOffsetMm: frame.propOffsetMm, exposureSec: frame.exposureSec });
    },
    speedOf(frame: FrameEntry, fps: number): number {
      return estimateSpeed(frame.propOffsetMm, fps);
    },
  },
});
