import { checked, createDebtService } from './debt-service.js';
import { bangkokToday } from '../core/format.js';
import { cents, fromCents } from './schedule-service.js';
const UUID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
export function settingsPayload(fields, allowEmail = false) {
  if (!['system', 'light', 'dark'].includes(fields.theme)) throw new Error('เลือกธีมที่ต้องการ');
  const days = String(fields.days ?? '');
  if (!/^\d+$/.test(days) || Number(days) > 30) throw new Error('แจ้งเตือนล่วงหน้าได้ 0–30 วัน');
  const name = String(fields.name ?? '').trim();
  if (name.length > 100) throw new Error('ชื่อยาวได้ไม่เกิน 100 ตัวอักษร');
  const settings = {
    theme: fields.theme,
    reminder_days_before: Number(days),
    in_app_notifications: fields.in_app === 'on',
  };
  if (allowEmail) settings.email_notifications = fields.email === 'on';
  return { profile: { display_name: name }, settings };
}
export function csvText(rows) {
  const cell = (value) => {
    let text = String(value ?? '');
    if (/^[\s\u0000-\u001f]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  return '\uFEFF' + rows.map((row) => row.map(cell).join(',')).join('\r\n');
}
export function createWorkspaceService(client, owner) {
  if (!UUID.test(owner)) throw new Error('เซสชันไม่ถูกต้อง');
  const owned = (table, columns) => client.from(table).select(columns).eq('user_id', owner);
  return {
    overview: async () => {
      const data = await checked(client.rpc('dm_get_overview'));
      if (!data || !Array.isArray(data.by_category) || !Number.isFinite(Number(data.total_due)))
        throw new Error('ข้อมูลภาพรวมไม่ถูกต้อง');
      return data;
    },
    paymentOverview: async (today = bangkokToday()) => {
      const installments = [];
      let cursor = null;
      while (true) {
        let query = client
          .from('installment_balances')
          .select('id,debt_id,schedule_id,installment_no,due_on,remaining_amount::text,status', {
            count: 'exact',
          })
          .eq('user_id', owner)
          .in('status', ['pending', 'overdue', 'paid'])
          .order('id')
          .limit(250);
        if (cursor) query = query.gt('id', cursor);
        let count;
        const rows = await checked(
          Promise.resolve(query).then((result) => {
            count = result.count;
            return result;
          }),
        );
        if (!Array.isArray(rows) || !Number.isSafeInteger(count) || count < rows.length)
          throw new Error('ยังตรวจจำนวนงวดทั้งหมดไม่ได้');
        for (const row of rows) {
          if (
            !UUID.test(row.id) ||
            !UUID.test(row.debt_id) ||
            !UUID.test(row.schedule_id) ||
            !/^\d{4}-\d{2}-\d{2}$/.test(row.due_on)
          )
            throw new Error('ข้อมูลงวดไม่ครบ');
          cents(row.remaining_amount);
        }
        installments.push(...rows);
        if (rows.length === count) break;
        const next = rows.at(-1)?.id;
        if (!next || (cursor && next <= cursor)) throw new Error('อ่านงวดถัดไปไม่สำเร็จ');
        cursor = next;
      }
      const monthly = installments.filter((row) => row.due_on.slice(0, 7) === today.slice(0, 7));
      const unpaid = installments
        .filter((row) => row.status !== 'paid' && cents(row.remaining_amount) > 0n)
        .sort((a, b) => a.due_on.localeCompare(b.due_on) || a.id.localeCompare(b.id));
      const overdue = unpaid.filter((row) => row.due_on < today);
      const debtIds = [...new Set(unpaid.map((row) => row.debt_id))];
      const debts = new Map();
      for (let index = 0; index < debtIds.length; index += 100) {
        const rows = await checked(
          owned('debts', 'id,title,creditor').in('id', debtIds.slice(index, index + 100)),
        );
        for (const row of rows) debts.set(row.id, row);
      }
      for (const row of unpaid) {
        if (!debts.has(row.debt_id)) throw new Error('อ่านชื่อหนี้ของงวดไม่สำเร็จ');
      }
      return {
        hasSchedules: installments.length > 0,
        monthRemaining: fromCents(
          monthly.reduce((sum, row) => sum + cents(row.remaining_amount), 0n),
        ),
        monthCount: monthly.filter((row) => cents(row.remaining_amount) > 0n).length,
        overdueCount: overdue.length,
        overdueRemaining: fromCents(
          overdue.reduce((sum, row) => sum + cents(row.remaining_amount), 0n),
        ),
        installments: unpaid.map((row) => ({ ...row, debt: debts.get(row.debt_id) })),
        today,
      };
    },
    categories: () =>
      checked(client.from('categories').select('id,user_id,name,is_archived').order('name')),
    reminders: async (before) => {
      let query = owned('due_reminders', 'id,debt_id,installment_id,title,remind_at')
        .order('remind_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(25);
      if (before) {
        if (
          !UUID.test(before.id) ||
          !/^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})$/.test(before.remind_at)
        )
          throw new Error('ตำแหน่งแจ้งเตือนไม่ถูกต้อง');
        query = query.or(
          `remind_at.lt.${before.remind_at},and(remind_at.eq.${before.remind_at},id.lt.${before.id})`,
        );
      }
      const rows = await checked(query);
      if (!Array.isArray(rows)) throw new Error('ข้อมูลแจ้งเตือนไม่ถูกต้อง');
      return rows;
    },
    reminderDebts: async (ids, current = () => true) => {
      if (!Array.isArray(ids) || ids.some((id) => !UUID.test(id)))
        throw new Error('รายการหนี้ไม่ถูกต้อง');
      const result = [];
      for (let index = 0; index < ids.length && current(); index += 100) {
        const rows = await checked(
          owned('debts', 'id,title').in('id', ids.slice(index, index + 100)),
        );
        if (!Array.isArray(rows)) throw new Error('อ่านชื่อหนี้ไม่สำเร็จ');
        result.push(...rows);
      }
      return result;
    },
    markRead: async (id) => {
      if (!UUID.test(id)) throw new Error('รายการไม่ถูกต้อง');
      const row = await checked(
        client
          .from('reminders')
          .update({ read_at: new Date().toISOString() })
          .eq('user_id', owner)
          .eq('id', id)
          .select('id')
          .single(),
      );
      if (row?.id !== id) throw new Error('ยังยืนยันผลไม่ได้');
      return row;
    },
    profile: () =>
      checked(client.from('profiles').select('display_name').eq('id', owner).maybeSingle()),
    settings: () =>
      checked(
        owned(
          'user_settings',
          'theme,reminder_days_before,email_notifications,in_app_notifications',
        ).maybeSingle(),
      ),
    saveProfile: async (data) => {
      const row = await checked(
        client.from('profiles').update(data).eq('id', owner).select('id').single(),
      );
      if (row?.id !== owner) throw new Error('ไม่พบข้อมูลบัญชี');
      return row;
    },
    saveSettings: async (data) => {
      const row = await checked(
        client.from('user_settings').update(data).eq('user_id', owner).select('user_id').single(),
      );
      if (row?.user_id !== owner) throw new Error('ไม่พบการตั้งค่าบัญชี');
      return row;
    },
    addCategory: async (name, id) => {
      const title = String(name ?? '').trim();
      if (!title || title.length > 80 || !UUID.test(id))
        throw new Error('ตั้งชื่อประเภทหนี้ 1–80 ตัวอักษร');
      // Creating a category needs INSERT, never UPDATE of its immutable ID/owner.
      // A response-loss retry reuses its UUID and verifies the existing row instead of overwriting it.
      // The installed column grants allow id/user_id/name; is_archived uses the database default.
      const payload = { id, user_id: owner, name: title };
      let row;
      try {
        row = await checked(
          client.from('categories').insert(payload).select('id,user_id,name,is_archived').single(),
        );
      } catch (error) {
        if (error.code !== '23505') throw error;
        row = await checked(
          owned('categories', 'id,user_id,name,is_archived').eq('id', id).maybeSingle(),
        );
        if (!row) throw error;
      }
      if (
        row?.id !== id ||
        row.user_id !== owner ||
        row.name !== title ||
        row.is_archived !== false
      )
        throw Object.assign(new Error('ยังยืนยันผลไม่ได้'), { uncertain: true });
      return row;
    },
    archiveCategory: async (id, archived) => {
      if (!UUID.test(id)) throw new Error('ประเภทหนี้ไม่ถูกต้อง');
      return checked(
        client
          .from('categories')
          .update({ is_archived: archived })
          .eq('user_id', owner)
          .eq('id', id)
          .select('id')
          .single(),
      );
    },
    exportRows: async (mode = 'all', cancelled = () => false) => {
      const api = createDebtService(client),
        result = [];
      for (const archived of mode === 'active'
        ? [false]
        : mode === 'archived'
          ? [true]
          : [false, true]) {
        let cursor = null;
        while (true) {
          if (cancelled()) throw new Error('หยุดส่งออกแล้ว');
          const rows = await api.list({ archived, cursor });
          result.push(...rows);
          if (rows.length < 25) break;
          const last = rows.at(-1).debt;
          if (!last.created_at || !last.id || cursor?.id === last.id)
            throw new Error('อ่านรายการหน้าถัดไปไม่สำเร็จ');
          cursor = { created_at: last.created_at, id: last.id };
        }
      }
      if (cancelled()) throw new Error('หยุดส่งออกแล้ว');
      return result;
    },
  };
}
