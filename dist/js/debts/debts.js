import { authReady } from '../auth/auth.js';
import { createDebtService, createDebtPayload, createSubmission } from '../data/debt-service.js';
import { money } from '../core/format.js';
import { debtUrl, protectPendingNavigation } from '../core/navigation.js';

const $ = (selector) => document.querySelector(selector);
const form = $('#create-debt');
const fields = $('#debt-fields');
const save = $('#save-debt');
const edit = $('#edit-draft');
const list = $('#debt-list');
let service;
let client;
let userId;
let stopped = false;
let listVersion = 0;
let cursor = null;
let filters = {};
let submission = null;
let saving = false;
let leaving = false;
let categoryRows = [];
let channel;
let reloadTimer;
let refreshingCategories;
const renderedIds = new Set();
function syncInterestFields() {
  if (!form) return;
  const active = $('#interest-method').value === 'simple_daily';
  $('#interest-fields').hidden = !active;
  $('#interest-fields').disabled = !active;
  $('#initial-rate').required = active;
}
$('#interest-method')?.addEventListener('change', syncInterestFields);
syncInterestFields();

function today() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}
function status(selector, text, error = false) {
  const el = $(selector);
  if (!el) return;
  el.textContent = text;
  el.dataset.error = String(error);
  el.setAttribute('role', error ? 'alert' : 'status');
}
function errorText(error) {
  if (error.status === 401 || error.code === 'PGRST301')
    return 'เซสชันไม่ถูกต้องหรือหมดอายุ กรุณาออกจากระบบแล้วเข้าสู่ระบบใหม่';
  if (error.status === 403 || error.code === '42501')
    return 'บัญชีนี้ยังเข้าถึงข้อมูลไม่ได้ กรุณาตรวจบัญชีที่เข้าสู่ระบบ';
  if (error.code === 'PGRST202') return 'บริการรายการหนี้ยังไม่พร้อม กรุณาลองใหม่หรือติดต่อผู้ดูแล';
  if (['P0001', '23514', '22023'].includes(error.code))
    return 'ฐานข้อมูลไม่รับข้อมูลนี้ กรุณาตรวจวันที่ หมวดหมู่ และจำนวนเงิน';
  return 'โหลดหรือบันทึกไม่สำเร็จ กรุณาตรวจการเชื่อมต่อและลองใหม่';
}
function categoryName(row) {
  return typeof row.name === 'string' ? row.name : `หมวด ${row.id}`;
}
function setCategoryOptions(selector, rows, emptyText) {
  const select = $(selector);
  if (!select) return;
  const previous = select.value;
  select.replaceChildren(new Option(emptyText, ''));
  for (const row of rows)
    if (typeof row.id === 'string') select.add(new Option(categoryName(row), row.id));
  if (rows.some((row) => row.id === previous)) select.value = previous;
}
async function loadCategories() {
  if (refreshingCategories) return refreshingCategories;
  refreshingCategories = (async () => {
    try {
      const rows = await service.categories();
      if (stopped) return;
      categoryRows = rows.filter((row) => typeof row.id === 'string' && !row.is_archived);
      setCategoryOptions('#category-filter', categoryRows, 'ทุกหมวด');
      // อย่าเปลี่ยน payload ที่รอ retry อยู่
      if (!submission) setCategoryOptions('#category', categoryRows, 'เลือกหมวดหมู่');
      if (fields && !saving && !submission) {
        fields.disabled = !categoryRows.length;
        save.disabled = !categoryRows.length;
      }
      if (!categoryRows.length)
        status('#create-status', 'ไม่พบหมวดหมู่ที่บัญชีนี้อ่านได้ จึงยังเพิ่มหนี้ไม่ได้', true);
    } catch (error) {
      if (!stopped)
        status('#create-status', `${errorText(error)} กดโหลดใหม่เพื่อลองอ่านหมวดหมู่อีกครั้ง`, true);
    }
  })();
  try {
    await refreshingCategories;
  } finally {
    refreshingCategories = null;
  }
}
function dateText(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00+07:00`);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'medium' }).format(
        date,
      )
    : null;
}
function appendDebt(row) {
  const debt = row.debt;
  if (renderedIds.has(debt.id)) return;
  renderedIds.add(debt.id);
  const item = document.createElement('li');
  item.className = 'debt-item';
  const title = document.createElement('h3');
  title.textContent = typeof debt.title === 'string' ? debt.title : 'รายการหนี้';
  item.append(title);
  const details = document.createElement('dl');
  const add = (label, value) => {
    if (value == null || value === '') return;
    const term = document.createElement('dt');
    term.textContent = label;
    const description = document.createElement('dd');
    description.textContent = value;
    details.append(term, description);
  };
  add('เจ้าหนี้', debt.creditor);
  const category = categoryRows.find((row) => row.id === debt.category_id);
  if (category) add('หมวดหมู่', categoryName(category));
  add('เริ่มนับหนี้', dateText(debt.opening_date));
  add('ครบกำหนด', dateText(debt.due_on));
  item.append(details);
  const balance = document.createElement('div');
  balance.className = 'debt-item-balance';
  const balanceLabel = document.createElement('span');
  balanceLabel.textContent = 'ยอดคงเหลือวันนี้';
  const balanceAmount = document.createElement('strong');
  balanceAmount.textContent = money(row.balance?.total_due);
  balance.append(balanceLabel, balanceAmount);
  const link = document.createElement('a');
  link.href = `debt-detail.html?id=${encodeURIComponent(debt.id)}`;
  link.className = 'detail-link section-link';
  link.setAttribute('aria-label', `ดูสรุปหนี้ ${title.textContent}`);
  link.textContent = 'ดูสรุปหนี้';
  const arrow = document.createElement('span');
  arrow.className = 'link-arrow';
  arrow.textContent = '→';
  arrow.setAttribute('aria-hidden', 'true');
  link.append(arrow);
  balance.append(link);
  item.append(balance);
  list.append(item);
}
async function loadList(more = false) {
  if (stopped || !list) return;
  const version = ++listVersion;
  if (!more) {
    cursor = null;
    renderedIds.clear();
    list.replaceChildren();
    $('#load-more').hidden = true;
  }
  $('#load-more').disabled = true;
  status('#list-status', 'กำลังโหลดรายการ…');
  try {
    const rows = await service.list({ ...filters, cursor: more ? cursor : null });
    if (stopped || version !== listVersion) return;
    rows.forEach(appendDebt);
    const last = rows.at(-1)?.debt;
    cursor = last?.created_at && last?.id ? { created_at: last.created_at, id: last.id } : null;
    $('#load-more').hidden = rows.length < 25 || !cursor;
    status(
      '#list-status',
      renderedIds.size ? `แสดง ${renderedIds.size} รายการ` : 'ยังไม่มีรายการตรงกับเงื่อนไขนี้',
    );
    if (rows.length === 25 && !cursor)
      status(
        '#list-status',
        'โหลดแล้ว 25 รายการ แต่ยังอ่านตำแหน่งหน้าถัดไปไม่ได้ กรุณาตรวจรูปแบบผลลัพธ์ RPC',
        true,
      );
  } catch (error) {
    if (!stopped && version === listVersion) status('#list-status', errorText(error), true);
  } finally {
    if (!stopped && version === listVersion) $('#load-more').disabled = false;
  }
}
function scheduleReload() {
  if (stopped || !service) return;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    loadList();
  }, 350);
}
function stop() {
  stopped = true;
  listVersion++;
  clearTimeout(reloadTimer);
  submission = null;
  categoryRows = [];
  renderedIds.clear();
  form?.reset();
  if (fields) fields.disabled = true;
  if (save) save.disabled = true;
  list?.replaceChildren();
  $('#category')?.replaceChildren();
  $('#category-filter')?.replaceChildren();
  status('#create-status', '');
  status('#list-status', '');
  if (channel) {
    client.removeChannel(channel);
    channel = null;
  }
}
$('#filters')?.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!service || stopped) return;
  const data = new FormData(event.currentTarget);
  filters = {
    search: String(data.get('search')),
    category: data.get('category'),
    archived: data.get('archived') === 'true',
  };
  loadList();
});
$('#load-more')?.addEventListener('click', () => loadList(true));
$('#refresh')?.addEventListener('click', async (event) => {
  if (!service || stopped) return;
  const button = event.currentTarget;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  try {
    await loadCategories();
    await loadList();
  } finally {
    button.disabled = stopped;
    button.removeAttribute('aria-busy');
  }
});
edit?.addEventListener('click', () => {
  if (saving || stopped) return;
  // ปุ่มนี้ปรากฏเฉพาะเมื่อฐานตอบปฏิเสธแน่นอน ไม่ใช่เมื่อผลเครือข่ายไม่ชัดเจน
  submission = null;
  edit.hidden = true;
  fields.disabled = false;
  save.textContent = 'บันทึกหนี้';
  status('#create-status', 'แก้ไขข้อมูลแล้วกดบันทึกอีกครั้ง');
});
form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!service || saving || stopped) return;
  if (!submission) {
    if (!form.reportValidity()) return;
    try {
      submission = createSubmission(
        service,
        createDebtPayload(Object.fromEntries(new FormData(form)), today()),
      );
    } catch (error) {
      status('#create-status', error.message, true);
      return;
    }
  }
  saving = true;
  fields.disabled = true;
  save.disabled = true;
  edit.hidden = true;
  form.setAttribute('aria-busy', 'true');
  status('#create-status', 'กำลังบันทึก…');
  try {
    const created = await submission.send();
    if (stopped) return;
    submission = null;
    if (!list) {
      saving = false;
      leaving = true;
      location.assign(debtUrl('debt-detail', created.id));
      return;
    }
    form.reset();
    syncInterestFields();
    $('#opening-date').value = today();
    setCategoryOptions('#category', categoryRows, 'เลือกหมวดหมู่');
    status('#create-status', 'บันทึกหนี้สำเร็จแล้ว');
    // โหลดจากฐานใหม่หลังยืนยัน ไม่หัก/บวกยอดเองในเบราว์เซอร์
    await loadList();
  } catch (error) {
    if (stopped) return;
    edit.hidden = error.uncertain !== false;
    status(
      '#create-status',
      error.uncertain !== false
        ? 'ยังยืนยันผลบันทึกไม่ได้ กด “ส่งรายการเดิมอีกครั้ง” เพื่อสอบถามผลด้วยรหัสเดิม อย่าปิดหรือรีโหลดหน้านี้จนกว่าจะทราบผล'
        : `${errorText(error)} คุณสามารถแก้ไขข้อมูลหรือส่งรายการเดิมอีกครั้งได้`,
      true,
    );
  } finally {
    saving = false;
    form.setAttribute('aria-busy', 'false');
    if (!stopped && !leaving) {
      save.disabled = !categoryRows.length;
      fields.disabled = Boolean(submission) || !categoryRows.length;
      save.textContent = submission ? 'ส่งรายการเดิมอีกครั้ง' : 'บันทึกหนี้';
    }
  }
});
addEventListener('pagehide', stop);
protectPendingNavigation(
  () => saving || Boolean(submission && edit?.hidden),
  form ? '#create-status' : '#list-status',
);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && service) scheduleReload();
});
addEventListener('online', scheduleReload);
const ready = await authReady;
if (ready?.session) {
  client = ready.client;
  userId = ready.session.user.id;
  service = createDebtService(client);
  client.auth.onAuthStateChange((_event, session) => {
    if (!session || session.user.id !== userId) stop();
  });
  if ($('#opening-date')) {
    $('#opening-date').value = today();
    $('#opening-date').max = today();
  }
  await loadCategories();
  if (!stopped) {
    await loadList();
    if (!stopped)
      channel = client
        .channel('debt-list-refresh')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'debts' }, scheduleReload)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'debt_rate_changes' },
          scheduleReload,
        )
        .on('postgres_changes', { event: '*', schema: 'public', table: 'categories' }, () => {
          loadCategories();
          scheduleReload();
        })
        .subscribe((state) => {
          if (state === 'SUBSCRIBED') scheduleReload();
        });
  }
}
