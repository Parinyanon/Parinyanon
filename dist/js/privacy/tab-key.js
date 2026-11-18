// Optional convenience: non-extractable key in this browser, scoped to account and tab, for 15 minutes.
// It is not an XSS boundary. Never store passwords, recovery codes, raw keys or plaintext here.
let database;
function db() {
  return (database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('jadnee-private-keys', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('keys');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('เปิดที่เก็บกุญแจไม่ได้'));
  }));
}
function tabId() {
  let id = sessionStorage.getItem('dm:private-tab');
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem('dm:private-tab', id);
  }
  return id;
}
async function operation(mode, run) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('keys', mode),
      store = transaction.objectStore('keys');
    let result;
    try {
      result = run(store);
    } catch (error) {
      reject(error);
      return;
    }
    transaction.oncomplete = () => resolve(result?.result);
    transaction.onerror = transaction.onabort = () => reject(new Error('บันทึกกุญแจในแท็บไม่ได้'));
  });
}
export async function forgetTabKey(owner) {
  try {
    await operation('readwrite', (store) => store.delete(`${owner}:${tabId()}`));
  } catch {
    /* No persistent key when storage is blocked. */
  }
}
export async function rememberTabKey(owner, version, key) {
  if (key.extractable || key.algorithm.name !== 'AES-GCM') throw new Error('กุญแจไม่ถูกต้อง');
  await operation('readwrite', (store) =>
    store.put({ key, version, expires: Date.now() + 15 * 60 * 1000 }, `${owner}:${tabId()}`),
  );
}
export async function readTabKey(owner, version) {
  try {
    const entry = await operation('readonly', (store) => store.get(`${owner}:${tabId()}`));
    if (
      entry?.version === version &&
      entry.expires > Date.now() &&
      entry.key?.extractable === false
    )
      return entry.key;
    await forgetTabKey(owner);
  } catch {
    /* Fall back to an explicit unlock. */
  }
  return null;
}
