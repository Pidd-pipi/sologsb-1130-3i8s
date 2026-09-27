<script setup lang="ts">
/**
 * 镜头详情：上部镜头参数与逐帧台账进度，中部帧序条带（每格显示已拍/废片/待拍），
 * 下部逐格台账表格（含逐格登记、张数调整、格名修改、移除格子），
 * 以及道具轨迹与本格实拍流水。
 * 消费 Shot、FrameEntry、PropState、TakeLog、PickupItem 五个模型。
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { storeToRefs } from 'pinia';
import { useShotStore } from '../stores/shotStore';
import { useFrameStore } from '../stores/frameStore';
import { useLedgerStore } from '../stores/ledgerStore';
import { useFrameSequence } from '../hooks/useFrameSequence';
import * as api from '../db/api';
import { estimateSpeed, framesToDuration } from '../utils/frameMath';
import { FIXATION_OPTIONS, type Fixation, type PropState } from '../types/prop';
import { SHOT_STATUS_OPTIONS, type ShotStatus } from '../types/shot';
import type { FrameEntry } from '../types/frame';
import { formatDateTime } from '../utils/format';
import FrameStrip from '../components/common/FrameStrip.vue';
import ExposureForm from '../components/common/ExposureForm.vue';
import RegisterTakeForm from '../components/common/RegisterTakeForm.vue';
import ShotProgress from '../components/common/ShotProgress.vue';
import StatusTag from '../components/common/StatusTag.vue';
import EmptyState from '../components/common/EmptyState.vue';
import { PICKUP_REASON_LABEL } from '../types/take';

const route = useRoute();
const router = useRouter();
const shotStore = useShotStore();
const frameStore = useFrameStore();
const ledgerStore = useLedgerStore();
const { frames, selectedFrameNo } = storeToRefs(frameStore);

const { insertAfter, removeAt, move, patch, select, syncShotRange } = useFrameSequence();

const props = ref<PropState[]>([]);
const propForm = ref({ name: '', fromFrame: 1, toFrame: 12, posX: 0, posY: 0, posZ: 0, rotation: 0, fixation: '支架' as Fixation });
const exposureDraft = ref<Partial<FrameEntry>>({});
const feedback = ref('');
const notFound = ref(false);

const shotId = computed(() => Number(route.params.id));
const shot = computed(() => shotStore.byId(shotId.value));
const stat = computed(() => ledgerStore.shotStat(shotId.value));
const sceneProgress = computed(() =>
  shot.value ? framesToDuration(frames.value.length, shot.value.fps) : 0,
);
const statusOptions = SHOT_STATUS_OPTIONS;
const fixationOptions = FIXATION_OPTIONS;

/** uid → 单格台账，供条带与表格渲染 */
const cellLedgers = computed(() => {
  const map: Record<string, ReturnType<typeof ledgerStore.ledgerOfUid>> = {};
  for (const f of frames.value) map[f.uid] = ledgerStore.ledgerOfUid(f.uid);
  return map;
});

const shotTakes = computed(() =>
  ledgerStore.takes
    .filter((t) => t.shotId === shotId.value)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.id ?? 0) - (a.id ?? 0))),
);

const shotPickups = computed(() => ledgerStore.openPickups.filter((p) => p.shotId === shotId.value));

const selectedFrame = computed(() => frames.value.find((f) => f.frameNo === selectedFrameNo.value) ?? null);
const selectedUid = computed(() => selectedFrame.value?.uid ?? null);

async function bootstrap(id: number) {
  if (!shotStore.ready) await shotStore.load();
  if (!ledgerStore.ready) await ledgerStore.load();
  const row = await api.getShot(id);
  if (!row) {
    notFound.value = true;
    return;
  }
  notFound.value = false;
  await frameStore.loadForShot(id);
  await ledgerStore.reloadFrames(id);
  props.value = await api.listProps(id);
  if (typeof row.id === 'number') shotStore.currentId = row.id;
  const first = frames.value[0];
  exposureDraft.value = first
    ? {
        shotCount: first.shotCount,
        exposureSec: first.exposureSec,
        aperture: first.aperture,
        iso: first.iso,
        shutterAngle: first.shutterAngle,
        lighting: first.lighting,
        propOffsetMm: first.propOffsetMm,
        note: '',
      }
    : {};
}

onMounted(() => bootstrap(shotId.value));
watch(shotId, (id) => {
  if (Number.isFinite(id)) void bootstrap(id);
});

function flash(text: string) {
  feedback.value = text;
  window.setTimeout(() => {
    if (feedback.value === text) feedback.value = '';
  }, 3200);
}

async function changeStatus(status: ShotStatus) {
  if (!shot.value) return;
  await shotStore.setStatus(shotId.value, status);
  flash(`拍摄状态已更新为「${status}」`);
}

async function changeFps(value: number) {
  if (!shot.value) return;
  await shotStore.update(shotId.value, { fps: value });
  await syncShotRange();
  flash('已按新帧率重算镜头时长');
}

async function addFrameWithExposure() {
  const created = await insertAfter(
    selectedFrameNo.value ?? frames.value[frames.value.length - 1]?.frameNo ?? null,
    exposureDraft.value as Partial<FrameEntry>,
  );
  if (created) select(created.frameNo);
  flash('已在帧序中插入一格');
}

async function reorder(from: number, to: number) {
  await move(from, to);
  flash('已移动格子并重排序号（uid 不变，实拍记录仍对回原格）');
}

async function patchFrame(frameNo: number, value: Partial<FrameEntry>) {
  await patch(frameNo, value);
}

async function editCell(frame: FrameEntry, key: keyof FrameEntry, raw: string, numeric = true) {
  const value = numeric ? Number(raw) : raw;
  await patch(frame.frameNo, { [key]: value } as Partial<FrameEntry>);
}

async function editLabel(frame: FrameEntry, raw: string) {
  await ledgerStore.renameCell(frame, raw);
  await frameStore.refresh(shotId.value);
}

async function changeCount(frame: FrameEntry, raw: string) {
  const value = Math.max(1, Math.floor(Number(raw)));
  if (!Number.isFinite(value)) return;
  const before = frame.shotCount;
  await ledgerStore.changeCellCount(frame, value);
  await frameStore.refresh(shotId.value);
  if (value < before) flash(`该格张数下调为 ${value}，超量好张已留进补拍清单`);
}

async function removeFrameRow(frameNo: number) {
  await removeAt(frameNo);
  flash('格子已从条带移除：位次已重排，已拍好张保留进补拍清单，历史记录不删除');
}

function onRegistered(payload: { frame: FrameEntry; taken: number; wasted: number }) {
  flash(`已登记到「${payload.frame.label}」：实拍 ${payload.taken} 张（废片 ${payload.wasted}），该格/镜头/总览进度已重算`);
}

async function addProp() {
  if (!shot.value) return;
  if (!propForm.value.name.trim()) {
    flash('请填写道具名');
    return;
  }
  const payload: PropState = {
    name: propForm.value.name.trim(),
    shotId: shotId.value,
    fromFrame: Math.max(1, Math.floor(propForm.value.fromFrame)),
    toFrame: Math.max(1, Math.floor(propForm.value.toFrame)),
    posX: propForm.value.posX,
    posY: propForm.value.posY,
    posZ: propForm.value.posZ,
    rotation: propForm.value.rotation,
    fixation: propForm.value.fixation,
    updatedAt: Date.now(),
  };
  const id = await api.addProp(payload);
  props.value = [...props.value, { ...payload, id }];
  propForm.value.name = '';
  flash('已登记道具状态');
}

async function removeProp(id: number | undefined) {
  if (typeof id !== 'number') return;
  await api.deleteProp(id);
  props.value = props.value.filter((p) => p.id !== id);
}

/** 按帧号查询该帧上的道具位置（对应 PropState 的帧区间查询动作） */
function propsAtFrame(frameNo: number): PropState[] {
  return props.value.filter((p) => frameNo >= p.fromFrame && frameNo <= p.toFrame);
}

const selectedProps = computed(() => (selectedFrameNo.value === null ? [] : propsAtFrame(selectedFrameNo.value)));

function speedOf(frame: FrameEntry) {
  return estimateSpeed(frame.propOffsetMm, shot.value?.fps ?? 24);
}

async function deleteTake(id: number | undefined) {
  if (typeof id !== 'number') return;
  await ledgerStore.removeTake(id);
  flash('已删除该条登记，进度与补拍清单已重算');
}

async function resolvePickup(id: number | undefined) {
  if (typeof id !== 'number') return;
  await ledgerStore.resolvePickup(id);
  flash('补拍条目已核销归档');
}

/** 表格里的「登记」：选中该格并把页面带到逐格登记表单 */
function focusRegister(frame: FrameEntry) {
  select(frame.frameNo);
  document.querySelector<HTMLElement>('[data-testid="register-form"]')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
</script>

<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h1>
          逐帧拍摄台账
          <span v-if="shot" class="mono">{{ shot.code }}</span>
        </h1>
        <p class="sub" v-if="shot">{{ shot.sceneName }} · {{ shot.fps }} fps · 条带 {{ frames.length }} 格</p>
      </div>
      <div class="head-actions">
        <StatusTag v-if="shot" :status="shot.status" />
        <button type="button" class="btn" @click="router.push('/frames')">去帧序编排台</button>
        <button type="button" class="btn" @click="router.push('/progress')">实拍记录/补拍</button>
        <button type="button" class="btn" @click="router.push('/')">返回总览</button>
      </div>
    </header>

    <EmptyState
      v-if="notFound"
      title="镜头不存在"
      description="该 id 在本地库中没有对应镜头，可能已被删除。"
      action-text="返回总览"
      @action="router.push('/')"
    />

    <template v-else-if="shot">
      <p v-if="feedback" class="feedback" data-testid="detail-feedback">{{ feedback }}</p>

      <div class="panel">
        <div class="panel-head"><h2>镜头参数与进度</h2></div>
        <div class="two-col">
          <dl class="kv">
            <div><dt>镜号</dt><dd class="mono" data-testid="detail-code">{{ shot.code }}</dd></div>
            <div><dt>场景名</dt><dd>{{ shot.sceneName }}</dd></div>
            <div>
              <dt>帧率</dt>
              <dd>
                <select :value="shot.fps" data-testid="detail-fps" @change="changeFps(Number(($event.target as HTMLSelectElement).value))">
                  <option v-for="f in [8, 12, 15, 24, 25, 30]" :key="f" :value="f">{{ f }} fps</option>
                </select>
              </dd>
            </div>
            <div><dt>条带格子数</dt><dd class="mono">{{ frames.length }} 格（{{ sceneProgress }} s）</dd></div>
            <div><dt>负责人</dt><dd>{{ shot.owner || '未指派' }}</dd></div>
            <div>
              <dt>拍摄状态</dt>
              <dd>
                <select :value="shot.status" data-testid="detail-status" @change="changeStatus(($event.target as HTMLSelectElement).value as ShotStatus)">
                  <option v-for="s in statusOptions" :key="s" :value="s">{{ s }}</option>
                </select>
              </dd>
            </div>
          </dl>
          <div>
            <ShotProgress
              :code="shot.code"
              :status="shot.status"
              :planned="stat.required"
              :taken="stat.good"
              :wasted="stat.wasted"
              :remaining="stat.remaining"
              :percent="stat.percent"
            />
            <p class="muted sub-line">
              已拍齐 {{ stat.doneFrames }}/{{ stat.totalFrames }} 格 · 实拍 {{ stat.taken }} 张（含废片 {{ stat.wasted }}）
              <template v-if="stat.excess > 0"> · 超量好张 <strong class="warn">{{ stat.excess }}</strong> 在补拍清单</template>
            </p>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head">
          <h2>帧序条带</h2>
          <span class="muted">每格显示 已拍/废片/待拍；点击选中后可逐格登记或改参数</span>
        </div>
        <FrameStrip
          :frames="frames"
          :selected="selectedFrameNo"
          :ledgers="cellLedgers"
          @update:selected="select"
          @reorder="reorder"
          @patch="patchFrame"
        />
        <div v-if="selectedFrameNo !== null" class="prop-lookup" data-testid="prop-lookup">
          <strong>第 {{ selectedFrameNo }} 格道具位置：</strong>
          <span v-if="!selectedProps.length" class="muted">该帧区间内没有已登记道具</span>
          <span v-for="p in selectedProps" :key="p.id" class="chip">
            {{ p.name }} ({{ p.posX }}, {{ p.posY }}, {{ p.posZ }}) mm · 旋转 {{ p.rotation }}°
          </span>
        </div>
      </div>

      <div v-if="shotPickups.length" class="panel pickup-panel">
        <div class="panel-head">
          <h2>本镜头补拍清单（{{ shotPickups.length }}）</h2>
          <span class="muted">超量好张不会消失，核销前一直挂账</span>
        </div>
        <table class="table" data-testid="detail-pickup-table">
          <thead>
            <tr><th>格子</th><th>原因</th><th>超量好张</th><th>状态</th><th>操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="p in shotPickups" :key="p.id">
              <td>{{ p.frameLabel }}<span v-if="p.reason === 'removed'" class="tag">已移除</span></td>
              <td>{{ PICKUP_REASON_LABEL[p.reason] }}</td>
              <td class="warn strong">{{ p.liveExcess }} 张</td>
              <td class="muted">{{ p.reason === 'removed' ? '固定快照' : '随计划实时重算' }}</td>
              <td><button type="button" class="btn tiny" @click="resolvePickup(p.id)">核销归档</button></td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="two-panel">
        <div class="panel">
          <div class="panel-head">
            <h2>逐格登记实拍</h2>
            <span class="muted">废片自动重新计入该格待拍</span>
          </div>
          <RegisterTakeForm
            v-if="frames.length"
            :shot="shot"
            :frames="frames"
            :preselect-uid="selectedUid"
            @registered="onRegistered"
          />
          <EmptyState v-else title="条带上还没有格子" description="先在下方帧条目表格插入一格，再逐格登记。" />
        </div>

        <div class="panel">
          <div class="panel-head">
            <h2>插入格曝光参数</h2>
            <span class="muted">插入后自动重排位次并联动镜头时长</span>
          </div>
          <ExposureForm v-model="exposureDraft" :fps="shot.fps" />
          <div class="actions">
            <button type="button" class="btn primary" data-testid="insert-frame" @click="addFrameWithExposure">在选中格后插入</button>
            <button type="button" class="btn" @click="syncShotRange">重算时长</button>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head">
          <h2>逐帧台账表格</h2>
          <span class="muted">每格按自己的张数记账；张数下调或移除格子，超量好张进上方补拍清单</span>
        </div>

        <table v-if="frames.length" class="table" data-testid="frame-table">
          <thead>
            <tr>
              <th>位次</th>
              <th>格名</th>
              <th>该格张数</th>
              <th>已拍</th>
              <th>废片</th>
              <th>好张</th>
              <th>待拍</th>
              <th>曝光 s</th>
              <th>位移 mm</th>
              <th>速度 mm/s</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="frame in frames" :key="frame.uid" :class="{ active: frame.frameNo === selectedFrameNo }" @click="select(frame.frameNo)">
              <td class="mono">{{ frame.frameNo }}</td>
              <td><input class="label-input" type="text" maxlength="12" :value="frame.label" @change="editLabel(frame, ($event.target as HTMLInputElement).value)" @click.stop /></td>
              <td>
                <input
                  class="count-input"
                  type="number"
                  min="1"
                  max="99"
                  step="1"
                  :value="frame.shotCount"
                  :data-testid="`cell-count-${frame.frameNo}`"
                  @change="changeCount(frame, ($event.target as HTMLInputElement).value)"
                  @click.stop
                />
              </td>
              <td>{{ cellLedgers[frame.uid].taken }}</td>
              <td :class="{ warn: cellLedgers[frame.uid].wasted > 0 }">{{ cellLedgers[frame.uid].wasted }}</td>
              <td>{{ cellLedgers[frame.uid].good }}</td>
              <td>
                <strong :class="{ done: cellLedgers[frame.uid].remaining === 0, warn: cellLedgers[frame.uid].remaining > 0 }">
                  {{ cellLedgers[frame.uid].remaining }}
                </strong>
                <span v-if="cellLedgers[frame.uid].excess > 0" class="pickup-flag">超 {{ cellLedgers[frame.uid].excess }}</span>
              </td>
              <td><input type="number" min="0.008" max="8" step="0.008" :value="frame.exposureSec" @change="editCell(frame, 'exposureSec', ($event.target as HTMLInputElement).value)" @click.stop /></td>
              <td><input type="number" min="-200" max="200" step="0.5" :value="frame.propOffsetMm" @change="editCell(frame, 'propOffsetMm', ($event.target as HTMLInputElement).value)" @click.stop /></td>
              <td class="muted">{{ speedOf(frame) }}</td>
              <td class="row-actions">
                <button type="button" class="btn tiny" @click.stop="focusRegister(frame)">登记</button>
                <button type="button" class="btn tiny danger" data-testid="remove-cell" @click.stop="removeFrameRow(frame.frameNo)">移除</button>
              </td>
            </tr>
          </tbody>
        </table>
        <EmptyState v-else title="该镜头条带上还没有格子" description="点击「在选中格后插入」按当前曝光参数生成第一格。" action-text="插入一格" @action="addFrameWithExposure" />
      </div>

      <div class="two-panel">
        <div class="panel">
          <div class="panel-head"><h2>本镜头实拍流水</h2><span class="muted">共 {{ shotTakes.length }} 条，按日期倒序</span></div>
          <table v-if="shotTakes.length" class="table" data-testid="shot-take-table">
            <thead>
              <tr><th>日期</th><th>格子</th><th>实拍</th><th>废片</th><th>备注</th><th>登记时间</th><th>操作</th></tr>
            </thead>
            <tbody>
              <tr v-for="row in shotTakes" :key="row.id">
                <td class="mono">{{ row.date }}</td>
                <td>
                  <template v-if="row.frameUid">{{ row.frameLabel }}<span class="muted">（原第 {{ row.frameNo }} 格）</span></template>
                  <span v-else class="muted">旧版整天记录</span>
                </td>
                <td>{{ row.takenFrames }}</td>
                <td :class="{ warn: row.wastedFrames > 0 }">{{ row.wastedFrames }}</td>
                <td class="muted">{{ row.note || '—' }}</td>
                <td class="muted">{{ formatDateTime(row.updatedAt) }}</td>
                <td><button type="button" class="btn tiny danger" @click="deleteTake(row.id)">删除</button></td>
              </tr>
            </tbody>
          </table>
          <EmptyState v-else title="还没有实拍登记" description="在上方选择格子逐格登记，废片会自动重算进待拍。" />
        </div>

        <div class="panel">
          <div class="panel-head"><h2>道具轨迹</h2><span class="muted">按帧区间登记道具位置，条带上按位次可查</span></div>
          <div class="prop-form">
            <label class="field"><span>道具名</span><input v-model="propForm.name" type="text" maxlength="20" data-testid="prop-name" /></label>
            <label class="field"><span>起始帧</span><input v-model.number="propForm.fromFrame" type="number" min="1" step="1" data-testid="prop-from" /></label>
            <label class="field"><span>结束帧</span><input v-model.number="propForm.toFrame" type="number" min="1" step="1" data-testid="prop-to" /></label>
            <label class="field"><span>X mm</span><input v-model.number="propForm.posX" type="number" step="0.5" /></label>
            <label class="field"><span>Y mm</span><input v-model.number="propForm.posY" type="number" step="0.5" /></label>
            <label class="field"><span>Z mm</span><input v-model.number="propForm.posZ" type="number" step="0.5" /></label>
            <label class="field"><span>旋转 °</span><input v-model.number="propForm.rotation" type="number" step="1" /></label>
            <label class="field">
              <span>固定方式</span>
              <select v-model="propForm.fixation">
                <option v-for="f in fixationOptions" :key="f" :value="f">{{ f }}</option>
              </select>
            </label>
            <button type="button" class="btn primary" data-testid="prop-submit" @click="addProp">登记道具</button>
          </div>

          <table v-if="props.length" class="table" data-testid="prop-table">
            <thead>
              <tr><th>道具</th><th>帧区间</th><th>X</th><th>Y</th><th>Z</th><th>旋转</th><th>固定</th><th>操作</th></tr>
            </thead>
            <tbody>
              <tr v-for="p in props" :key="p.id">
                <td>{{ p.name }}</td>
                <td class="mono">{{ p.fromFrame }} – {{ p.toFrame }}</td>
                <td>{{ p.posX }}</td>
                <td>{{ p.posY }}</td>
                <td>{{ p.posZ }}</td>
                <td>{{ p.rotation }}°</td>
                <td>{{ p.fixation }}</td>
                <td><button type="button" class="btn tiny danger" @click="removeProp(p.id)">删除</button></td>
              </tr>
            </tbody>
          </table>
          <EmptyState v-else title="还没有道具状态" description="填写道具名与帧区间后登记，即可在帧序条带上按位次查询位置。" />
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
h1 .mono {
  font-size: 16px;
  color: #2f6fed;
  margin-left: 8px;
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
.two-col {
  display: grid;
  grid-template-columns: 1.4fr 1fr;
  gap: 18px;
}
.two-panel {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
@media (max-width: 1100px) {
  .two-col,
  .two-panel {
    grid-template-columns: 1fr;
  }
}
.kv {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 10px 18px;
  margin: 0;
}
.kv div {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.kv dt {
  font-size: 12px;
  color: #8a94a6;
}
.kv dd {
  margin: 0;
  font-size: 13px;
  color: #1f2d3d;
  display: flex;
  align-items: center;
  gap: 6px;
}
.kv input,
.kv select,
.table input,
.table select,
.prop-form input,
.prop-form select {
  height: 30px;
  border: 1px solid #cfd6e0;
  border-radius: 6px;
  padding: 0 8px;
  font-size: 13px;
  background: #fff;
  color: #1f2d3d;
  box-sizing: border-box;
}
.table input[type='text'],
.table input[type='number'] {
  width: 100%;
}
.label-input {
  min-width: 84px;
}
.count-input {
  max-width: 64px;
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
.table tbody tr.active {
  background: #f5f8ff;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.muted {
  color: #8a94a6;
  font-size: 12px;
}
.sub-line {
  margin: 10px 0 0;
}
.warn {
  color: #b36a00;
}
.strong {
  font-weight: 700;
}
.done {
  color: #227a52;
}
.pickup-flag {
  margin-left: 6px;
  font-size: 11px;
  color: #b36a00;
  background: #fff3dc;
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
.prop-lookup {
  margin-top: 10px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  font-size: 13px;
}
.chip {
  background: #f0f4ff;
  border: 1px solid #dbe6ff;
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 12px;
}
.prop-form {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
  gap: 10px;
  align-items: end;
  margin-bottom: 12px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: #5a6472;
}
.row-actions {
  display: flex;
  gap: 6px;
}
.actions {
  display: flex;
  gap: 10px;
  margin-top: 12px;
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
.pickup-panel {
  border-color: #f0d9b0;
}
</style>
