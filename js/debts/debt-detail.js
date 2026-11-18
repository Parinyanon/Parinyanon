import { authReady } from '../auth/auth.js';
import {
  createDebtService,
  createSubmission,
  paymentPayload,
  voidPayload,
  ratePayload,
} from '../data/debt-service.js';
import { bangkokToday, dateText, money } from '../core/format.js';
import {
  connectDebtNavigation,
  debtUrl,
  installmentPaymentUrl,
  protectPendingNavigation,
} from '../core/navigation.js';
import { createScheduleService, cents, fromCents } from '../data/schedule-service.js';
import {
  readPendingPayment,
  rememberPendingPayment,
  clearPendingPayment,
} from './pending-payment.js';

const $ = (selector) => document.querySelector(selector);
const debtId = new URLSearchParams(location.search).get('id');
const paymentQuery = new URLSearchParams(location.search);
const requestedInstallment = $('#payment-form') ? paymentQuery.get('installment') : null;
const requestedPaymentPlan = paymentQuery.get('plan');
let installmentService,
  paymentInstallment = null,
  amountSuggested = false;
const kinds = { payment: 'ชำระหนี้', fee: 'ค่าธรรมเนียม', tax: 'ภาษี' };
const periods = { year: 'ปี', month: 'เดือน', day: 'วัน' };
const wantsHistory = Boolean($('#history'));
const wantsRates = Boolean($('#current-rate') || $('#rates-history') || $('#rate-form'));
const wantsBalance = Boolean($('#total-due'));
const wantsLatest = Boolean($('#void-form'));
let service, client, channel, ownerId;
let stopped = false,
  busy = false,
  refreshWanted = false,
  leaving = false;
let version = 0,
  snapshot = null,
  pending = null;
let reloadTimer,
  dayTimer,
  historyCursor = null,
  rateCursor = null;
let historyBusy = false,
  ratesBusy = false,
  lastDay = bangkokToday();
let resumedRequestId = null,
  recoveryChecking = false,
  recoveredPayment = false;
const historyIds = new Set(),
  rateIds = new Set();
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
function empty(selector) {
  $(selector)?.replaceChildren();
}
function status(selector, value, error = false) {
  const node = $(selector);
  if (!node) return;
  node.textContent = value;
  node.dataset.error = String(error);
  node.setAttribute('role', error ? 'alert' : 'status');
}
connectDebtNavigation(debtId);
status('#mutation-status', '');
function errorText(error) {
  const reasons = {
    'Payment exceeds total due': 'ยอดชำระเกินยอดค้าง ณ วันที่เลือก กรุณาตรวจจำนวนเงินและวันที่',
    'Only latest active event can be voided': 'มีรายการใหม่กว่าแล้ว กรุณาโหลดข้อมูลใหม่และตรวจรายการล่าสุด',
    'Debt is archived': 'หนี้นี้ถูกซ่อนไว้ จึงยังบันทึกชำระไม่ได้',
    'Unarchive debt before correction': 'ต้องยกเลิกการซ่อนหนี้ก่อนย้อนรายการ',
    'Event already voided': 'รายการนี้ถูกย้อนแล้ว กรุณาโหลดข้อมูลใหม่',
    'Request ID reused or voided': 'รายการเดิมเปลี่ยนสถานะแล้ว กรุณาโหลดข้อมูลใหม่เพื่อตรวจสอบ',
    'Invalid rate/date; cannot change settled history':
      'วันที่มีผลต้องไม่เก่ากว่าวันยอดที่ยืนยันล่าสุดและไม่ใช่อนาคต กรุณาตรวจอัตราและวันที่อีกครั้ง',
  };
  if (reasons[error.reason]) return reasons[error.reason];
  if (error.code === '42501' || error.status === 403) return 'ไม่พบรายการหรือไม่มีสิทธิ์เข้าถึงข้อมูลนี้';
  if (error.status === 401 || error.code === 'PGRST301') return 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่';
  if (error.code === '23505') return 'มีรายการสำหรับวันที่นี้หรือรหัสคำขอนี้แล้ว กรุณาตรวจประวัติและเลือกวันที่อื่น';
  if (error.code === '22023' || error.code === '23514')
    return 'ฐานข้อมูลไม่รับข้อมูลนี้ กรุณาตรวจยอด วันที่ และรายการล่าสุด';
  return 'โหลดหรือบันทึกไม่สำเร็จ กรุณาตรวจอินเทอร์เน็ตแล้วลองใหม่';
}
function updateControls() {
  const editable = !stopped && !busy && !pending && snapshot && !snapshot.debt.is_archived;
  const payable =
    editable && !recoveryChecking && !recoveredPayment && Number(snapshot.balance?.total_due) > 0;
  hide('#payment-form', recoveredPayment && !pending);
  hide('#payment-entry-panel', recoveredPayment && !pending);
  disable('#payment-fields', !payable);
  disable('#void-fields', !editable || !snapshot?.latest);
  disable('#rate-fields', !editable || snapshot?.debt.interest_method !== 'simple_daily');
  for (const [kind, selector, allowed, label] of [
    [
      'payment',
      '#pay',
      payable && (!requestedInstallment || paymentInstallment),
      requestedInstallment ? 'บันทึกและไปยืนยันงวด' : 'บันทึกชำระ',
    ],
    ['void', '#void-event', editable && snapshot?.latest, 'ยืนยันย้อนรายการล่าสุด'],
    [
      'rate',
      '#change-rate',
      editable && snapshot?.debt.interest_method === 'simple_daily',
      'บันทึกอัตราใหม่',
    ],
  ]) {
    disable(selector, stopped || busy || (pending ? pending.kind !== kind : !allowed));
    text(
      selector,
      busy && pending?.kind === kind
        ? 'กำลังบันทึก…'
        : pending?.kind === kind
          ? 'ส่งคำขอเดิมอีกครั้ง'
          : label,
    );
  }
  hide('#edit-mutation', stopped || busy || !pending?.canEdit);
  disable('#payment-recovery-check', stopped || busy || recoveryChecking || Boolean(pending));
  disable(
    '#payment-recovery-new',
    !editable || recoveryChecking || !(Number(snapshot?.balance?.total_due) > 0),
  );
  disable('#more-history', historyBusy || !snapshot || stopped);
  disable('#more-rates', ratesBusy || !snapshot || stopped);
  for (const form of ['#payment-form', '#void-form', '#rate-form'])
    $(form)?.setAttribute('aria-busy', String(busy));
}
async function restorePayment() {
  if (!$('#payment-form') || !service || stopped || busy || pending || recoveryChecking) return;
  const saved = readPendingPayment(ownerId, debtId);
  if (!saved) return;
  resumedRequestId = saved.requestId;
  recoveryChecking = true;
  recoveredPayment = false;
  hide('#payment-recovery', false);
  hide('#payment-recovery-new', true);
  hide('#payment-recovery-allocate', true);
  text('#payment-recovery-message', 'กำลังตรวจผลการชำระที่ยังไม่ยืนยันก่อนรีโหลด…');
  updateControls();
  try {
    const row = await service.paymentByRequest(debtId, saved.requestId);
    if (stopped) return;
    if (row) {
      recoveredPayment = true;
      text(
        '#payment-recovery-message',
        row.voided_at
          ? 'รายการก่อนรีโหลดถูกย้อนแล้ว ตรวจประวัติก่อนเริ่มบันทึกใหม่'
          : `พบการชำระที่บันทึกแล้ว ${money(row.amount)} วันที่ ${dateText(row.occurred_on)} ไม่ต้องบันทึกยอดนี้ซ้ำ`,
      );
      if (!row.voided_at && saved.planId && saved.installmentId) {
        const link = $('#payment-recovery-allocate');
        link.href = installmentPaymentUrl(debtId, saved.planId, saved.installmentId, row.id);
        link.hidden = false;
      }
      rememberPendingPayment(ownerId, debtId, { ...saved, eventId: row.id });
      resumedRequestId = null;
      hide('#payment-recovery-new', false);
      hide('#payment-recovery-check', false);
    } else {
      text(
        '#payment-recovery-message',
        'ยังไม่พบผลการชำระเดิม กรอกข้อมูลการชำระครั้งเดิมอีกครั้ง ระบบจะใช้รหัสคำขอเดิมเพื่อป้องกันการบันทึกซ้ำ',
      );
      hide('#payment-recovery-check', false);
    }
  } catch {
    if (!stopped) {
      text(
        '#payment-recovery-message',
        'ยังตรวจผลเดิมไม่ได้ ตรวจประวัติหรือลองอีกครั้ง หากส่งข้อมูลการชำระเดิม ระบบจะยังใช้รหัสคำขอเดิม',
      );
      hide('#payment-recovery-check', false);
    }
  } finally {
    recoveryChecking = false;
    if (!stopped) updateControls();
  }
}
function clearBalances() {
  hide('#detail-payment-action', true);
  for (const id of [
    'total-due',
    'principal-balance',
    'interest-balance',
    'fee-balance',
    'tax-balance',
  ])
    text(`#${id}`, '—');
  text('#balance-date', '');
}
function renderSnapshot({ debt, balance, latest, rates }) {
  hide('#detail-payment-action', debt.is_archived || !(Number(balance?.total_due) > 0));
  text('#debt-title', debt.title);
  text(
    '#debt-meta',
    [
      debt.creditor ? `เจ้าหนี้: ${debt.creditor}` : '',
      `เงินต้นเริ่มต้น ${money(debt.opening_principal)}`,
      `เริ่มนับ ${dateText(debt.opening_date)}`,
      debt.due_on ? `ครบกำหนด ${dateText(debt.due_on)}` : '',
      debt.interest_method === 'none' ? 'ไม่มีดอกเบี้ย' : 'ดอกเบี้ยอย่างง่าย',
      debt.is_archived ? 'รายการที่ซ่อนไว้' : '',
    ]
      .filter(Boolean)
      .join(' · '),
  );
  text('#debt-note', debt.note || '');
  text('#balance-date', `ณ ${dateText(bangkokToday())} · เวลาไทย`);
  for (const [id, key] of [
    ['total-due', 'total_due'],
    ['principal-balance', 'principal'],
    ['interest-balance', 'interest'],
    ['fee-balance', 'fee'],
    ['tax-balance', 'tax'],
  ])
    text(`#${id}`, money(balance?.[key]));
  if ($('#payment-date')) {
    $('#payment-date').min = debt.balance_date;
    $('#payment-date').max = bangkokToday();
  }
  if ($('#pay-full')) {
    $('#pay-full').dataset.fillAmount = money(balance?.total_due).replace(/[^0-9.]/g, '');
    $('#pay-full').disabled = $('#payment-date').value !== bangkokToday();
  }
  text('#payment-date-hint', `เลือกได้ตั้งแต่ ${dateText(debt.balance_date)} ถึงวันนี้ ยอดด้านบนเป็นยอดวันนี้`);
  text(
    '#latest-event',
    latest
      ? `${kinds[latest.kind] ?? 'รายการ'} ${money(latest.amount)} วันที่ ${dateText(latest.occurred_on)}`
      : 'ยังไม่มีรายการที่ย้อนกลับได้',
  );
  const currentRate = rates.find((row) => row.effective_on <= bangkokToday());
  if ($('#interest-example')) {
    $('#interest-example').dataset.principal = debt.principal_balance ?? debt.opening_principal;
  }
  const rate = currentRate?.rate_percent ?? debt.rate_percent;
  const period = currentRate?.rate_period ?? debt.rate_period;
  text(
    '#current-rate',
    debt.interest_method === 'none'
      ? 'ไม่มีดอกเบี้ยเกิดเพิ่ม'
      : `อัตราที่มีผลล่าสุด ${rate}% ต่อ${periods[period] ?? period} ตั้งแต่ ${dateText(currentRate?.effective_on ?? debt.opening_date)} · ไม่ทบต้น`,
  );
  text(
    '#initial-rate-summary',
    debt.interest_method === 'none'
      ? 'วิธีคิดดอกเบี้ย: ไม่มีดอกเบี้ย'
      : `อัตราเริ่มต้น ${debt.rate_percent}% ต่อ${periods[debt.rate_period] ?? debt.rate_period} ณ ${dateText(debt.opening_date)}`,
  );
  text(
    '#rate-eligibility',
    debt.interest_method === 'simple_daily'
      ? 'เปลี่ยนอัตราของหนี้ดอกเบี้ยอย่างง่ายตามวันที่มีผล'
      : 'หนี้นี้เลือกวิธีไม่มีดอกเบี้ย จึงยังเปลี่ยนเป็นแบบมีดอกเบี้ยจากหน้านี้ไม่ได้',
  );
  if ($('#rate-date')) {
    $('#rate-date').min = debt.balance_date;
    $('#rate-date').max = bangkokToday();
  }
  text(
    '#rate-date-hint',
    `เลือกได้ตั้งแต่ ${dateText(debt.balance_date)} ถึงวันนี้ ตรวจวันที่ที่มีอัตราอยู่แล้วในประวัติ`,
  );
}
function renderRates(rows, reset = false) {
  if (!$('#rates-history')) return;
  if (reset) {
    rateIds.clear();
    empty('#rates-history');
  }
  for (const row of rows) {
    if (rateIds.has(row.id)) continue;
    rateIds.add(row.id);
    const item = document.createElement('li');
    item.className = 'debt-item';
    const title = document.createElement('h3');
    title.textContent = `${row.rate_percent}% ต่อ${periods[row.rate_period] ?? row.rate_period}`;
    const effective = document.createElement('p');
    effective.className = 'small';
    effective.textContent = `มีผลตั้งแต่ ${dateText(row.effective_on)}`;
    item.append(title, effective);
    if (row.note) {
      const note = document.createElement('p');
      note.className = 'small user-note';
      note.textContent = row.note;
      item.append(note);
    }
    $('#rates-history').append(item);
  }
  rateCursor = rows.at(-1)?.effective_on ?? null;
  hide('#more-rates', rows.length < 25);
  status(
    '#rates-status',
    rateIds.size ? `แสดง ${rateIds.size} รายการ · ใหม่ไปเก่า` : 'ยังไม่มีรายการเปลี่ยนอัตรา ใช้อัตราเริ่มต้น',
  );
}
function renderHistory(rows, reset = false) {
  if (!$('#history')) return;
  if (reset) {
    historyIds.clear();
    empty('#history');
  }
  for (const event of rows) {
    if (historyIds.has(event.id)) continue;
    historyIds.add(event.id);
    const item = document.createElement('li');
    item.className = `debt-item${event.voided_at ? ' event-voided' : ''}`;
    const title = document.createElement('h3');
    title.textContent = `${kinds[event.kind] ?? 'รายการ'} · ${dateText(event.occurred_on)}`;
    const amount = document.createElement('p');
    amount.className = 'event-amount';
    amount.textContent = money(event.amount);
    item.append(title, amount);
    if (event.voided_at) {
      const state = document.createElement('p');
      state.className = 'event-status';
      state.textContent = `ย้อนรายการแล้ว · ${event.void_reason ?? ''}`;
      item.append(state);
    } else if (event.kind === 'payment') {
      const allocation = document.createElement('p');
      allocation.className = 'event-details';
      allocation.textContent = `ตัดค่าธรรมเนียม ${money(event.fee_paid)} · ภาษี ${money(event.tax_paid)} · ดอกเบี้ย ${money(event.interest_paid)} · เงินต้น ${money(event.principal_paid)}`;
      item.append(allocation);
    }
    if (event.note) {
      const note = document.createElement('p');
      note.className = 'small user-note';
      note.textContent = event.note;
      item.append(note);
    }
    $('#history').append(item);
  }
  historyCursor = rows.at(-1)?.event_seq ?? null;
  hide('#more-history', rows.length < 25);
  status(
    '#history-status',
    historyIds.size ? `แสดง ${historyIds.size} รายการ` : 'ยังไม่มีประวัติรายการ',
  );
}
async function refresh() {
  if (!service || stopped) return;
  if (busy) {
    refreshWanted = true;
    return;
  }
  const current = ++version;
  snapshot = null;
  clearBalances();
  hide('#more-history', true);
  hide('#more-rates', true);
  empty('#history');
  empty('#rates-history');
  text('#current-rate', '');
  status('#detail-status', 'กำลังโหลดข้อมูลล่าสุด…');
  updateControls();
  try {
    paymentInstallment = null;
    const [debt, balance, history, latest, rates] = await Promise.all([
      service.debt(debtId),
      wantsBalance ? service.balance(debtId) : null,
      wantsHistory ? service.history(debtId) : [],
      wantsLatest ? service.latestActive(debtId) : null,
      wantsRates ? service.rates(debtId) : [],
    ]);
    if (stopped || current !== version) return;
    if (latest && (latest.debt_id !== debtId || !latest.id))
      throw new Error('รูปแบบรายการล่าสุดไม่ถูกต้อง');
    if (requestedInstallment) {
      installmentPaymentUrl(debtId, requestedPaymentPlan, requestedInstallment);
      const rows = await installmentService.installments(debtId, requestedPaymentPlan);
      if (stopped || current !== version) return;
      paymentInstallment = rows.find(
        (row) =>
          row.id === requestedInstallment &&
          row.status !== 'cancelled' &&
          !row.cancelled_at &&
          cents(row.remaining_amount) > 0n,
      );
      if (!paymentInstallment) throw new Error('งวดนี้ชำระครบหรือถูกยกเลิกแล้ว กรุณากลับไปตรวจภาพรวม');
      hide('#payment-installment-context', false);
      text(
        '#payment-installment-context',
        `ขั้นที่ 1 จาก 2 · ${debt.title} · งวดที่ ${paymentInstallment.installment_no} ครบกำหนด ${dateText(paymentInstallment.due_on)} · ยอดงวดคงเหลือ ${money(paymentInstallment.remaining_amount)}`,
      );
      if (!amountSuggested) {
        const suggested =
          cents(paymentInstallment.remaining_amount) < cents(balance.total_due)
            ? cents(paymentInstallment.remaining_amount)
            : cents(balance.total_due);
        $('#payment-amount').value = fromCents(suggested);
        amountSuggested = true;
      }
    }
    snapshot = { debt, balance, latest, rates };
    renderSnapshot(snapshot);
    renderHistory(history, true);
    renderRates(rates, true);
    status(
      '#detail-status',
      debt.is_archived
        ? 'หนี้ถูกซ่อนไว้ ยอดยังคงนับอยู่ แต่ยังบันทึกหรือย้อนรายการไม่ได้'
        : wantsBalance && Number(balance?.total_due) === 0
          ? 'หนี้นี้ชำระครบแล้ว เปิดดูประวัติรายการได้ด้านล่าง'
          : '',
    );
  } catch (error) {
    if (!stopped && current === version) {
      snapshot = null;
      status(
        '#detail-status',
        requestedInstallment
          ? 'ยังบันทึกงวดนี้ไม่ได้ กรุณาโหลดใหม่ หรือตรวจว่างวดยังมียอดคงเหลือในหน้าภาพรวม'
          : errorText(error),
        true,
      );
      text('#latest-event', 'ยังโหลดรายการล่าสุดไม่ได้');
    }
  } finally {
    if (!stopped && current === version) updateControls();
  }
}
function scheduleRefresh() {
  if (!stopped && service) {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(refresh, 350);
  }
}
async function mutate(kind, form) {
  if (!service || stopped || busy || (pending && pending.kind !== kind)) return;
  if (!pending) {
    if (kind === 'payment' && (recoveryChecking || recoveredPayment)) return;
    if (!snapshot || snapshot.debt.is_archived || !form.reportValidity()) return;
    try {
      const values = Object.fromEntries(new FormData(form));
      if (kind === 'rate' && snapshot.debt.interest_method !== 'simple_daily') return;
      if (kind === 'payment' && Number(snapshot.balance?.total_due) <= 0) return;
      const payload =
        kind === 'payment'
          ? paymentPayload(debtId, values, snapshot.debt.balance_date, bangkokToday())
          : kind === 'rate'
            ? ratePayload(debtId, values, snapshot.debt.balance_date, bangkokToday())
            : voidPayload(snapshot.latest?.id, values.reason);
      if (kind === 'void' && !snapshot.latest) return;
      if (
        kind === 'payment' &&
        requestedInstallment &&
        (!paymentInstallment ||
          cents(payload.p_amount) > cents(paymentInstallment.remaining_amount))
      )
        throw new Error('ยอดชำระของงวดนี้ต้องไม่เกินยอดงวดคงเหลือ ชำระบางส่วนได้');
      pending = {
        kind,
        canEdit: false,
        submission: createSubmission(
          {
            create: { payment: service.pay, void: service.voidEvent, rate: service.changeRate }[
              kind
            ],
          },
          payload,
          () => (kind === 'payment' && resumedRequestId ? resumedRequestId : crypto.randomUUID()),
        ),
      };
    } catch (error) {
      status('#mutation-status', error.message, true);
      return;
    }
  }
  busy = true;
  pending.canEdit = false;
  let success = false;
  updateControls();
  if (kind === 'payment') {
    resumedRequestId = pending.submission.requestId;
    rememberPendingPayment(ownerId, debtId, {
      requestId: resumedRequestId,
      planId: requestedPaymentPlan,
      installmentId: requestedInstallment,
    });
  }
  status('#mutation-status', 'กำลังบันทึก…');
  try {
    const result = await pending.submission.send();
    if (stopped) return;
    if (kind === 'payment') {
      if (requestedInstallment)
        rememberPendingPayment(ownerId, debtId, {
          requestId: pending.submission.requestId,
          planId: requestedPaymentPlan,
          installmentId: requestedInstallment,
          eventId: result.id,
        });
      else clearPendingPayment(ownerId, debtId, pending.submission.requestId);
      resumedRequestId = null;
      hide('#payment-recovery', true);
    }
    success = true;
    pending = null;
    snapshot = null;
    form.reset();
    if (kind === 'payment' && requestedInstallment) {
      const next = installmentPaymentUrl(
        debtId,
        requestedPaymentPlan,
        requestedInstallment,
        result.id,
      );
      const link = $('#continue-installment');
      link.href = next;
      link.hidden = false;
      status('#mutation-status', 'บันทึกรายการชำระแล้ว กำลังเปิดขั้นยืนยันยอดเข้ากับงวด');
      busy = false;
      leaving = true;
      location.assign(next);
      return;
    }
    if (kind === 'payment') $('#payment-date').value = bangkokToday();
    if (kind === 'rate') $('#rate-date').value = bangkokToday();
    status(
      '#mutation-status',
      {
        payment: 'บันทึกชำระสำเร็จแล้ว เลือกดูประวัติหรือผูกยอดกับงวดได้ด้านล่าง',
        void: 'ย้อนรายการสำเร็จแล้ว',
        rate: 'บันทึกอัตราใหม่สำเร็จแล้ว',
      }[kind],
    );
    if (kind === 'void' && !$('#payment-form') && !$('#rate-form')) {
      busy = false;
      leaving = true;
      location.assign(debtUrl('history', debtId));
      return;
    }
  } catch (error) {
    if (stopped) return;
    if (kind === 'payment' && error.reason === 'Request ID reused or voided') {
      pending = null;
      busy = false;
      await restorePayment();
      if (!stopped) await refresh();
      return;
    }
    pending.canEdit = error.uncertain === false;
    status(
      '#mutation-status',
      error.uncertain === false ? errorText(error) : 'ยังยืนยันผลไม่ได้ กรุณาส่งรายการเดิมอีกครั้งก่อนเปลี่ยนหน้า',
      true,
    );
  } finally {
    busy = false;
    if (!stopped && !leaving) {
      updateControls();
      if (success || refreshWanted) {
        refreshWanted = false;
        await refresh();
      }
    }
  }
}
function stop() {
  stopped = true;
  version++;
  clearTimeout(reloadTimer);
  clearInterval(dayTimer);
  snapshot = null;
  pending = null;
  historyIds.clear();
  rateIds.clear();
  clearBalances();
  paymentInstallment = null;
  text('#payment-installment-context', '');
  hide('#continue-installment', true);
  resumedRequestId = null;
  recoveredPayment = false;
  hide('#payment-recovery', true);
  text('#payment-recovery-message', '');
  for (const id of [
    'debt-title',
    'debt-meta',
    'debt-note',
    'latest-event',
    'current-rate',
    'initial-rate-summary',
    'rate-eligibility',
    'rate-date-hint',
  ])
    text(`#${id}`, '');
  empty('#history');
  empty('#rates-history');
  for (const form of ['#payment-form', '#void-form', '#rate-form']) $(form)?.reset();
  for (const selector of ['#detail-status', '#history-status', '#mutation-status', '#rates-status'])
    status(selector, '');
  updateControls();
  if (channel) {
    client.removeChannel(channel);
    channel = null;
  }
}
for (const [kind, selector] of [
  ['payment', '#payment-form'],
  ['void', '#void-form'],
  ['rate', '#rate-form'],
])
  $(selector)?.addEventListener('submit', (event) => {
    event.preventDefault();
    mutate(kind, event.currentTarget);
  });
$('#refresh-detail')?.addEventListener('click', async () => {
  if (recoveredPayment) await restorePayment();
  if (!stopped) await refresh();
});
$('#payment-recovery-check')?.addEventListener('click', async () => {
  await restorePayment();
  if (!stopped) await refresh();
});
$('#payment-recovery-new')?.addEventListener('click', () => {
  if (stopped || busy || recoveryChecking) return;
  const saved = readPendingPayment(ownerId, debtId);
  if (saved) clearPendingPayment(ownerId, debtId, saved.requestId);
  resumedRequestId = null;
  recoveredPayment = false;
  hide('#payment-recovery', true);
  $('#payment-form').reset();
  $('#payment-date').value = bangkokToday();
  updateControls();
});
$('#payment-date')?.addEventListener('change', () => {
  if ($('#pay-full')) $('#pay-full').disabled = $('#payment-date').value !== bangkokToday();
});
$('#edit-mutation')?.addEventListener('click', () => {
  if (!busy && pending?.canEdit && !stopped) {
    pending = null;
    status('#mutation-status', 'แก้ไขข้อมูลแล้วส่งใหม่ได้');
    updateControls();
  }
});
$('#more-history')?.addEventListener('click', async () => {
  if (!snapshot || stopped || historyBusy || !historyCursor) return;
  const current = version;
  historyBusy = true;
  updateControls();
  try {
    const rows = await service.history(debtId, historyCursor);
    if (!stopped && current === version) renderHistory(rows);
  } catch (error) {
    if (!stopped && current === version) status('#history-status', errorText(error), true);
  } finally {
    historyBusy = false;
    updateControls();
  }
});
$('#more-rates')?.addEventListener('click', async () => {
  if (!snapshot || stopped || ratesBusy || !rateCursor) return;
  const current = version;
  ratesBusy = true;
  updateControls();
  try {
    const rows = await service.rates(debtId, rateCursor);
    if (!stopped && current === version) renderRates(rows);
  } catch (error) {
    if (!stopped && current === version) status('#rates-status', errorText(error), true);
  } finally {
    ratesBusy = false;
    updateControls();
  }
});
protectPendingNavigation(() => busy || Boolean(pending && !pending.canEdit), '#mutation-status');
addEventListener('pagehide', stop);
addEventListener('online', scheduleRefresh);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) scheduleRefresh();
});
const ready = await authReady;
if (ready?.session && !stopped) {
  client = ready.client;
  ownerId = ready.session.user.id;
  client.auth.onAuthStateChange((_event, session) => {
    if (!session || session.user.id !== ownerId) stop();
  });
  if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(debtId ?? ''))
    status('#detail-status', 'ลิงก์หนี้ไม่ถูกต้อง กรุณากลับไปเลือกรายการหนี้', true);
  else {
    service = createDebtService(client);
    if (requestedInstallment) installmentService = createScheduleService(client, ownerId);
    if ($('#payment-date')) $('#payment-date').value = bangkokToday();
    if ($('#rate-date')) $('#rate-date').value = bangkokToday();
    await restorePayment();
    if (!stopped) await refresh();
    if (!stopped) {
      channel = client
        .channel(`debt-${debtId}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'debts', filter: `id=eq.${debtId}` },
          scheduleRefresh,
        )
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'debt_events', filter: `debt_id=eq.${debtId}` },
          scheduleRefresh,
        )
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'debt_rate_changes',
            filter: `debt_id=eq.${debtId}`,
          },
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
