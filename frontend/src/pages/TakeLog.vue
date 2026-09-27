<script setup lang="ts">
/**
 * 实拍记录 / 补拍清单：
 * - 逐格登记实拍与废片（登记后该格、镜头、总览进度一起变化，废片重计待拍）；
 * - 每日实拍台账：按「镜头 + 日期」汇总，原有按整天登记的历史记录照常显示；
 * - 补拍清单：张数下调、多拍、格子移除产生的超量好张，核销前一直挂账。
 * 消费 TakeLog、PickupItem、Shot、FrameEntry。
 */
import { computed, onMounted, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useShotStore } from '../stores/shotStore';
import { useLedgerStore } from '../stores/ledgerStore';
import { formatDateTime, today } from '../utils/format';
import ShotProgress from '../components/common/ShotProgress.vue';
import StatusTag from '../components/common/StatusTag.vue';
import EmptyState from '../components/common/EmptyState.vue';
import RegisterTakeForm from '../components/common/RegisterTakeForm.vue';
import { PICKUP_REASON_LABEL } from '../types/take';
import type { TakeLog } from '../types/take';

const shotStore = useShotStore();
const ledgerStore = useLedgerStore();
const { shots } = storeToRefs(shotStore);
const { openPickups, resolvedPickups, loading } = storeToRefs(ledgerStore);

const selectedShotId = ref<number | null>(null);
const showArchive = ref(false);

onMounted(async () => {
  if (!shotStore.ready) await shotStore.load();
  if (!ledgerStore.ready) await ledgerStore.load();
  const first = shots.value[0];
  if (first && typeof first.id === 'number') selectedShotId.value = first.id;
});

const selectedShot = computed(() => (selectedShotId.value === null ? undefined : shotStore.byId(selectedShotId.value)));
const selectedFrames = computed(() =>
  selectedShotId.value === null ? [] : ledgerStore.framesOfShot(selectedShotId.value),
);
const selectedStat = computed(() => (selectedShotId.value === null ? undefined : ledgerStore.shotStat(selectedShotId.value)));
const overall = computed(() => ledgerStore.overall);

interface DailyRow {
  key: string;
  date: string;
  shotId: number;
  shotCode: string;
  taken: number;
  wasted: number;
  good: number;
  count: number;
  rows: TakeLog[];
}

/** 每日实拍台账：同镜头同一天的逐格登记合并为一行，点开看明细 */
const dailyRows = computed<DailyRow[]>(() => {
  const map = new Map<string, DailyRow>();
  for (const t of ledgerStore.takes) {
    const key = `${t.shotId}@${t.date}`;
    const row = map.get(key);
    const taken = t.takenFrames || 0;
    const wasted = t.wastedFrames || 0;
    if (row) {
      row.taken += taken;
      row.wasted += wasted;
      row.good += taken - wasted;
      row.count += 1;
      row.rows.push(t);
    } else {
      map.set(key, {
        key,
        date: t.date,
        shotId: t.shotId,
        shotCode: t.shotCode,
        taken,
        wasted,
        good: taken - wasted,
        count: 1,
        rows: [t],
      });
    }
  }
  return [...map.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.shotCode.localeCompare(b.shotCode)));
});

const expanded = ref<Set<string>>(new Set());
function toggle(key: string) {
  const next = new Set(expanded.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  expanded.value = next;
}

function frameLabelOf(t: TakeLog): string {
  if (!t.frameUid) return '整天汇总（旧记录）';
  const frame = ledgerStore.frames.find((f) => f.uid === t.frameUid);
  if (!frame) return `${t.frameLabel}（已删除）`;
  return frame.active ? `${frame.label}（第 ${frame.frameNo} 格）` : `${frame.label}（已移出条带）`;
}

async function removeRow(row: TakeLog) {
  if (typeof row.id !== 'number') return;
  await ledgerStore.removeTake(row.id);
}

async function resolvePickup(id: number | undefined) {
  if (typeof id !== 'number') return;
  await ledgerStore.resolvePickup(id);
}

function onRegistered() {
  /* 进度由 store 响应式更新，无需额外处理 */
}

const openPickupTotal = computed(() => openPickups.value.reduce((s, p) => s + p.liveExcess, 0));
const isToday = (date: string) => date === today();
</script>

<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h1>实拍记录 · 补拍清单</h1>
        <p class="sub">逐格登记已拍与废片，废片自动重算进待拍；每日按镜头汇总，原有整天记录照常使用</p>
      </div>
      <div class="stat-inline">
        <span>全片待拍 <strong>{{ overall.remaining }}</strong> 张</span>
        <span>补拍清单 <strong class="warn">{{ openPickups.length }}</strong> 条 / {{ openPickupTotal }} 张</span>
      </div>
    </header>

    <EmptyState v-if="!shots.length" title="还没有镜头" description="请先到「新建镜头」创建镜头，再逐格登记实拍。" />

    <template v-else>
      <div class="two-panel">
        <div class="panel">
          <div class="panel-head">
            <h2>逐格登记实拍</h2>
            <select v-model.number="selectedShotId" class="shot-select" data-testid="take-shot-select">
              <option v-for="s in shots" :key="s.id" :value="s.id">{{ s.code }} · {{ s.sceneName }}</option>
            </select>
          </div>
          <RegisterTakeForm
            v-if="selectedShot && selectedFrames.length"
            :key="selectedShotId ?? 'none'"
            :shot="selectedShot"
            :frames="selectedFrames"
            @registered="onRegistered"
          />
          <EmptyState v-else title="该镜头条带上还没有格子" description="到镜头详情或帧序编排台插入格子后，再逐格登记。" />
        </div>

        <div class="panel">
          <div class="panel-head">
            <h2>当前镜头进度</h2>
            <StatusTag v-if="selectedShot" :status="selectedShot.status" />
          </div>
          <ShotProgress
            v-if="selectedStat"
            :code="selectedShot?.code ?? ''"
            :status="selectedShot?.status ?? ''"
            :planned="selectedStat.required"
            :taken="selectedStat.good"
            :wasted="selectedStat.wasted"
            :remaining="selectedStat.remaining"
            :percent="selectedStat.percent"
          />
          <ul v-if="selectedStat" class="facts">
            <li>条带 {{ selectedStat.totalFrames }} 格，已拍齐 {{ selectedStat.doneFrames }} 格</li>
            <li>累计实拍 {{ selectedStat.taken }} 张（含废片 {{ selectedStat.wasted }} 张）</li>
            <li v-if="selectedStat.excess > 0" class="warn">超量好张 {{ selectedStat.excess }} 张已进补拍清单</li>
            <li v-if="selectedStat.unassignedGood > 0" class="muted">另有旧版整天记录好张 {{ selectedStat.unassignedGood }} 张，不对格冲抵</li>
          </ul>
        </div>
      </div>

      <div class="panel pickup-panel">
        <div class="panel-head">
          <h2>补拍清单（{{ openPickups.length }}）</h2>
          <span class="muted">张数下调 / 多拍 / 格子移除产生的超量好张，不核销不消失</span>
        </div>
        <table v-if="openPickups.length" class="table" data-testid="pickup-table">
          <thead>
            <tr><th>镜头</th><th>格子</th><th>原因</th><th>超量好张</th><th>计数方式</th><th>操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="p in openPickups" :key="p.id">
              <td class="mono">{{ p.shotCode }}</td>
              <td>
                {{ p.frameLabel }}
                <span v-if="p.reason === 'removed'" class="tag">已移出条带</span>
              </td>
              <td>{{ PICKUP_REASON_LABEL[p.reason] }}</td>
              <td class="warn strong">{{ p.liveExcess }} 张</td>
              <td class="muted">{{ p.reason === 'removed' ? '移除时固定快照' : '随该格计划实时重算' }}</td>
              <td><button type="button" class="btn tiny" data-testid="pickup-resolve" @click="resolvePickup(p.id)">核销归档</button></td>
            </tr>
          </tbody>
        </table>
        <EmptyState v-else title="补拍清单为空" description="张数下调、登记多拍或移除已拍格子时，超量好张会自动留在这里。" />
        <div v-if="resolvedPickups.length" class="archive-toggle">
          <button type="button" class="link-btn" @click="showArchive = !showArchive">
            {{ showArchive ? '收起' : '查看' }}已归档（{{ resolvedPickups.length }}）
          </button>
        </div>
        <table v-if="showArchive && resolvedPickups.length" class="table archive">
          <thead>
            <tr><th>镜头</th><th>格子</th><th>原因</th><th>归档时超量</th><th>核销时间</th></tr>
          </thead>
          <tbody>
            <tr v-for="p in resolvedPickups" :key="p.id">
              <td class="mono">{{ p.shotCode }}</td>
              <td>{{ p.frameLabel }}</td>
              <td>{{ PICKUP_REASON_LABEL[p.reason] }}</td>
              <td>{{ p.excess }} 张</td>
              <td class="muted">{{ formatDateTime(p.updatedAt) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="panel">
        <div class="panel-head">
          <h2>每日实拍台账</h2>
          <span class="muted">{{ loading ? '读取中…' : '按镜头 + 日期汇总，点击行展开逐格明细' }}</span>
        </div>
        <table v-if="dailyRows.length" class="table" data-testid="take-table">
          <thead>
            <tr><th>拍摄日期</th><th>镜号</th><th>登记条数</th><th>实拍张数</th><th>废片</th><th>好张</th><th>明细</th></tr>
          </thead>
          <tbody>
            <template v-for="d in dailyRows" :key="d.key">
              <tr class="daily-head" @click="toggle(d.key)">
                <td class="mono">
                  {{ d.date }}
                  <span v-if="isToday(d.date)" class="today">今天</span>
                </td>
                <td class="mono">{{ d.shotCode }}</td>
                <td>{{ d.count }} 条</td>
                <td>{{ d.taken }}</td>
                <td :class="{ warn: d.wasted > 0 }">{{ d.wasted }}</td>
                <td>{{ d.good }}</td>
                <td><button type="button" class="btn tiny" @click.stop="toggle(d.key)">{{ expanded.has(d.key) ? '收起' : '展开' }}</button></td>
              </tr>
              <template v-if="expanded.has(d.key)">
                <tr v-for="row in d.rows" :key="row.id" class="detail-row">
                  <td class="muted mono">{{ formatDateTime(row.updatedAt) }}</td>
                  <td colspan="3">{{ frameLabelOf(row) }}<span v-if="row.note" class="muted"> · {{ row.note }}</span></td>
                  <td class="muted">废 {{ row.wastedFrames }}</td>
                  <td>{{ row.takenFrames - row.wastedFrames }} 好张</td>
                  <td><button type="button" class="btn tiny danger" @click="removeRow(row)">删除</button></td>
                </tr>
              </template>
            </template>
          </tbody>
        </table>
        <EmptyState v-else title="还没有实拍记录" description="在上方选择镜头与格子，登记本次实拍张数与废片。" />
      </div>
    </template>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.page-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  gap: 12px;
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
.stat-inline {
  display: flex;
  gap: 14px;
  align-items: baseline;
  font-size: 13px;
  color: #5a6472;
}
.stat-inline strong {
  font-size: 18px;
  color: #2f6fed;
}
.stat-inline strong.warn {
  color: #b36a00;
}
.two-panel {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
@media (max-width: 1100px) {
  .two-panel {
    grid-template-columns: 1fr;
  }
}
.panel {
  background: #fff;
  border: 1px solid #e2e7ef;
  border-radius: 10px;
  padding: 16px;
}
.pickup-panel {
  border-color: #f0d9b0;
}
.panel-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
  gap: 10px;
}
.panel-head h2 {
  margin: 0;
  font-size: 16px;
}
.shot-select {
  height: 30px;
  border: 1px solid #cfd6e0;
  border-radius: 6px;
  padding: 0 8px;
  font-size: 13px;
  background: #fff;
}
.facts {
  margin: 12px 0 0;
  padding-left: 18px;
  font-size: 13px;
  color: #3d4757;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.table th,
.table td {
  text-align: left;
  padding: 8px 6px;
  border-bottom: 1px solid #eef1f6;
  vertical-align: middle;
}
.table th {
  color: #6b7686;
  font-weight: 600;
  font-size: 12px;
}
.daily-head {
  cursor: pointer;
}
.daily-head:hover {
  background: #f7faff;
}
.detail-row td {
  background: #fafbfd;
  font-size: 12px;
}
.archive {
  margin-top: 10px;
  opacity: 0.85;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.muted {
  color: #8a94a6;
  font-size: 12px;
}
.warn {
  color: #b36a00;
}
.strong {
  font-weight: 700;
}
.today {
  margin-left: 6px;
  font-size: 11px;
  color: #227a52;
  background: #e4f5ec;
  border-radius: 999px;
  padding: 1px 8px;
}
.tag {
  margin-left: 6px;
  font-size: 11px;
  color: #8a94a6;
  background: #eef1f6;
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
.btn.tiny {
  height: 24px;
  padding: 0 8px;
  font-size: 12px;
}
.btn.danger {
  color: #c45656;
  border-color: #f0c8c8;
}
.archive-toggle {
  margin-top: 10px;
}
.link-btn {
  border: none;
  background: none;
  color: #2f6fed;
  cursor: pointer;
  font-size: 12px;
  padding: 0;
}
</style>
