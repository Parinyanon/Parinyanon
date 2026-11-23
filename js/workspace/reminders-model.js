import { bangkokToday } from '../core/format.js';

const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
export const reminderDay = (value) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(value));
export const reminderTime = (value, full = false) =>
  new Intl.DateTimeFormat('th-TH', {
    timeZone: 'Asia/Bangkok',
    ...(full
      ? { dateStyle: 'medium', timeStyle: 'short' }
      : { hour: '2-digit', minute: '2-digit' }),
  }).format(new Date(value));
const normalize = (text) => text.trim().normalize('NFC').toLocaleLowerCase('th');
export function matchingReminders(rows, search, period, today = bangkokToday()) {
  const term = normalize(search);
  return rows.filter(
    (row) =>
      (!term || normalize(row.debtName + ' ' + row.title).includes(term)) &&
      (period === 'all' ||
        (period === 'today'
          ? reminderDay(row.remind_at) === today
          : reminderDay(row.remind_at) < today)),
  );
}

// Read the complete owned snapshot before presenting totals or filtering it.
// A repeated cursor or incomplete response must never become a misleading total.
export async function readReminderScope(service, current) {
  const rows = [],
    seen = new Set();
  let cursor = null;
  while (current()) {
    const page = await service.reminders(cursor);
    if (!current()) return null;
    for (const row of page) {
      if (
        !uuid.test(row.id) ||
        !uuid.test(row.debt_id) ||
        !Number.isFinite(Date.parse(row.remind_at)) ||
        seen.has(row.id)
      )
        throw new Error('ข้อมูลแจ้งเตือนไม่ครบ กรุณาลองใหม่');
      seen.add(row.id);
      rows.push(row);
    }
    if (page.length < 25) break;
    const next = page.at(-1);
    if (
      cursor &&
      (next.remind_at > cursor.remind_at ||
        (next.remind_at === cursor.remind_at && next.id >= cursor.id))
    )
      throw new Error('อ่านแจ้งเตือนหน้าถัดไปไม่สำเร็จ');
    cursor = next;
  }
  if (!current()) return null;
  const debts = await service.reminderDebts([...new Set(rows.map((row) => row.debt_id))], current);
  if (!current()) return null;
  const names = new Map(debts.map((row) => [row.id, row.title]));
  return rows
    .map((row) => ({
      ...row,
      title: String(row.title || 'แจ้งเตือนการชำระ'),
      debtName: names.get(row.debt_id) || 'รายการหนี้',
    }))
    .sort((a, b) => b.remind_at.localeCompare(a.remind_at) || b.id.localeCompare(a.id));
}
