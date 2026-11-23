import { debtUrl } from '../core/navigation.js';
import { bangkokToday } from '../core/format.js';
import {
  matchingReminders,
  readReminderScope,
  reminderDay,
  reminderTime,
} from './reminders-model.js';

// This view owns presentation only. Account lifecycle, refresh and RLS remain in workspace/service.
export function createRemindersView(root, onRead, onRefresh, isAlive) {
  const find = (selector) => root.querySelector(selector);
  const state = { search: '', period: 'all', page: 0, selected: null };
  let rows = [],
    service,
    current = () => false,
    revision = 0,
    pending = false,
    queued = false,
    loading = true,
    failed = null,
    returnId;
  const dialog = find('#reminder-reader');
  const node = (tag, text, cls) => {
    const item = document.createElement(tag);
    if (text !== undefined) item.textContent = text;
    if (cls) item.className = cls;
    return item;
  };
  const button = (text, action, value, cls) => {
    const item = node('button', text, cls);
    item.type = 'button';
    item.dataset[action] = value ?? '';
    return item;
  };
  const filtered = () => matchingReminders(rows, state.search, state.period);
  function notice(text, error = false) {
    const item = find('#reminder-feedback');
    item.textContent = text;
    item.setAttribute('role', error ? 'alert' : 'status');
    item.dataset.error = String(error);
  }
  function closeReader(restore = true) {
    if (dialog.open) dialog.close();
    find('#reminder-dialog-content').replaceChildren();
    if (restore && returnId)
      root.querySelector(`[data-select-reminder="${returnId}"]`)?.focus({ preventScroll: true });
  }
  function details(row) {
    const box = node('div', undefined, 'rn-detail'),
      content = node('div', undefined, 'rn-detail-scroll'),
      title = node('div');
    title.append(node('p', 'การเตือนที่เลือก', 'rn-kicker'), node('h2', row.debtName));
    // Notification text is not a payment status or a due date; label its timestamp explicitly.
    const reason = row.title.endsWith(': ' + row.debtName)
      ? row.title.slice(0, -row.debtName.length - 2)
      : row.title;
    title.append(node('p', reason, 'rn-reason'));
    const when = node('div', undefined, 'rn-date-block'),
      date = node('div', undefined, 'rn-day');
    date.setAttribute('aria-hidden', 'true');
    date.append(
      node(
        'span',
        new Intl.DateTimeFormat('th-TH', { day: 'numeric', timeZone: 'Asia/Bangkok' }).format(
          new Date(row.remind_at),
        ),
      ),
      node(
        'small',
        new Intl.DateTimeFormat('th-TH', { month: 'short', timeZone: 'Asia/Bangkok' }).format(
          new Date(row.remind_at),
        ),
      ),
    );
    const text = node('div'),
      time = node('time', reminderTime(row.remind_at, true));
    time.dateTime = row.remind_at;
    text.append(node('p', 'แจ้งเตือนเมื่อ', 'rn-muted'), time);
    when.append(date, text);
    content.append(title, when);
    if (failed === row.id) {
      const error = node('p', 'ยังทำเครื่องหมายไม่สำเร็จ รายการยังอยู่ ลองอีกครั้งได้', 'rn-error');
      error.setAttribute('role', 'alert');
      content.append(error);
    }
    const actions = node('div', undefined, 'rn-actions'),
      link = node('a', 'ดูรายละเอียดหนี้ →', 'rn-primary');
    link.href = debtUrl('debt-detail', row.debt_id);
    const read = button(
      pending ? 'กำลังบันทึก…' : failed === row.id ? 'ลองอีกครั้ง' : 'อ่านแล้ว',
      'readReminder',
      row.id,
    );
    read.disabled = pending || loading || !current();
    actions.append(link, read);
    box.append(content, actions);
    return box;
  }
  function openReader(id) {
    const row = rows.find((row) => row.id === id);
    if (!row) return;
    state.selected = returnId = id;
    find('#reminder-dialog-content').replaceChildren(details(row));
    if (!dialog.open) dialog.showModal();
    find('[data-close-reader]').focus();
  }
  function empty(title, text, retry = false) {
    const box = node('section', undefined, 'rn-empty');
    box.append(node('h2', title), node('p', text, 'rn-muted'));
    if (retry) box.append(button('ลองอีกครั้ง', 'retryReminders', '', 'rn-primary'));
    else if (state.search || state.period !== 'all')
      box.append(button('ล้างตัวกรอง', 'resetReminders'));
    else {
      const link = node('a', 'ดูรายการหนี้', 'rn-primary');
      link.href = 'index.html';
      box.append(link);
    }
    find('#reminder-results').replaceChildren(box);
  }
  function paint() {
    find('#reminder-total').textContent = loading
      ? 'กำลังตรวจรายการล่าสุด…'
      : `ยังไม่อ่านทั้งหมด ${rows.length} รายการ`;
    find('#reminder-tools').hidden = loading || rows.length === 0;
    find('#reminder-search').disabled = find('#reminder-period').disabled = pending || loading;
    if (loading) {
      empty('กำลังโหลดแจ้งเตือน…', 'รอสักครู่ ระบบกำลังตรวจรายการล่าสุด');
      return;
    }
    const list = filtered();
    if (!list.length) {
      state.selected = null;
      closeReader(false);
      empty(
        rows.length ? 'ไม่พบแจ้งเตือน' : 'ไม่มีแจ้งเตือนที่ต้องอ่าน',
        rows.length ? 'ลองเปลี่ยนคำค้นหรือช่วงเวลา' : 'คุณตามรายการครบแล้ว หรือยังไม่มีแผนงวดที่ถึงเวลาเตือน',
      );
      return;
    }
    state.page = Math.max(0, Math.min(state.page, Math.ceil(list.length / 6) - 1));
    const shown = list.slice(state.page * 6, state.page * 6 + 6);
    if (!shown.some((row) => row.id === state.selected)) state.selected = shown[0].id;
    const layout = node('div', undefined, 'rn-reader'),
      left = node('section', undefined, 'rn-list'),
      heading = node('header', undefined, 'rn-result-heading');
    heading.append(
      node(
        'h2',
        state.period === 'today'
          ? `เตือนวันนี้ · ${list.length} รายการ`
          : state.period === 'earlier'
            ? `ก่อนวันนี้ · ${list.length} รายการ`
            : state.search
              ? `ผลการค้นหา · ${list.length} รายการ`
              : 'รายการที่ยังไม่อ่าน',
      ),
      node(
        'span',
        `${state.page * 6 + 1}–${Math.min(state.page * 6 + 6, list.length)} จาก ${list.length}`,
      ),
    );
    left.append(heading);
    let lastDay = '';
    for (const [index, row] of shown.entries()) {
      const key = reminderDay(row.remind_at);
      if (key !== lastDay) {
        left.append(
          node(
            'h3',
            key === bangkokToday()
              ? 'วันนี้'
              : new Intl.DateTimeFormat('th-TH', {
                  dateStyle: 'medium',
                  timeZone: 'Asia/Bangkok',
                }).format(new Date(row.remind_at)),
            'rn-date-heading',
          ),
        );
        lastDay = key;
      }
      const item = button('', 'selectReminder', row.id, 'rn-row'),
        dot = node('span', undefined, 'rn-dot'),
        text = node('span', undefined, 'rn-row-text');
      dot.setAttribute('aria-hidden', 'true');
      item.setAttribute('aria-pressed', String(row.id === state.selected));
      text.append(
        node('span', row.debtName, 'rn-row-name'),
        node('small', 'แจ้งเตือน ' + reminderTime(row.remind_at) + ' น.'),
      );
      if (!index) text.append(node('span', 'เปิดอ่าน →', 'rn-open-cue'));
      const arrow = node('span', '›', 'rn-arrow');
      arrow.setAttribute('aria-hidden', 'true');
      item.append(dot, text, arrow);
      item.disabled = pending;
      left.append(item);
    }
    const pages = Math.ceil(list.length / 6);
    if (pages > 1) {
      const nav = node('nav', undefined, 'rn-pager');
      nav.setAttribute('aria-label', 'เปลี่ยนหน้าแจ้งเตือน');
      const add = (text, page, disabled) => {
        const b = button(text, 'reminderPage', page);
        b.disabled = pending || disabled;
        nav.append(b);
      };
      if (pages > 5) add('แรก', 0, !state.page);
      add('ก่อนหน้า', state.page - 1, !state.page);
      nav.append(node('span', `${state.page + 1} / ${pages}`));
      add('ถัดไป', state.page + 1, state.page === pages - 1);
      if (pages > 5) add('สุดท้าย', pages - 1, state.page === pages - 1);
      left.append(nav);
    }
    const right = node('section', undefined, 'rn-desktop-detail');
    right.setAttribute('aria-label', 'รายละเอียดแจ้งเตือนที่เลือก');
    right.append(details(shown.find((row) => row.id === state.selected)));
    layout.append(left, right);
    find('#reminder-results').replaceChildren(layout);
  }
  async function markRead(id) {
    if (pending || loading || !current() || !rows.some((row) => row.id === id)) return;
    const active = isAlive,
      token = ++revision,
      before = filtered(),
      index = before.findIndex((row) => row.id === id),
      next = before[index + 1] || before[index - 1];
    pending = true;
    failed = null;
    paint();
    if (dialog.open)
      find('#reminder-dialog-content').replaceChildren(details(rows.find((row) => row.id === id)));
    try {
      await service.markRead(id);
      if (!active() || token !== revision) return;
      rows = rows.filter((row) => row.id !== id);
      state.selected = next?.id || null;
      state.page = Math.max(
        0,
        Math.floor(filtered().findIndex((row) => row.id === state.selected) / 6),
      );
      closeReader(false);
      notice('ทำเครื่องหมายว่าอ่านแล้ว');
      onRead();
    } catch {
      if (!active() || token !== revision) return;
      failed = id;
      notice('ยังบันทึกไม่สำเร็จ รายการนี้ยังอยู่', true);
    } finally {
      pending = false;
      if (active() && token === revision) {
        paint();
        if (dialog.open) {
          find('#reminder-dialog-content').replaceChildren(
            details(rows.find((row) => row.id === id)),
          );
          find('dialog [data-read-reminder]')?.focus();
        } else
          root
            .querySelector(`[data-select-reminder="${state.selected}"]`)
            ?.focus({ preventScroll: true });
        if (queued) {
          queued = false;
          onRefresh();
        }
      }
    }
  }
  find('#reminder-search').addEventListener('input', (event) => {
    state.search = event.target.value;
    state.page = 0;
    paint();
  });
  find('#reminder-period').addEventListener('change', (event) => {
    state.period = event.target.value;
    state.page = 0;
    paint();
  });
  root.addEventListener('click', (event) => {
    const target = event.target.closest('button');
    if (!target || target.disabled) return;
    if (target.hasAttribute('data-close-reader')) {
      closeReader();
      return;
    }
    if (pending) return;
    if (target.dataset.selectReminder) {
      state.selected = target.dataset.selectReminder;
      if (matchMedia('(max-width:850px)').matches) openReader(state.selected);
      else {
        paint();
        root
          .querySelector(`[data-select-reminder="${state.selected}"]`)
          ?.focus({ preventScroll: true });
      }
    } else if (target.dataset.readReminder) markRead(target.dataset.readReminder);
    else if (target.hasAttribute('data-reminder-page')) {
      state.page = Number(target.dataset.reminderPage);
      state.selected = null;
      paint();
      find('#reminder-results').scrollIntoView({ block: 'start' });
      root.querySelector('[data-select-reminder]')?.focus({ preventScroll: true });
    } else if (target.hasAttribute('data-reset-reminders')) {
      state.search = '';
      state.period = 'all';
      state.page = 0;
      find('#reminder-search').value = '';
      find('#reminder-period').value = 'all';
      paint();
      find('#reminder-search').focus();
    } else if (target.hasAttribute('data-retry-reminders')) onRefresh();
  });
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeReader();
  });
  return {
    async render(nextService, isCurrent) {
      if (pending) {
        queued = true;
        return;
      }
      service = nextService;
      current = isCurrent;
      const token = ++revision;
      const openId = dialog.open ? returnId : null;
      loading = true;
      notice('');
      paint();
      if (openId && rows.some((row) => row.id === openId)) {
        find('#reminder-dialog-content').replaceChildren(
          details(rows.find((row) => row.id === openId)),
        );
      }
      const snapshot = await readReminderScope(service, () => token === revision && isCurrent());
      if (!snapshot || !isCurrent() || token !== revision) return;
      rows = snapshot;
      loading = false;
      paint();
      if (openId && dialog.open) {
        const row = rows.find((row) => row.id === openId);
        if (row) find('#reminder-dialog-content').replaceChildren(details(row));
        else closeReader();
      }
    },
    fail(message) {
      loading = false;
      rows = [];
      closeReader(false);
      find('#reminder-total').textContent = 'ยังตรวจจำนวนแจ้งเตือนไม่ได้';
      find('#reminder-tools').hidden = true;
      empty('ยังโหลดแจ้งเตือนไม่ได้', message, true);
    },
    clear() {
      revision++;
      current = () => false;
      rows = [];
      closeReader(false);
      find('#reminder-results').replaceChildren();
      find('#reminder-total').textContent = '';
      find('#reminder-search').value = '';
      find('#reminder-tools').hidden = true;
      notice('');
    },
  };
}
