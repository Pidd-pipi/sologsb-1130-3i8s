/**
 * 一条实拍登记记录（逐帧拍摄台账）。
 * 每登记一次 = 某天在某一格（或旧版整天汇总，frameUid 为空）拍下的一批张数，
 * 其中废片单独计数：废片不产生好张、必须重新拍进待拍。
 */
export interface TakeLog {
  id?: number;
  /** 拍摄日期 YYYY-MM-DD */
  date: string;
  /** 镜号（登记时快照，便于按镜头阅读与镜头改名后留痕） */
  shotCode: string;
  /** 关联镜头 id */
  shotId: number;
  /** 关联格子 uid；null = 旧版按整天登记、无法对到具体格子的历史记录 */
  frameUid: string | null;
  /** 格名快照（格子从条带移除后，历史记录仍能读出「拍的是哪一格」） */
  frameLabel: string;
  /** 帧序号快照（登记时该格在条带上的位次） */
  frameNo: number | null;
  /** 本次实拍张数（含废片） */
  takenFrames: number;
  /** 其中废片张数（废片自动重新计入待拍） */
  wastedFrames: number;
  /** 备注 */
  note: string;
  updatedAt: number;
}

export const createEmptyTake = (shotId: number, shotCode: string): TakeLog => ({
  date: new Date().toISOString().slice(0, 10),
  shotCode,
  shotId,
  frameUid: null,
  frameLabel: '',
  frameNo: null,
  takenFrames: 0,
  wastedFrames: 0,
  note: '',
  updatedAt: Date.now(),
});

/** 废片分布的一个分组 */
export interface WasteBucket {
  label: string;
  count: number;
}

/** 补拍清单条目的产生原因 */
export type PickupReason = 'shrink' | 'overflow' | 'removed';

export const PICKUP_REASON_LABEL: Record<PickupReason, string> = {
  /** 格子仍在条带上，计划张数被下调，已拍好张超出新计划 */
  shrink: '张数下调',
  /** 格子仍在条带上，登记张数超出计划（多拍） */
  overflow: '多拍超量',
  /** 格子已从条带移除，移除时已拍好张无法再对回任何格子 */
  removed: '格子已移除',
};

/**
 * 补拍清单条目：已经拍过、但因计划变化不再对得上格子的「超量好张」。
 * shrink / overflow 条目绑定 frameUid，超量张数随格子计划实时重算；
 * removed 条目为移除瞬间的固定快照，不再变化，只能人工核销。
 */
export interface PickupItem {
  id?: number;
  /** 所属镜头 id */
  shotId: number;
  /** 镜号快照 */
  shotCode: string;
  /** 关联格子 uid（removed 条目也保留，便于追溯） */
  frameUid: string;
  /** 格名快照 */
  frameLabel: string;
  /** 产生原因 */
  reason: PickupReason;
  /**
   * 超量好张数：
   * - removed：移除时的固定快照；
   * - shrink / overflow：该格子实时超量（好张 − 当前计划张数），下限 0。
   */
  excess: number;
  /** 是否已人工核销（归档） */
  resolved: boolean;
  createdAt: number;
  updatedAt: number;
}

export function createPickupItem(params: {
  shotId: number;
  shotCode: string;
  frameUid: string;
  frameLabel: string;
  reason: PickupReason;
  excess: number;
}): PickupItem {
  const now = Date.now();
  return {
    shotId: params.shotId,
    shotCode: params.shotCode,
    frameUid: params.frameUid,
    frameLabel: params.frameLabel,
    reason: params.reason,
    excess: Math.max(0, Math.floor(params.excess)),
    resolved: false,
    createdAt: now,
    updatedAt: now,
  };
}
