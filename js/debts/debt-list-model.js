import { money, bangkokToday } from '../core/format.js';
import { validDebtId } from '../core/navigation.js';
import { cents, fromCents } from '../data/schedule-service.js';

export const debtStates = [
  ['all', 'ทั้งหมด'],
  ['late', 'เลยกำหนด'],
  ['active', 'ยังไม่เลยกำหนด'],
  ['paid', 'ชำระครบ'],
];
export const normalizeSearch = (value) =>
  String(value).trim().normalize('NFC').toLocaleLowerCase('th');

// ยอดมาจาก RPC เท่านั้น: ปัดเพื่อแสดงและรวมผลค้นหา ไม่คำนวณดอกเบี้ย/ตัดชำระในหน้า UI
export function debtRows(rows, categories, today = bangkokToday()) {
  const names = new Map(categories.map((row) => [row.id, row.name]));
  return rows.map(({ debt, balance }) => {
    if (!validDebtId(debt?.id) || typeof debt.title !== 'string') throw new Error('ข้อมูลหนี้ไม่ครบ');
    const formatted = money(balance?.total_due);
    if (formatted === '—') throw new Error('ข้อมูลยอดคงเหลือไม่ครบ');
    const total = formatted.replace(/ บาท$/, '').replaceAll(',', '');
    return {
      debt,
      balance: total,
      categoryName: names.get(debt.category_id) || 'หมวดหมู่เดิม',
      status: cents(total) === 0n ? 'paid' : debt.due_on && debt.due_on < today ? 'late' : 'active',
    };
  });
}
export function filteredBase(rows, state) {
  const query = normalizeSearch(state.search);
  return rows.filter(
    ({ debt }) =>
      debt.is_archived === (state.view === 'archived') &&
      (!state.category || debt.category_id === state.category) &&
      (!query || normalizeSearch(debt.title + ' ' + (debt.creditor || '')).includes(query)),
  );
}
export function matchingRows(rows, state) {
  return filteredBase(rows, state)
    .filter((row) => state.status === 'all' || row.status === state.status)
    .sort((a, b) => {
      if (state.sort === 'name') return a.debt.title.localeCompare(b.debt.title, 'th');
      if (state.sort === 'balance')
        return cents(a.balance) > cents(b.balance)
          ? -1
          : cents(a.balance) < cents(b.balance)
            ? 1
            : 0;
      const priority = { late: 0, active: 1, paid: 2 };
      return (
        priority[a.status] - priority[b.status] ||
        (a.debt.due_on || '9999').localeCompare(b.debt.due_on || '9999') ||
        a.debt.id.localeCompare(b.debt.id)
      );
    });
}
export function resultTotal(rows) {
  return fromCents(rows.reduce((sum, row) => sum + cents(row.balance), 0n));
}

// ใช้ keyset ของ RPC จนจบ ป้องกัน cursor ซ้ำและผลเกินขนาด ห้ามแสดงผลบางส่วนเป็นทั้งหมด
export async function readDebtScope(service, archived, isCurrent = () => true) {
  const result = [],
    ids = new Set();
  let cursor = null;
  while (isCurrent()) {
    const rows = await service.list({ archived, cursor, limit: 100 });
    if (!isCurrent()) return null;
    if (rows.length > 100) throw new Error('ขนาดข้อมูลไม่ถูกต้อง');
    for (const row of rows) {
      if (!validDebtId(row.debt?.id) || ids.has(row.debt.id) || row.debt.is_archived !== archived)
        throw new Error('รายการหนี้ไม่ครบหรือซ้ำ');
      ids.add(row.debt.id);
      result.push(row);
    }
    if (rows.length < 100) return result;
    const last = rows.at(-1).debt;
    if (!last.created_at || !Number.isFinite(Date.parse(last.created_at)))
      throw new Error('อ่านหน้าถัดไปไม่สำเร็จ');
    const next = { created_at: last.created_at, id: last.id };
    if (cursor && cursor.created_at === next.created_at && cursor.id === next.id)
      throw new Error('ตำแหน่งหน้าถัดไปซ้ำ');
    cursor = next;
  }
  return null;
}
