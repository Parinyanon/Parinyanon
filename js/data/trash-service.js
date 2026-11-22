import { checked } from './debt-service.js';
import { validDebtId } from '../core/navigation.js';
function id(value) {
  if (!validDebtId(value)) throw new Error('รหัสรายการไม่ถูกต้อง');
  return value;
}
function title(value) {
  if (typeof value !== 'string' || !value || value.length > 150) throw new Error('ชื่อหนี้ไม่ถูกต้อง');
  return value;
}
export function trashError(error) {
  if (error.code === 'PGRST202' || error.code === '42883')
    return 'ถังขยะยังไม่เปิดใช้งาน กรุณาติดต่อผู้ดูแล รายการหนี้ยังไม่ถูกลบ';
  if (error.code === '42501' || error.status === 403)
    return 'ไม่พบรายการหรือไม่มีสิทธิ์จัดการ กรุณาโหลดข้อมูลใหม่';
  if (error.code === '55000')
    return 'รายการนี้ยังดำเนินการไม่ได้ อาจพ้นเวลากู้คืนหรือโครงสร้างข้อมูลเปลี่ยน กรุณาติดต่อผู้ดูแล';
  if (error.code === '40001') return 'ข้อมูลหนี้เปลี่ยนแล้ว กรุณาปิดหน้าต่างและโหลดใหม่';
  return 'ยังยืนยันผลไม่ได้ กรุณาลองอีกครั้ง หรือเปิดถังขยะเพื่อตรวจสถานะ';
}
export function createTrashService(client) {
  async function mutate(name, payload, expected) {
    const value = await checked(client.rpc(name, payload));
    if (!validDebtId(value) || value !== expected)
      throw Object.assign(new Error('ยังยืนยันผลไม่ได้'), { uncertain: true });
    return value;
  }
  return {
    async list(cursor = null) {
      const rows = await checked(
        client.rpc('dm_list_debt_trash', {
          p_before: cursor?.deleted_at ?? null,
          p_before_id: cursor?.id ?? null,
        }),
      );
      if (
        !Array.isArray(rows) ||
        rows.some(
          (row) =>
            !validDebtId(row.id) ||
            !validDebtId(row.debt_id) ||
            typeof row.title !== 'string' ||
            !Number.isFinite(Date.parse(row.deleted_at)) ||
            !Number.isFinite(Date.parse(row.expires_at)),
        )
      )
        throw new Error('ข้อมูลถังขยะไม่ถูกต้อง');
      return rows;
    },
    move: (debt, request) =>
      mutate(
        'dm_trash_debt',
        {
          p_debt_id: id(debt.id),
          p_request_id: id(request),
          p_title: title(debt.title),
        },
        request,
      ),
    restore: (row) => mutate('dm_restore_debt', { p_trash_id: id(row.id) }, id(row.debt_id)),
    purge: (row) =>
      mutate('dm_purge_debt_trash', { p_trash_id: id(row.id), p_title: title(row.title) }, row.id),
  };
}
