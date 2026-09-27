/**
 * 逐帧拍摄台账计算：每格按自己的张数统计已拍、废片与待拍。
 * 废片重新算进待拍；计划下调后的超量已拍不消失，留在补拍清单。
 */
import type { FrameEntry } from '../types/frame';

/** 一格的台账行 */
export interface FrameLedgerRow {
  frameNo: number;
  /** 计划张数（帧条目自己的张数） */
  planned: number;
  /** 已拍张数（含废片） */
  taken: number;
  /** 废片张数 */
  wasted: number;
  /** 有效张数 = 已拍 - 废片 */
  good: number;
  /** 待拍 = 计划 - 有效（废片重新算进待拍） */
  remaining: number;
  /** 超量 = 有效 - 计划（计划下调后仍保留，不消失） */
  excess: number;
  /** 该格是否已拍齐 */
  done: boolean;
}

/** 由帧条目算出一格的台账行 */
export function ledgerRowOf(frame: FrameEntry): FrameLedgerRow {
  const planned = Math.max(0, Math.floor(frame.shotCount || 0));
  const taken = Math.max(0, Math.floor(frame.takenCount || 0));
  const wasted = Math.min(taken, Math.max(0, Math.floor(frame.wastedCount || 0)));
  const good = taken - wasted;
  const remaining = Math.max(0, planned - good);
  const excess = Math.max(0, good - planned);
  return { frameNo: frame.frameNo, planned, taken, wasted, good, remaining, excess, done: remaining === 0 };
}

/** 镜头级台账合计 */
export interface LedgerSummary {
  planned: number;
  taken: number;
  wasted: number;
  good: number;
  remaining: number;
  excess: number;
  percent: number;
}

/**
 * 汇总一段帧序的台账。
 * 完成度按「计划 - 待拍」逐格封顶计算：某格的超量不抵扣其它格的待拍。
 */
export function summarizeLedger(frames: FrameEntry[]): LedgerSummary {
  const rows = frames.map(ledgerRowOf);
  const planned = rows.reduce((s, r) => s + r.planned, 0);
  const taken = rows.reduce((s, r) => s + r.taken, 0);
  const wasted = rows.reduce((s, r) => s + r.wasted, 0);
  const good = rows.reduce((s, r) => s + r.good, 0);
  const remaining = rows.reduce((s, r) => s + r.remaining, 0);
  const excess = rows.reduce((s, r) => s + r.excess, 0);
  const done = planned - remaining;
  const percent = planned > 0 ? Math.min(100, Math.round((done / planned) * 100)) : 0;
  return { planned, taken, wasted, good, remaining, excess, percent };
}

/** 台账行状态：待拍 / 拍摄中 / 已完成 / 超量（计划下调后多拍的张数保留在补拍清单） */
export type LedgerRowStatus = '待拍' | '拍摄中' | '已完成' | '超量';

export function ledgerRowStatus(row: FrameLedgerRow): LedgerRowStatus {
  if (row.excess > 0) return '超量';
  if (row.remaining === 0) return '已完成';
  if (row.good > 0 || row.taken > 0) return '拍摄中';
  return '待拍';
}
