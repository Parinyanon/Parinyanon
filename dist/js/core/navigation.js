const pages = new Set([
  'debt-detail',
  'payment',
  'history',
  'void-event',
  'rates',
  'schedules',
  'create-schedule',
  'allocate-payment',
  'cancel-schedule',
  'edit-debt',
  'charges',
]);
export function validDebtId(id) {
  return typeof id === 'string' && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id);
}
export function debtUrl(page, id, plan = null) {
  if (!pages.has(page) || !validDebtId(id)) throw new Error('ลิงก์หน้าหนี้ไม่ถูกต้อง');
  const query = new URLSearchParams({ id });
  if (validDebtId(plan)) query.set('plan', plan);
  return `${page}.html?${query}`;
}
export function installmentPaymentUrl(debtId, planId, installmentId, paymentId = null) {
  if (![debtId, planId, installmentId].every(validDebtId) || (paymentId && !validDebtId(paymentId)))
    throw new Error('ลิงก์งวดไม่ถูกต้อง');
  const query = new URLSearchParams({ id: debtId, plan: planId, installment: installmentId });
  if (paymentId) query.set('payment', paymentId);
  return `${paymentId ? 'allocate-payment' : 'payment'}.html?${query}`;
}
export function safeReturnPath(value) {
  try {
    const url = new URL(value || 'index.html', 'https://local.invalid/');
    if (url.origin !== 'https://local.invalid') return 'index.html';
    const name = url.pathname.replace(/^\//, '');
    if (
      [
        'index.html',
        'create-debt.html',
        'overview.html',
        'installments.html',
        'reminders.html',
        'settings.html',
        'change-password.html',
        'categories.html',
        'export.html',
        'privacy.html',
      ].includes(name)
    )
      return name;
    const page = name.replace(/\.html$/, '');
    if (['payment', 'allocate-payment'].includes(page) && url.searchParams.has('installment'))
      return installmentPaymentUrl(
        url.searchParams.get('id'),
        url.searchParams.get('plan'),
        url.searchParams.get('installment'),
        page === 'allocate-payment' ? url.searchParams.get('payment') : null,
      );
    return name === `${page}.html`
      ? debtUrl(page, url.searchParams.get('id'), url.searchParams.get('plan'))
      : 'index.html';
  } catch {
    return 'index.html';
  }
}
export function connectDebtNavigation(id, plan = new URLSearchParams(location.search).get('plan')) {
  if (!validDebtId(id)) return;
  const current = location.pathname.split('/').at(-1).replace('.html', '');
  const family = ['create-schedule', 'allocate-payment', 'cancel-schedule'].includes(current)
    ? 'schedules'
    : current === 'void-event'
      ? 'history'
      : current;
  for (const link of document.querySelectorAll('[data-debt-page]')) {
    const page = link.dataset.debtPage;
    link.href = debtUrl(page, id, plan);
    if (link.closest('.task-nav') && page === family) link.setAttribute('aria-current', 'page');
  }
}
// เก็บผู้ใช้ไว้กับรายการเดิมเฉพาะระหว่างส่ง/ยังยืนยันผลไม่ได้ เพื่อให้ retry ใช้รหัสเดิม
export function protectPendingNavigation(isPending, selector) {
  const warn = () => {
    const node = document.querySelector(selector);
    if (node) {
      node.textContent = 'ยังยืนยันผลรายการนี้ไม่ได้ กรุณารอหรือส่งรายการเดิมอีกครั้งก่อนเปลี่ยนหน้า';
      node.dataset.error = 'true';
      node.setAttribute('role', 'alert');
      node.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    }
  };
  document.addEventListener('click', (event) => {
    const link = event.target.closest?.('a[href]');
    if (!link || !isPending()) return;
    const destination = new URL(link.href, location.href);
    // An app-created file download keeps this page open and does not abandon the pending work.
    const fileDownload =
      Boolean(link.download) &&
      destination.protocol === 'blob:' &&
      destination.origin === location.origin;
    if (!fileDownload && destination.origin === location.origin) {
      event.preventDefault();
      warn();
    }
  });
  addEventListener('beforeunload', (event) => {
    if (isPending()) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
}
