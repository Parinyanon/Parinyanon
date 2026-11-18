import { authReady } from '../auth/auth.js';
import { requestUnlock } from './vault-ui.js';
const auth = await authReady;
if (auth?.session) {
  const vault = auth.client.privateTextVault;
  const status = document.querySelector('#privacy-status');
  status.textContent = vault?.enabled
    ? 'เปิดการเข้ารหัสข้อความใหม่แล้ว กดย้ายข้อมูลเดิมเพื่อเข้ารหัสข้อความ ประวัติ และแจ้งเตือนเก่าของบัญชีนี้'
    : 'การเข้ารหัสข้อความยังไม่เปิดให้ใช้งาน กรุณาติดต่อผู้ดูแลก่อนเก็บข้อความสำคัญ ข้อความปัจจุบันยังไม่ได้เข้ารหัสแบบนี้';
  const change = document.querySelector('#privacy-change'),
    lock = document.querySelector('#privacy-lock');
  change.disabled = lock.disabled = !vault?.enabled;
  const migrate = document.querySelector('#privacy-migrate');
  migrate.disabled = !vault?.enabled;
  migrate.addEventListener('click', async () => {
    if (!document.querySelector('#privacy-migrate-confirm').checked) {
      status.textContent = 'ยืนยันว่าเก็บรหัสกู้คืนและเข้าใจเรื่องสำเนาสำรองก่อน';
      return;
    }
    migrate.disabled = change.disabled = lock.disabled = true;
    const stopLeaving = (event) => {
      event.preventDefault();
      event.returnValue = '';
    };
    addEventListener('beforeunload', stopLeaving);
    try {
      const count = await vault.migrate((count) => {
        status.textContent = `กำลังเข้ารหัสข้อมูลเดิม ${count} ส่วน กรุณาเปิดหน้านี้ไว้…`;
      });
      status.textContent = `ย้ายข้อมูลปัจจุบันครบแล้ว ${count} ส่วน สำเนาสำรองและไฟล์ที่เคยส่งออกยังต้องดูแลแยก`;
    } catch (error) {
      status.textContent = error.message;
    } finally {
      removeEventListener('beforeunload', stopLeaving);
      migrate.disabled = change.disabled = lock.disabled = false;
    }
  });
  change.addEventListener('click', async () => {
    try {
      if ((await requestUnlock(vault, true)) !== false)
        status.textContent = 'เปลี่ยนรหัสปลดล็อกแล้ว รหัสกู้คืนเดิมยังใช้ได้';
    } catch {
      /* The unlock dialog handles cancellation. */
    }
  });
  lock.addEventListener('click', () => {
    vault.lock();
    location.reload();
  });
}
