<script setup lang="ts">
/**
 * 进度总览：各镜头的逐帧台账汇总（每格按自己的张数计），
 * 累计全片计划/已拍/废片/待拍张数与补拍清单待处理数。
 * 消费 Shot、FrameEntry、TakeLog、PickupItem。
 */
import { computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { storeToRefs } from 'pinia';
import { useShotStore } from '../stores/shotStore';
import { useFrameStore } from '../stores/frameStore';
import { useLedgerStore } from '../stores/ledgerStore';
import { framesToDuration } from '../utils/frameMath';
import { formatDateTime } from '../utils/format';
import ShotProgress from '../components/common/ShotProgress.vue';
import StatusTag from '../components/common/StatusTag.vue';
import EmptyState from '../components/common/EmptyState.vue';

const router = useRouter();
const shotStore = useShotStore();
const frameStore = useFrameStore();
const ledgerStore = useLedgerStore();
const { shots } = storeToRefs(shotStore);
const { openPickups } = storeToRefs(ledgerStore);

onMounted(async () => {
  await shotStore.load();
  await ledgerStore.load();
});

const rows = computed(() =>
  shots.value.map((shot) => {
    const id = shot.id ?? 0;
    const frames = ledgerStore.framesOfShot(id);
    const stat = ledgerStore.shotStat(id);
    return {
      shot,
      frames,
      frameCount: frames.length,
      plannedSheets: frames.reduce((sum, f) => sum + f.shotCount, 0),
      duration: framesToDuration(frames.length, shot.fps),
      stat,
    };
  }),
);

const overall = computed(() => ledgerStore.overall);
const activeFrameCount = computed(() =>
  ledgerStore.frames.filter((f) => f.active && shots.value.some((s) => s.id === f.shotId)).length,
);
const statusCount = computed(() => ({
  idle: shots.value.filter((s) => s.status === '未开机').length,
  shooting: shots.value.filter((s) => s.status === '拍摄中').length,
  done: shots.value.filter((s) => s.status === '已完成').length,
}));

function goDetail(id: number | undefined) {
  if (typeof id !== 'number') return;
  void frameStore.loadForShot(id);
  void router.push(`/shots/${id}`);
}
</script>

<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h1>进度总览</h1>
        <p class="sub">逐帧拍摄台账：每格按自己的张数记已拍与废片，废片自动重算进待拍</p>
      </div>
      <div class="head-actions">
        <button type="button" class="btn primary" @click="router.push('/shots/new')">新建镜头</button>
        <button type="button" class="btn" @click="router.push('/frames')">帧序编排台</button>
      </div>
    </header>

    <div class="stat-row">
      <div class="stat">
        <span class="label">镜头总数</span>
        <span class="value">{{ shots.length }}</span>
        <span class="hint">未开机 {{ statusCount.idle }} · 拍摄中 {{ statusCount.shooting }} · 已完成 {{ statusCount.done }}</span>
      </div>
      <div class="stat">
        <span class="label">条带格子 / 计划张数</span>
        <span class="value">{{ activeFrameCount }} <small>格</small></span>
        <span class="hint">合计 {{ overall.required }} 张（每格张数之和）</span>
      </div>
      <div class="stat">
        <span class="label">累计实拍</span>
        <span class="value">{{ overall.taken }}</span>
        <span class="hint">好张 {{ overall.good }} · 废片 {{ overall.wasted }} 张</span>
      </div>
      <div class="stat">
        <span class="label">待拍 / 补拍清单</span>
        <span class="value">{{ overall.remaining }}</span>
        <span class="hint">
          整体完成 {{ overall.percent }}% ·
          <RouterLink class="link" to="/progress">补拍 {{ openPickups.length }} 条</RouterLink>
        </span>
      </div>
    </div>

    <div v-if="overall.unassignedGood > 0" class="notice" data-testid="legacy-notice">
      另有 {{ overall.unassignedGood }} 张好张来自旧版「按整天登记」的记录，对不到具体格子，已计入实拍但不冲抵各格待拍；
      可到 <RouterLink class="link" to="/progress">实拍记录</RouterLink> 查看。
    </div>

    <div class="panel">
      <div class="panel-head">
        <h2>镜头清单</h2>
        <span class="muted">{{ ledgerStore.loading ? '读取台账中…' : '数据来源：IndexedDB（gbstopmotion-db）' }}</span>
      </div>

      <EmptyState
        v-if="!rows.length"
        title="还没有镜头"
        description="创建第一个镜头后，逐格登记已拍与废片，这里会汇总各镜头进度与补拍清单。"
        action-text="新建镜头"
        @action="router.push('/shots/new')"
      />

      <table v-else class="table" data-testid="shot-table">
        <thead>
          <tr>
            <th>镜号</th>
            <th>场景</th>
            <th>状态</th>
            <th>帧率</th>
            <th>格子 / 张数</th>
            <th>预计时长</th>
            <th>完成度（逐格）</th>
            <th>待拍</th>
            <th>负责人</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.shot.id">
            <td class="mono">{{ row.shot.code }}</td>
            <td>{{ row.shot.sceneName }}</td>
            <td><StatusTag :status="row.shot.status" size="small" /></td>
            <td>{{ row.shot.fps }} fps</td>
            <td>{{ row.frameCount }} 格 / {{ row.plannedSheets }} 张</td>
            <td>{{ row.duration }} s</td>
            <td class="progress-cell">
              <ShotProgress
                compact
                :planned="row.stat.required"
                :taken="row.stat.good"
                :wasted="row.stat.wasted"
                :remaining="row.stat.remaining"
                :percent="row.stat.percent"
              />
              <span class="muted small">已拍齐 {{ row.stat.doneFrames }}/{{ row.stat.totalFrames }} 格</span>
            </td>
            <td>
              <strong :class="{ warn: row.stat.remaining > 0 }">{{ row.stat.remaining }}</strong>
              <span v-if="row.stat.excess > 0" class="pickup-flag" :title="`超量好张 ${row.stat.excess} 张已进入补拍清单`">
                补 {{ row.stat.excess }}
              </span>
            </td>
            <td>{{ row.shot.owner || '未指派' }}</td>
            <td>
              <button type="button" class="btn small" @click="goDetail(row.shot.id)">逐格台账</button>
            </td>
          </tr>
        </tbody>
      </table>

      <p v-if="rows.length" class="muted footer-note">
        最近更新：{{ formatDateTime(Math.max(...shots.map((s) => s.updatedAt || 0))) }}
      </p>
    </div>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.page-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  gap: 16px;
}
h1 {
  margin: 0;
  font-size: 22px;
}
.sub {
  margin: 4px 0 0;
  color: #6b7686;
  font-size: 13px;
}
.head-actions {
  display: flex;
  gap: 10px;
}
.stat-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: 12px;
}
.stat {
  background: #fff;
  border: 1px solid #e2e7ef;
  border-radius: 10px;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.stat .label {
  font-size: 12px;
  color: #6b7686;
}
.stat .value {
  font-size: 24px;
  font-weight: 700;
  color: #1f2d3d;
}
.stat .value small {
  font-size: 13px;
  font-weight: 400;
  color: #6b7686;
}
.stat .hint {
  font-size: 12px;
  color: #8a94a6;
}
.link {
  color: #2f6fed;
  text-decoration: none;
}
.link:hover {
  text-decoration: underline;
}
.notice {
  background: #fff7e8;
  border: 1px solid #f3ddb0;
  color: #8a5a10;
  border-radius: 8px;
  padding: 9px 12px;
  font-size: 13px;
}
.panel {
  background: #fff;
  border: 1px solid #e2e7ef;
  border-radius: 10px;
  padding: 16px;
}
.panel-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}
.panel-head h2 {
  margin: 0;
  font-size: 16px;
}
.muted {
  color: #8a94a6;
  font-size: 12px;
}
.muted.small {
  font-size: 11px;
}
.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.table th,
.table td {
  text-align: left;
  padding: 10px 8px;
  border-bottom: 1px solid #eef1f6;
  vertical-align: middle;
}
.table th {
  color: #6b7686;
  font-weight: 600;
  font-size: 12px;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.progress-cell {
  min-width: 210px;
}
.warn {
  color: #d99b2b;
}
.pickup-flag {
  margin-left: 6px;
  font-size: 11px;
  color: #b36a00;
  background: #fff3dc;
  border-radius: 999px;
  padding: 1px 8px;
}
.btn {
  height: 32px;
  padding: 0 14px;
  border-radius: 6px;
  border: 1px solid #cfd6e0;
  background: #fff;
  color: #1f2d3d;
  cursor: pointer;
  font-size: 13px;
}
.btn.primary {
  background: #2f6fed;
  border-color: #2f6fed;
  color: #fff;
}
.btn.small {
  height: 28px;
  padding: 0 10px;
  font-size: 12px;
}
.footer-note {
  margin: 10px 0 0;
}
</style>
