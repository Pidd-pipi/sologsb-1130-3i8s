<script setup lang="ts">
/**
 * 逐格实拍登记表单：选择格子、日期，填写本次实拍张数与废片张数。
 * 登记后该格、镜头与总览进度由 ledgerStore 一起重算，废片自动重新计入待拍。
 * frameUid=null 的「整天汇总」仅为兼容旧记录，新登记一律对到具体格子。
 */
import { computed, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useLedgerStore } from '../../stores/ledgerStore';
import { validateRegistration } from '../../utils/ledger';
import { today } from '../../utils/format';
import type { FrameEntry } from '../../types/frame';
import type { Shot } from '../../types/shot';

interface Props {
  shot: Shot;
  frames: FrameEntry[];
  /** 预选格子 uid（详情页点中某格时带入） */
  preselectUid?: string | null;
  compact?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  preselectUid: null,
  compact: false,
});

const emit = defineEmits<{
  (e: 'registered', payload: { frame: FrameEntry; taken: number; wasted: number }): void;
}>();

const ledgerStore = useLedgerStore();

const form = ref({
  frameUid: props.preselectUid ?? props.frames[0]?.uid ?? '',
  date: today(),
  taken: 1,
  wasted: 0,
  note: '',
});
const error = ref('');

watch(
  () => props.frames.map((f) => f.uid).join(','),
  () => {
    if (!props.frames.some((f) => f.uid === form.value.frameUid)) {
      form.value.frameUid = props.frames[0]?.uid ?? '';
    }
  },
);
watch(
  () => props.preselectUid,
  (uid) => {
    if (uid) form.value.frameUid = uid;
  },
);

const selectedFrame = computed(() => props.frames.find((f) => f.uid === form.value.frameUid));
const cell = computed(() => (selectedFrame.value ? ledgerStore.ledgerOfUid(selectedFrame.value.uid) : undefined));

async function submit() {
  error.value = '';
  const frame = selectedFrame.value;
  if (!frame) {
    error.value = '请选择要登记的格子';
    return;
  }
  const taken = Math.floor(Number(form.value.taken));
  const wasted = Math.floor(Number(form.value.wasted));
  error.value = validateRegistration(taken, wasted);
  if (error.value) return;
  await ledgerStore.registerTake({
    shot: props.shot,
    frame,
    date: form.value.date || today(),
    taken,
    wasted,
    note: form.value.note.trim(),
  });
  emit('registered', { frame, taken, wasted });
  form.value.taken = 1;
  form.value.wasted = 0;
  form.value.note = '';
}
</script>

<template>
  <div class="register-form" data-testid="register-form">
    <div class="grid" :class="{ compact }">
      <label class="field">
        <span>格子</span>
        <select v-model="form.frameUid" data-testid="register-frame">
          <option v-for="f in frames" :key="f.uid" :value="f.uid">
            {{ f.label }}（第 {{ f.frameNo }} 格 · {{ f.shotCount }} 张）
          </option>
        </select>
      </label>
      <label class="field">
        <span>拍摄日期</span>
        <input v-model="form.date" type="date" data-testid="register-date" />
      </label>
      <label class="field">
        <span>本次实拍张数</span>
        <input v-model.number="form.taken" type="number" min="1" max="2000" step="1" data-testid="register-taken" />
      </label>
      <label class="field">
        <span>其中废片</span>
        <input v-model.number="form.wasted" type="number" min="0" max="2000" step="1" data-testid="register-wasted" />
      </label>
      <label v-if="!compact" class="field wide">
        <span>备注</span>
        <input v-model="form.note" type="text" maxlength="80" placeholder="如：穿帮、抖动" data-testid="register-note" />
      </label>
    </div>

    <div v-if="cell" class="readout" data-testid="register-readout">
      <span>登记前：已拍 {{ cell.taken }} · 废 {{ cell.wasted }} · 待拍 {{ cell.remaining }}</span>
      <span v-if="cell.remaining === 0" class="ok">该格已拍齐</span>
      <span v-else class="hint">本次好张 {{ Math.max(0, Math.floor(Number(form.taken) || 0) - Math.floor(Number(form.wasted) || 0)) }} 张将冲抵待拍，废片重计待拍</span>
    </div>

    <p v-if="error" class="err" data-testid="register-error">{{ error }}</p>

    <div class="actions">
      <button type="button" class="btn primary" data-testid="register-submit" @click="submit">登记到该格</button>
    </div>
  </div>
</template>

<style scoped>
.register-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 10px;
}
.grid.compact {
  grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: #5a6472;
}
.field.wide {
  grid-column: 1 / -1;
}
.field input,
.field select {
  height: 32px;
  border: 1px solid #cfd6e0;
  border-radius: 6px;
  padding: 0 8px;
  font-size: 13px;
  background: #fff;
  color: #1f2d3d;
}
.readout {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  font-size: 12px;
  color: #5a6472;
}
.readout .ok {
  color: #227a52;
}
.readout .hint {
  color: #8a94a6;
}
.err {
  margin: 0;
  color: #c45656;
  font-size: 12px;
}
.actions {
  display: flex;
  gap: 10px;
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
</style>
