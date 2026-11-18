export function validateConfig(config) {
  const allowed = new Set([
    'supabaseUrl',
    'supabaseKey',
    'emailRemindersReady',
    'privateTextReady',
  ]);
  if (
    !config ||
    typeof config !== 'object' ||
    Array.isArray(config) ||
    Object.keys(config).some((key) => !allowed.has(key))
  )
    throw new Error('public config มีค่าที่ไม่อนุญาต ห้ามใส่รหัสผ่านหรือคีย์หลังบ้าน');
  for (const flag of ['emailRemindersReady', 'privateTextReady'])
    if (Object.hasOwn(config, flag) && typeof config[flag] !== 'boolean')
      throw new Error('ค่าการเปิดฟังก์ชันใน public config ต้องเป็น true หรือ false');
  if (config?.supabaseUrl !== 'https://zyahvjrnjthsdyvylktw.supabase.co') {
    throw new Error('กรุณาใช้ URL ของโครงการ Supabase ที่ระบุในเอกสาร');
  }
  const key = config.supabaseKey;
  if (typeof key !== 'string' || !key.trim())
    throw new Error('ยังไม่ได้ตั้งค่า publishable key ใน js/config.local.js');
  if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) return config;
  // Legacy anon keys เป็น JWT: อ่านเฉพาะ role เพื่อป้องกันการวาง service-role key ผิดที่
  try {
    const payload = key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    if (JSON.parse(atob(payload)).role === 'anon') return config;
  } catch {
    /* แสดงข้อความเดียวกันโดยไม่เปิดเผย key */
  }
  throw new Error(
    'ใช้ได้เฉพาะ publishable key หรือ anon key ห้ามใช้ secret key, service-role key หรือ session token',
  );
}
