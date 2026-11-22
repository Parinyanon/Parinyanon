import { bangkokToday, dateText, money } from '../core/format.js';
import { debtUrl, installmentPaymentUrl } from '../core/navigation.js';

// สร้างข้อความผ่าน textContent เท่านั้น: ชื่อหนี้/เจ้าหนี้เป็นข้อมูลของผู้ใช้ ไม่ใช่ HTML
function node(tag, text, className) {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  if (className) result.className = className;
  return result;
}
function link(text, href, className) {
  const result = node('a', text, className);
  result.href = href;
  return result;
}
function amount(target, value) {
  const formatted = money(value);
  target.replaceChildren(node('span', formatted.replace(/ บาท$/, ''), 'overview-number'));
  if (formatted !== '—') target.append(node('span', ' บาท', 'overview-unit'));
}

export function createOverviewView(root) {
  const find = (id) => root.querySelector('#' + id);
  let openId = null;
  let initialized = false;

  // ยอดทั้งหมดมาจาก RPC; ยอดเดือนนี้มาจาก paymentOverview ซึ่งรวมเป็นสตางค์อยู่แล้ว
  // มุมมองนี้จัดวางข้อมูลเท่านั้น ไม่คำนวณดอกเบี้ยหรือตัดยอดการชำระเอง
  function summary(summaryResult, scheduleResult, today) {
    const hasSummary = summaryResult.status === 'fulfilled';
    const payments = scheduleResult.status === 'fulfilled' ? scheduleResult.value : null;
    const noDebts = hasSummary && Number(summaryResult.value.total_debts) === 0;
    const showMonth = !noDebts && Boolean(payments?.hasSchedules);
    find('overview-month').hidden = !showMonth;
    find('overview-month-note').hidden = !showMonth;
    root.querySelector('.overview-summary').dataset.mode = showMonth ? 'month' : 'balance';
    if (hasSummary) amount(find('overview-total'), summaryResult.value.total_due);
    else find('overview-total').textContent = 'โหลดไม่สำเร็จ';
    find('overview-asof').textContent = hasSummary
      ? 'ข้อมูล ณ ' + dateText(summaryResult.value.as_of) + ' · ยอดหนี้รวมรายการที่ซ่อนไว้'
      : 'โหลดยอดหนี้ไม่สำเร็จ กดอัปเดตข้อมูลเพื่อลองอีกครั้ง';
    find('overview-month-name').textContent = new Intl.DateTimeFormat('th-TH', {
      month: 'short',
      year: 'numeric',
      timeZone: 'Asia/Bangkok',
    }).format(new Date(today + 'T12:00:00+07:00'));
    if (showMonth) amount(find('overview-month-total'), payments.monthRemaining);
    else find('overview-month-total').textContent = '—';
    find('overview-overdue').hidden = noDebts || !payments?.overdueCount;
    find('overview-overdue-label').textContent = payments
      ? `เลยกำหนด ${payments.overdueCount} งวด`
      : '';
    find('overview-overdue-total').textContent = payments ? money(payments.overdueRemaining) : '';
    return noDebts;
  }

  function showState(title, description, text, href) {
    const section = node('section', undefined, 'overview-state');
    section.append(node('h2', title), node('p', description));
    if (href) section.append(link(text, href, 'action-button'));
    else {
      const retry = node('button', 'ลองอีกครั้ง', 'plain-button');
      retry.type = 'button';
      retry.addEventListener('click', () => find('workspace-refresh').click());
      section.append(retry);
    }
    find('priority-content').replaceChildren(section);
  }

  function renderDebts(result, noDebts, canSetPlan) {
    find('overview-debts-panel').hidden = noDebts;
    const list = find('overview-debts');
    list.replaceChildren();
    if (noDebts) return;
    if (result.status === 'rejected') {
      list.append(node('p', 'โหลดรายการหนี้ไม่สำเร็จ กดอัปเดตข้อมูลเพื่อลองใหม่', 'small'));
      return;
    }
    const rows = result.value.slice(0, 4);
    if (!rows.length) list.append(node('p', 'ไม่มีหนี้ที่ยังไม่ซ่อน เปิด “ดูทั้งหมด” เพื่อดูรายการอื่น', 'small'));
    for (const { debt, balance } of rows) {
      const row = node('article', undefined, 'overview-debt-row');
      const info = node('div');
      info.append(link(debt.title, debtUrl('debt-detail', debt.id), 'overview-debt-title'));
      if (debt.creditor) info.append(node('p', debt.creditor, 'small'));
      row.append(info, node('strong', money(balance?.total_due), 'overview-debt-amount'));
      if (canSetPlan && Number(balance?.total_due) > 0)
        row.append(link('ตั้งแผนงวด', debtUrl('create-schedule', debt.id), 'overview-debt-plan'));
      list.append(row);
    }
  }

  function installment(row, today, debtService, balances, isCurrent) {
    const details = node('details', undefined, 'overview-installment');
    details.name = 'overview-installments';
    details.dataset.installment = row.id;
    details.dataset.overdue = String(row.due_on < today);
    const trigger = node('summary', undefined, 'overview-installment-trigger');
    const date = new Date(row.due_on + 'T12:00:00+07:00');
    const rail = node('span', undefined, 'overview-date');
    rail.append(
      node('span', new Intl.DateTimeFormat('th-TH', { day: 'numeric' }).format(date)),
      node('small', new Intl.DateTimeFormat('th-TH', { month: 'short' }).format(date)),
    );
    const info = node('span', undefined, 'overview-installment-info');
    info.append(node('strong', row.debt.title, 'overview-installment-title'));
    if (row.debt.creditor) info.append(node('span', row.debt.creditor, 'overview-creditor'));
    info.append(
      node(
        'span',
        row.due_on < today ? 'เลยกำหนด' : row.due_on === today ? 'ครบกำหนดวันนี้' : 'งวดถัดไป',
        'overview-payment-state',
      ),
    );
    const value = node('span', undefined, 'overview-installment-value');
    value.append(node('strong', money(row.remaining_amount).replace(/ บาท$/, '')));
    const unit = node('small', 'บาท ');
    const chevron = node('span', '⌄', 'overview-chevron');
    chevron.setAttribute('aria-hidden', 'true');
    unit.append(chevron);
    value.append(unit);
    trigger.append(rail, info, value);
    const panel = node('div', undefined, 'overview-installment-panel');
    const due = node('p', undefined, 'overview-installment-due');
    due.append(
      node('span', `งวดที่ ${row.installment_no} · ครบกำหนด`),
      node('strong', dateText(row.due_on)),
    );
    const balanceLine = node('p', undefined, 'overview-installment-balance');
    balanceLine.append(node('span', 'ยอดคงเหลือของหนี้นี้'));
    const balanceValue = node('strong', 'กำลังโหลด…');
    balanceLine.append(balanceValue);
    const pay = link(
      'บันทึกชำระ',
      installmentPaymentUrl(row.debt_id, row.schedule_id, row.id),
      'action-button',
    );
    pay.setAttribute('aria-label', 'บันทึกชำระ ' + row.debt.title + ' งวดที่ ' + row.installment_no);
    const actions = node('div', undefined, 'overview-installment-links');
    actions.append(
      link('รายละเอียดหนี้', debtUrl('debt-detail', row.debt_id)),
      link('ดูแผนงวด', debtUrl('schedules', row.debt_id, row.schedule_id)),
    );
    panel.append(due, balanceLine, pay, actions);
    details.append(trigger, panel);

    // อ่านยอดหนี้เพิ่มเติมเฉพาะแถวที่เปิด และแชร์ Promise ต่อหนี้ เพื่อลดคำขอซ้ำ
    details.addEventListener('toggle', async () => {
      if (!root.contains(details) || !isCurrent()) return;
      if (!details.open) {
        if (openId === row.id) openId = null;
        return;
      }
      openId = row.id;
      for (const other of root.querySelectorAll('.overview-installment'))
        if (other !== details) other.open = false;
      if (!balances.has(row.debt_id)) balances.set(row.debt_id, debtService.balance(row.debt_id));
      try {
        const balance = await balances.get(row.debt_id);
        if (isCurrent() && root.contains(details))
          balanceValue.textContent = money(balance.total_due);
      } catch {
        if (isCurrent() && root.contains(details)) balanceValue.textContent = 'ดูในหน้ารายละเอียดหนี้';
      }
    });
    return details;
  }

  find('overview-overdue').addEventListener('click', () => {
    const first = root.querySelector('.overview-installment[data-overdue="true"]');
    if (!first) return;
    openId = first.dataset.installment;
    first.open = true;
    first.querySelector('summary').focus();
  });

  return {
    async render(service, debtService, isCurrent) {
      // toggle เป็น event แบบ queued: อ่านสถานะ DOM ก่อน refresh เพื่อไม่คืนแถวเก่า
      // เมื่อผู้ใช้เลือกงวดแล้วกดอัปเดตทันที
      if (initialized)
        openId = root.querySelector('.overview-installment[open]')?.dataset.installment ?? null;
      find('overview-layout').setAttribute('aria-busy', 'true');
      const today = bangkokToday();
      const results = await Promise.allSettled([
        service.overview(),
        service.paymentOverview(today),
        debtService.list(),
      ]);
      if (!isCurrent()) return;
      const [summaryResult, scheduleResult, debtResult] = results;
      const noDebts = summary(summaryResult, scheduleResult, today);
      const payments = scheduleResult.status === 'fulfilled' ? scheduleResult.value : null;
      renderDebts(debtResult, noDebts, Boolean(payments && !payments.hasSchedules));
      find('priority-content').replaceChildren();
      const list = find('upcoming-installments');
      list.replaceChildren();
      find('overview-schedule-panel').hidden = true;
      if (noDebts)
        showState(
          'เริ่มจัดหนี้จากรายการแรกของคุณ',
          'เพิ่มชื่อหนี้ เจ้าหนี้ และยอดคงเหลือ แล้วค่อยตั้งแผนงวดภายหลังได้',
          'เพิ่มหนี้รายการแรก',
          'create-debt.html',
        );
      else if (!payments) showState('โหลดกำหนดชำระไม่สำเร็จ', 'ตรวจการเชื่อมต่อ แล้วลองโหลดข้อมูลอีกครั้ง');
      else if (!payments.hasSchedules)
        showState(
          'ยังไม่ได้ตั้งแผนงวด',
          'เลือกหนี้เพื่อตั้งวันและจำนวนเงินของแต่ละงวด ยอดเดือนนี้จะแสดงเมื่อมีแผนแล้ว',
          'เลือกหนี้เพื่อตั้งแผน',
          'index.html',
        );
      else if (!payments.installments.length)
        showState(
          'ไม่มีงวดค้างชำระ',
          'งวดตามแผนที่มีอยู่ชำระครบแล้ว ดูรายการหนี้เพื่อตรวจยอดคงเหลือทั้งหมด',
          'ดูรายการหนี้',
          'index.html',
        );
      else {
        // หน้าภาพรวมจำกัด 3 งวดเสมอ; รายการทั้งหมดอยู่ที่ installments.html
        const rows = payments.installments.slice(0, 3);
        if (!initialized || (openId && !rows.some((row) => row.id === openId))) openId = rows[0].id;
        initialized = true;
        const balances = new Map(
          debtResult.status === 'fulfilled'
            ? debtResult.value.map(({ debt, balance }) => [debt.id, Promise.resolve(balance)])
            : [],
        );
        for (const row of rows) {
          const entry = installment(row, today, debtService, balances, isCurrent);
          list.append(entry);
          entry.open = row.id === openId;
        }
        find('overview-schedule-panel').hidden = false;
        find('overview-schedule-count').textContent = `${payments.installments.length} งวด`;
      }
      find('overview-layout').setAttribute('aria-busy', 'false');
      // แสดงข้อมูลส่วนที่โหลดได้ต่อไป พร้อมแจ้งข้อผิดพลาดผ่านสถานะกลางของ workspace
      const failed = results.find((result) => result.status === 'rejected');
      if (failed) throw failed.reason;
    },
    clear() {
      openId = null;
      initialized = false;
      for (const id of ['upcoming-installments', 'overview-debts', 'priority-content'])
        find(id).replaceChildren();
      for (const id of [
        'overview-total',
        'overview-month-total',
        'overview-asof',
        'overview-schedule-count',
      ])
        find(id).textContent = '—';
      find('overview-overdue').hidden = true;
      find('overview-overdue-label').textContent = '';
      find('overview-overdue-total').textContent = '';
    },
  };
}
