// Keep the outgoing snapshot visible until this page is ready.
// The budget releases a slow page to its existing loading/error states, never waits forever.
const controllers = {
  trash: () => import('../debts/trash.js'),
  'change-password': () => import('../auth/change-password.js'),
  installments: () => import('../workspace/installments.js'),
  privacy: () => import('../privacy/privacy.js'),
  auth: () => import('../auth/auth.js'),
  debts: () => import('../debts/debts.js'),
  workspace: () => import('../workspace/workspace.js'),
  'debt-detail': () => import('../debts/debt-detail.js'),
  schedules: () => import('../schedules/schedules.js'),
  'manage-debt': () => import('../debts/manage-debt.js'),
};
const name = document.querySelector('script[data-controller]')?.dataset.controller;
document.documentElement.dataset.pageReady = 'loading';
document.documentElement.dataset.transitionReady = 'false';
let timer;
const load = Promise.resolve()
  .then(() => {
    if (!controllers[name]) throw new Error('Unknown page');
    return controllers[name]();
  })
  .then(
    () => {
      document.documentElement.dataset.pageReady = 'ready';
    },
    () => {
      document.documentElement.dataset.pageReady = 'error';
      const message = document.querySelector('#message');
      if (message) {
        message.textContent = 'โหลดหน้าไม่สำเร็จ กรุณาตรวจการเชื่อมต่อแล้วเปิดหน้าใหม่';
        message.dataset.error = 'true';
        message.setAttribute('role', 'alert');
      }
      for (const button of document.querySelectorAll('form button[type="submit"]'))
        button.disabled = true;
    },
  );
try {
  await Promise.race([
    load,
    new Promise((resolve) => {
      timer = setTimeout(resolve, 200);
    }),
  ]);
} finally {
  clearTimeout(timer);
  document.documentElement.dataset.transitionReady = 'true';
}
