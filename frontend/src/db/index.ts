/**
 * IndexedDB 持久化层（Dexie 封装）。
 * 库名 gbstopmotion-db，含版本号与升级迁移：
 *   v1 建 shots / frames
 *   v2 增加 props 表与 shotId 索引
 *   v3 增加 takes 表，并按实拍张数回填进度
 *   v4 逐帧拍摄台账：frames 补 uid/label/active（永久格子身份），
 *      takes 补 frameUid/frameLabel/frameNo/note（逐格登记，旧整天记录 frameUid=null 保留），
 *      新增 pickups 补拍清单表。
 */
import Dexie from 'dexie';
import type { Table } from 'dexie';
import type { Shot } from '../types/shot';
import type { FrameEntry } from '../types/frame';
import { createFrameUid, defaultFrameLabel } from '../types/frame';
import type { PropState } from '../types/prop';
import type { TakeLog, PickupItem } from '../types/take';

export const DB_NAME = 'gbstopmotion-db';

/**
 * 脱代理：Pinia 里的对象是 Proxy，直接写进 IndexedDB 会抛 DataCloneError。
 * 这里统一做一次结构化克隆后的纯对象转换。
 */
export function toPlain<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}

export class StopMotionDb extends Dexie {
  shots!: Table<Shot, number>;
  frames!: Table<FrameEntry, number>;
  props!: Table<PropState, number>;
  takes!: Table<TakeLog, number>;
  pickups!: Table<PickupItem, number>;

  constructor() {
    super(DB_NAME);
    this.version(1).stores({
      shots: '++id, code, status, sceneName',
      frames: '++id, shotId, frameNo, [shotId+frameNo]',
    });
    this.version(2)
      .stores({
        shots: '++id, code, status, sceneName',
        frames: '++id, shotId, frameNo, [shotId+frameNo]',
        props: '++id, shotId, name, [shotId+fromFrame]',
      })
      .upgrade(async (tx) => {
        // v2：为已有帧补齐道具位移字段，保证轨迹页可直接读取
        await tx
          .table('frames')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (typeof row.propOffsetMm !== 'number') row.propOffsetMm = 0;
          });
      });
    this.version(3)
      .stores({
        shots: '++id, code, status, sceneName',
        frames: '++id, shotId, frameNo, [shotId+frameNo]',
        props: '++id, shotId, name, [shotId+fromFrame]',
        takes: '++id, shotId, date, shotCode',
      })
      .upgrade(async (tx) => {
        // v3：按已登记的实拍张数回填完成百分比
        const takes = await tx.table('takes').toCollection().toArray();
        const shots = await tx.table('shots').toCollection().toArray();
        for (const take of takes) {
          const shot = shots.find((s: Record<string, unknown>) => s.id === take.shotId);
          if (!shot || typeof shot.durationSec !== 'number' || typeof shot.fps !== 'number') continue;
          const total = Math.max(1, Math.ceil(shot.durationSec * shot.fps));
          const percent = Math.min(100, Math.round((take.takenFrames / total) * 100));
          await tx.table('takes').update(take.id, { percent });
        }
      });
    this.version(4)
      .stores({
        shots: '++id, code, status, sceneName',
        // uid 为永久身份索引；active 为普通字段（内存过滤），不建复合索引
        frames: '++id, uid, shotId, frameNo, [shotId+frameNo]',
        props: '++id, shotId, name, [shotId+fromFrame]',
        takes: '++id, shotId, date, shotCode, frameUid',
        pickups: '++id, shotId, frameUid, resolved',
      })
      .upgrade(async (tx) => {
        // 格子补永久 uid / 格名 / active；同一镜头内保持原帧序号
        const frameRows = await tx.table('frames').toCollection().toArray();
        for (const row of frameRows as Array<Record<string, unknown>>) {
          const patch: Record<string, unknown> = {};
          if (typeof row.uid !== 'string' || !row.uid) patch.uid = createFrameUid();
          if (typeof row.label !== 'string' || !row.label) {
            patch.label = defaultFrameLabel(typeof row.frameNo === 'number' ? row.frameNo : 1);
          }
          if (typeof row.active !== 'boolean') patch.active = true;
          if (typeof row.createdAt !== 'number') patch.createdAt = typeof row.updatedAt === 'number' ? row.updatedAt : Date.now();
          if (Object.keys(patch).length) await tx.table('frames').update(row.id, patch);
        }
        // 旧版整天实拍记录：frameUid=null 原样保留，继续可用于每日台账
        const takeRows = await tx.table('takes').toCollection().toArray();
        for (const row of takeRows as Array<Record<string, unknown>>) {
          const patch: Record<string, unknown> = {};
          if (row.frameUid === undefined) patch.frameUid = null;
          if (typeof row.frameLabel !== 'string') patch.frameLabel = '';
          if (row.frameNo === undefined) patch.frameNo = null;
          if (typeof row.note !== 'string') patch.note = '';
          if (Object.keys(patch).length) await tx.table('takes').update(row.id, patch);
        }
      });
  }
}

export const db = new StopMotionDb();
