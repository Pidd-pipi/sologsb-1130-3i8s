/**
 * 帧序编排：插入 / 删除 / 移动帧并重排帧序号，联动镜头帧区间。
 * 被 /frames 与 /shots/:id 消费。
 *
 * 台账要点：
 * - 调整某格「张数」走 ledgerStore.changeCellCount（下调超量进补拍清单）；
 * - 删除格子走 frameStore.removeAt → ledgerStore.removeCell（软删除 + 超量快照）；
 * - 插入/移动只改位次（frameNo），格子 uid 不变。
 */
import { computed } from 'vue';
import { storeToRefs } from 'pinia';
import { useFrameStore } from '../stores/frameStore';
import { useLedgerStore } from '../stores/ledgerStore';
import { useShotStore } from '../stores/shotStore';
import { durationToFrames, framesToDuration } from '../utils/frameMath';
import type { FrameEntry } from '../types/frame';

export function useFrameSequence() {
  const frameStore = useFrameStore();
  const ledgerStore = useLedgerStore();
  const shotStore = useShotStore();
  const { frames, selectedFrameNo } = storeToRefs(frameStore);

  const shotId = computed(() => frameStore.shotId);
  const shot = computed(() => (shotId.value === null ? undefined : shotStore.byId(shotId.value)));
  const fps = computed(() => shot.value?.fps ?? 24);
  const frameCount = computed(() => frames.value.length);
  const totalDuration = computed(() => framesToDuration(frameCount.value, fps.value));
  const plannedFrames = computed(() => durationToFrames(shot.value?.durationSec ?? 0, fps.value));

  async function insertAfter(frameNo: number | null, seed?: Partial<FrameEntry>) {
    const index = frameNo === null ? frames.value.length : frames.value.findIndex((f) => f.frameNo === frameNo) + 1;
    const created = await frameStore.insertAt(Math.max(0, index), seed);
    await syncShotRange();
    if (shotId.value !== null) await ledgerStore.reloadFrames(shotId.value);
    return created;
  }

  async function removeAt(frameNo: number) {
    if (shotId.value === null) return;
    const frame = frames.value.find((f) => f.frameNo === frameNo);
    if (!frame) return;
    // 台账软删除 + 超量快照，随后刷新条带（位次重排、uid 不变）
    await ledgerStore.removeCell(frame);
    await frameStore.refresh(shotId.value);
    await syncShotRange();
    await ledgerStore.reloadFrames(shotId.value);
  }

  async function move(fromIndex: number, toIndex: number) {
    await frameStore.move(fromIndex, toIndex);
    if (shotId.value !== null) await ledgerStore.reloadFrames(shotId.value);
    await syncShotRange();
  }

  /**
   * 帧序变化后重算镜头的帧区间与时长。
   * 帧区间与条带上的格子一一对应（结束帧号 = 起始帧号 + 格子数 - 1），
   * 时长 = 格子数 ÷ 帧率；新增格即延长本段，删除格即缩短本段。
   */
  async function syncShotRange() {
    if (shotId.value === null) return;
    const current = shotStore.byId(shotId.value);
    if (!current) return;
    const fps = current.fps || 24;
    const count = Math.max(1, frames.value.length);
    const seconds = Math.round((count / fps) * 1000) / 1000;
    await shotStore.update(shotId.value, {
      durationSec: seconds,
      startFrame: current.startFrame,
      endFrame: current.startFrame + count - 1,
    });
  }

  /** 条带上的单格改动；shotCount（该格张数）必须走台账，超量才会进补拍清单 */
  async function patch(frameNo: number, patchValue: Partial<FrameEntry>) {
    const frame = frames.value.find((f) => f.frameNo === frameNo);
    if (!frame) return;
    if (typeof patchValue.shotCount === 'number' && patchValue.shotCount !== frame.shotCount) {
      const { shotCount, ...rest } = patchValue;
      await ledgerStore.changeCellCount(frame, shotCount);
      if (Object.keys(rest).length) await frameStore.patchFrame(frameNo, rest);
      // 刷新条带本地缓存（张数变化由台账落库），保证两处显示一致
      if (shotId.value !== null) await frameStore.refresh(shotId.value);
    } else {
      await frameStore.patchFrame(frameNo, patchValue);
    }
  }

  function select(frameNo: number | null) {
    frameStore.select(frameNo);
  }

  return {
    frames,
    selectedFrameNo,
    shot,
    fps,
    frameCount,
    totalDuration,
    plannedFrames,
    insertAfter,
    removeAt,
    move,
    patch,
    select,
    syncShotRange,
    reload: (id: number) => frameStore.loadForShot(id),
  };
}
