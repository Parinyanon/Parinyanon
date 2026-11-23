import { authReady } from '../auth/auth.js';
import { createDebtService } from '../data/debt-service.js';
import { createWorkspaceService } from '../data/workspace-service.js';
import { money, dateText } from '../core/format.js';
import { debtUrl } from '../core/navigation.js';
import { confirmTrash } from './trash-actions.js';
import {
  debtRows,
  filteredBase,
  matchingRows,
  resultTotal,
  readDebtScope,
  debtStates,
  normalizeSearch,
} from './debt-list-model.js';

const root = document.querySelector('#private-content');
const find = (selector) => root.querySelector(selector);
const state = {
  search: '',
  category: '',
  view: 'active',
  status: 'all',
  sort: 'priority',
  page: 0,
  size: 6,
  selected: null,
};
let rows = [],
  categories = [],
  recent = [],
  client,
  service,
  workspace,
  owner,
  channel;
let stopped = false,
  loading = false,
  initialized = false,
  queued = false,
  revision = 0,
  reloadTimer,
  resizeFrame;

// ชื่อหนี้/หมวด/หมายเหตุเป็นข้อมูลผู้ใช้ สร้างผ่าน textContent ไม่แทรกเป็น HTML
function node(tag, text, className) {
  const item = document.createElement(tag);
  if (text !== undefined) item.textContent = text;
  if (className) item.className = className;
  return item;
}
function button(text, key, value = '', className = '') {
  const item = node('button', text, className);
  item.type = 'button';
  if (key) item.dataset[key] = value;
  return item;
}
function link(text, href, className = '') {
  const item = node('a', text, className);
  item.href = href;
  return item;
}
function amount(target, value) {
  const formatted = money(value);
  target.replaceChildren(node('span', formatted.replace(/ บาท$/, ''), 'du-number'));
  if (formatted !== '—') target.append(node('small', 'บาท'));
}
function status(text, error = false) {
  const target = find('#list-status');
  if (!target) return;
  target.textContent = text;
  target.dataset.error = String(error);
  target.setAttribute('role', error ? 'alert' : 'status');
}
function badge(row) {
  return node(
    'span',
    { late: 'เลยกำหนด', active: 'มียอดคงเหลือ', paid: 'ชำระครบแล้ว' }[row.status],
    'du-badge ' + row.status,
  );
}
const matches = () => matchingRows(rows, state);
function resetPage() {
  state.page = 0;
  state.selected = matches()[0]?.debt.id || null;
}
function categoryName() {
  return categories.find((row) => row.id === state.category)?.name || 'หมวดหมู่เดิม';
}

function statuses() {
  const base = filteredBase(rows, state),
    box = node('div', undefined, 'du-status-tools');
  const tabs = node('div', undefined, 'du-tabs');
  tabs.setAttribute('aria-label', 'กรองสถานะ');
  const mobile = node('label', 'สถานะ', 'du-mobile-status'),
    select = node('select');
  select.dataset.statusSelect = '';
  for (const [value, label] of debtStates) {
    const count = base.filter((row) => value === 'all' || row.status === value).length;
    const tab = button(`${label} · ${count}`, 'status', value);
    tab.setAttribute('aria-pressed', String(value === state.status));
    tabs.append(tab);
    select.add(new Option(`${label} (${count})`, value));
  }
  select.value = state.status;
  mobile.append(select);
  const sort = node('label', 'เรียงตาม', 'du-sort'),
    order = node('select');
  order.dataset.sort = '';
  for (const [value, text] of [
    ['priority', 'เลยกำหนดก่อน'],
    ['balance', 'ยอดมากที่สุด'],
    ['name', 'ชื่อหนี้'],
  ])
    order.add(new Option(text, value));
  order.value = state.sort;
  sort.append(order);
  box.append(tabs, mobile, sort);
  find('#debt-status-tools').replaceChildren(box);
}
function filterState() {
  const box = find('#debt-filter-state');
  box.replaceChildren();
  if (state.category) box.append(button('หมวด: ' + categoryName() + ' ×', 'clearCategory'));
  if (state.view === 'archived') box.append(button('เฉพาะที่ซ่อน ×', 'clearView'));
  if (state.search) box.append(button('คำค้น: ' + state.search + ' ×', 'clearSearch'));
  box.hidden = !box.childElementCount;
  find('#category-picker span').textContent = state.category
    ? categoryName()
    : `ทุกหมวด (${categories.length})`;
  find('#search').value = state.search;
  find('#archived').value = state.view;
}
function actions(row) {
  const box = node('div', undefined, 'du-detail-actions');
  if (!row.debt.is_archived && Number(row.balance) > 0)
    box.append(link('บันทึกชำระ', debtUrl('payment', row.debt.id), 'du-primary'));
  box.append(link('ดูรายละเอียด', debtUrl('debt-detail', row.debt.id)));
  return box;
}
function detail(row) {
  if (!row) return node('p', 'เลือกหนี้จากรายการเพื่อดูรายละเอียดและบันทึกชำระ', 'du-detail-placeholder');
  const debt = row.debt,
    box = node('section', undefined, 'du-detail'),
    heading = node('header'),
    info = node('div');
  info.append(
    node('p', row.categoryName, 'du-muted'),
    node('h2', debt.title),
    node('p', debt.creditor || 'ไม่ได้ระบุเจ้าหนี้', 'du-muted'),
  );
  const menu = button('⋯', 'debtMenu', debt.id, 'du-more');
  menu.setAttribute('aria-label', 'จัดการ ' + debt.title);
  heading.append(info, menu);
  const balance = node('div'),
    value = node('div', undefined, 'du-money');
  amount(value, row.balance);
  balance.append(node('p', 'ยอดคงเหลือทั้งหมดของหนี้นี้', 'du-muted'), value);
  const data = node('dl');
  data.append(
    node('dt', 'วันครบกำหนดหนี้'),
    node('dd', debt.due_on ? dateText(debt.due_on) : 'ยังไม่ได้ระบุ'),
    node('dt', 'การแสดงรายการ'),
    node('dd', debt.is_archived ? 'ซ่อนไว้ · ยังรวมในยอดหนี้ทั้งหมด' : 'แสดงในรายการ'),
  );
  box.append(heading, balance, badge(row), actions(row), data);
  if (debt.note) box.append(node('p', debt.note, 'du-muted'));
  return box;
}
function debtRow(row) {
  const debt = row.debt,
    selected = debt.id === state.selected,
    item = node('li', undefined, 'du-item' + (selected ? ' is-selected' : ''));
  item.dataset.debt = debt.id;
  const trigger = button(
    '',
    'select',
    debt.id,
    'du-row' + (money(row.balance).length > 19 ? ' large' : ''),
  );
  trigger.setAttribute('aria-pressed', String(selected));
  trigger.setAttribute('aria-expanded', String(selected));
  trigger.setAttribute('aria-controls', 'debt-inline-' + debt.id);
  const info = node('span', undefined, 'du-row-info'),
    meta = node('span', undefined, 'du-row-meta');
  meta.append(
    badge(row),
    node(
      'span',
      debt.due_on
        ? 'ครบกำหนด ' + dateText(debt.due_on)
        : row.status === 'paid'
          ? 'ไม่มียอดค้าง'
          : 'ยังไม่ได้ระบุวันครบกำหนด',
    ),
  );
  info.append(
    node('h3', debt.title),
    node('span', debt.creditor || 'ไม่ได้ระบุเจ้าหนี้', 'du-row-owner'),
    meta,
  );
  const value = node('span', undefined, 'du-row-value');
  value.append(
    node('span', money(row.balance).replace(/ บาท$/, ''), 'du-number'),
    node('small', 'บาท · ยอดคงเหลือ'),
  );
  trigger.append(info, value);
  const inline = actions(row);
  inline.className = 'du-inline';
  const manage = button('⋯', 'debtMenu', debt.id, 'du-more');
  manage.setAttribute('aria-label', 'จัดการ ' + debt.title);
  inline.append(manage);
  inline.id = 'debt-inline-' + debt.id;
  inline.hidden = !selected;
  item.append(trigger, inline);
  return item;
}
function empty(title, description, clear = false) {
  const box = node('section', undefined, 'du-empty');
  box.append(node('h2', title), node('p', description, 'du-muted'));
  if (!clear) box.append(link('เพิ่มหนี้รายการแรก', 'create-debt.html', 'action-button du-primary'));
  else {
    if (state.status !== 'all') box.append(button('ดูทุกสถานะ', 'clearStatus'));
    box.append(button('ล้างตัวกรองทั้งหมด', 'reset'));
  }
  return box;
}
function results() {
  const target = find('#debt-results');
  target.replaceChildren();
  if (!initialized) return;
  if (!rows.length) {
    target.append(empty('เริ่มจากหนี้รายการแรกของคุณ', 'เพิ่มหนี้เพื่อรวบรวมยอดและติดตามวันครบกำหนด'));
    return;
  }
  const all = matches();
  state.page = Math.max(0, Math.min(state.page, Math.ceil(all.length / state.size) - 1));
  const shown = all.slice(state.page * state.size, (state.page + 1) * state.size);
  if (state.selected && !shown.some((row) => row.debt.id === state.selected))
    state.selected = shown[0]?.debt.id || null;
  if (!all.length) {
    target.append(
      empty(
        state.status === 'late'
          ? (state.category ? 'หมวด ' + categoryName() : 'รายการที่เลือก') + ' ไม่มีหนี้เลยกำหนด'
          : 'ไม่พบหนี้ที่ตรงกับการค้นหา',
        'ลองเปลี่ยนหมวด สถานะ หรือคำค้น',
        true,
      ),
    );
    return;
  }
  const heading = node('header', undefined, 'du-result-label');
  heading.append(
    node('h2', `หนี้ที่แสดง · ${all.length} รายการ`),
    node(
      'p',
      `ยอดผลค้นหา ${money(resultTotal(all))} · ${state.page * state.size + 1}–${Math.min((state.page + 1) * state.size, all.length)}`,
    ),
  );
  const layout = node('div', undefined, 'du-layout'),
    list = node('ul', undefined, 'du-list'),
    panel = node('div', undefined, 'du-detail-panel');
  list.id = 'debt-list';
  list.append(...shown.map(debtRow));
  panel.append(detail(shown.find((row) => row.debt.id === state.selected)));
  layout.append(list, panel);
  const pages = Math.ceil(all.length / state.size),
    pager = node('nav', undefined, 'du-pagination'),
    group = node('div');
  pager.setAttribute('aria-label', 'แบ่งหน้ารายการหนี้');
  const prev = button('ก่อนหน้า', 'page', String(state.page - 1)),
    next = button('ถัดไป', 'page', String(state.page + 1));
  prev.disabled = !state.page;
  next.disabled = state.page + 1 >= pages;
  group.append(prev, node('span', `หน้า ${state.page + 1} / ${pages}`), next);
  const label = node('label', 'ต่อหน้า'),
    size = node('select');
  size.dataset.pageSize = '';
  for (const value of [6, 12, 24]) size.add(new Option(value + ' รายการ', String(value)));
  size.value = String(state.size);
  label.append(size);
  pager.append(group, label);
  target.append(heading, layout, pager);
}
function fitAmounts() {
  root.querySelectorAll('.du-number').forEach((item) => {
    item.style.fontSize = '';
    let size = parseFloat(getComputedStyle(item).fontSize);
    while (item.scrollWidth > item.parentElement.clientWidth && size > 16)
      item.style.fontSize = --size + 'px';
  });
}
function controls() {
  find('#debt-results').setAttribute('aria-busy', String(loading));
  for (const field of root.querySelectorAll(
    '.du-tools input,.du-tools button,.du-tools select,[data-status],[data-status-select],[data-sort]',
  ))
    field.disabled = loading || !initialized;
  find('#refresh').disabled = loading;
}
function paint() {
  statuses();
  filterState();
  results();
  controls();
  fitAmounts();
}

// หน้าต่างใช้เฉพาะเลือกหมวด/เมนู การชำระจริงไปหน้าเดิมที่มี retry/idempotency ครบ
function closeDialog() {
  const modal = root.querySelector('.du-dialog');
  if (modal) {
    modal.close();
    modal.remove();
  }
}
function dialog(title, returnSelector) {
  closeDialog();
  const modal = node('dialog', undefined, 'du-dialog'),
    heading = node('header'),
    caption = node('h2', title),
    cancel = button('ปิด');
  caption.id = 'debt-dialog-title';
  modal.setAttribute('aria-labelledby', caption.id);
  const close = () => {
    closeDialog();
    root.querySelector(returnSelector)?.focus({ preventScroll: true });
  };
  cancel.onclick = close;
  modal.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });
  heading.append(caption, cancel);
  modal.append(heading);
  root.append(modal);
  modal.showModal();
  cancel.focus();
  return modal;
}
function openPicker() {
  const modal = dialog('เลือกหมวดหมู่', '#category-picker'),
    label = node('label', 'ค้นหาหมวดหมู่'),
    input = node('input'),
    count = node('p', undefined, 'du-category-count'),
    list = node('div', undefined, 'du-category-list');
  input.type = 'search';
  input.maxLength = 80;
  input.placeholder = 'เช่น ค่าเรียน เงินยืม';
  input.dataset.categorySearch = '';
  count.setAttribute('role', 'status');
  list.setAttribute('aria-label', 'หมวดหมู่ทั้งหมด');
  const draw = () => {
    const query = normalizeSearch(input.value),
      filtered = categories.filter((row) => normalizeSearch(row.name).includes(query));
    if (!query)
      filtered.sort((a, b) =>
        a.id === state.category
          ? -1
          : b.id === state.category
            ? 1
            : (recent.indexOf(a.id) < 0 ? 99 : recent.indexOf(a.id)) -
              (recent.indexOf(b.id) < 0 ? 99 : recent.indexOf(b.id)),
      );
    list.replaceChildren();
    const all = button('ทุกหมวดหมู่', 'category', '');
    all.setAttribute('aria-pressed', String(!state.category));
    list.append(all);
    for (const row of filtered) {
      const option = button('', 'category', row.id),
        total = rows.filter(
          (entry) =>
            entry.debt.category_id === row.id &&
            entry.debt.is_archived === (state.view === 'archived'),
        ).length;
      option.append(
        node('span', row.name + (recent.includes(row.id) ? ' · ใช้ล่าสุด' : '')),
        node('small', `${total} รายการ`),
      );
      option.setAttribute('aria-pressed', String(state.category === row.id));
      list.append(option);
    }
    if (!filtered.length) list.append(node('p', 'ไม่พบหมวดหมู่ ลองใช้คำสั้นลง', 'du-muted'));
    count.textContent = `พบ ${filtered.length} หมวด · หมวดที่ใช้ล่าสุดอยู่ด้านบน`;
    list.scrollTop = 0;
  };
  input.oninput = draw;
  label.append(input);
  modal.append(label, count, list);
  draw();
  input.focus();
}
function openMenu() {
  const modal = dialog('เมนู', '#debt-menu'),
    menu = node('nav', undefined, 'du-menu-list');
  for (const [href, text] of [
    ['overview.html', 'ภาพรวม'],
    ['index.html', 'รายการหนี้'],
    ['reminders.html', 'แจ้งเตือน'],
    ['export.html', 'ดาวน์โหลด'],
    ['settings.html', 'ตั้งค่า'],
    ['trash.html', 'ถังขยะ'],
  ])
    menu.append(link(text, href, 'plain-button'));
  const refreshButton = button('อัปเดตรายการหนี้', 'reload');
  menu.append(refreshButton);
  modal.append(menu);
}

async function refresh() {
  if (stopped || !service) return;
  if (loading) {
    queued = true;
    return;
  }
  loading = true;
  const current = ++revision,
    isCurrent = () => !stopped && revision === current;
  status(initialized ? 'กำลังอัปเดตข้อมูล…' : 'กำลังโหลดรายการหนี้…');
  controls();
  const [data, summary] = await Promise.allSettled([
    Promise.all([
      service.categories(),
      readDebtScope(service, false, isCurrent),
      readDebtScope(service, true, isCurrent),
    ]),
    workspace.overview(),
  ]);
  if (!isCurrent()) return;
  if (summary.status === 'fulfilled') {
    amount(find('#debt-total'), summary.value.total_due);
    find('#debt-summary-note').textContent =
      `${summary.value.total_debts} รายการทั้งหมด · ยอดผลค้นหาแสดงเหนือรายการด้านล่าง`;
  } else find('#debt-total').textContent = 'โหลดไม่สำเร็จ';
  try {
    if (data.status === 'rejected') throw data.reason;
    const [categoryRows, active, archived] = data.value;
    if (!active || !archived || [...active, ...archived].some((row) => row.debt.user_id !== owner))
      throw new Error('ข้อมูลบัญชีไม่ตรงกัน');
    categories = categoryRows
      .filter(
        (row) => typeof row.name === 'string' && (row.user_id === null || row.user_id === owner),
      )
      .sort((a, b) => a.name.localeCompare(b.name, 'th'));
    rows = debtRows([...active, ...archived], categories);
    initialized = true;
    if (!state.selected) resetPage();
    status(
      summary.status === 'rejected' ? 'โหลดยอดหนี้ทั้งหมดไม่สำเร็จ กดอัปเดตข้อมูลเพื่อลองใหม่' : '',
      summary.status === 'rejected',
    );
  } catch {
    status(
      initialized
        ? 'อัปเดตไม่สำเร็จ กำลังแสดงข้อมูลเดิม กรุณาลองอีกครั้ง'
        : 'โหลดรายการหนี้ไม่สำเร็จ กดอัปเดตข้อมูลเพื่อลองใหม่',
      true,
    );
    if (!initialized) {
      const retry = button('ลองอีกครั้ง', 'reload');
      find('#debt-results').replaceChildren(
        node('p', 'ยังอ่านรายการหนี้ไม่ได้ ไม่ใช่ยอดหนี้เป็นศูนย์', 'du-muted'),
        retry,
      );
    }
  } finally {
    loading = false;
    if (initialized) paint();
    else controls();
    fitAmounts();
    if (queued) {
      queued = false;
      scheduleReload();
    }
  }
}
function scheduleReload() {
  if (stopped) return;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(refresh, 350);
}
function stop() {
  stopped = true;
  revision++;
  clearTimeout(reloadTimer);
  cancelAnimationFrame(resizeFrame);
  closeDialog();
  if (channel) client.removeChannel(channel);
  rows = [];
  categories = [];
  recent = [];
  state.search = '';
  state.selected = null;
  root.replaceChildren();
  root.hidden = true;
}
root.addEventListener('input', (event) => {
  if (event.target.id !== 'search' || loading || !initialized) return;
  state.search = event.target.value;
  resetPage();
  paint();
});
root.addEventListener('change', (event) => {
  if (loading || !initialized) return;
  const field = event.target;
  if (field.id === 'archived') state.view = field.value;
  else if (field.hasAttribute('data-status-select')) state.status = field.value;
  else if (field.hasAttribute('data-sort')) state.sort = field.value;
  else if (field.hasAttribute('data-page-size')) state.size = Number(field.value);
  else return;
  const selector = field.id
    ? '#' + field.id
    : field.hasAttribute('data-sort')
      ? '[data-sort]'
      : field.hasAttribute('data-page-size')
        ? '[data-page-size]'
        : '[data-status-select]';
  resetPage();
  paint();
  find(selector)?.focus({ preventScroll: true });
});
root.addEventListener('click', (event) => {
  if (stopped) return;
  const target = event.target.closest('button');
  if (!target || target.disabled) return;
  if (target.id === 'refresh' || target.hasAttribute('data-reload')) {
    closeDialog();
    refresh();
    return;
  }
  if (target.id === 'debt-menu') {
    openMenu();
    return;
  }
  if (loading || !initialized) return;
  if (target.id === 'category-picker') {
    openPicker();
    return;
  }
  if (target.hasAttribute('data-category')) {
    state.category = target.dataset.category;
    if (state.category)
      recent = [state.category, ...recent.filter((id) => id !== state.category)].slice(0, 3);
    closeDialog();
    resetPage();
    paint();
    find('#category-picker').focus({ preventScroll: true });
    return;
  }
  if (target.hasAttribute('data-select')) {
    state.selected =
      matchMedia('(max-width:1100px)').matches && state.selected === target.dataset.select
        ? null
        : target.dataset.select;
    paint();
    find('[data-select="' + target.dataset.select + '"]').focus({ preventScroll: true });
    return;
  }
  if (target.hasAttribute('data-status')) {
    state.status = target.dataset.status;
    resetPage();
    paint();
    find('[data-status="' + state.status + '"]').focus({ preventScroll: true });
    return;
  }
  if (target.hasAttribute('data-page')) {
    state.page = Number(target.dataset.page);
    state.selected = matches()[state.page * state.size]?.debt.id || null;
    paint();
    find('#debt-results').scrollIntoView({ block: 'start' });
    find('[data-select]')?.focus({ preventScroll: true });
    return;
  }
  if (
    ['clearCategory', 'clearView', 'clearSearch', 'clearStatus', 'reset'].some((key) =>
      Object.hasOwn(target.dataset, key),
    )
  ) {
    if (target.hasAttribute('data-reset'))
      Object.assign(state, { category: '', view: 'active', search: '', status: 'all' });
    if (target.hasAttribute('data-clear-category')) state.category = '';
    if (target.hasAttribute('data-clear-view')) state.view = 'active';
    if (target.hasAttribute('data-clear-search')) state.search = '';
    if (target.hasAttribute('data-clear-status')) state.status = 'all';
    resetPage();
    paint();
    find('#search').focus({ preventScroll: true });
    return;
  }
  if (target.hasAttribute('data-debt-menu')) {
    const row = rows.find((entry) => entry.debt.id === target.dataset.debtMenu);
    if (!row) return;
    const modal = dialog('จัดการ ' + row.debt.title, '[data-select="' + row.debt.id + '"]'),
      menu = node('div', undefined, 'du-menu-list');
    menu.append(link('แก้ไขข้อมูล / ซ่อนรายการ', debtUrl('edit-debt', row.debt.id), 'plain-button'));
    const remove = button('ลบหนี้', 'trash', row.debt.id, 'plain-button danger-button');
    menu.append(remove);
    modal.append(menu);
    return;
  }
  if (target.hasAttribute('data-trash')) {
    const row = rows.find((entry) => entry.debt.id === target.dataset.trash);
    if (!row) return;
    closeDialog();
    confirmTrash({
      client,
      debt: row.debt,
      balance: row.balance,
      canAct: () => !stopped,
      onDone: () => location.assign('trash.html?moved=1'),
    });
  }
});
addEventListener('resize', () => {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(fitAmounts);
});
addEventListener('pagehide', stop, { once: true });
document.addEventListener('dm:clear-private-view', stop, { once: true });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && initialized) scheduleReload();
});
addEventListener('online', scheduleReload);

const ready = await authReady;
if (ready?.session && !stopped) {
  client = ready.client;
  owner = ready.session.user.id;
  service = createDebtService(client);
  workspace = createWorkspaceService(client, owner);
  client.auth.onAuthStateChange((_event, session) => {
    if (!session || session.user.id !== owner) stop();
  });
  await refresh();
  if (!stopped)
    channel = client
      .channel('debt-list-view')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'debts', filter: 'user_id=eq.' + owner },
        scheduleReload,
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'debt_rate_changes', filter: 'user_id=eq.' + owner },
        scheduleReload,
      )
      .on('postgres_changes', { event: '*', schema: 'public', table: 'categories' }, scheduleReload)
      .subscribe();
}
