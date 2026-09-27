/**
 * 逐帧拍摄台账 store：
 * - 每格按自己的张数记录已拍/废片，废片自动重算进待拍；
 * - 张数下调、多拍、格子移出条带时，超量好张留进补拍清单，不消失；
 * - 实拍记录按格子永久 uid 对回原格，切换镜头/重开页面后对应关系不变。
 */
import { defineStore } from 'pinia';
import * as api from '../db/api';
import { frameLedger, overallLedger, shotLedger, sumTakes, type FrameLedger, type ShotLedger } from '../utils/ledger';
import { useShotStore } from './shotStore';
import type { FrameEntry } from '../types/frame';
import type { PickupItem, PickupReason, TakeLog } from '../types/take';
import { createPickupItem } from '../types/take';
import type { Shot } from '../types/shot';

interface LedgerState {
  frames: FrameEntry[];
  takes: TakeLog[];
  pickups: PickupItem[];
  ready: boolean;
  loading: boolean;
}

/** 补拍清单在界面上的一行（含实时超量） */
export interface PickupView extends PickupItem {
  /** 当前实际超量：在条格子随计划实时重算，已移除格子为固定快照 */
  liveExcess: number;
  /** 格子是否仍在条带上 */
  frameActive: boolean;
}

export interface RegisterPayload {
  shot: Shot;
  frame: FrameEntry | null;
  date: string;
  taken: number;
  wasted: number;
  note?: string;
}

export const useLedgerStore = defineStore('ledger', {
  state: (): LedgerState => ({
    frames: [],
    takes: [],
    pickups: [],
    ready: false,
    loading: false,
  }),
  getters: {
    /** 某镜头仍在条带上的格子（按位次） */
    framesOfShot(state) {
      return (shotId: number) =>
        state.frames
          .filter((f) => f.shotId === shotId && f.active)
          .sort((a, b) => a.frameNo - b.frameNo);
    },
    /** 单格台账（由实拍记录实时累加，废片含在待拍里） */
    ledgerOfUid(state) {
      return (uid: string): FrameLedger => {
        const frame = state.frames.find((f) => f.uid === uid);
        const rows = state.takes.filter((t) => t.frameUid === uid);
        const sums = sumTakes(rows);
        return { ...frameLedger(frame?.shotCount ?? 0, sums.taken, sums.wasted), uid };
      };
    },
    /** 镜头级台账 */
    shotStat(state) {
      return (shotId: number): ShotLedger => {
        const frames = state.frames.filter((f) => f.shotId === shotId && f.active);
        const takes = state.takes.filter((t) => t.shotId === shotId);
        return shotLedger(frames, takes);
      };
    },
    /** 全部镜头台账（与 shotStore 对齐，已删除镜头的孤量不出现在总览） */
    shotStats(): ShotLedger[] {
      const shotStore = useShotStore();
      return shotStore.shots.map((s) => (typeof s.id === 'number' ? this.shotStat(s.id) : shotLedger([], [])));
    },
    overall(): ShotLedger & { percent: number } {
      const shotStore = useShotStore();
      const stats = shotStore.shots.map((s) => (typeof s.id === 'number' ? this.shotStat(s.id) : shotLedger([], [])));
      return overallLedger(stats);
    },
    /** 未核销补拍条目；在条格子的超量随计划实时重算 */
    openPickups(state): PickupView[] {
      return state.pickups
        .filter((p) => !p.resolved)
        .map((p) => {
          const frame = state.frames.find((f) => f.uid === p.frameUid);
          const active = !!frame?.active;
          let liveExcess = p.excess;
          if (active) {
            const sums = sumTakes(state.takes.filter((t) => t.frameUid === p.frameUid));
            liveExcess = Math.max(0, sums.taken - sums.wasted - (frame?.shotCount ?? 0));
          }
          return { ...p, liveExcess, frameActive: active };
        })
        .filter((p) => p.liveExcess > 0)
        .sort((a, b) => (a.shotCode < b.shotCode ? -1 : a.shotCode > b.shotCode ? 1 : b.updatedAt - a.updatedAt));
    },
    resolvedPickups(state): PickupItem[] {
      return state.pickups
        .filter((p) => p.resolved)
        .sort((a, b) => b.updatedAt - a.updatedAt);
    },
  },
  actions: {
    async load() {
      this.loading = true;
      try {
        const [frames, takes, pickups] = await Promise.all([api.listAllFrames(), api.listTakes(), api.listPickups()]);
        this.frames = frames;
        this.takes = takes;
        this.pickups = pickups;
        this.ready = true;
      } finally {
        this.loading = false;
      }
    },
    async reloadFrames(shotId: number) {
      this.frames = [
        ...this.frames.filter((f) => f.shotId !== shotId),
        ...(await api.listAllFramesOfShot(shotId)),
      ];
    },

    /** 登记一次实拍（逐格或旧版整天），随后三档进度一起重算 */
    async registerTake(payload: RegisterPayload): Promise<number> {
      const { shot, frame, date, taken, wasted, note } = { note: '', ...payload };
      const row: TakeLog = {
        date,
        shotCode: shot.code,
        shotId: shot.id ?? 0,
        frameUid: frame?.uid ?? null,
        frameLabel: frame?.label ?? '',
        frameNo: frame?.frameNo ?? null,
        takenFrames: taken,
        wastedFrames: wasted,
        note,
        updatedAt: Date.now(),
      };
      const id = await api.addTake(row);
      this.takes = [...this.takes, { ...row, id }];
      if (frame) await this.reconcileFrame(frame.uid, 'overflow');
      await this.syncShotProgress(shot.id ?? 0);
      return id;
    },

    /** 删除一条登记（登记可纠正），进度与补拍清单随之重算 */
    async removeTake(id: number) {
      const row = this.takes.find((t) => t.id === id);
      await api.deleteTake(id);
      this.takes = this.takes.filter((t) => t.id !== id);
      if (row) {
        if (row.frameUid) await this.reconcileFrame(row.frameUid, 'overflow');
        await this.syncShotProgress(row.shotId);
      }
    },

    /** 调整某格计划张数：下调产生的超量进补拍清单 */
    async changeCellCount(frame: FrameEntry, count: number) {
      if (typeof frame.id !== 'number') return;
      const value = Math.max(1, Math.floor(count));
      if (value === frame.shotCount) return;
      await api.updateFrame(frame.id, { shotCount: value });
      this.frames = this.frames.map((f) => (f.uid === frame.uid ? { ...f, shotCount: value, updatedAt: Date.now() } : f));
      await this.reconcileFrame(frame.uid, 'shrink');
      await this.syncShotProgress(frame.shotId);
    },

    /** 改格名（不影响 uid 对应关系） */
    async renameCell(frame: FrameEntry, label: string) {
      if (typeof frame.id !== 'number') return;
      const text = label.trim();
      if (!text || text === frame.label) return;
      await api.updateFrame(frame.id, { label: text });
      this.frames = this.frames.map((f) => (f.uid === frame.uid ? { ...f, label: text, updatedAt: Date.now() } : f));
    },

    /**
     * 格子从条带移除：软删除（active=false）+ 条带位次重排。
     * 已拍过的好张以固定快照留进补拍清单；废片记录继续留在每日台账。
     */
    async removeCell(frame: FrameEntry): Promise<void> {
      if (typeof frame.id !== 'number') return;
      const sums = sumTakes(this.takes.filter((t) => t.frameUid === frame.uid));
      const good = sums.taken - sums.wasted;

      // 1. 软删除格子（记录本体不消失）
      await api.deactivateFrame(frame.id);
      this.frames = this.frames.map((f) => (f.uid === frame.uid ? { ...f, active: false, updatedAt: Date.now() } : f));

      // 2. 仍在条带上的格子位次重排（uid 不变，只改 frameNo，保持镜头起始帧号）
      const shot = useShotStore().byId(frame.shotId);
      const shotStart = shot?.startFrame ?? 1;
      const remaining = this.framesOfShot(frame.shotId);
      const renumbered = remaining.map((f, i) => ({ ...f, frameNo: shotStart + i }));
      await api.renumberFrames(renumbered);
      this.frames = this.frames.map((f) => {
        const next = renumbered.find((r) => r.uid === f.uid);
        return next ?? f;
      });

      // 3. 该格在条期间的超量条目一律核销，由移除快照接管（快照为全量好张）
      const openLive = this.pickups.filter((p) => p.frameUid === frame.uid && !p.resolved && p.reason !== 'removed');
      for (const item of openLive) {
        if (typeof item.id === 'number') {
          await api.updatePickup(item.id, { resolved: true });
        }
      }
      if (openLive.length) {
        const ids = new Set(openLive.map((p) => p.id));
        this.pickups = this.pickups.map((p) => (ids.has(p.id) ? { ...p, resolved: true, updatedAt: Date.now() } : p));
      }

      // 4. 已拍好张不能消失 → 固定快照进入补拍清单
      if (good > 0) {
        const item = createPickupItem({
          shotId: frame.shotId,
          shotCode: this.shotCodeOf(frame.shotId),
          frameUid: frame.uid,
          frameLabel: frame.label,
          reason: 'removed',
          excess: good,
        });
        const pid = await api.addPickup(item);
        this.pickups = [...this.pickups, { ...item, id: pid }];
      }

      await this.syncShotProgress(frame.shotId);
    },

    /** 新格子入店（frameStore 落库后同步台账内存） */
    async noteFrame(frame: FrameEntry) {
      if (!this.frames.some((f) => f.uid === frame.uid)) {
        this.frames = [...this.frames, frame];
      }
      await this.syncShotProgress(frame.shotId);
    },

    /** 手动核销补拍条目 */
    async resolvePickup(id: number) {
      await api.updatePickup(id, { resolved: true });
      this.pickups = this.pickups.map((p) => (p.id === id ? { ...p, resolved: true, updatedAt: Date.now() } : p));
    },

    /**
     * 单格补拍对账：
     * 好张超出当前计划 → 保证有一条未核销的「在条超量」条目（超量随计划实时重算）；
     * 超量归零（张数调回、删除多拍登记）→ 自动核销并归档，条目仍可在归档中查到。
     */
    async reconcileFrame(uid: string, reason: PickupReason) {
      const frame = this.frames.find((f) => f.uid === uid);
      if (!frame || !frame.active) return;
      const sums = sumTakes(this.takes.filter((t) => t.frameUid === uid));
      const excess = Math.max(0, sums.taken - sums.wasted - frame.shotCount);
      const open = this.pickups.find((p) => p.frameUid === uid && !p.resolved && p.reason !== 'removed');

      if (excess > 0 && !open) {
        const item = createPickupItem({
          shotId: frame.shotId,
          shotCode: this.shotCodeOf(frame.shotId),
          frameUid: uid,
          frameLabel: frame.label,
          reason,
          excess,
        });
        const id = await api.addPickup(item);
        this.pickups = [...this.pickups, { ...item, id }];
      } else if (excess > 0 && open && typeof open.id === 'number' && open.excess !== excess) {
        await api.updatePickup(open.id, { excess });
        this.pickups = this.pickups.map((p) => (p.id === open.id ? { ...p, excess, updatedAt: Date.now() } : p));
      } else if (excess === 0 && open && typeof open.id === 'number') {
        await api.updatePickup(open.id, { resolved: true, excess: 0 });
        this.pickups = this.pickups.map((p) =>
          p.id === open.id ? { ...p, resolved: true, excess: 0, updatedAt: Date.now() } : p,
        );
      }
    },

    async syncShotProgress(shotId: number) {
      const stat = this.shotStat(shotId);
      const shotStore = useShotStore();
      await shotStore.syncProgress(shotId, stat.percent);
    },

    shotCodeOf(shotId: number): string {
      const shotStore = useShotStore();
      return shotStore.byId(shotId)?.code ?? `#${shotId}`;
    },
  },
});
