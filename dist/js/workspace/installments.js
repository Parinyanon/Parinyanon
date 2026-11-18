import { authReady } from '../auth/auth.js';
import { createWorkspaceService } from '../data/workspace-service.js';
import { installmentEntry } from '../core/installment-entry.js';
import { bangkokToday } from '../core/format.js';
const $ = (selector) => document.querySelector(selector);
let service,
  rows = [],
  page = 0,
  revision = 0,
  stopped = false,
  loading = false;
const size = 10;
function render() {
  const pages = Math.max(1, Math.ceil(rows.length / size));
  page = Math.min(page, pages - 1);
  $('#installments-list').replaceChildren(
    ...rows
      .slice(page * size, (page + 1) * size)
      .map((row) => installmentEntry(row, bangkokToday())),
  );
  $('#installments-prev').disabled = stopped || loading || page === 0;
  $('#installments-next').disabled = stopped || loading || page >= pages - 1;
  $('#installments-page').textContent = rows.length ? `หน้า ${page + 1} / ${pages}` : '';
  $('.installments-pagination').hidden = !rows.length;
}
async function load() {
  if (stopped || !service) return;
  const current = ++revision;
  loading = true;
  $('#installments-refresh').disabled = true;
  $('#installments-list').replaceChildren();
  $('#installments-status').textContent = 'กำลังโหลดงวดชำระ…';
  $('.installments-pagination').hidden = true;
  try {
    const result = await service.paymentOverview();
    if (stopped || current !== revision) return;
    rows = result.installments;
    $('#installments-status').textContent = rows.length
      ? `มี ${rows.length} งวดที่ยังชำระไม่ครบ`
      : 'ไม่มีงวดที่ต้องชำระในขณะนี้';
    loading = false;
    render();
  } catch {
    if (!stopped && current === revision)
      $('#installments-status').textContent = 'โหลดงวดชำระไม่สำเร็จ กดอัปเดตข้อมูลเพื่อลองใหม่';
  } finally {
    if (!stopped && current === revision) {
      loading = false;
      $('#installments-refresh').disabled = false;
    }
  }
}
$('#installments-refresh').addEventListener('click', load);
for (const [id, direction] of [
  ['#installments-prev', -1],
  ['#installments-next', 1],
])
  $(id).addEventListener('click', () => {
    if (stopped || loading) return;
    page += direction;
    render();
    $('#installments-list a')?.focus();
  });
function stop() {
  stopped = true;
  revision++;
  rows = [];
  $('#installments-list').replaceChildren();
  $('#installments-status').textContent = '';
  $('.installments-pagination').hidden = true;
}
addEventListener('pagehide', stop);
addEventListener('online', load);
const auth = await authReady;
if (auth?.session && !stopped) {
  service = createWorkspaceService(auth.client, auth.session.user.id);
  auth.client.auth.onAuthStateChange((_event, session) => {
    if (!session || session.user.id !== auth.session.user.id) stop();
  });
  await load();
}
