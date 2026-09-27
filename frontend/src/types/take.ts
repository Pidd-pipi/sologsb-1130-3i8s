/** 一条实拍登记记录（按镜头 + 日期汇总当日张数） */
export interface TakeLog {
  id?: number;
  /** 拍摄日期 YYYY-MM-DD */
  date: string;
  /** 镜号，便于按镜头阅读 */
  shotCode: string;
  /** 关联镜头 id */
  shotId: number;
  /** 实拍张数 */
  takenFrames: number;
  /** 废帧数 */
  wastedFrames: number;
  /** 剩余张数（登记时快照） */
  remainingFrames: number;
  /** 完成百分比 0-100 */
  percent: number;
  updatedAt: number;
}

export const createEmptyTake = (shotId: number, shotCode: string): TakeLog => ({
  date: new Date().toISOString().slice(0, 10),
  shotCode,
  shotId,
  takenFrames: 0,
  wastedFrames: 0,
  remainingFrames: 0,
  percent: 0,
  updatedAt: Date.now(),
});

/** 废帧分布的一个分组 */
export interface WasteBucket {
  label: string;
  count: number;
}

/**
 * 一条补拍清单记录：帧从条带移除时，其已拍/废片不随格子消失，
 * 快照保留在这里，直到跟拍人员手动销记。
 */
export interface FrameTake {
  id?: number;
  /** 所属镜头 id */
  shotId: number;
  /** 镜号快照，便于按镜头阅读 */
  shotCode: string;
  /** 从条带移除时的帧号 */
  frameNo: number;
  /** 移除时的计划张数 */
  planned: number;
  /** 已拍张数（含废片） */
  taken: number;
  /** 废片张数 */
  wasted: number;
  /** 移除时间戳 */
  removedAt: number;
}

export const createEmptyFrameTake = (shotId: number, shotCode: string, frameNo: number): FrameTake => ({
  shotId,
  shotCode,
  frameNo,
  planned: 0,
  taken: 0,
  wasted: 0,
  removedAt: Date.now(),
});
