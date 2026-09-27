/** 数据访问层：所有读写都在这里收口，写入前统一脱代理 */
import { db, toPlain } from './index';
import type { Shot } from '../types/shot';
import type { FrameEntry } from '../types/frame';
import type { PropState } from '../types/prop';
import type { TakeLog, PickupItem } from '../types/take';

export async function initDb(): Promise<void> {
  if (!db.isOpen()) await db.open();
}

/* ---------------- shots ---------------- */

export async function listShots(): Promise<Shot[]> {
  const rows = await db.shots.toArray();
  return rows.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'));
}

export async function getShot(id: number): Promise<Shot | undefined> {
  return db.shots.get(id);
}

export async function addShot(shot: Shot): Promise<number> {
  return db.shots.add(toPlain(shot));
}

export async function updateShot(id: number, patch: Partial<Shot>): Promise<void> {
  await db.shots.update(id, toPlain({ ...patch, updatedAt: Date.now() }));
}

export async function deleteShot(id: number): Promise<void> {
  await db.transaction('rw', db.shots, db.frames, db.props, db.takes, db.pickups, async () => {
    await db.frames.where('shotId').equals(id).delete();
    await db.props.where('shotId').equals(id).delete();
    await db.takes.where('shotId').equals(id).delete();
    await db.pickups.where('shotId').equals(id).delete();
    await db.shots.delete(id);
  });
}

/* ---------------- frames（逐帧台账格子，uid 永久不变） ---------------- */

/** 读取镜头仍在条带上的格子（按位次排序） */
export async function listFrames(shotId: number): Promise<FrameEntry[]> {
  const rows = await db.frames.where('shotId').equals(shotId).toArray();
  return rows.filter((f) => f.active).sort((a, b) => a.frameNo - b.frameNo);
}

/** 读取镜头的全部格子（含已从条带移除的，用于补拍追溯） */
export async function listAllFramesOfShot(shotId: number): Promise<FrameEntry[]> {
  const rows = await db.frames.where('shotId').equals(shotId).toArray();
  return rows.sort((a, b) => a.frameNo - b.frameNo);
}

export async function listAllFrames(): Promise<FrameEntry[]> {
  return db.frames.toArray();
}

export async function getFrameByUid(uid: string): Promise<FrameEntry | undefined> {
  return db.frames.where('uid').equals(uid).first();
}

export async function addFrame(frame: FrameEntry): Promise<number> {
  return db.frames.add(toPlain(frame));
}

export async function addFrames(frames: FrameEntry[]): Promise<void> {
  if (!frames.length) return;
  await db.frames.bulkAdd(frames.map((f) => toPlain(f)));
}

export async function updateFrame(id: number, patch: Partial<FrameEntry>): Promise<void> {
  await db.frames.update(id, toPlain({ ...patch, updatedAt: Date.now() }));
}

/** 按 uid 更新格子（台账记录引用的是 uid，不是自增 id） */
export async function updateFrameByUid(uid: string, patch: Partial<FrameEntry>): Promise<void> {
  await db.frames.where('uid').equals(uid).modify(toPlain({ ...patch, updatedAt: Date.now() }) as Record<string, unknown>);
}

/**
 * 条带重排：只改 frameNo，绝不删除重建，保证每格 id/uid 稳定，
 * 实拍记录与补拍条目永远对得回原格。
 */
export async function renumberFrames(ordered: FrameEntry[]): Promise<void> {
  await db.transaction('rw', db.frames, async () => {
    const now = Date.now();
    for (let i = 0; i < ordered.length; i += 1) {
      const row = ordered[i];
      if (typeof row.id !== 'number') continue;
      if (row.frameNo !== i + 1) {
        await db.frames.update(row.id, { frameNo: i + 1, updatedAt: now });
      }
    }
  });
}

/** 格子从条带移除：软删除（active=false），历史实拍与补拍记录保留 */
export async function deactivateFrame(id: number): Promise<void> {
  await db.frames.update(id, { active: false, updatedAt: Date.now() });
}

/* ---------------- props ---------------- */

export async function listProps(shotId: number): Promise<PropState[]> {
  const rows = await db.props.where('shotId').equals(shotId).toArray();
  return rows.sort((a, b) => a.fromFrame - b.fromFrame || a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

export async function listAllProps(): Promise<PropState[]> {
  return db.props.toArray();
}

export async function addProp(prop: PropState): Promise<number> {
  return db.props.add(toPlain(prop));
}

export async function updateProp(id: number, patch: Partial<PropState>): Promise<void> {
  await db.props.update(id, toPlain({ ...patch, updatedAt: Date.now() }));
}

export async function deleteProp(id: number): Promise<void> {
  await db.props.delete(id);
}

/* ---------------- takes（逐格实拍登记） ---------------- */

export async function listTakes(): Promise<TakeLog[]> {
  const rows = await db.takes.toArray();
  return rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.id ?? 0) - (a.id ?? 0)));
}

export async function listTakesByShot(shotId: number): Promise<TakeLog[]> {
  const rows = await db.takes.where('shotId').equals(shotId).toArray();
  return rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.id ?? 0) - (a.id ?? 0)));
}

export async function addTake(take: TakeLog): Promise<number> {
  return db.takes.add(toPlain(take));
}

export async function updateTake(id: number, patch: Partial<TakeLog>): Promise<void> {
  await db.takes.update(id, toPlain({ ...patch, updatedAt: Date.now() }));
}

export async function deleteTake(id: number): Promise<void> {
  await db.takes.delete(id);
}

/* ---------------- pickups（补拍清单） ---------------- */

export async function listPickups(): Promise<PickupItem[]> {
  return db.pickups.toArray();
}

export async function listPickupsByShot(shotId: number): Promise<PickupItem[]> {
  return db.pickups.where('shotId').equals(shotId).toArray();
}

export async function addPickup(item: PickupItem): Promise<number> {
  return db.pickups.add(toPlain(item));
}

export async function updatePickup(id: number, patch: Partial<PickupItem>): Promise<void> {
  await db.pickups.update(id, toPlain({ ...patch, updatedAt: Date.now() }));
}

export async function deletePickup(id: number): Promise<void> {
  await db.pickups.delete(id);
}
