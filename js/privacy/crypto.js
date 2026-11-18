// Web Crypto primitives only. Passwords, recovery codes and raw keys never go to the server.
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const iterations = 600000;
export function encode(bytes) {
  const data = new Uint8Array(bytes);
  let binary = '';
  for (let offset = 0; offset < data.length; offset += 32768)
    binary += String.fromCharCode(...data.subarray(offset, offset + 32768));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function decode(text, length = null) {
  if (typeof text !== 'string' || !/^[\w-]+$/.test(text) || text.length > 262144)
    throw new Error('ข้อมูลเข้ารหัสไม่ถูกต้อง');
  const bytes = Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
    c.charCodeAt(0),
  );
  if ((length !== null && bytes.length !== length) || encode(bytes) !== text)
    throw new Error('ข้อมูลเข้ารหัสไม่ถูกต้อง');
  return bytes;
}
function context(owner, purpose) {
  if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(owner)) throw new Error('บัญชีไม่ถูกต้อง');
  return encoder.encode(`jadnee-private-v1|${owner}|${purpose}`);
}
const keyFromBytes = (bytes) =>
  crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
async function passwordKey(password, salt) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}
async function sealBytes(key, bytes, aad) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const result = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 },
    key,
    bytes,
  );
  return { v: 1, iv: encode(iv), ct: encode(result) };
}
async function openBytes(key, sealed, aad) {
  if (sealed?.v !== 1 || Object.keys(sealed).sort().join(',') !== 'ct,iv,v')
    throw new Error('รุ่นข้อมูลไม่ถูกต้อง');
  const ct = decode(sealed.ct);
  if (ct.length < 16) throw new Error('ข้อมูลเข้ารหัสไม่ครบ');
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: decode(sealed.iv, 12), additionalData: aad, tagLength: 128 },
      key,
      ct,
    ),
  );
}
export function validatePassphrase(password) {
  if (typeof password !== 'string' || password.length < 16 || password.length > 256)
    throw new Error('ใช้รหัสปลดล็อก 16–256 ตัวอักษร เช่น วลีที่จำได้และเดายาก');
}
export async function createKeyRecord(owner, password) {
  validatePassphrase(password);
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const recovery = crypto.getRandomValues(new Uint8Array(32));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  try {
    const key = await keyFromBytes(raw);
    const passwordWrap = await sealBytes(
      await passwordKey(password, salt),
      raw,
      context(owner, 'password'),
    );
    const recoveryWrap = await sealBytes(
      await keyFromBytes(recovery),
      raw,
      context(owner, 'recovery'),
    );
    return {
      key,
      recoveryCode: encode(recovery),
      record: {
        v: 1,
        kdf: 'PBKDF2-SHA256',
        iterations,
        salt: encode(salt),
        password: passwordWrap,
        recovery: recoveryWrap,
      },
    };
  } finally {
    raw.fill(0);
    recovery.fill(0);
  }
}
function validateRecord(record) {
  if (record?.v !== 1 || record.kdf !== 'PBKDF2-SHA256' || record.iterations !== iterations)
    throw new Error('รูปแบบกุญแจไม่รองรับ');
  return record;
}
export async function unlockKey(owner, record, secret, recovery = false) {
  validateRecord(record);
  const wrapping = recovery
    ? await keyFromBytes(decode(secret, 32))
    : await passwordKey(secret, decode(record.salt, 16));
  const raw = await openBytes(
    wrapping,
    recovery ? record.recovery : record.password,
    context(owner, recovery ? 'recovery' : 'password'),
  );
  try {
    if (raw.length !== 32) throw new Error('กุญแจไม่ครบ');
    return await keyFromBytes(raw);
  } finally {
    raw.fill(0);
  }
}
export async function changePassphrase(owner, record, recoveryCode, password) {
  validateRecord(record);
  validatePassphrase(password);
  const raw = await openBytes(
    await keyFromBytes(decode(recoveryCode, 32)),
    record.recovery,
    context(owner, 'recovery'),
  );
  const salt = crypto.getRandomValues(new Uint8Array(16));
  try {
    return {
      ...record,
      salt: encode(salt),
      password: await sealBytes(await passwordKey(password, salt), raw, context(owner, 'password')),
    };
  } finally {
    raw.fill(0);
  }
}
export async function encryptText(key, owner, id, operation, values) {
  return sealBytes(
    key,
    encoder.encode(JSON.stringify(values)),
    context(owner, `${operation}|${id}`),
  );
}
export async function decryptText(key, owner, id, operation, sealed) {
  const bytes = await openBytes(key, sealed, context(owner, `${operation}|${id}`));
  try {
    return JSON.parse(decoder.decode(bytes));
  } finally {
    bytes.fill(0);
  }
}
