import { authReady } from '../auth/auth.js';
import { createDebtService, createSubmission } from '../data/debt-service.js';
import {
  createScheduleService,
  schedulePayload,
  allocationPayload,
  cents,
  fromCents,
} from '../data/schedule-service.js';
import { bangkokToday, dateText, money } from '../core/format.js';
import { connectDebtNavigation, debtUrl, protectPendingNavigation } from '../core/navigation.js';
import { readPendingPayment, clearPendingPayment } from '../debts/pending-payment.js';

const $ = (selector) => document.querySelector(selector);
const debtId = new URLSearchParams(location.search).get('id');
const requestedPlan = new URLSearchParams(location.search).get('plan');
const allocationQuery = new URLSearchParams(location.search);
const requestedInstallment = $('#allocation-form') ? allocationQuery.get('installment') : null;
const requestedPayment = requestedInstallment ? allocationQuery.get('payment') : null;
let allocationSuggested = false;
const wantsPlans = Boolean($('#selected-plan'));
const wantsPayments = Boolean($('#allocation-form'));
const wantsBalance = Boolean($('#debt-balance'));
connectDebtNavigation(debtId);
function text(selector, value) {
  const node = $(selector);
  if (node) node.textContent = value;
}
function disable(selector, value) {
  const node = $(selector);
  if (node) node.disabled = value;
}
function hide(selector, value) {
  const node = $(selector);
  if (node) node.hidden = value;
}
let client, service, debtService, channel, ownerId;
let stopped = false,
  busy = false,
  ready = false,
  refreshWanted = false,
  leaving = false;
let epoch = 0,
  availabilityVersion = 0;
let debt = null,
  pending = null,
  available = null;
let plans = [],
  payments = [],
  installments = [];
let planCursor = null,
  paymentCursor = null;
let plansBusy = false,
  paymentsBusy = false;
let reloadTimer,
  dayTimer,
  lastDay = bangkokToday();
const states = { pending: 'รอครบกำหนด', overdue: 'ค้างชำระ', paid: 'จ่ายครบ', cancelled: 'ยกเลิก' };
function status(selector, text, error = false) {
  const node = $(selector);
  if (!node) return;
  node.textContent = text;
  node.dataset.error = String(error);
  node.setAttribute('role', error ? 'alert' : 'status');
}
function errorText(error) {
  if (error.reason === 'Allocation exceeds payment or installment')
    return 'ยอดผูกเกินเงินที่ยังใช้ได้หรือยอดค้างงวด กรุณาโหลดข้อมูลใหม่';
  if (error.reason === 'Invalid installment allocation')
    return 'งวดอาจถูกยกเลิกหรือรายการชำระถูกย้อนแล้ว กรุณาโหลดข้อมูลใหม่';
  if (error.code === '42501' || error.status === 403) return 'ไม่พบข้อมูลหรือไม่มีสิทธิ์เข้าถึงรายการนี้';
  if (error.status === 401 || error.code === 'PGRST301') return 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่';
  if (['22023', '23514', '23505'].includes(error.code))
    return 'ฐานข้อมูลไม่รับรายการนี้ กรุณาตรวจแผน งวด วันที่ และจำนวนเงิน';
  return 'ดำเนินการไม่สำเร็จ กรุณาตรวจอินเทอร์เน็ตแล้วโหลดข้อมูลใหม่';
}
function selectedPlan() {
  return plans.find((row) => row.id === $('#selected-plan')?.value);
}
function selectedPayment() {
  return payments.find((row) => row.id === $('#allocation-payment')?.value);
}
function openInstallments() {
  return installments.filter(
    (row) => row.status !== 'cancelled' && !row.cancelled_at && cents(row.remaining_amount) > 0n,
  );
}
function controls() {
  const editable = ready && !stopped && !busy && !pending;
  const eligible = editable && Boolean(selectedPlan()) && openInstallments().length > 0;
  disable('#schedule-fields', !editable || debt?.is_archived);
  disable('#allocation-fields', !eligible);
  disable(
    '#cancel-schedule-fields',
    !editable ||
      !selectedPlan() ||
      !installments.some((row) => !row.cancelled_at && row.status !== 'cancelled'),
  );
  for (const [kind, selector, allowed, normal] of [
    ['create', '#create-schedule', editable && !debt?.is_archived, 'สร้างแผนชำระ'],
    [
      'allocate',
      '#allocate',
      eligible && available !== null && cents(available) > 0n && Boolean(selectedPayment()),
      requestedInstallment && money($('#allocation-amount')?.value) !== '—'
        ? `ยืนยันยอด ${money($('#allocation-amount').value)}`
        : 'ยืนยันผูกยอดกับงวด',
    ],
    [
      'cancel',
      '#cancel-schedule',
      editable &&
        Boolean(selectedPlan()) &&
        installments.some((row) => !row.cancelled_at && row.status !== 'cancelled'),
      'ยืนยันยกเลิกแผนที่เลือก',
    ],
  ]) {
    disable(selector, stopped || busy || (pending ? pending.kind !== kind : !allowed));
    text(
      selector,
      busy && pending?.kind === kind
        ? 'กำลังบันทึก…'
        : pending?.kind === kind
          ? 'ส่งคำขอเดิมอีกครั้ง'
          : normal,
    );
  }
  disable('#selected-plan', !editable || !plans.length);
  disable('#more-plans', stopped || busy || Boolean(pending) || plansBusy || !ready);
  disable('#more-payments', stopped || busy || Boolean(pending) || paymentsBusy || !eligible);
  hide('#edit-schedule-mutation', stopped || busy || !pending?.canEdit);
  for (const form of ['#schedule-form', '#allocation-form', '#cancel-schedule-form'])
    $(form)?.setAttribute('aria-busy', String(busy));
}
function options(selector, rows, label, empty, selected) {
  const select = $(selector);
  if (!select) return;
  select.replaceChildren(new Option(empty, ''));
  for (const row of rows) select.add(new Option(label(row), row.id));
  if (rows.some((row) => row.id === selected)) select.value = selected;
}
function planOptions(selected) {
  options(
    '#selected-plan',
    plans,
    (row) =>
      `เริ่ม ${dateText(row.first_due_on)} · ${row.installment_count} งวด × ${money(row.installment_amount)} · ${row.id.slice(0, 8)}`,
    'เลือกแผนชำระ',
    selected,
  );
}
function paymentOptions(selected) {
  options(
    '#allocation-payment',
    payments,
    (row) => `${dateText(row.occurred_on)} · ชำระ ${money(row.amount)} · ${row.id.slice(0, 8)}`,
    'เลือกรายการชำระ',
    selected,
  );
}
function renderInstallments() {
  const filter = $('#installment-filter')?.value || 'all';
  const partial = (row) =>
    row.status !== 'cancelled' &&
    !row.cancelled_at &&
    cents(row.paid_amount) > 0n &&
    cents(row.remaining_amount) > 0n;
  $('#installment-rows')?.replaceChildren();
  const visible = installments.filter(
    (row) => filter === 'all' || (filter === 'partial' ? partial(row) : row.status === filter),
  );
  hide('#installment-empty', visible.length > 0);
  text(
    '#installment-empty',
    installments.length
      ? 'ไม่มีงวดในสถานะที่เลือก'
      : 'ยังไม่มีงวดในแผนนี้ เลือกแผนอื่นหรือกด “สร้างแผน” เพื่อเริ่มติดตาม',
  );
  if ($('#installment-rows'))
    for (const row of visible) {
      const tr = document.createElement('tr');
      tr.setAttribute('role', 'row');
      const label = `${partial(row) ? 'จ่ายบางส่วน · ' : ''}${states[row.status]}`;
      const labels = ['งวด', 'ครบกำหนด', 'ยอดงวด', 'ชำระแล้ว', 'คงเหลือ', 'สถานะ'];
      for (const [index, value] of [
        String(row.installment_no),
        dateText(row.due_on),
        money(row.amount),
        money(row.paid_amount),
        money(row.remaining_amount),
        label,
      ].entries()) {
        const td = document.createElement('td');
        td.setAttribute('role', 'cell');
        td.dataset.label = labels[index];
        td.textContent = value;
        tr.append(td);
      }
      tr.className = `status-${row.status}`;
      $('#installment-rows').append(tr);
    }
  text(
    '#installment-summary',
    installments.length
      ? `ทั้งหมด ${installments.length} งวด · จ่ายครบ ${installments.filter((row) => row.status === 'paid').length} · จ่ายบางส่วน ${installments.filter(partial).length} · ค้างชำระ ${installments.filter((row) => row.status === 'overdue').length} · แสดง ${visible.length} งวด`
      : 'ยังไม่มีงวดในแผนที่เลือก',
  );
}
async function loadAvailable(current = epoch) {
  const revision = ++availabilityVersion;
  available = null;
  const payment = selectedPayment();
  status('#payment-available', payment ? 'กำลังตรวจยอดที่ยังผูกได้…' : 'เลือกรายการเพื่อดูยอดที่ยังผูกได้');
  controls();
  if (!wantsPayments || !payment) return;
  try {
    const result = await service.available(debtId, payment);
    if (stopped || current !== epoch || revision !== availabilityVersion) return;
    available = result;
    status('#payment-available', `ยังผูกได้ ${money(result)} ณ ข้อมูลล่าสุด (รวมการผูกในทุกแผนแล้ว)`);
  } catch (error) {
    if (!stopped && current === epoch && revision === availabilityVersion)
      status('#payment-available', errorText(error), true);
  } finally {
    if (!stopped && current === epoch && revision === availabilityVersion) controls();
  }
  if (requestedInstallment && !allocationSuggested && available !== null) {
    const target = openInstallments().find((row) => row.id === requestedInstallment);
    if (target) {
      $('#allocation-installment').value = target.id;
      $('#allocation-amount').value = fromCents(
        cents(available) < cents(target.remaining_amount)
          ? cents(available)
          : cents(target.remaining_amount),
      );
      allocationSuggested = true;
      controls();
      hide('#guided-allocation-context', false);
      text(
        '#guided-allocation-context',
        `ขั้นที่ 2 จาก 2 · ${debt.title} · งวดที่ ${target.installment_no} ครบกำหนด ${dateText(target.due_on)} · ตรวจยอดด้านล่างแล้วกดยืนยัน`,
      );
    } else
      status(
        '#schedule-status',
        'งวดที่เลือกชำระครบหรือถูกยกเลิกแล้ว รายการชำระบันทึกไว้แล้ว ตรวจรายการและเลือกงวดค้างที่ต้องการ',
        true,
      );
  }
}
async function loadPlan(current) {
  ready = false;
  available = null;
  installments = [];
  $('#installment-rows')?.replaceChildren();
  text('#installment-summary', 'กำลังโหลดงวด…');
  controls();
  const plan = selectedPlan();
  const previous = $('#allocation-installment')?.value;
  const rows = plan ? await service.installments(debtId, plan.id) : [];
  if (stopped || current !== epoch) return;
  if (plan && rows.length !== plan.installment_count) throw new Error('จำนวนงวดที่อ่านได้ไม่ครบ');
  installments = rows;
  options(
    '#allocation-installment',
    openInstallments(),
    (row) =>
      `งวด ${row.installment_no} · ${dateText(row.due_on)} · ค้าง ${money(row.remaining_amount)}`,
    'เลือกงวดค้าง',
    previous,
  );
  $('#cancel-schedule-form')?.reset();
  renderInstallments();
  ready = true;
  controls();
  connectDebtNavigation(debtId, selectedPlan()?.id || requestedPlan);
  status(
    '#schedule-status',
    debt.is_archived
      ? 'หนี้ถูกซ่อนไว้ จึงสร้างแผนใหม่ไม่ได้ แต่ยังดูงวดและจัดสรรยอดเดิมได้'
      : wantsPlans && !plans.length
        ? 'ยังไม่มีแผน กด + สร้างแผน เพื่อเริ่มติดตามงวด'
        : '',
  );
  await loadAvailable(current);
}
async function refresh(preferredPlan = null) {
  if (stopped || !service) return;
  if (busy) {
    refreshWanted = true;
    return;
  }
  const current = ++epoch;
  const oldPlan = preferredPlan || $('#selected-plan')?.value || requestedPlan;
  const oldPayment = $('#allocation-payment')?.value || requestedPayment;
  ready = false;
  available = null;
  installments = [];
  text('#debt-balance', '—');
  $('#installment-rows')?.replaceChildren();
  text('#installment-summary', '');
  status('#schedule-status', 'กำลังโหลดข้อมูล…');
  controls();
  try {
    const [newDebt, balance, newPlans, newPayments] = await Promise.all([
      debtService.debt(debtId),
      wantsBalance ? debtService.balance(debtId) : null,
      wantsPlans ? service.plans(debtId) : [],
      wantsPayments ? service.payments(debtId) : [],
    ]);
    if (stopped || current !== epoch) return;
    // รักษาแผน/รายการเก่าที่เลือกไว้ แม้จะไม่ได้อยู่ในหน้าแรกหลัง refresh
    const [extraPlan, extraPayment] = await Promise.all([
      wantsPlans && oldPlan && !newPlans.some((row) => row.id === oldPlan)
        ? service.plan(debtId, oldPlan)
        : null,
      wantsPayments && oldPayment && !newPayments.some((row) => row.id === oldPayment)
        ? service.payment(debtId, oldPayment)
        : null,
    ]);
    if (stopped || current !== epoch) return;
    debt = newDebt;
    plans = newPlans;
    payments = newPayments;
    planCursor = newPlans.at(-1) ?? null;
    paymentCursor = newPayments.at(-1)?.event_seq ?? null;
    hide('#more-plans', newPlans.length < 25);
    hide('#more-payments', newPayments.length < 25);
    if (extraPlan && extraPlan.id === oldPlan && extraPlan.debt_id === debtId)
      plans.push(extraPlan);
    if (extraPayment && extraPayment.id === oldPayment && extraPayment.debt_id === debtId)
      payments.push(extraPayment);
    text('#schedule-title', debt.title);
    text('#debt-title', debt.title);
    text('#debt-balance', money(balance?.total_due));
    planOptions(plans.some((row) => row.id === oldPlan) ? oldPlan : plans[0]?.id);
    paymentOptions(oldPayment);
    await loadPlan(current);
  } catch (error) {
    if (!stopped && current === epoch) {
      ready = false;
      available = null;
      status('#schedule-status', errorText(error), true);
      text('#installment-summary', 'ยังโหลดงวดไม่สำเร็จ กรุณาโหลดข้อมูลใหม่');
      controls();
    }
  }
}
function scheduleRefresh() {
  if (!service || stopped) return;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => refresh(), 350);
}
async function mutate(kind, form) {
  if (stopped || busy || !service || (pending && pending.kind !== kind)) return;
  if (!pending) {
    if (!ready || !form.reportValidity()) return;
    try {
      const values = Object.fromEntries(new FormData(form));
      let payload;
      if (kind === 'create') {
        if (debt.is_archived) return;
        payload = schedulePayload(debtId, values);
      } else if (kind === 'allocate') {
        payload = allocationPayload(values);
        const target = openInstallments().find((row) => row.id === values.installment_id);
        if (!target || selectedPayment()?.id !== values.event_id || available === null)
          throw new Error('เลือกรายการชำระและงวดที่ยังค้าง');
        if (
          cents(payload.p_amount) > cents(available) ||
          cents(payload.p_amount) > cents(target.remaining_amount)
        )
          throw new Error('จำนวนเงินเกินยอดชำระที่ยังผูกได้หรือยอดค้างงวด');
      } else {
        if (!selectedPlan() || !values.confirmed) return;
        payload = { p_schedule_id: selectedPlan().id };
      }
      pending = {
        kind,
        canEdit: false,
        submission: createSubmission(
          {
            create: { create: service.create, allocate: service.allocate, cancel: service.cancel }[
              kind
            ],
          },
          payload,
        ),
      };
    } catch (error) {
      status('#schedule-mutation-status', error.message, true);
      return;
    }
  }
  busy = true;
  pending.canEdit = false;
  controls();
  status('#schedule-mutation-status', 'กำลังบันทึก…');
  let success = false,
    preferred = null;
  try {
    const result = await pending.submission.send();
    if (stopped) return;
    success = true;
    pending = null;
    if (kind === 'allocate') {
      const saved = readPendingPayment(ownerId, debtId);
      if (saved?.eventId === selectedPayment()?.id)
        clearPendingPayment(ownerId, debtId, saved.requestId);
    }
    if (kind === 'allocate' && requestedInstallment) {
      busy = false;
      ready = false;
      leaving = true;
      location.assign('overview.html');
      return;
    }
    if (kind === 'create') preferred = result.id;
    const standaloneCreate =
      kind === 'create' && !$('#allocation-form') && !$('#cancel-schedule-form');
    const standaloneCancel = kind === 'cancel' && !$('#schedule-form') && !$('#allocation-form');
    if (standaloneCreate || standaloneCancel) {
      const targetPlan = standaloneCreate ? result.id : selectedPlan()?.id;
      busy = false;
      ready = false;
      leaving = true;
      location.assign(debtUrl('schedules', debtId, targetPlan));
      return;
    }
    form.reset();
    if (kind === 'create' && $('#first-due')) $('#first-due').value = bangkokToday();
    status(
      '#schedule-mutation-status',
      {
        create: 'สร้างแผนสำเร็จแล้ว',
        allocate: 'ผูกยอดชำระสำเร็จแล้ว โดยไม่หักยอดหนี้ซ้ำ',
        cancel: 'ยกเลิกงวดและการเตือนของแผนแล้ว ยอดหนี้และรายการชำระยังคงอยู่',
      }[kind],
    );
  } catch (error) {
    if (stopped) return;
    pending.canEdit = error.uncertain === false;
    status(
      '#schedule-mutation-status',
      error.uncertain === false
        ? errorText(error)
        : 'ยังยืนยันผลไม่ได้ กรุณาส่งคำขอเดิมอีกครั้ง อย่าปิดหรือรีโหลดหน้าจนกว่าจะทราบผล',
      true,
    );
  } finally {
    busy = false;
    if (!stopped && !leaving) {
      controls();
      if (success || refreshWanted) {
        refreshWanted = false;
        await refresh(preferred);
      }
    }
  }
}
function stop() {
  stopped = true;
  ready = false;
  epoch++;
  availabilityVersion++;
  clearTimeout(reloadTimer);
  clearInterval(dayTimer);
  debt = null;
  pending = null;
  available = null;
  plans = [];
  payments = [];
  installments = [];
  text('#guided-allocation-context', '');
  for (const selector of ['#schedule-form', '#allocation-form', '#cancel-schedule-form'])
    $(selector)?.reset();
  for (const selector of [
    '#selected-plan',
    '#allocation-payment',
    '#allocation-installment',
    '#installment-rows',
  ])
    $(selector)?.replaceChildren();
  for (const selector of [
    '#schedule-title',
    '#debt-title',
    '#installment-summary',
    '#payment-available',
  ])
    text(selector, '');
  text('#debt-balance', '—');
  for (const selector of ['#schedule-status', '#schedule-mutation-status']) status(selector, '');
  controls();
  if (channel) {
    client.removeChannel(channel);
    channel = null;
  }
}
for (const [kind, selector] of [
  ['create', '#schedule-form'],
  ['allocate', '#allocation-form'],
  ['cancel', '#cancel-schedule-form'],
]) {
  $(selector)?.addEventListener('submit', (event) => {
    event.preventDefault();
    mutate(kind, event.currentTarget);
  });
}
$('#refresh-schedules')?.addEventListener('click', () => refresh());
$('#installment-filter')?.addEventListener('change', renderInstallments);
$('#allocation-payment')?.addEventListener('change', () => loadAvailable());
$('#allocation-amount')?.addEventListener('input', controls);
$('#selected-plan')?.addEventListener('change', async () => {
  if (busy || pending || stopped || !service) return;
  const current = ++epoch;
  try {
    await loadPlan(current);
  } catch (error) {
    if (!stopped && current === epoch) {
      ready = false;
      status('#schedule-status', errorText(error), true);
      controls();
    }
  }
});
$('#edit-schedule-mutation')?.addEventListener('click', () => {
  if (busy || stopped || !pending?.canEdit) return;
  pending = null;
  status('#schedule-mutation-status', 'แก้ไขข้อมูลแล้วส่งใหม่ได้');
  controls();
});
$('#more-plans')?.addEventListener('click', async () => {
  if (!ready || stopped || busy || pending || plansBusy || !planCursor) return;
  const current = epoch;
  const selected = $('#selected-plan')?.value;
  plansBusy = true;
  controls();
  try {
    const rows = await service.plans(debtId, planCursor);
    if (stopped || current !== epoch) return;
    planCursor = rows.at(-1) ?? null;
    for (const row of rows) if (!plans.some((plan) => plan.id === row.id)) plans.push(row);
    planOptions(selected);
    hide('#more-plans', rows.length < 25);
  } catch (error) {
    if (!stopped && current === epoch) status('#schedule-status', errorText(error), true);
  } finally {
    plansBusy = false;
    controls();
  }
});
$('#more-payments')?.addEventListener('click', async () => {
  if (!ready || stopped || busy || pending || paymentsBusy || !paymentCursor) return;
  const current = epoch;
  paymentsBusy = true;
  controls();
  try {
    const rows = await service.payments(debtId, paymentCursor);
    if (stopped || current !== epoch) return;
    paymentCursor = rows.at(-1)?.event_seq ?? null;
    for (const row of rows)
      if (!payments.some((payment) => payment.id === row.id)) payments.push(row);
    paymentOptions($('#allocation-payment')?.value);
    hide('#more-payments', rows.length < 25);
  } catch (error) {
    if (!stopped && current === epoch) status('#schedule-status', errorText(error), true);
  } finally {
    paymentsBusy = false;
    controls();
  }
});
protectPendingNavigation(
  () => busy || Boolean(pending && !pending.canEdit),
  '#schedule-mutation-status',
);
addEventListener('pagehide', stop);
addEventListener('online', scheduleRefresh);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) scheduleRefresh();
});
const auth = await authReady;
if (auth?.session && !stopped) {
  client = auth.client;
  ownerId = auth.session.user.id;
  client.auth.onAuthStateChange((_event, session) => {
    if (!session || session.user.id !== ownerId) stop();
  });
  if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(debtId ?? ''))
    status('#schedule-status', 'ลิงก์หนี้ไม่ถูกต้อง กรุณากลับไปเลือกรายการหนี้', true);
  else {
    service = createScheduleService(client, ownerId);
    debtService = createDebtService(client);
    connectDebtNavigation(debtId);
    if ($('#first-due')) $('#first-due').value = bangkokToday();
    await refresh();
    if (!stopped) {
      channel = client.channel(`installments-${debtId}`);
      for (const table of [
        'payment_schedules',
        'installments',
        'installment_allocations',
        'debt_events',
        'debt_rate_changes',
      ]) {
        channel = channel.on(
          'postgres_changes',
          { event: '*', schema: 'public', table, filter: `debt_id=eq.${debtId}` },
          scheduleRefresh,
        );
      }
      channel
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'debts', filter: `id=eq.${debtId}` },
          scheduleRefresh,
        )
        .subscribe((state) => {
          if (state === 'SUBSCRIBED') scheduleRefresh();
        });
      dayTimer = setInterval(() => {
        const day = bangkokToday();
        if (day !== lastDay) {
          lastDay = day;
          scheduleRefresh();
        }
      }, 30000);
    }
  }
}
