import { encryptText, decryptText } from './crypto.js';
import { readTabKey, rememberTabKey, forgetTabKey } from './tab-key.js';
const operations = {
  dm_create_debt: 'debt',
  dm_update_debt_metadata: 'metadata',
  dm_post_event: 'event',
  dm_change_rate: 'rate',
  dm_void_last_event: 'void',
};
const protectedFields = {
  debt: ['title', 'creditor', 'note'],
  metadata: ['title', 'creditor', 'note'],
  event: ['note'],
  rate: ['note'],
  void: ['void_reason'],
  creation: ['title', 'creditor', 'note'],
  reminder: ['title'],
  audit: ['snapshot'],
};
const marker =
  /@jn1:(debt|metadata|event|rate|void|creation|reminder|audit):([\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})$/i;
const failure = () => new Error('ปลดล็อกข้อมูลส่วนตัวก่อนใช้งาน');
export function createPrivateClient(raw, enabled, promptUnlock = null) {
  let owner = null,
    key = null,
    record = null,
    version = null,
    revision = 0;
  const writes = new Map(),
    reads = new Map(),
    cipherRows = new Map();
  const vault = {
    enabled,
    get owner() {
      return owner;
    },
    get record() {
      return record;
    },
    get version() {
      return version;
    },
    get unlocked() {
      return Boolean(key);
    },
    async migrate(onProgress) {
      if (!enabled || !key || !owner) throw failure();
      const current = revision,
        user = owner,
        activeKey = key;
      const groups = {
        debts: 'metadata',
        creation: 'creation',
        events: 'event',
        voids: 'void',
        rates: 'rate',
        reminders: 'reminder',
        audit: 'audit',
      };
      let count = 0;
      for (const [kind, operation] of Object.entries(groups)) {
        const seen = new Set();
        while (true) {
          if (current !== revision) throw failure();
          const result = await raw.rpc('dm_private_legacy', { p_kind: kind });
          if (result.error || !Array.isArray(result.data))
            throw new Error('อ่านข้อมูลเดิมไม่สำเร็จ การย้ายยังไม่ครบ');
          if (!result.data.length) break;
          for (const row of result.data) {
            if (seen.has(row.id) || current !== revision)
              throw new Error('ข้อมูลเปลี่ยนระหว่างย้าย กรุณาลองใหม่');
            seen.add(row.id);
            const context = crypto.randomUUID();
            const ciphertext = await encryptText(activeKey, user, context, operation, row.texts);
            if (current !== revision) throw failure();
            const saved = await raw.rpc('dm_private_migrate', {
              p_kind: kind,
              p_id: row.id,
              p_fingerprint: row.fingerprint,
              p_context: context,
              p_ciphertext: ciphertext,
            });
            if (saved.error) throw new Error('ย้ายข้อมูลยังไม่ครบ กรุณาลองใหม่ ระบบจะทำต่อเฉพาะส่วนที่เหลือ');
            onProgress?.(++count);
          }
        }
      }
      for (const kind of Object.keys(groups)) {
        const remaining = await raw.rpc('dm_private_legacy', { p_kind: kind });
        if (
          current !== revision ||
          remaining.error ||
          !Array.isArray(remaining.data) ||
          remaining.data.length
        )
          throw new Error('ยังมีข้อมูลเดิมเหลือหรือมีการแก้ไขจากแท็บอื่น กรุณาลองย้ายต่อ');
      }
      reads.clear();
      cipherRows.clear();
      return count;
    },
    async exit() {
      const result = await raw.auth.signOut({ scope: 'local' });
      if (result.error) throw new Error('ออกจากระบบไม่สำเร็จ กรุณาลองใหม่');
      vault.lock();
    },
    async prepare(userId) {
      if (!enabled) return;
      const current = ++revision;
      key = null;
      record = null;
      version = null;
      writes.clear();
      reads.clear();
      cipherRows.clear();
      owner = userId;
      const result = await raw
        .from('private_text_keys')
        .select('wrapped_key,version')
        .eq('user_id', owner)
        .maybeSingle();
      if (current !== revision) throw failure();
      if (result.error) throw new Error('ยังเปิดระบบเข้ารหัสไม่ได้ กรุณาตรวจการติดตั้งฐานข้อมูล');
      record = result.data?.wrapped_key ?? null;
      version = result.data?.version ?? null;
      key = record ? await readTabKey(owner, version) : null;
      if (current !== revision) {
        key = null;
        throw failure();
      }
      if (!key) {
        const requestUnlock = promptUnlock || (await import('./vault-ui.js')).requestUnlock;
        await requestUnlock(vault);
      }
      if (current !== revision || !key) throw failure();
    },
    async setup(candidate, remember) {
      const current = revision,
        user = owner;
      const result = await raw.rpc('dm_private_setup', { p_wrapped_key: candidate.record });
      if (result.error || current !== revision)
        throw new Error('บันทึกกุญแจไม่สำเร็จ กรุณาลองใหม่ ห้ามทิ้งรหัสกู้คืน');
      record = candidate.record;
      version = result.data;
      await vault.accept(candidate.key, remember);
      if (owner !== user) throw failure();
    },
    async accept(unlockedKey, remember) {
      if (!owner || !record || unlockedKey.extractable) throw failure();
      if (unlockedKey.algorithm?.name !== 'AES-GCM' || unlockedKey.algorithm.length !== 256)
        throw failure();
      key = unlockedKey;
      if (remember) {
        try {
          await rememberTabKey(owner, version, key);
        } catch {
          await forgetTabKey(owner);
          return false;
        }
      }
      if (!remember) await forgetTabKey(owner);
      return true;
    },
    async replacePassword(nextRecord) {
      const current = revision;
      const result = await raw.rpc('dm_private_rewrap', {
        p_wrapped_key: nextRecord,
        p_expected_version: version,
      });
      if (result.error || current !== revision)
        throw new Error('เปลี่ยนรหัสปลดล็อกไม่สำเร็จ กรุณาเปิดหน้าใหม่');
      record = nextRecord;
      version = result.data;
      await forgetTabKey(owner);
    },
    lock() {
      revision++;
      if (owner) void forgetTabKey(owner);
      owner = null;
      key = null;
      record = null;
      version = null;
      writes.clear();
      reads.clear();
      cipherRows.clear();
    },
  };
  raw.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT' || (owner && session?.user?.id !== owner)) vault.lock();
  });
  async function privateValues(operation, id) {
    if (!enabled || !key || !owner) throw failure();
    const cacheId = `${operation}:${id}`;
    if (!reads.has(cacheId)) {
      const current = revision,
        activeKey = key,
        user = owner;
      const loading = (async () => {
        const result = cipherRows.has(cacheId)
          ? { data: cipherRows.get(cacheId) }
          : await raw
              .from('private_texts')
              .select('operation,ciphertext')
              .eq('user_id', user)
              .eq('id', id)
              .single();
        if (result.error || result.data?.operation !== operation || current !== revision)
          throw failure();
        const values = await decryptText(activeKey, user, id, operation, result.data.ciphertext);
        if (current !== revision || !values || typeof values !== 'object' || Array.isArray(values))
          throw failure();
        for (const field of protectedFields[operation]) {
          if (operation === 'audit') {
            if (!values.snapshot || typeof values.snapshot !== 'object') throw failure();
            continue;
          }
          if (values[field] !== null && typeof values[field] !== 'string') throw failure();
          const limit =
            field === 'note'
              ? 2000
              : field === 'void_reason'
                ? 500
                : operation === 'reminder'
                  ? 200
                  : 150;
          if (values[field]?.length > limit) throw failure();
        }
        return values;
      })();
      reads.set(cacheId, loading);
      loading.catch(() => {
        if (reads.get(cacheId) === loading) reads.delete(cacheId);
      });
    }
    return reads.get(cacheId);
  }
  async function reveal(value) {
    if (Array.isArray(value)) return Promise.all(value.map(reveal));
    if (!value || typeof value !== 'object') return value;
    if (typeof value._private === 'string') {
      const match = value._private.match(marker);
      if (match?.[1] === 'audit' && ['old_data', 'new_data'].includes(value.part)) {
        return (await privateValues('audit', match[2])).snapshot[value.part];
      }
    }
    const copy = { ...value };
    for (const [field, item] of Object.entries(value)) {
      if (typeof item === 'string' && ['title', 'note', 'void_reason'].includes(field)) {
        const match = item.match(marker);
        if (match) {
          const values = await privateValues(match[1], match[2]);
          if (!(field in values)) throw failure();
          copy[field] =
            field === 'title' ? item.slice(0, match.index) + values.title : values[field];
          if (field === 'title' && Object.hasOwn(copy, 'creditor')) copy.creditor = values.creditor;
        }
      } else if (item && typeof item === 'object') copy[field] = await reveal(item);
    }
    return copy;
  }
  async function resultWithText(result) {
    if (!result.error && result.data) {
      const needed = new Map();
      const collect = (value) => {
        if (!value || typeof value !== 'object') return;
        for (const [field, item] of Object.entries(value)) {
          if (
            typeof item === 'string' &&
            ['title', 'note', 'void_reason', '_private'].includes(field)
          ) {
            const match = item.match(marker);
            if (
              match &&
              !reads.has(`${match[1]}:${match[2]}`) &&
              !cipherRows.has(`${match[1]}:${match[2]}`)
            )
              needed.set(match[2], match[1]);
          } else if (item && typeof item === 'object') collect(item);
        }
      };
      collect(result.data);
      if (needed.size && (!enabled || !key || !owner)) throw failure();
      const ids = [...needed.keys()],
        current = revision;
      // Fetch one batch for a list instead of one API call for each debt.
      for (let offset = 0; offset < ids.length; offset += 100) {
        const batch = ids.slice(offset, offset + 100);
        const response = await raw
          .from('private_texts')
          .select('id,operation,ciphertext')
          .eq('user_id', owner)
          .in('id', batch);
        if (response.error || !Array.isArray(response.data) || current !== revision)
          throw failure();
        for (const id of batch) {
          const row = response.data.find(
            (row) => row.id === id && row.operation === needed.get(id),
          );
          if (!row) throw failure();
          cipherRows.set(`${row.operation}:${id}`, row);
        }
      }
    }
    return result.error || result.data === null
      ? result
      : { ...result, data: await reveal(result.data) };
  }
  function queryProxy(query) {
    return new Proxy(query, {
      get(target, property) {
        if (property === 'then')
          return (resolve, reject) =>
            Promise.resolve(target).then(resultWithText).then(resolve, reject);
        const value = Reflect.get(target, property);
        return typeof value === 'function'
          ? (...args) => {
              const next = value.apply(target, args);
              return next && typeof next === 'object' && typeof next.then === 'function'
                ? queryProxy(next)
                : next;
            }
          : value;
      },
    });
  }
  async function rpc(name, payload = {}, options) {
    const operation = operations[name];
    if (enabled && operation) {
      if (!key || !owner) throw failure();
      const current = revision,
        values = {},
        safe = { ...payload };
      for (const field of protectedFields[operation]) {
        const parameter = field === 'void_reason' ? 'p_reason' : `p_${field}`;
        values[field] = safe[parameter] ?? null;
        delete safe[parameter];
      }
      const context = payload.p_request_id || crypto.randomUUID();
      const fingerprint = JSON.stringify({ operation, payload });
      // Stable ciphertext for retries: an IV is random once for each immutable request.
      if (writes.has(context) && writes.get(context).fingerprint !== fingerprint)
        throw new Error('รหัสรายการซ้ำกับข้อมูลคนละชุด');
      if (!writes.has(context))
        writes.set(context, {
          fingerprint,
          ciphertext: encryptText(key, owner, context, operation, values),
        });
      const ciphertext = await writes.get(context).ciphertext;
      if (current !== revision) throw failure();
      return resultWithText(
        await raw.rpc(
          'dm_private_write',
          { p_operation: operation, p_payload: safe, p_context: context, p_ciphertext: ciphertext },
          options,
        ),
      );
    }
    if (enabled && name === 'dm_list_debts' && payload.p_search) {
      const search = payload.p_search.trim().toLocaleLowerCase('th'),
        matches = [];
      let cursor = {
        p_before_created_at: payload.p_before_created_at,
        p_before_id: payload.p_before_id,
      };
      const limit = payload.p_limit || 25;
      while (matches.length < limit) {
        const result = await resultWithText(
          await raw.rpc(name, { ...payload, ...cursor, p_search: null }, options),
        );
        if (result.error) return result;
        if (!Array.isArray(result.data)) throw new Error('อ่านรายการหนี้ไม่สำเร็จ');
        matches.push(
          ...result.data.filter(({ debt }) =>
            [debt.title, debt.creditor].some((text) =>
              text?.toLocaleLowerCase('th').includes(search),
            ),
          ),
        );
        if (result.data.length < limit) break;
        const last = result.data.at(-1).debt;
        if (!last.created_at || !last.id || last.id === cursor.p_before_id)
          throw new Error('อ่านหน้าถัดไปไม่สำเร็จ');
        cursor = { p_before_created_at: last.created_at, p_before_id: last.id };
      }
      return { data: matches.slice(0, limit), error: null, status: 200 };
    }
    return resultWithText(await raw.rpc(name, payload, options));
  }
  return new Proxy(raw, {
    get(target, property) {
      if (property === 'privateTextVault') return vault;
      if (property === 'rpc') return rpc;
      if (property === 'from') return (...args) => queryProxy(raw.from(...args));
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
