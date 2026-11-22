import { authReady } from '../auth/auth.js';
import { createTrashService, trashError } from '../data/trash-service.js';
import { debtUrl } from '../core/navigation.js';
const list = document.querySelector('#trash-list'),
  status = document.querySelector('#trash-status');
const prev = document.querySelector('#trash-prev'),
  next = document.querySelector('#trash-next');
let justMoved = new URLSearchParams(location.search).has('moved');
let stopped = false,
  busy = false,
  version = 0,
  service,
  rows = [],
  pages = [null],
  page = 0;
const el = (tag, text, cls) => {
  const n = document.createElement(tag);
  n.textContent = text;
  if (cls) n.className = cls;
  return n;
};
const time = (value) =>
  new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeZone: 'Asia/Bangkok' }).format(
    new Date(value),
  );
function recordIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.6',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  }))
    svg.setAttribute(key, value);
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute(
    'd',
    'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z M14 3v6h6 M8 13h8 M8 17h5',
  );
  svg.append(path);
  return svg;
}
function controls() {
  prev.disabled = stopped || busy || page === 0;
  next.disabled = stopped || busy || rows.length < 25;
  document.querySelector('.trash-pagination').hidden = !busy && page === 0 && rows.length < 25;
  for (const b of list.querySelectorAll('button'))
    b.disabled = stopped || busy || b.dataset.expired === 'true';
}
function stop() {
  stopped = true;
  version++;
  rows = [];
  list.replaceChildren();
  document.querySelector('#trash-empty').hidden = true;
  document.querySelector('#trash-count').textContent = '';
  status.textContent = '';
  document.querySelector('#purge-dialog')?.close();
  document.querySelector('#purge-dialog')?.remove();
  controls();
}
async function restore(row) {
  if (stopped || busy) return;
  busy = true;
  controls();
  status.textContent = 'กำลังกู้คืน…';
  try {
    await service.restore(row);
    if (!stopped) location.href = debtUrl('debt-detail', row.debt_id);
  } catch (error) {
    if (!stopped) status.textContent = trashError(error);
  } finally {
    busy = false;
    controls();
  }
}
function purge(row) {
  if (stopped || busy || document.querySelector('#purge-dialog')) return;
  const d = document.createElement('dialog');
  d.id = 'purge-dialog';
  d.className = 'trash-dialog';
  const h = el('h2', 'ลบหนี้ถาวร');
  h.id = 'purge-title';
  d.setAttribute('aria-labelledby', h.id);
  const info = el('p', `พิมพ์ชื่อ “${row.title}” เพื่อยืนยัน หนี้และประวัติในถังขยะจะกู้คืนผ่านแอปไม่ได้`);
  const label = el('label', 'ชื่อหนี้ที่ต้องการลบถาวร');
  label.htmlFor = 'purge-confirm';
  const input = document.createElement('input');
  input.id = 'purge-confirm';
  input.maxLength = 150;
  input.autocomplete = 'off';
  const message = el('p', '');
  message.setAttribute('role', 'status');
  const actions = el('div', '', 'trash-actions');
  const cancel = el('button', 'ยกเลิก', 'plain-button');
  cancel.type = 'button';
  const submit = el('button', 'ลบถาวร', 'plain-button danger-button');
  submit.type = 'button';
  submit.disabled = true;
  input.oninput = () => {
    submit.disabled = input.value !== row.title || busy;
  };
  const close = () => {
    d.close();
    d.remove();
  };
  cancel.onclick = close;
  d.addEventListener('cancel', (event) => {
    event.preventDefault();
    if (!busy) close();
  });
  submit.onclick = async () => {
    if (busy || stopped || input.value !== row.title) return;
    busy = true;
    controls();
    submit.disabled = cancel.disabled = input.disabled = true;
    try {
      await service.purge(row);
      if (stopped) return;
      close();
      busy = false;
      await load();
    } catch (error) {
      if (!stopped) message.textContent = trashError(error);
    } finally {
      busy = false;
      controls();
      cancel.disabled = input.disabled = false;
      submit.disabled = input.value !== row.title;
    }
  };
  actions.append(cancel, submit);
  d.append(h, info, label, input, message, actions);
  document.body.append(d);
  d.showModal();
  cancel.focus();
}
async function load() {
  const current = ++version;
  busy = true;
  controls();
  list.replaceChildren();
  document.querySelector('#trash-empty').hidden = true;
  document.querySelector('#trash-count').textContent = 'กำลังโหลด…';
  status.dataset.error = 'false';
  status.textContent = 'กำลังโหลดถังขยะ…';
  try {
    const data = await service.list(pages[page]);
    if (stopped || current !== version) return;
    rows = data;
    for (const row of rows) {
      const item = el('li', '', 'trash-item');
      const h = el('h2', row.title);
      const expired = Date.now() >= Date.parse(row.expires_at);
      const days = Math.ceil((Date.parse(row.expires_at) - Date.now()) / 86400000);
      const icon = el('span', '', 'trash-record-icon');
      icon.append(recordIcon());
      const copy = el('div', '', 'trash-record-copy');
      const badge = el(
        'span',
        expired ? 'พ้นเวลากู้คืน' : days <= 1 ? 'เหลือน้อยกว่า 1 วัน' : `เหลือประมาณ ${days} วัน`,
        'trash-expiry',
      );
      badge.dataset.state = expired ? 'expired' : days <= 3 ? 'soon' : 'available';
      const detail = el(
        'p',
        `ลบเมื่อ ${time(row.deleted_at)} · ${expired ? 'พ้นเวลากู้คืนแล้ว' : `กู้คืนได้ถึง ${time(row.expires_at)}`}`,
        'small',
      );
      const actions = el('div', '', 'trash-actions');
      const undo = el('button', 'กู้คืน', 'plain-button trash-restore');
      undo.type = 'button';
      undo.setAttribute('aria-label', `กู้คืนหนี้ ${row.title}`);
      undo.dataset.expired = String(expired);
      undo.onclick = () => restore(row);
      const remove = el('button', 'ลบถาวร', 'plain-button danger-button trash-purge');
      remove.type = 'button';
      remove.setAttribute('aria-label', `ลบหนี้ ${row.title} ถาวร`);
      remove.onclick = () => purge(row);
      actions.append(undo, remove);
      copy.append(h, detail);
      const side = el('div', '', 'trash-record-side');
      side.append(badge, actions);
      item.append(icon, copy, side);
      list.append(item);
    }
    status.textContent = rows.length
      ? justMoved && page === 0
        ? 'ย้ายหนี้ไปถังขยะแล้ว กดกู้คืนเพื่อเลิกทำ'
        : `ถังขยะ · หน้า ${page + 1}`
      : 'ถังขยะว่าง ไม่มีหนี้ที่ถูกลบ';
    justMoved = false;
    document.querySelector('#trash-count').textContent = `${rows.length} รายการในหน้านี้`;
    document.querySelector('#trash-page-number').textContent = `หน้า ${page + 1}`;
    document.querySelector('#trash-empty').hidden = rows.length > 0;
  } catch (error) {
    if (!stopped && current === version) {
      rows = [];
      document.querySelector('#trash-count').textContent = 'โหลดไม่สำเร็จ';
      status.dataset.error = 'true';
      status.textContent = trashError(error);
    }
  } finally {
    if (!stopped && current === version) {
      busy = false;
      controls();
    }
  }
}
prev.onclick = () => {
  if (!busy && page > 0) {
    page--;
    load();
  }
};
next.onclick = () => {
  if (!busy && rows.length === 25) {
    const last = rows.at(-1);
    pages[++page] = { deleted_at: last.deleted_at, id: last.id };
    load();
  }
};
addEventListener('pagehide', stop);
const ready = await authReady;
if (ready?.session && !stopped) {
  const owner = ready.session.user.id;
  service = createTrashService(ready.client);
  ready.client.auth.onAuthStateChange((_event, session) => {
    if (!session || session.user.id !== owner) stop();
  });
  await load();
}
