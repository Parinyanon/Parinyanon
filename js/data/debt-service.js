// RPC signatures ตรวจจาก CSV ที่ส่งออกจาก Supabase ของโครงการเดิม
const validId = (value) =>
  typeof value === 'string' && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value);
function eventMatches(row, payload) {
  if (
    !validId(row?.id) ||
    row.debt_id !== payload.p_debt_id ||
    row.kind !== payload.p_kind ||
    row.occurred_on !== payload.p_occurred_on ||
    row.voided_at != null
  )
    return false;
  const amount = (value) => {
    const text = String(value);
    if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new Error();
    const [whole, fraction = ''] = text.split('.');
    return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  };
  try {
    return payload.p_amount === null
      ? amount(row.amount) >= 0n
      : amount(row.amount) === amount(payload.p_amount);
  } catch {
    return false;
  }
}
export function decimal(value) {
  const text = String(value).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text))
    throw new Error('กรอกเงินเป็นตัวเลขบวกและทศนิยมไม่เกิน 2 ตำแหน่ง');
  const [whole, fraction = ''] = text.split('.');
  if (BigInt(whole) === 0n && Number(fraction || 0) === 0) throw new Error('จำนวนเงินต้องมากกว่า 0');
  return `${BigInt(whole)}.${fraction.padEnd(2, '0')}`;
}
export function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('กรุณาระบุวันที่ให้ครบ');
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value)
    throw new Error('วันที่ไม่ถูกต้อง');
  return value;
}
export function ratePercent(value) {
  const text = String(value).trim();
  if (!/^\d+(?:\.\d{1,6})?$/.test(text))
    throw new Error('อัตราดอกเบี้ยต้องเป็นเลขตั้งแต่ 0 ถึง 1,000 และทศนิยมไม่เกิน 6 ตำแหน่ง');
  const [whole, fraction = ''] = text.split('.');
  if (BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0')) > 1000000000n)
    throw new Error('อัตราดอกเบี้ยต้องไม่เกิน 1,000% ต่อคาบ');
  const trimmed = fraction.replace(/0+$/, '');
  return `${BigInt(whole)}${trimmed ? `.${trimmed}` : ''}`;
}
function ratePeriod(value) {
  if (!['day', 'month', 'year'].includes(value)) throw new Error('เลือกคาบดอกเบี้ยต่อวัน เดือน หรือปี');
  return value;
}
function boundedAmount(value, allowZero = false) {
  if (allowZero && /^0+(?:\.0{1,2})?$/.test(String(value).trim())) return '0';
  const amount = decimal(value);
  const [whole, fraction] = amount.split('.');
  if (BigInt(whole) * 100n + BigInt(fraction) > 99999999999999n)
    throw new Error('จำนวนเงินสูงสุด 999,999,999,999.99 บาท');
  return amount;
}
export function createDebtPayload(fields, today = null) {
  const title = String(fields.title ?? '').trim();
  if (!title || title.length > 150) throw new Error('ระบุชื่อหนี้ไม่เกิน 150 ตัวอักษร');
  if (String(fields.creditor ?? '').trim().length > 150)
    throw new Error('ระบุชื่อเจ้าหนี้ไม่เกิน 150 ตัวอักษร');
  const category = String(fields.category ?? '');
  if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(category))
    throw new Error('กรุณาเลือกหมวดหมู่');
  const method = fields.interest_method ?? 'none';
  if (!['none', 'simple_daily'].includes(method)) throw new Error('เลือกไม่มีดอกเบี้ยหรือดอกเบี้ยอย่างง่าย');
  const openingDate = validDate(String(fields.opening_date ?? ''));
  if (today && openingDate > today) throw new Error('วันที่เริ่มนับหนี้ต้องไม่ใช่วันในอนาคต');
  const note = String(fields.note ?? '').trim();
  if (note.length > 2000) throw new Error('หมายเหตุต้องไม่เกิน 2,000 ตัวอักษร');
  return {
    p_category_id: category,
    p_title: title,
    p_principal: boundedAmount(fields.principal),
    p_opening_date: openingDate,
    p_interest_method: method,
    p_rate_percent: method === 'simple_daily' ? ratePercent(fields.rate_percent) : '0',
    p_rate_period: method === 'simple_daily' ? ratePeriod(fields.rate_period) : 'year',
    p_opening_interest: boundedAmount(fields.opening_interest ?? '0', true),
    p_creditor: String(fields.creditor ?? '').trim() || null,
    p_due_on: fields.due_on ? validDate(String(fields.due_on)) : null,
    p_note: note || null,
  };
}
export async function checked(request) {
  let result;
  try {
    result = await request;
  } catch {
    throw Object.assign(new Error('ติดต่อฐานข้อมูลไม่ได้'), { uncertain: true });
  }
  if (result.error) {
    const uncertain =
      !result.status || result.status >= 500 || ['57014', 'PGRST003'].includes(result.error.code);
    throw Object.assign(new Error('ฐานข้อมูลไม่รับคำขอ'), {
      code: result.error.code,
      status: result.status,
      uncertain,
      reason: [
        'Payment exceeds total due',
        'Only latest active event can be voided',
        'Debt is archived',
        'Unarchive debt before correction',
        'Event already voided',
        'Request ID reused or voided',
        'Invalid rate/date; cannot change settled history',
        'Allocation exceeds payment or installment',
        'Invalid installment allocation',
        'permission denied for table categories',
        'new row violates row-level security policy for table "categories"',
        'permission denied for schema public',
      ].includes(result.error.message)
        ? result.error.message
        : null,
    });
  }
  return result.data;
}
export function createDebtService(client) {
  return {
    categories: async () => {
      const rows = await checked(client.from('categories').select('*'));
      if (!Array.isArray(rows)) throw new Error('รูปแบบหมวดหมู่ไม่ถูกต้อง');
      return rows;
    },
    list: async ({
      search = '',
      category = null,
      archived = false,
      cursor = null,
      limit = 25,
    } = {}) => {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        throw new Error('จำนวนรายการต่อคำขอไม่ถูกต้อง');
      const rows = await checked(
        client.rpc('dm_list_debts', {
          p_limit: limit,
          p_before_created_at: cursor?.created_at ?? null,
          p_before_id: cursor?.id ?? null,
          p_archived: archived,
          p_search: search.trim() || null,
          p_category_id: category || null,
        }),
      );
      if (!Array.isArray(rows) || rows.some((row) => !row.debt || typeof row.debt.id !== 'string'))
        throw new Error('รูปแบบรายการหนี้ไม่ตรงกับ RPC ที่คาดไว้');
      return rows;
    },
    create: async (payload, requestId) => {
      const result = await checked(
        client.rpc('dm_create_debt', { ...payload, p_request_id: requestId }),
      );
      const debt = Array.isArray(result) && result.length === 1 ? result[0] : result;
      if (!validId(debt?.id))
        throw Object.assign(new Error('ยังยืนยันผลบันทึกไม่ได้'), { uncertain: true });
      return debt;
    },
    debt: async (id) => {
      const row = await checked(
        client
          .from('debts')
          .select(
            'id,category_id,title,creditor,note,opening_date,opening_principal,opening_interest,principal_balance::text,interest_method,rate_percent,rate_period,balance_date,due_on,is_archived',
          )
          .eq('id', id)
          .maybeSingle(),
      );
      if (!row || row.id !== id)
        throw Object.assign(new Error('ไม่พบหนี้หรือไม่มีสิทธิ์เข้าถึง'), { code: '42501' });
      return row;
    },
    balance: async (id) => {
      const row = await checked(client.rpc('dm_get_balance', { p_debt_id: id, p_as_of: null }));
      // ชื่อฟิลด์ตรวจจาก dm_get_overview ซึ่งอ่านผล debt_private.balance เช่นเดียวกัน
      const keys = ['principal', 'interest', 'fee', 'tax', 'total_due'];
      if (
        !row ||
        keys.some((key) =>
          typeof row[key] === 'number'
            ? !Number.isFinite(row[key]) || row[key] < 0
            : typeof row[key] !== 'string' || !/^[0-9]+(?:\.[0-9]+)?$/.test(row[key]),
        )
      )
        throw new Error('รูปแบบยอดคงเหลือไม่ถูกต้อง');
      return row;
    },
    history: async (id, before = null) => {
      let query = client
        .from('debt_events')
        .select(
          'id,debt_id,event_seq::text,kind,amount::text,occurred_on,note,principal_paid::text,interest_paid::text,fee_paid::text,tax_paid::text,voided_at,void_reason',
        )
        .eq('debt_id', id)
        .order('event_seq', { ascending: false })
        .limit(25);
      if (before !== null) query = query.lt('event_seq', before);
      const rows = await checked(query);
      if (
        !Array.isArray(rows) ||
        rows.some((row) => row.debt_id !== id || !/^\d+$/.test(row.event_seq))
      )
        throw new Error('รูปแบบประวัติไม่ถูกต้อง');
      return rows;
    },
    latestActive: async (id) =>
      checked(
        client
          .from('debt_events')
          .select('id,debt_id,event_seq::text,kind,amount::text,occurred_on')
          .eq('debt_id', id)
          .is('voided_at', null)
          .order('event_seq', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ),
    paymentByRequest: async (debtId, requestId) => {
      if (!validId(debtId) || !validId(requestId)) throw new Error('รหัสรายการไม่ถูกต้อง');
      const row = await checked(
        client
          .from('debt_events')
          .select('id,debt_id,request_id,kind,amount::text,occurred_on,voided_at')
          .eq('debt_id', debtId)
          .eq('request_id', requestId)
          .maybeSingle(),
      );
      if (row === null) return null;
      if (
        !validId(row?.id) ||
        row.debt_id !== debtId ||
        row.request_id !== requestId ||
        row.kind !== 'payment' ||
        !(
          row.voided_at === null ||
          (typeof row.voided_at === 'string' && Number.isFinite(Date.parse(row.voided_at)))
        )
      )
        throw new Error('ยังยืนยันผลรายการเดิมไม่ได้');
      decimal(row.amount);
      validDate(row.occurred_on);
      return row;
    },
    pay: async (payload, requestId) => {
      if (payload.p_kind !== 'payment')
        throw Object.assign(new Error('ชนิดรายการชำระไม่ถูกต้อง'), { uncertain: false, code: '22023' });
      const result = await checked(
        client.rpc('dm_post_event', { ...payload, p_request_id: requestId }),
      );
      const row = Array.isArray(result) && result.length === 1 ? result[0] : result;
      if (!eventMatches(row, payload))
        throw Object.assign(new Error('ยังยืนยันผลชำระไม่ได้'), { uncertain: true });
      return row;
    },
    voidEvent: async (payload, requestId) => {
      const result = await checked(
        client.rpc('dm_void_last_event', { ...payload, p_request_id: requestId }),
      );
      const row = Array.isArray(result) && result.length === 1 ? result[0] : result;
      if (!row || row.id !== payload.p_event_id || !row.voided_at)
        throw Object.assign(new Error('ยังยืนยันผลย้อนรายการไม่ได้'), { uncertain: true });
      return row;
    },
    rates: async (id, before = null) => {
      let query = client
        .from('debt_rate_changes')
        .select('id,debt_id,effective_on,rate_percent::text,rate_period,note')
        .eq('debt_id', id)
        .order('effective_on', { ascending: false })
        .limit(25);
      if (before !== null) query = query.lt('effective_on', before);
      const rows = await checked(query);
      if (
        !Array.isArray(rows) ||
        rows.some((row) => row.debt_id !== id || !/^\d{4}-\d{2}-\d{2}$/.test(row.effective_on))
      )
        throw new Error('รูปแบบประวัติอัตราไม่ถูกต้อง');
      return rows;
    },
    changeRate: async (payload, requestId) => {
      const result = await checked(
        client.rpc('dm_change_rate', { ...payload, p_request_id: requestId }),
      );
      const row = Array.isArray(result) && result.length === 1 ? result[0] : result;
      let returnedRate;
      try {
        returnedRate = ratePercent(row?.rate_percent);
      } catch {
        /* ไม่ถือ response ผิดรูปแบบว่าสำเร็จ */
      }
      if (
        typeof row?.id !== 'string' ||
        row.debt_id !== payload.p_debt_id ||
        row.effective_on !== payload.p_effective_on ||
        row.rate_period !== payload.p_rate_period ||
        returnedRate !== payload.p_rate_percent
      ) {
        throw Object.assign(new Error('ยังยืนยันผลเปลี่ยนอัตราไม่ได้'), { uncertain: true });
      }
      return row;
    },
    metadata: async (payload) => {
      const result = await checked(client.rpc('dm_update_debt_metadata', payload));
      const row = Array.isArray(result) && result.length === 1 ? result[0] : result;
      if (row?.id !== payload.p_debt_id)
        throw Object.assign(new Error('ยังยืนยันผลแก้ไขไม่ได้'), { uncertain: true });
      return row;
    },
    charge: async (payload, requestId) => {
      if (!['fee', 'tax'].includes(payload.p_kind))
        throw Object.assign(new Error('ชนิดค่าใช้จ่ายไม่ถูกต้อง'), { uncertain: false, code: '22023' });
      const result = await checked(
        client.rpc('dm_post_event', { ...payload, p_request_id: requestId }),
      );
      const row = Array.isArray(result) && result.length === 1 ? result[0] : result;
      if (!eventMatches(row, payload))
        throw Object.assign(new Error('ยังยืนยันผลเพิ่มค่าใช้จ่ายไม่ได้'), { uncertain: true });
      return row;
    },
  };
}
export function metadataPayload(id, fields) {
  const title = String(fields.title ?? '').trim(),
    creditor = String(fields.creditor ?? '').trim(),
    note = String(fields.note ?? '').trim();
  if (!title || title.length > 150 || creditor.length > 150 || note.length > 2000)
    throw new Error('ตรวจชื่อหนี้ เจ้าหนี้ และหมายเหตุอีกครั้ง');
  if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(fields.category ?? ''))
    throw new Error('เลือกประเภทหนี้');
  return {
    p_debt_id: id,
    p_title: title,
    p_category_id: fields.category,
    p_creditor: creditor || null,
    p_due_on: fields.due_on ? validDate(fields.due_on) : null,
    p_note: note || null,
    p_is_archived: fields.archived === 'on',
  };
}
export function chargePayload(id, fields, balanceDate, today) {
  if (!['fee', 'tax'].includes(fields.kind)) throw new Error('เลือกค่าธรรมเนียมหรือภาษี');
  const date = validDate(String(fields.occurred_on ?? ''));
  if (date < balanceDate || date > today) throw new Error('เลือกวันตั้งแต่ยอดที่ยืนยันล่าสุดถึงวันนี้');
  const percentage = fields.calculation === 'percentage';
  const rate = percentage ? ratePercent(fields.rate) : null;
  if (percentage && rate === '0') throw new Error('เปอร์เซ็นต์ต้องมากกว่า 0');
  const note = String(fields.note ?? '').trim();
  if (note.length > 2000) throw new Error('หมายเหตุยาวเกิน 2,000 ตัวอักษร');
  return {
    p_debt_id: id,
    p_kind: fields.kind,
    p_amount: percentage ? null : boundedAmount(fields.amount),
    p_occurred_on: date,
    p_note: note || null,
    p_calculation_base: percentage ? boundedAmount(fields.base) : null,
    p_calculation_rate_percent: rate,
  };
}

export function paymentPayload(debtId, fields, balanceDate, today) {
  const amount = decimal(fields.amount);
  const [whole, fraction] = amount.split('.');
  if (BigInt(whole) * 100n + BigInt(fraction) > 99999999999999n)
    throw new Error('ยอดชำระสูงสุด 999,999,999,999.99 บาท');
  const date = validDate(String(fields.occurred_on ?? ''));
  if (date > today || date < balanceDate)
    throw new Error('วันที่ชำระต้องไม่เก่ากว่าวันยอดที่ยืนยันล่าสุด และไม่ใช่วันในอนาคต');
  const note = String(fields.note ?? '').trim();
  if (note.length > 2000) throw new Error('หมายเหตุต้องไม่เกิน 2,000 ตัวอักษร');
  return {
    p_debt_id: debtId,
    p_kind: 'payment',
    p_amount: amount,
    p_occurred_on: date,
    p_note: note || null,
    p_calculation_base: null,
    p_calculation_rate_percent: null,
  };
}
export function voidPayload(eventId, reason) {
  const trimmed = String(reason ?? '').trim();
  if (!trimmed || trimmed.length > 500) throw new Error('ระบุเหตุผลย้อนรายการ 1–500 ตัวอักษร');
  return { p_event_id: eventId, p_reason: trimmed };
}
export function ratePayload(debtId, fields, balanceDate, today) {
  const effective = validDate(String(fields.effective_on ?? ''));
  if (effective < balanceDate || effective > today)
    throw new Error('วันที่มีผลต้องไม่เก่ากว่าวันยอดที่ยืนยันล่าสุด และไม่ใช่วันในอนาคต');
  const note = String(fields.note ?? '').trim();
  if (note.length > 2000) throw new Error('หมายเหตุต้องไม่เกิน 2,000 ตัวอักษร');
  return {
    p_debt_id: debtId,
    p_effective_on: effective,
    p_rate_percent: ratePercent(fields.rate_percent),
    p_rate_period: ratePeriod(fields.rate_period),
    p_note: note || null,
  };
}
// แต่ละ draft มี ID และ payload เดียว ใช้ซ้ำตลอดเมื่อ retry ไม่สร้าง ID ใหม่
export function createSubmission(service, payload, newId = () => crypto.randomUUID()) {
  const requestId = newId();
  const snapshot = Object.freeze({ ...payload });
  let inFlight;
  return {
    requestId,
    send() {
      if (!inFlight)
        inFlight = Promise.resolve()
          .then(() => service.create(snapshot, requestId))
          .finally(() => {
            inFlight = null;
          });
      return inFlight;
    },
  };
}
