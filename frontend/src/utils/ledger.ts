/**
 * 逐帧拍摄台账核心算法（全部为纯函数）。
 *
 * 记账规则：
 *   好张 good = 已拍 taken − 废片 wasted
 *   待拍 remaining = max(0, 计划张数 required − 好张 good)
 *   —— 废片必须重拍，因此自动重新计入待拍。
 *   超量 excess = max(0, 好张 good − 计划张数 required)
 *      —— 计划张数下调、登记多拍、或格子移出条带时，超量不能消失，进补拍清单。
 */
import type { FrameEntry } from '../types/frame';
import type { TakeLog } from '../types/take';

export interface FrameLedger {
  /** 格子永久 uid */
  uid: string;
  /** 计划张数（该格自己的张数） */
  required: number;
  /** 累计实拍张数（含废片） */
  taken: number;
  /** 累计废片张数 */
  wasted: number;
  /** 累计好张 = 已拍 − 废片 */
  good: number;
  /** 待拍张数（废片已重新计入） */
  remaining: number;
  /** 超量好张（已拍好但超出计划，需进补拍清单） */
  excess: number;
  /** 完成百分比 0-100，按好张/计划张数 */
  percent: number;
  /** 是否拍齐（好张 ≥ 计划） */
  done: boolean;
}

/** 单格张数汇总：由该格的全部实拍记录累加 */
export function sumTakes(rows: Pick<TakeLog, 'takenFrames' | 'wastedFrames'>[]): { taken: number; wasted: number } {
  return rows.reduce(
    (acc, r) => ({
      taken: acc.taken + Math.max(0, Math.floor(r.takenFrames || 0)),
      wasted: acc.wasted + Math.max(0, Math.floor(r.wastedFrames || 0)),
    }),
    { taken: 0, wasted: 0 },
  );
}

/** 由计划张数与（已拍、废片）算单格台账 */
export function frameLedger(required: number, taken: number, wasted: number): FrameLedger {
  const req = Math.max(0, Math.floor(required));
  const shot = Math.max(0, Math.floor(taken));
  const bad = Math.min(shot, Math.max(0, Math.floor(wasted)));
  const good = shot - bad;
  const remaining = Math.max(0, req - good);
  const excess = Math.max(0, good - req);
  const percent = req > 0 ? Math.min(100, Math.round((good / req) * 100)) : good > 0 ? 100 : 0;
  return {
    uid: '',
    required: req,
    taken: shot,
    wasted: bad,
    good,
    remaining,
    excess,
    percent,
    done: req > 0 && good >= req,
  };
}

export interface ShotLedger {
  /** 计划张数（条带上各格张数之和） */
  required: number;
  /** 已拍张数（含废片，含旧整天记录） */
  taken: number;
  /** 废片张数 */
  wasted: number;
  /** 好张 */
  good: number;
  /** 待拍（各格待拍之和；旧整天记录无法对格，不冲抵待拍，单独提示） */
  remaining: number;
  /** 超量好张（各格超量之和） */
  excess: number;
  /** 旧版整天登记、对不到格子的好张 */
  unassignedGood: number;
  /** 完成百分比：好张/计划，上限 100 */
  percent: number;
  /** 已拍齐的格子数 / 条带格子数 */
  doneFrames: number;
  totalFrames: number;
}

/**
 * 镜头级汇总。
 * @param frames 镜头条带上的格子（active）
 * @param takes  镜头的全部实拍记录（含 frameUid=null 的旧整天记录）
 */
export function shotLedger(frames: FrameEntry[], takes: TakeLog[]): ShotLedger {
  let required = 0;
  let remaining = 0;
  let excess = 0;
  let doneFrames = 0;

  for (const frame of frames) {
    const cell = sumTakes(takes.filter((t) => t.frameUid === frame.uid));
    const ledger = frameLedger(frame.shotCount, cell.taken, cell.wasted);
    required += ledger.required;
    remaining += ledger.remaining;
    excess += ledger.excess;
    if (ledger.done) doneFrames += 1;
  }

  const assigned = sumTakes(takes.filter((t) => t.frameUid !== null));
  const unassigned = sumTakes(takes.filter((t) => t.frameUid === null));
  const taken = assigned.taken + unassigned.taken;
  const wasted = assigned.wasted + unassigned.wasted;
  const good = assigned.taken - assigned.wasted + (unassigned.taken - unassigned.wasted);
  const unassignedGood = unassigned.taken - unassigned.wasted;
  const percent = required > 0 ? Math.min(100, Math.round((good / required) * 100)) : 0;

  return {
    required,
    taken,
    wasted,
    good,
    remaining,
    excess,
    unassignedGood,
    percent,
    doneFrames,
    totalFrames: frames.length,
  };
}

/** 全片汇总：直接累加各镜头汇总 */
export function overallLedger(shots: ShotLedger[]): Omit<ShotLedger, 'doneFrames' | 'totalFrames'> & {
  percent: number;
  doneFrames: number;
  totalFrames: number;
} {
  const acc = shots.reduce(
    (a, s) => ({
      required: a.required + s.required,
      taken: a.taken + s.taken,
      wasted: a.wasted + s.wasted,
      good: a.good + s.good,
      remaining: a.remaining + s.remaining,
      excess: a.excess + s.excess,
      unassignedGood: a.unassignedGood + s.unassignedGood,
      doneFrames: a.doneFrames + s.doneFrames,
      totalFrames: a.totalFrames + s.totalFrames,
    }),
    { required: 0, taken: 0, wasted: 0, good: 0, remaining: 0, excess: 0, unassignedGood: 0, doneFrames: 0, totalFrames: 0 },
  );
  const percent = acc.required > 0 ? Math.min(100, Math.round((acc.good / acc.required) * 100)) : 0;
  return { ...acc, percent };
}

/** 登记校验：实拍张数 ≥ 废片 ≥ 0，实拍至少 1 */
export function validateRegistration(taken: number, wasted: number): string {
  if (!Number.isFinite(taken) || taken < 1) return '实拍张数需大于 0';
  if (!Number.isFinite(wasted) || wasted < 0) return '废片数不能为负';
  if (wasted > taken) return '废片数不能多于实拍张数';
  return '';
}
