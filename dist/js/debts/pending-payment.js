// Recovery references only: no amount, note, title, password or token is stored.
const uuid = (value) =>
  typeof value === 'string' && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value);
function storageOrNull() {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}
const key = (owner, debt) =>
  uuid(owner) && uuid(debt) ? `dm:pending-payment:${owner}:${debt}` : null;
export function readPendingPayment(owner, debt, storage = storageOrNull()) {
  try {
    const name = key(owner, debt);
    if (!name || !storage) return null;
    const data = JSON.parse(storage.getItem(name) || 'null');
    if (!uuid(data?.requestId)) return null;
    const context =
      uuid(data.planId) && uuid(data.installmentId)
        ? { planId: data.planId, installmentId: data.installmentId }
        : {};
    return {
      requestId: data.requestId,
      ...context,
      ...(uuid(data.eventId) ? { eventId: data.eventId } : {}),
    };
  } catch {
    return null;
  }
}
export function rememberPendingPayment(owner, debt, data, storage = storageOrNull()) {
  try {
    const name = key(owner, debt);
    if (!name || !storage || !uuid(data.requestId)) return false;
    const safe = { requestId: data.requestId };
    if (uuid(data.eventId)) safe.eventId = data.eventId;
    if (uuid(data.planId) && uuid(data.installmentId)) {
      safe.planId = data.planId;
      safe.installmentId = data.installmentId;
    }
    storage.setItem(name, JSON.stringify(safe));
    return true;
  } catch {
    return false;
  }
}
export function clearPendingPayment(owner, debt, requestId, storage = storageOrNull()) {
  try {
    const name = key(owner, debt);
    if (name && readPendingPayment(owner, debt, storage)?.requestId === requestId)
      storage.removeItem(name);
  } catch {}
}
