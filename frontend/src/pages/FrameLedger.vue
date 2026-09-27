<script setup lang="ts">
/**
 * 逐帧拍摄台账：每格按自己的张数登记已拍与废片，
 * 登记后该格、镜头与总览的进度一起变化；废片重新算进待拍。
 * 某格张数下调或格子从条带移除后，已拍的超量不消失，保留在补拍清单。
 * 消费 FrameEntry、FrameTake、TakeLog；登记时同步写一条每日实拍记录。
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { storeToRefs } from 'pinia';
import { useShotStore } from '../stores/shotStore';
import { useFrameStore } from '../stores/frameStore';
import { useProgress } from '../hooks/useProgress';
import * as api from '../db/api';
import { ledgerRowOf, ledgerRowStatus, summarizeLedger, type FrameLedgerRow, type LedgerRowStatus } from '../utils/ledger';
import { formatDateTime, today } from '../utils/format';
import type { FrameEntry } from '../types/frame';
import type { FrameTake } from '../types/take';
import type { Shot } from '../types/shot';
import FrameStrip from '../components/common/FrameStrip.vue';
import StatusTag from '../components/common/StatusTag.vue';
import EmptyState from '../components/common/EmptyState.vue';

const route = useRoute();
const router = useRouter();
const shotStore = useShotStore();
const frameStore = useFrameStore();
const { shots } = storeToRefs(shotStore);
const { frames, selectedFrameNo } = storeToRefs(frameStore);
const { overall, loadTakes, registerTake } = useProgress();

const activeShotId = ref<number | null>(null);
const removedTakes = ref<FrameTake[]>([]);
const feedback = ref('');
/** 每格的本次登记输入（已拍 / 废片） */
const inputs = ref<Record<number, { taken: number; wasted: number }>>({});

const activeShot = computed<Shot | undefined>(() =>
  activeShotId.value === null ? undefined : shotStore.byId(activeShotId.value),
);
const ordered = computed(() => frames.value.slice().sort((a, b) => a.frameNo - b.frameNo));
/** 镜头级台账合计：由每格逐行汇总 */
const ledger = computed(() => summarizeLedger(frames.value));
const rows = computed(() => ordered.value.map((frame) => ({ frame, row: ledgerRowOf(frame) })));
/** 补拍清单：待拍格（废片已重新算进待拍） */
const pendingRows = computed(() => rows.value.filter((r) => r.row.remaining > 0));
/** 补拍清单：计划下调后的超量已拍 */
const excessRows = computed(() => rows.value.filter((r) => r.row.excess > 0));

const STATUS_CLASS: Record<LedgerRowStatus, string> = {
  待拍: 'idle',
  拍摄中: 'doing',
  已完成: 'done',
  超量: 'over',
};

onMounted(async () => {
  if (!shotStore.ready) await shotStore.load();
  await loadTakes();
  const fromQuery = Number(route.query.shot);
  const first = shots.value.find((s) => s.id === fromQuery) ?? shots.value[0];
  if (first && typeof first.id === 'number') activeShotId.value = first.id;
});

watch(activeShotId, async (id) => {
  if (typeof id !== 'number') return;
  await frameStore.loadForShot(id);
  removedTakes.value = await api.listFrameTakes(id);
  if (Number(route.query.shot) !== id) void router.replace({ query: { shot: id } });
});

// 帧序变化后补齐每格的登记输入；未提交的旧值保留
watch(
  frames,
  (list) => {
    const next: Record<number, { taken: number; wasted: number }> = {};
    for (const f of list) {
      next[f.frameNo] = inputs.value[f.frameNo] ?? defaultInput(f);
    }
    inputs.value = next;
  },
  { immediate: true },
);

/** 默认本次登记量：该格剩余待拍（至少 1 张），废片 0 */
function defaultInput(frame: FrameEntry) {
  return { taken: Math.max(1, ledgerRowOf(frame).remaining), wasted: 0 };
}

function flash(text: string) {
  feedback.value = text;
  window.setTimeout(() => {
    if (feedback.value === text) feedback.value = '';
  }, 3200);
}

function statusOf(row: FrameLedgerRow): LedgerRowStatus {
  return ledgerRowStatus(row);
}

function statusClass(row: FrameLedgerRow): string {
  return STATUS_CLASS[ledgerRowStatus(row)];
}

function select(frameNo: number | null) {
  frameStore.select(frameNo);
}

/**
 * 登记一格的已拍与废片：
 * 1) 写回该格台账（帧条目持久化，切镜头/刷新后仍按原格对应）；
 * 2) 同步写一条每日实拍记录，镜头与总览进度一起回写。
 */
async function register(frame: FrameEntry) {
  const shot = activeShot.value;
  if (!shot) return;
  const input = inputs.value[frame.frameNo] ?? defaultInput(frame);
  const taken = Math.max(0, Math.floor(Number(input.taken) || 0));
  const wasted = Math.max(0, Math.floor(Number(input.wasted) || 0));
  if (taken <= 0) {
    flash('本次已拍需大于 0');
    return;
  }
  if (wasted > taken) {
    flash('废片不能多于本次已拍');
    return;
  }
  await frameStore.patchFrame(frame.frameNo, {
    takenCount: (frame.takenCount ?? 0) + taken,
    wastedCount: (frame.wastedCount ?? 0) + wasted,
  });
  await registerTake(shot, today(), taken, wasted);
  await loadTakes();
  const current = frames.value.find((f) => f.frameNo === frame.frameNo) ?? frame;
  inputs.value[frame.frameNo] = defaultInput(current);
  flash(`第 ${frame.frameNo} 格已登记 ${taken} 张（废片 ${wasted}），镜头与总览进度已更新`);
}

/** 销记一条补拍清单记录（仅移除清单条目，不影响帧台账与每日实拍记录） */
async function dismiss(record: FrameTake) {
  if (typeof record.id !== 'number') return;
  await api.deleteFrameTake(record.id);
  removedTakes.value = removedTakes.value.filter((r) => r.id !== record.id);
  flash('已销记该条补拍记录');
}
</script>

<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h1>逐帧拍摄台账</h1>
        <p class="sub">每格按自己的张数登记已拍与废片，废片重新算进待拍；格、镜头与总览进度联动</p>
      </div>
      <div class="head-actions">
        <select v-model.number="activeShotId" data-testid="ledger-shot-select" class="shot-select">
          <option :value="null" disabled>选择镜头</option>
          <option v-for="s in shots" :key="s.id" :value="s.id">{{ s.code }} · {{ s.sceneName }}</option>
        </select>
        <StatusTag v-if="activeShot" :status="activeShot.status" />
      </div>
    </header>

    <EmptyState
      v-if="!shots.length"
      title="还没有镜头"
      description="请先到「新建镜头」创建镜头，再逐格登记实拍。"
      action-text="新建镜头"
      @action="router.push('/shots/new')"
    />

    <template v-else-if="activeShot">
      <p v-if="feedback" class="feedback" data-testid="ledger-feedback">{{ feedback }}</p>

      <div class="stat-row">
        <div class="stat">
          <span class="label">计划张数</span>
          <span class="value" data-testid="ledger-planned">{{ ledger.planned }}</span>
          <span class="hint">每格张数合计</span>
        </div>
        <div class="stat">
          <span class="label">已拍</span>
          <span class="value" data-testid="ledger-taken">{{ ledger.taken }}</span>
          <span class="hint">废片 {{ ledger.wasted }} 张</span>
        </div>
        <div class="stat">
          <span class="label">待拍</span>
          <span class="value" data-testid="ledger-remaining">{{ ledger.remaining }}</span>
          <span class="hint">废片已重新算进待拍</span>
        </div>
        <div class="stat">
          <span class="label">超量已拍</span>
          <span class="value" data-testid="ledger-excess">{{ ledger.excess }}</span>
          <span class="hint">保留在补拍清单</span>
        </div>
        <div class="stat">
          <span class="label">镜头完成度</span>
          <span class="value" data-testid="ledger-percent">{{ ledger.percent }}%</span>
          <span class="hint" data-testid="ledger-overall">全片 {{ overall.percent }}% · 待拍 {{ overall.remaining }} 张</span>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head">
          <h2>帧序条带</h2>
          <span class="muted">点击色块定位台账行</span>
        </div>
        <FrameStrip :frames="ordered" :selected="selectedFrameNo" readonly @update:selected="select" />
      </div>

      <div class="panel">
        <div class="panel-head">
          <h2>逐帧台账</h2>
          <span class="muted">登记后该格、镜头与总览进度一起变化</span>
        </div>
        <table class="table" data-testid="ledger-table">
          <thead>
            <tr>
              <th>帧号</th>
              <th>计划张数</th>
              <th>已拍</th>
              <th>废片</th>
              <th>待拍</th>
              <th>状态</th>
              <th>本次已拍</th>
              <th>本次废片</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="{ frame, row } in rows"
              :key="frame.id ?? frame.frameNo"
              :class="{ active: frame.frameNo === selectedFrameNo }"
              @click="select(frame.frameNo)"
            >
              <td class="mono">{{ frame.frameNo }}</td>
              <td>{{ row.planned }} 张</td>
              <td data-testid="ledger-row-taken">{{ row.taken }}</td>
              <td>{{ row.wasted }}</td>
              <td>{{ row.remaining }}</td>
              <td><span class="tag" :class="statusClass(row)" :data-status="statusOf(row)">{{ statusOf(row) }}</span></td>
              <td>
                <input
                  v-model.number="inputs[frame.frameNo].taken"
                  class="mini"
                  type="number"
                  min="1"
                  max="99"
                  step="1"
                  data-testid="ledger-input-taken"
                  @click.stop
                />
              </td>
              <td>
                <input
                  v-model.number="inputs[frame.frameNo].wasted"
                  class="mini"
                  type="number"
                  min="0"
                  max="99"
                  step="1"
                  data-testid="ledger-input-wasted"
                  @click.stop
                />
              </td>
              <td>
                <button type="button" class="btn tiny primary" data-testid="ledger-register" @click.stop="register(frame)">登记</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="panel">
        <div class="panel-head">
          <h2>补拍清单</h2>
          <span class="muted">待拍格、超量已拍与移除格记录；已拍的超量不消失</span>
        </div>
        <div class="reshoot" data-testid="reshoot-list">
          <div class="reshoot-group">
            <div class="group-title">待补拍（含废片重拍）</div>
            <div v-if="pendingRows.length" class="chips" data-testid="reshoot-pending">
              <span v-for="{ row } in pendingRows" :key="row.frameNo" class="chip">第 {{ row.frameNo }} 格 · 待 {{ row.remaining }} 张</span>
            </div>
            <p v-else class="muted">没有待拍格。</p>
          </div>

          <div class="reshoot-group">
            <div class="group-title">超量已拍（计划下调后保留）</div>
            <table v-if="excessRows.length" class="table slim" data-testid="reshoot-excess-table">
              <thead>
                <tr><th>帧号</th><th>计划张数</th><th>已拍</th><th>废片</th><th>超量</th></tr>
              </thead>
              <tbody>
                <tr v-for="{ row } in excessRows" :key="row.frameNo">
                  <td class="mono">{{ row.frameNo }}</td>
                  <td>{{ row.planned }} 张</td>
                  <td>{{ row.taken }}</td>
                  <td>{{ row.wasted }}</td>
                  <td>{{ row.excess }} 张</td>
                </tr>
              </tbody>
            </table>
            <p v-else class="muted">没有超量记录。</p>
          </div>

          <div class="reshoot-group">
            <div class="group-title">已移除格（已拍 / 废片快照）</div>
            <table v-if="removedTakes.length" class="table slim" data-testid="reshoot-removed-table">
              <thead>
                <tr><th>原帧号</th><th>计划张数</th><th>已拍</th><th>废片</th><th>移除时间</th><th>操作</th></tr>
              </thead>
              <tbody>
                <tr v-for="r in removedTakes" :key="r.id">
                  <td class="mono">{{ r.frameNo }}</td>
                  <td>{{ r.planned }} 张</td>
                  <td>{{ r.taken }}</td>
                  <td>{{ r.wasted }}</td>
                  <td class="muted">{{ formatDateTime(r.removedAt) }}</td>
                  <td><button type="button" class="btn tiny danger" @click="dismiss(r)">销记</button></td>
                </tr>
              </tbody>
            </table>
            <p v-else class="muted">没有移除格记录。</p>
          </div>
        </div>
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
.head-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}
.shot-select {
  height: 32px;
  border: 1px solid #cfd6e0;
  border-radius: 6px;
  padding: 0 8px;
  font-size: 13px;
  background: #fff;
}
.stat-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 12px;
}
.stat {
  background: #fff;
  border: 1px solid #e2e7ef;
  border-radius: 10px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.stat .label {
  font-size: 12px;
  color: #6b7686;
}
.stat .value {
  font-size: 22px;
  font-weight: 700;
  color: #1f2d3d;
}
.stat .hint {
  font-size: 12px;
  color: #8a94a6;
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
}
.table th {
  color: #6b7686;
  font-weight: 600;
  font-size: 12px;
}
.table tbody tr.active {
  background: #f5f8ff;
}
.table.slim td,
.table.slim th {
  padding: 6px;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.muted {
  color: #8a94a6;
  font-size: 12px;
}
.mini {
  width: 64px;
  height: 28px;
  border: 1px solid #cfd6e0;
  border-radius: 6px;
  padding: 0 6px;
  font-size: 13px;
  background: #fff;
  color: #1f2d3d;
  box-sizing: border-box;
}
.tag {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  padding: 0 8px;
  font-size: 11px;
  line-height: 20px;
  white-space: nowrap;
}
.tag.idle {
  background: #eef1f6;
  color: #5a6472;
}
.tag.doing {
  background: #fff3dc;
  color: #a8730f;
}
.tag.done {
  background: #e4f5ec;
  color: #227a52;
}
.tag.over {
  background: #fde8e8;
  color: #b3423a;
}
.reshoot {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.group-title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 8px;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.chip {
  background: #f0f4ff;
  border: 1px solid #dbe6ff;
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 12px;
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
.btn.tiny {
  height: 24px;
  padding: 0 8px;
  font-size: 12px;
}
.btn.danger {
  color: #c45656;
  border-color: #f0c8c8;
}
.feedback {
  margin: 0;
  background: #eef6ff;
  border: 1px solid #d3e4ff;
  color: #24559c;
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 13px;
}
</style>
