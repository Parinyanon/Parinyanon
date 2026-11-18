import { checked, decimal, validDate } from './debt-service.js';

const uuid = (value) =>
  typeof value === 'string' && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value);
export function cents(value) {
  const text = String(value);
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new Error('รูปแบบจำนวนเงินไม่ถูกต้อง');
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}
export function fromCents(value) {
  return `${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`;
}
function amount(value) {
  const text = decimal(value);
  if (cents(text) > 99999999999999n) throw new Error('จำนวนเงินสูงสุด 999,999,999,999.99 บาท');
  return text;
}
export function schedulePayload(debtId, fields) {
  if (!uuid(debtId)) throw new Error('ลิงก์หนี้ไม่ถูกต้อง');
  const count = String(fields.count ?? '').trim();
  if (!/^\d+$/.test(count) || Number(count) < 1 || Number(count) > 360)
    throw new Error('จำนวนงวดต้องเป็นจำนวนเต็มตั้งแต่ 1 ถึง 360');
  return {
    p_debt_id: debtId,
    p_first_due_on: validDate(String(fields.first_due_on ?? '')),
    p_amount: amount(fields.amount),
    p_count: Number(count),
  };
}
export function allocationPayload(fields) {
  if (!uuid(fields.event_id) || !uuid(fields.installment_id))
    throw new Error('เลือกรายการชำระและงวดที่ต้องการผูกยอด');
  return {
    p_event_id: fields.event_id,
    p_installment_id: fields.installment_id,
    p_amount: amount(fields.amount),
  };
}
function rowResult(result) {
  return Array.isArray(result) && result.length === 1 ? result[0] : result;
}
function unconfirmed() {
  return Object.assign(new Error('ยังยืนยันผลบันทึกไม่ได้'), { uncertain: true });
}
export function createScheduleService(client, ownerId) {
  if (!uuid(ownerId)) throw new Error('เซสชันผู้ใช้ไม่ถูกต้อง');
  // กรอง owner เสริมทุก query โดยฐานจริงยังต้องบังคับ RLS/สิทธิ์ของ view และ RPC
  const owned = (table, columns, debtId, options) =>
    client.from(table).select(columns, options).eq('user_id', ownerId).eq('debt_id', debtId);
  return {
    plan: async (debtId, id) =>
      checked(
        owned(
          'payment_schedules',
          'id,debt_id,first_due_on,installment_amount::text,installment_count,created_at',
          debtId,
        )
          .eq('id', id)
          .maybeSingle(),
      ),
    payment: async (debtId, id) =>
      checked(
        owned('debt_events', 'id,debt_id,event_seq::text,amount::text,occurred_on,note', debtId)
          .eq('id', id)
          .eq('kind', 'payment')
          .is('voided_at', null)
          .maybeSingle(),
      ),
    plans: async (debtId, cursor = null) => {
      let query = owned(
        'payment_schedules',
        'id,debt_id,first_due_on,installment_amount::text,installment_count,created_at',
        debtId,
      )
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(25);
      if (cursor) {
        if (
          !uuid(cursor.id) ||
          !/^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})$/.test(cursor.created_at)
        )
          throw new Error('ตำแหน่งแผนถัดไปไม่ถูกต้อง');
        query = query.or(
          `created_at.lt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.lt.${cursor.id})`,
        );
      }
      const rows = await checked(query);
      if (!Array.isArray(rows) || rows.some((row) => !uuid(row.id) || row.debt_id !== debtId))
        throw new Error('รูปแบบแผนชำระไม่ถูกต้อง');
      return rows;
    },
    installments: async (debtId, planId) => {
      const rows = await checked(
        owned(
          'installment_balances',
          'id,debt_id,schedule_id,installment_no,due_on,amount::text,paid_amount::text,remaining_amount::text,status,cancelled_at',
          debtId,
        )
          .eq('schedule_id', planId)
          .order('installment_no', { ascending: true })
          .limit(360),
      );
      if (
        !Array.isArray(rows) ||
        rows.some(
          (row) =>
            !uuid(row.id) ||
            row.schedule_id !== planId ||
            row.debt_id !== debtId ||
            !['pending', 'overdue', 'paid', 'cancelled'].includes(row.status),
        )
      )
        throw new Error('รูปแบบงวดชำระไม่ถูกต้อง');
      rows.forEach((row) => {
        cents(row.amount);
        cents(row.paid_amount);
        cents(row.remaining_amount);
      });
      return rows;
    },
    payments: async (debtId, before = null) => {
      let query = owned(
        'debt_events',
        'id,debt_id,event_seq::text,amount::text,occurred_on,note',
        debtId,
      )
        .eq('kind', 'payment')
        .is('voided_at', null)
        .order('event_seq', { ascending: false })
        .limit(25);
      if (before !== null) {
        if (!/^\d+$/.test(before)) throw new Error('ตำแหน่งรายการชำระไม่ถูกต้อง');
        query = query.lt('event_seq', before);
      }
      const rows = await checked(query);
      if (
        !Array.isArray(rows) ||
        rows.some((row) => !uuid(row.id) || row.debt_id !== debtId || !/^\d+$/.test(row.event_seq))
      )
        throw new Error('รูปแบบรายการชำระไม่ถูกต้อง');
      rows.forEach((row) => cents(row.amount));
      return rows;
    },
    available: async (debtId, payment) => {
      let used = 0n;
      let cursor = null;
      // อ่านทุกหน้า ไม่ใช้ default row limit มาตีความว่าเป็นยอดจัดสรรทั้งหมด
      while (true) {
        let query = owned('installment_allocations', 'id,event_id,amount::text', debtId, {
          count: 'exact',
        })
          .eq('event_id', payment.id)
          .order('id', { ascending: true })
          .limit(500);
        if (cursor) query = query.gt('id', cursor);
        let count;
        const rows = await checked(
          Promise.resolve(query).then((result) => {
            count = result.count;
            return result;
          }),
        );
        if (
          !Array.isArray(rows) ||
          rows.some((row) => !uuid(row.id) || row.event_id !== payment.id)
        )
          throw new Error('รูปแบบยอดผูกงวดไม่ถูกต้อง');
        if (!Number.isSafeInteger(count) || count < rows.length)
          throw new Error('ยังตรวจจำนวนรายการผูกยอดทั้งหมดไม่ได้');
        rows.forEach((row) => {
          used += cents(row.amount);
        });
        if (rows.length === count) break;
        if (!rows.length) throw new Error('อ่านยอดผูกงวดหน้าถัดไปไม่สำเร็จ');
        const next = rows.at(-1).id;
        if (cursor !== null && next <= cursor) throw new Error('อ่านยอดผูกงวดหน้าถัดไปไม่สำเร็จ');
        cursor = next;
      }
      const remaining = cents(payment.amount) - used;
      if (remaining < 0n) throw new Error('ยอดจัดสรรเปลี่ยนแปลง กรุณาโหลดข้อมูลใหม่');
      return fromCents(remaining);
    },
    create: async (payload, requestId) => {
      const row = rowResult(
        await checked(client.rpc('dm_create_schedule', { ...payload, p_request_id: requestId })),
      );
      if (
        !uuid(row?.id) ||
        row.debt_id !== payload.p_debt_id ||
        row.first_due_on !== payload.p_first_due_on ||
        row.installment_count !== payload.p_count
      )
        throw unconfirmed();
      try {
        if (cents(row.installment_amount) !== cents(payload.p_amount)) throw unconfirmed();
      } catch {
        throw unconfirmed();
      }
      return row;
    },
    allocate: async (payload, requestId) => {
      const row = rowResult(
        await checked(client.rpc('dm_allocate_payment', { ...payload, p_request_id: requestId })),
      );
      if (
        !uuid(row?.id) ||
        row.event_id !== payload.p_event_id ||
        row.installment_id !== payload.p_installment_id
      )
        throw unconfirmed();
      try {
        if (cents(row.amount) !== cents(payload.p_amount)) throw unconfirmed();
      } catch {
        throw unconfirmed();
      }
      return row;
    },
    // RPC นี้ไม่มี request_id: SQL ยกเลิกเฉพาะแถว cancelled_at IS NULL จึงส่งซ้ำได้
    cancel: async (payload) => {
      if (!uuid(payload.p_schedule_id)) throw new Error('เลือกแผนที่ต้องการยกเลิก');
      await checked(client.rpc('dm_cancel_schedule', payload));
    },
  };
}
