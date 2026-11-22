import { createTrashService, trashError } from '../data/trash-service.js';
import { money } from '../core/format.js';
export function confirmTrash({ client, debt, balance, canAct = () => true, onDone }) {
  if (!canAct() || document.querySelector('#trash-dialog')) return;
  const request = crypto.randomUUID();
  const modal = document.createElement('dialog');
  modal.id = 'trash-dialog';
  modal.className = 'trash-dialog';
  const heading = document.createElement('h2');
  heading.id = 'trash-dialog-title';
  heading.textContent = `ลบหนี้ “${debt.title}” ?`;
  modal.setAttribute('aria-labelledby', heading.id);
  const info = document.createElement('p');
  info.textContent = `${balance != null ? `ยอดคงเหลือ ${money(balance)} บาท — ` : ''}หนี้ ประวัติชำระ และงวดจะย้ายไปถังขยะและออกจากยอดรวม กู้คืนได้ภายใน 30 วัน การซ่อนไม่ใช่การลบ`;
  const message = document.createElement('p');
  message.setAttribute('role', 'status');
  const actions = document.createElement('div');
  actions.className = 'trash-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'plain-button';
  cancel.textContent = 'ยกเลิก';
  const submit = document.createElement('button');
  submit.type = 'button';
  submit.className = 'plain-button danger-button';
  submit.textContent = 'ย้ายไปถังขยะ';
  let busy = false;
  const cleanup = () => {
    removeEventListener('pagehide', cleanup);
    modal.close();
    modal.remove();
    subscription?.unsubscribe();
  };
  let subscription;
  ({
    data: { subscription },
  } = client.auth.onAuthStateChange((_event, session) => {
    if (!session || !canAct()) cleanup();
  }));
  cancel.onclick = cleanup;
  modal.addEventListener('cancel', (event) => {
    event.preventDefault();
    if (!busy) cleanup();
  });
  submit.onclick = async () => {
    if (busy || !canAct()) return;
    busy = true;
    submit.disabled = cancel.disabled = true;
    submit.textContent = 'กำลังย้าย…';
    try {
      await createTrashService(client).move(debt, request);
      if (!canAct() || !modal.isConnected) return;
      cleanup();
      onDone();
    } catch (error) {
      if (modal.isConnected && canAct()) message.textContent = trashError(error);
    } finally {
      busy = false;
      submit.disabled = cancel.disabled = false;
      submit.textContent = 'ลองย้ายอีกครั้ง';
    }
  };
  actions.append(cancel, submit);
  modal.append(heading, info, message, actions);
  document.body.append(modal);
  modal.showModal();
  cancel.focus();
  addEventListener('pagehide', cleanup, { once: true });
}
