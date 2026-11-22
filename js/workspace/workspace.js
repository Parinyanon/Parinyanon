import { createOverviewView } from './overview.js';
import { authReady } from '../auth/auth.js';
import { createWorkspaceService, settingsPayload, csvText } from '../data/workspace-service.js';
import { createSubmission, createDebtService } from '../data/debt-service.js';
import { debtUrl, protectPendingNavigation } from '../core/navigation.js';
import { applyTheme, refreshReminderBadges } from '../core/experience.js';
import { bangkokToday } from '../core/format.js';
import { getPublicFeatures } from '../data/supabase-client.js';
const $ = (selector) => document.querySelector(selector),
  mode = document.body.dataset.workspace;
let service,
  client,
  owner,
  channel,
  stopped = false,
  busy = false,
  dirty = false,
  epoch = 0,
  cursor = null,
  pending = null,
  timer,
  day = bangkokToday(),
  emailAvailable = false,
  settingsLoaded = false,
  settingsRevision = 0;
const visibleIds = new Set();
function status(message, error = false) {
  const node = $('#workspace-status');
  node.textContent = message;
  node.dataset.error = String(error);
  node.setAttribute('role', error ? 'alert' : 'status');
}
function errorMessage(error) {
  return error.code === '42501' || error.status === 403
    ? 'ไม่มีสิทธิ์เข้าถึงข้อมูลนี้ กรุณาตรวจบัญชีที่เข้าสู่ระบบ'
    : error.status === 401
      ? 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่'
      : 'ดำเนินการไม่สำเร็จ กรุณาตรวจอินเทอร์เน็ตแล้วลองใหม่';
}
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function empty(target, title, body) {
  target.replaceChildren();
  const box = element('div', undefined, 'empty-state');
  box.append(element('strong', title), element('p', body));
  target.append(box);
}
function controls() {
  updateExportPresentation();
  updateSettingsPresentation();
  if (mode === 'categories') {
    $('#category-add-label').textContent = busy
      ? 'กำลังเพิ่ม…'
      : pending
        ? 'ลองเพิ่มอีกครั้ง'
        : 'เพิ่มประเภทหนี้';
    $('#add-category').setAttribute('aria-busy', String(busy));
  }
  for (const id of ['save-settings', 'download-export', 'add-category']) {
    const button = $(`#${id}`);
    if (button)
      button.disabled =
        busy ||
        stopped ||
        !service ||
        (id === 'save-settings' && (!settingsLoaded || (!dirty && !pending)));
  }
  for (const form of document.querySelectorAll('form')) {
    for (const field of form.querySelectorAll('input,select'))
      field.disabled =
        busy ||
        stopped ||
        (mode === 'settings' && !settingsLoaded) ||
        (['categories', 'settings'].includes(mode) && Boolean(pending)) ||
        field.dataset.unavailable === 'true';
  }
}
function updateExportPresentation() {
  if (mode !== 'export') return;
  const form = $('#export-form'),
    format = form.querySelector('[name="format"]:checked')?.value || 'csv',
    scope = form.querySelector('[name="scope"]:checked')?.value || 'all';
  $('#export-filename').textContent = `jadnee-${bangkokToday()}.${format}`;
  $('#export-selection').textContent = {
    all: 'หนี้ทั้งหมด รวมรายการที่ซ่อนไว้',
    active: 'เฉพาะรายการที่ยังไม่ซ่อน',
    archived: 'เฉพาะรายการที่ซ่อนไว้',
  }[scope];
  $('#export-button-label').textContent = busy
    ? 'กำลังเตรียมไฟล์…'
    : format === 'json'
      ? 'ดาวน์โหลดไฟล์ JSON'
      : 'ดาวน์โหลดไฟล์สำหรับ Excel';
  $('#download-export').setAttribute('aria-busy', String(busy));
}
$('#export-form')?.addEventListener('change', updateExportPresentation);
updateExportPresentation();
const overviewView =
  mode === 'overview' ? createOverviewView(document.getElementById('private-content')) : null;
async function renderOverview(current) {
  return overviewView.render(
    service,
    createDebtService(client),
    () => !stopped && current === epoch,
  );
}
async function renderReminders(current, more = false) {
  const rows = await service.reminders(more ? cursor : null);
  if (stopped || current !== epoch) return;
  const list = $('#reminder-list');
  if (!more) {
    list.replaceChildren();
    visibleIds.clear();
  }
  for (const row of rows) {
    if (visibleIds.has(row.id)) continue;
    visibleIds.add(row.id);
    const card = element('div', undefined, 'reminder-card'),
      info = element('div');
    info.append(
      element('h3', row.title),
      element(
        'p',
        new Intl.DateTimeFormat('th-TH', {
          dateStyle: 'medium',
          timeStyle: 'short',
          timeZone: 'Asia/Bangkok',
        }).format(new Date(row.remind_at)),
      ),
    );
    const actions = element('div', undefined, 'mini-actions'),
      link = element('a', 'ดูหนี้ →', 'plain-button');
    link.href = debtUrl('debt-detail', row.debt_id);
    const read = element('button', 'อ่านแล้ว', 'plain-button');
    read.type = 'button';
    read.addEventListener('click', async () => {
      read.disabled = true;
      try {
        await service.markRead(row.id);
        if (stopped) return;
        card.remove();
        visibleIds.delete(row.id);
        refreshReminderBadges(client, owner, () => !stopped);
        if (!visibleIds.size) await refresh();
      } catch (error) {
        if (!stopped) {
          status(errorMessage(error), true);
          read.disabled = false;
        }
      }
    });
    actions.append(link, read);
    card.append(info, actions);
    list.append(card);
  }
  cursor = rows.at(-1) || null;
  $('#more-reminders').hidden = rows.length < 25;
  if (!visibleIds.size)
    empty(list, 'ไม่มีแจ้งเตือนที่ต้องอ่าน', 'คุณตามรายการครบแล้ว หรือยังไม่มีแผนงวดที่ถึงเวลาเตือน');
}
async function renderSettings(current) {
  const revision = settingsRevision;
  const [profile, settings, features] = await Promise.all([
    service.profile(),
    service.settings(),
    getPublicFeatures(),
  ]);
  if (stopped || current !== epoch || revision !== settingsRevision || dirty) return;
  if (!profile || !settings) throw new Error('ไม่พบข้อมูลตั้งค่า');
  $('#display-name').value = profile.display_name;
  for (const radio of document.querySelectorAll('[name="theme"]'))
    radio.checked = radio.value === settings.theme;
  $('#reminder-days').value = String(settings.reminder_days_before);
  $('#in-app').checked = settings.in_app_notifications;
  emailAvailable = features.emailRemindersReady || Boolean(settings.email_notifications);
  $('#email-notifications').checked = settings.email_notifications;
  $('#email-notifications').dataset.unavailable = String(!emailAvailable);
  $('#email-status').textContent = features.emailRemindersReady
    ? 'ส่งการเตือนงวดชำระไปยังอีเมลที่ยืนยันแล้ว'
    : settings.email_notifications
      ? 'บัญชีเปิดการเตือนไว้ แต่บริการส่งอีเมลยังไม่พร้อม คุณสามารถปิดไว้ก่อนได้'
      : 'ผู้ดูแลยังไม่ได้เปิดบริการส่งอีเมล ขณะนี้ใช้แจ้งเตือนในแอปได้';
  $('#email-availability').textContent = features.emailRemindersReady
    ? 'พร้อมใช้งาน'
    : 'ยังไม่พร้อมใช้งาน';
  settingsLoaded = true;
  applyTheme(settings.theme);
  try {
    localStorage.setItem('dm:theme', settings.theme);
  } catch {}
  dirty = false;
}
async function renderCategories(current) {
  const rows = await service.categories();
  if (stopped || current !== epoch) return;
  const list = $('#category-list');
  list.replaceChildren();
  for (const row of rows) {
    const card = element('div', undefined, 'reminder-card'),
      info = element('div');
    info.append(
      element('h3', row.name),
      element(
        'p',
        row.user_id === owner
          ? row.is_archived
            ? 'ประเภทส่วนตัว · ซ่อนไว้'
            : 'ประเภทส่วนตัว'
          : 'ประเภทเริ่มต้น',
      ),
    );
    card.append(info);
    if (row.user_id === owner) {
      const button = element('button', row.is_archived ? 'นำกลับมาใช้' : 'ซ่อน', 'plain-button');
      button.type = 'button';
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          await service.archiveCategory(row.id, !row.is_archived);
          if (!stopped) await refresh();
        } catch (error) {
          if (!stopped) {
            status(errorMessage(error), true);
            button.disabled = false;
          }
        }
      });
      card.append(button);
    }
    list.append(card);
  }
}
async function refresh() {
  if (!service || stopped || busy || (mode === 'settings' && dirty)) return;
  const current = ++epoch;
  const refreshButton = $('#workspace-refresh');
  if (refreshButton) {
    refreshButton.disabled = true;
    refreshButton.setAttribute('aria-busy', 'true');
  }
  status('กำลังโหลด…');
  try {
    if (mode === 'overview') await renderOverview(current);
    if (mode === 'reminders') {
      await renderReminders(current);
      refreshReminderBadges(client, owner, () => !stopped && current === epoch);
    }
    if (mode === 'settings') await renderSettings(current);
    if (mode === 'categories') await renderCategories(current);
    if (!stopped && current === epoch) {
      if (mode !== 'settings' || (!busy && !dirty && !pending)) status('');
      controls();
    }
  } catch (error) {
    if (!stopped && current === epoch) status(errorMessage(error), true);
  } finally {
    if (refreshButton && current === epoch) {
      refreshButton.disabled = stopped;
      refreshButton.removeAttribute('aria-busy');
    }
  }
}
function download(data, name, type) {
  const blob = new Blob([data], { type }),
    url = URL.createObjectURL(blob),
    link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function settingsTheme() {
  return document.querySelector('[name="theme"]:checked')?.value || 'system';
}
function updateSettingsPresentation() {
  if (mode !== 'settings') return;
  $('#settings-save-hint').textContent = busy
    ? 'กำลังบันทึกการตั้งค่า…'
    : !settingsLoaded
      ? 'กำลังโหลดการตั้งค่า…'
      : pending
        ? 'บันทึกยังไม่ครบ ลองบันทึกข้อมูลเดิมอีกครั้ง'
        : dirty
          ? 'มีการเปลี่ยนแปลงที่ยังไม่บันทึก'
          : 'บันทึกค่าล่าสุดไว้แล้ว';
  $('#settings-save-label').textContent = busy
    ? 'กำลังบันทึก…'
    : pending
      ? 'ลองบันทึกอีกครั้ง'
      : 'บันทึกการตั้งค่า';
  $('#save-settings').setAttribute('aria-busy', String(busy));
}
$('#settings-form')?.addEventListener('input', () => {
  settingsRevision++;
  dirty = true;
  controls();
});
$('#settings-form')?.addEventListener('change', (event) => {
  settingsRevision++;
  dirty = true;
  if (event.target.name === 'theme') applyTheme(settingsTheme());
  controls();
});
$('#settings-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy || stopped || !service || !settingsLoaded) return;
  settingsRevision++;
  if (!pending) {
    try {
      const payload = settingsPayload(
        Object.fromEntries(new FormData(event.currentTarget)),
        emailAvailable,
      );
      pending = createSubmission(
        {
          create: async (data) => {
            await service.saveProfile(data.profile);
            if (stopped) throw new Error('เซสชันสิ้นสุดแล้ว');
            return service.saveSettings(data.settings);
          },
        },
        payload,
      );
    } catch (error) {
      status(error.message, true);
      return;
    }
  }
  busy = true;
  controls();
  status('กำลังบันทึก…');
  try {
    await pending.send();
    if (stopped) return;
    pending = null;
    dirty = false;
    try {
      localStorage.setItem('dm:theme', settingsTheme());
    } catch {}
    status('บันทึกการตั้งค่าแล้ว');
    refreshReminderBadges(client, owner, () => !stopped);
  } catch (error) {
    if (!stopped) status('บันทึกยังไม่ครบ กรุณากดบันทึกอีกครั้งด้วยข้อมูลเดิม', true);
  } finally {
    busy = false;
    if (!stopped) {
      controls();
      if (pending)
        for (const input of $('#settings-form').querySelectorAll('input,select'))
          input.disabled = true;
    }
  }
});
$('#category-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (busy || stopped || !service) return;
  if (!pending) {
    const name = $('#category-name').value.trim();
    if (!name || name.length > 80) {
      status('ตั้งชื่อประเภทหนี้ 1–80 ตัวอักษร', true);
      return;
    }
    pending = createSubmission(
      { create: (data) => service.addCategory(data.name, data.id) },
      { name, id: crypto.randomUUID() },
    );
  }
  busy = true;
  controls();
  status('กำลังเพิ่มประเภทหนี้…');
  let saved = false;
  try {
    await pending.send();
    if (stopped) return;
    pending = null;
    form.reset();
    saved = true;
  } catch (error) {
    if (!stopped) {
      if (error.uncertain === false) pending = null;
      status(
        error.code === '23505'
          ? 'มีประเภทชื่อนี้อยู่แล้ว ลองใช้ชื่ออื่น'
          : error.uncertain === false
            ? error.reason === 'permission denied for table categories'
              ? 'ฐานข้อมูลยังไม่อนุญาตให้บัญชีผู้ใช้เพิ่มประเภทหนี้ (42501)'
              : error.reason === 'new row violates row-level security policy for table "categories"'
                ? 'กฎ RLS ไม่อนุญาตให้บันทึกประเภทหนี้ของบัญชีนี้ (42501)'
                : errorMessage(error)
            : 'ยังยืนยันผลไม่ได้ กด “ลองเพิ่มอีกครั้ง” เพื่อส่งชื่อเดิมโดยไม่สร้างรายการซ้ำ',
        true,
      );
    }
  } finally {
    busy = false;
    if (!stopped) {
      controls();
      if (saved) {
        await refresh();
        if (!stopped) {
          status('เพิ่มประเภทหนี้แล้ว เลือกใช้ในหน้าเพิ่มหนี้ได้เลย');
          $('#category-name').focus();
        }
      }
    }
  }
});
$('#export-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy || stopped || !service) return;
  const values = new FormData(event.currentTarget);
  busy = true;
  controls();
  status('กำลังอ่านข้อมูลทุกหน้า กรุณารอสักครู่…');
  try {
    const rows = await service.exportRows(String(values.get('scope')), () => stopped);
    if (stopped) return;
    const stamp = bangkokToday();
    if (values.get('format') === 'json')
      download(
        JSON.stringify(
          { exported_at: new Date().toISOString(), currency: 'THB', debts: rows },
          null,
          2,
        ),
        `jadnee-${stamp}.json`,
        'application/json;charset=utf-8',
      );
    else {
      const grid = [
        [
          'ชื่อหนี้',
          'เจ้าหนี้',
          'เริ่มนับ',
          'ครบกำหนด',
          'ซ่อนรายการ',
          'เงินต้นคงเหลือ',
          'ดอกเบี้ย',
          'ค่าธรรมเนียม',
          'ภาษี',
          'ยอดคงเหลือ',
          'หมายเหตุ',
        ],
        ...rows.map(({ debt: d, balance: b }) => [
          d.title,
          d.creditor,
          d.opening_date,
          d.due_on,
          d.is_archived ? 'ใช่' : 'ไม่',
          b.principal,
          b.interest,
          b.fee,
          b.tax,
          b.total_due,
          d.note,
        ]),
      ];
      download(csvText(grid), `jadnee-${stamp}.csv`, 'text/csv;charset=utf-8');
    }
    status(`ดาวน์โหลดข้อมูล ${rows.length} รายการแล้ว`);
  } catch (error) {
    if (!stopped) status(errorMessage(error), true);
  } finally {
    busy = false;
    controls();
  }
});
$('#more-reminders')?.addEventListener('click', async () => {
  if (!cursor || busy || stopped) return;
  const current = epoch;
  $('#more-reminders').disabled = true;
  try {
    await renderReminders(current, true);
  } catch (error) {
    if (!stopped) status(errorMessage(error), true);
  } finally {
    if (!stopped) $('#more-reminders').disabled = false;
  }
});
$('#workspace-refresh')?.addEventListener('click', () => {
  if (dirty) {
    status('มีข้อมูลที่ยังไม่บันทึก กรุณาบันทึกก่อนโหลดใหม่');
    return;
  }
  refresh();
});
function stop() {
  overviewView?.clear();
  stopped = true;
  if ($('#settings-email')) $('#settings-email').textContent = '';
  epoch++;
  pending = null;
  clearInterval(timer);
  for (const form of document.querySelectorAll('form')) form.reset();
  for (const id of ['reminder-list', 'category-list']) $(`#${id}`)?.replaceChildren();
  status('');
  controls();
  if (channel) {
    client.removeChannel(channel);
    channel = null;
  }
}
protectPendingNavigation(() => busy || Boolean(pending), '#workspace-status');
addEventListener('pagehide', stop);
addEventListener('online', () => refresh());
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh();
});
const auth = await authReady;
if (auth?.session && !stopped) {
  client = auth.client;
  owner = auth.session.user.id;
  service = createWorkspaceService(client, owner);
  if ($('#settings-email'))
    $('#settings-email').textContent = auth.session.user.email || 'ไม่พบอีเมลบัญชี';
  client.auth.onAuthStateChange((_event, session) => {
    if (!session || session.user.id !== owner) stop();
  });
  controls();
  await refresh();
  controls();
  if (!stopped) {
    channel = client.channel(`workspace-${mode}`);
    for (const table of [
      'debts',
      'debt_events',
      'debt_rate_changes',
      'installments',
      'installment_allocations',
      'reminders',
      'categories',
    ])
      channel = channel.on('postgres_changes', { event: '*', schema: 'public', table }, () =>
        refresh(),
      );
    channel.subscribe((state) => {
      if (state === 'SUBSCRIBED') refresh();
    });
    timer = setInterval(() => {
      if (stopped || document.hidden) return;
      const now = bangkokToday();
      if (mode === 'reminders' || now !== day) {
        day = now;
        refresh();
      }
    }, 60000);
  }
}
