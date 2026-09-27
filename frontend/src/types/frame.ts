/** 单帧拍摄张数（定格动画常用 1/2/3 张，台账支持任意正整数张数） */
export type ShotCount = 1 | 2 | 3;

export const SHOT_COUNT_OPTIONS: ShotCount[] = [1, 2, 3];

/** 逐帧台账单元格：一「格」= 镜头条带上的一个拍摄位置，拥有永久 uid */
export interface FrameEntry {
  id?: number;
  /** 永久身份标识：格子插入/删除/重排都不变，实拍记录按它对回原格 */
  uid: string;
  /** 格名（可自定义，默认「第 N 格」），序号重排后不影响 uid 对应关系 */
  label: string;
  /** 帧序号（条带位次），从 1 开始，随排序重排 */
  frameNo: number;
  /** 所属镜头 id */
  shotId: number;
  /** 该格计划拍摄张数（每格按自己的张数记账） */
  shotCount: number;
  /** 是否仍在条带上：从条带移除后置为 false，历史实拍与补拍记录继续保留 */
  active: boolean;
  /** 曝光时间（秒） */
  exposureSec: number;
  /** 光圈 f 值 */
  aperture: number;
  /** 感光度 */
  iso: number;
  /** 快门角度（度） */
  shutterAngle: number;
  /** 灯光配置 */
  lighting: string;
  /** 道具位移量（mm） */
  propOffsetMm: number;
  /** 备注 */
  note: string;
  createdAt: number;
  updatedAt: number;
}

export const createEmptyFrame = (shotId: number, frameNo: number): FrameEntry => ({
  uid: createFrameUid(),
  label: defaultFrameLabel(frameNo),
  frameNo,
  shotId,
  shotCount: 2,
  active: true,
  exposureSec: 0.25,
  aperture: 5.6,
  iso: 200,
  shutterAngle: 180,
  lighting: '主灯 + 柔光箱',
  propOffsetMm: 0,
  note: '',
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

/** 默认格名 */
export function defaultFrameLabel(frameNo: number): string {
  return `第${frameNo}格`;
}

/** 生成格子永久 uid（本地台账无需中心化 id 服务） */
export function createFrameUid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `frm_${crypto.randomUUID()}`;
  }
  return `frm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** 批量曝光设置（供 /frames 编排台使用） */
export interface BatchExposure {
  exposureSec: number;
  aperture: number;
  iso: number;
  shutterAngle: number;
}
