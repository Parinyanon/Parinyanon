import { money, dateText } from './format.js';
import { debtUrl, installmentPaymentUrl } from './navigation.js';
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
export function installmentEntry(row, today) {
  const entry = element('article', undefined, 'payment-task');
  const overdue = row.due_on < today;
  entry.dataset.overdue = String(overdue);
  entry.dataset.long = String(money(row.remaining_amount).length > 20);
  const info = element('div', undefined, 'payment-task-info');
  const title = element('a', row.debt.title, 'payment-task-title');
  title.href = debtUrl('debt-detail', row.debt_id);
  info.append(title);
  if (row.debt.creditor) info.append(element('p', row.debt.creditor, 'payment-creditor'));
  const timing = element('div', undefined, 'payment-task-timing');
  timing.append(
    element(
      'span',
      overdue ? 'เลยกำหนด' : row.due_on === today ? 'ครบกำหนดวันนี้' : 'ยังไม่ถึงกำหนด',
      'payment-state',
    ),
    element('span', `ครบกำหนด ${dateText(row.due_on)} · งวดที่ ${row.installment_no}`),
  );
  info.append(timing);
  const amount = element('div', undefined, 'payment-task-amount');
  amount.append(element('span', 'ยอดงวดคงเหลือ'), element('strong', money(row.remaining_amount)));
  const actions = element('div', undefined, 'payment-task-actions');
  const pay = element('a', 'บันทึกการชำระ', 'action-button');
  pay.href = installmentPaymentUrl(row.debt_id, row.schedule_id, row.id);
  pay.setAttribute('aria-label', `บันทึกการชำระ ${row.debt.title}`);
  actions.append(pay);
  entry.append(info, amount, actions);
  return entry;
}
