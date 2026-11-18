import { authReady } from '../auth/auth.js';
import {
  createDebtService,
  createSubmission,
  metadataPayload,
  chargePayload,
} from '../data/debt-service.js';
import {
  connectDebtNavigation,
  debtUrl,
  protectPendingNavigation,
  validDebtId,
} from '../core/navigation.js';
import { bangkokToday, dateText } from '../core/format.js';
const $ = (selector) => document.querySelector(selector),
  id = new URLSearchParams(location.search).get('id'),
  mode = document.body.dataset.manage;
let api,
  client,
  owner,
  debt,
  pending = null,
  busy = false,
  stopped = false,
  loaded = false,
  loadVersion = 0,
  dirty = false;
function status(text, error = false) {
  const node = $('#manage-status');
  node.textContent = text;
  node.dataset.error = String(error);
  node.setAttribute('role', error ? 'alert' : 'status');
}
function controls() {
  const can = loaded && !stopped && !busy && !pending && !(mode === 'charges' && debt?.is_archived);
  $('#manage-fields').disabled = !can;
  $('#manage-save').disabled = stopped || busy || (!pending && !can);
  $('#manage-save').textContent = busy
    ? 'กำลังบันทึก…'
    : pending
      ? 'ส่งคำขอเดิมอีกครั้ง'
      : mode === 'charges'
        ? 'บันทึกค่าใช้จ่าย'
        : 'บันทึกข้อมูลหนี้';
  $('#manage-save').setAttribute('aria-busy', String(busy));
  $('#edit-manage-draft').hidden = !pending?.canEdit || busy;
}
function sync() {
  if (!$('#charge-calculation')) return;
  const percent = $('#charge-calculation').value === 'percentage';
  $('#percentage-charge').hidden = !percent;
  $('#percentage-charge').disabled = !percent;
  $('#fixed-charge').hidden = percent;
  $('#charge-amount').disabled = percent;
  $('#charge-amount').required = !percent;
  $('#charge-base').required = percent;
  $('#charge-rate').required = percent;
}
connectDebtNavigation(id);
$('#charge-calculation')?.addEventListener('change', sync);
sync();
async function load() {
  if (!api || stopped || busy || pending) return;
  if (dirty) {
    status('มีข้อมูลที่ยังไม่บันทึก กรุณาบันทึกก่อนโหลดใหม่');
    return;
  }
  const current = ++loadVersion;
  loaded = false;
  controls();
  $('#manage-load-status').textContent = 'กำลังโหลดข้อมูล…';
  try {
    const data = await api.debt(id);
    if (stopped || current !== loadVersion) return;
    const categories = mode === 'edit-debt' ? await api.categories() : [];
    if (stopped || current !== loadVersion) return;
    debt = data;
    $('#debt-title').textContent = debt.title;
    if (mode === 'edit-debt') {
      for (const [selector, value] of [
        ['#edit-title', debt.title],
        ['#edit-creditor', debt.creditor || ''],
        ['#edit-due', debt.due_on || ''],
        ['#edit-note', debt.note || ''],
      ])
        $(selector).value = value;
      $('#edit-archived').checked = debt.is_archived;
      $('#edit-category').replaceChildren();
      for (const row of categories) {
        if (row.is_archived && row.id !== debt.category_id) continue;
        $('#edit-category').add(new Option(row.name, row.id));
      }
      $('#edit-category').value = debt.category_id;
    } else {
      $('#charge-date').value = bangkokToday();
      $('#charge-date').min = debt.balance_date;
      $('#charge-date').max = bangkokToday();
      $('#charge-date-hint').textContent = `เลือกได้ตั้งแต่ ${dateText(debt.balance_date)} ถึงวันนี้`;
    }
    loaded = true;
    status('');
    $('#manage-load-status').textContent =
      debt.is_archived && mode === 'charges' ? 'หนี้นี้ถูกซ่อนอยู่ ต้องนำกลับมาใช้ก่อนเพิ่มค่าใช้จ่าย' : '';
  } catch (error) {
    if (!stopped && current === loadVersion) {
      $('#manage-load-status').textContent = '';
      status('โหลดข้อมูลไม่ได้ กรุณาตรวจสิทธิ์บัญชีและลองใหม่', true);
    }
  } finally {
    if (!stopped && current === loadVersion) controls();
  }
}
const form = $('#metadata-form') || $('#charge-form');
form.addEventListener('input', () => {
  if (loaded && !pending && !busy) dirty = true;
});
form.addEventListener('change', () => {
  if (loaded && !pending && !busy) dirty = true;
});
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!api || stopped || busy) return;
  if (!pending) {
    if (!loaded || !form.reportValidity()) return;
    try {
      const fields = Object.fromEntries(new FormData(form)),
        payload =
          mode === 'edit-debt'
            ? metadataPayload(id, fields)
            : chargePayload(id, fields, debt.balance_date, bangkokToday());
      pending = {
        canEdit: false,
        submission: createSubmission(
          { create: mode === 'edit-debt' ? api.metadata : api.charge },
          payload,
        ),
      };
    } catch (error) {
      status(error.message, true);
      return;
    }
  }
  busy = true;
  pending.canEdit = false;
  controls();
  status('กำลังบันทึก…');
  try {
    await pending.submission.send();
    if (stopped) return;
    pending = null;
    busy = false;
    loaded = false;
    controls();
    location.assign(debtUrl('debt-detail', id));
  } catch (error) {
    if (!stopped) {
      pending.canEdit = error.uncertain === false;
      status(
        pending.canEdit
          ? 'ฐานข้อมูลไม่รับรายการนี้ กรุณาตรวจวันที่และจำนวนเงิน หรือเลือกแก้ไขข้อมูล'
          : 'ยังยืนยันผลไม่ได้ กดบันทึกอีกครั้งด้วยข้อมูลเดิมก่อนเปลี่ยนหน้า',
        true,
      );
    }
  } finally {
    busy = false;
    if (!stopped) controls();
  }
});
$('#edit-manage-draft').addEventListener('click', () => {
  if (pending?.canEdit && !busy) {
    pending = null;
    controls();
    status('แก้ไขข้อมูลแล้วส่งใหม่ได้');
  }
});
$('#refresh-manage').addEventListener('click', load);
function stop() {
  stopped = true;
  loadVersion++;
  dirty = false;
  pending = null;
  debt = null;
  form.reset();
  $('#debt-title').textContent = '';
  status('');
  controls();
}
protectPendingNavigation(() => busy || Boolean(pending && !pending.canEdit), '#manage-status');
addEventListener('pagehide', stop);
const auth = await authReady;
if (auth?.session && !stopped) {
  client = auth.client;
  owner = auth.session.user.id;
  client.auth.onAuthStateChange((_event, session) => {
    if (!session || session.user.id !== owner) stop();
  });
  if (!validDebtId(id)) status('ลิงก์หนี้ไม่ถูกต้อง', true);
  else {
    api = createDebtService(client);
    await load();
  }
}
