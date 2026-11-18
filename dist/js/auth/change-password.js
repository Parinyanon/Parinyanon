import { authReady } from './auth.js';
import { createAuthService, passwordChangePayload } from './auth-service.js';
const $ = (selector) => document.querySelector(selector),
  form = $('#change-password-form');
let service,
  stopped = false,
  busy = false,
  completed = false;
function status(text, error = false) {
  const node = $('#password-status');
  node.textContent = text;
  node.dataset.error = String(error);
  node.setAttribute('role', error ? 'alert' : 'status');
  if (error) node.scrollIntoView({ block: 'center', behavior: 'smooth' });
}
function controls() {
  for (const node of form.querySelectorAll('input,button'))
    node.disabled = busy || stopped || !service || completed;
  form.setAttribute('aria-busy', String(busy));
}
function explain(error) {
  const messages = {
    invalid_credentials: 'รหัสผ่านปัจจุบันไม่ถูกต้อง',
    same_password: 'ใช้รหัสผ่านใหม่ที่ต่างจากรหัสผ่านปัจจุบัน',
    weak_password: 'รหัสผ่านใหม่ไม่ผ่านข้อกำหนด กรุณาใช้รหัสที่ยาวและคาดเดายากขึ้น',
    validation_failed: 'ตรวจรหัสผ่านปัจจุบันและรหัสผ่านใหม่อีกครั้ง',
    reauthentication_not_valid: 'รหัสยืนยันไม่ถูกต้องหรือหมดอายุ กรุณาขอรหัสใหม่',
  };
  return (
    messages[error.code] ||
    (error.status === 429
      ? 'มีคำขอบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่'
      : error.status === 401
        ? 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่'
        : 'ยังยืนยันผลไม่ได้ หากเชื่อมต่อขัดข้อง รหัสผ่านอาจเปลี่ยนแล้ว ให้ออกจากระบบแล้วลองเข้าสู่ระบบด้วยรหัสใหม่')
  );
}
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!service || stopped || busy || completed || !form.reportValidity()) return;
  let payload;
  try {
    payload = passwordChangePayload(
      $('#current-password').value,
      $('#new-password').value,
      $('#confirm-new-password').value,
      $('#password-nonce').value,
    );
  } catch (error) {
    status(error.message, true);
    return;
  }
  busy = true;
  controls();
  status('กำลังเปลี่ยนรหัสผ่าน…');
  try {
    const result = await service.changePassword(payload.current, payload.password, payload.nonce);
    if (stopped) return;
    if (result?.user?.id !== auth.session.user.id) throw new Error('Unconfirmed password update');
    completed = true;
    form.reset();
    form.hidden = true;
    $('#password-success').hidden = false;
    status('เปลี่ยนรหัสผ่านเรียบร้อยแล้ว');
    $('#password-success').scrollIntoView({ block: 'center', behavior: 'smooth' });
  } catch (error) {
    if (stopped) return;
    if (error.code === 'reauthentication_needed') {
      $('#password-verification').hidden = false;
      $('#password-nonce').required = true;
      status('เพื่อยืนยันว่าเป็นคุณ กรุณากดส่งรหัสยืนยัน แล้วกรอกรหัสที่ได้รับทางอีเมล', true);
    } else status(explain(error), true);
  } finally {
    payload = null;
    busy = false;
    if (!stopped) controls();
  }
});
$('#password-send-code').addEventListener('click', async () => {
  if (!service || busy || stopped) return;
  busy = true;
  controls();
  try {
    await service.reauthenticate();
    if (!stopped) status('ส่งรหัสยืนยันแล้ว ตรวจกล่องจดหมายและสแปมของอีเมลบัญชีนี้');
  } catch (error) {
    if (!stopped)
      status(
        error.status === 429
          ? 'ส่งรหัสบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่'
          : 'ส่งรหัสยืนยันไม่สำเร็จ กรุณาลองใหม่อีกครั้ง',
        true,
      );
  } finally {
    busy = false;
    if (!stopped) controls();
  }
});
function stop() {
  stopped = true;
  form.reset();
  $('#password-status').textContent = '';
  $('#password-success').hidden = true;
  controls();
}
addEventListener('pagehide', stop);
controls();
const auth = await authReady;
if (auth?.session && !stopped) {
  service = createAuthService(auth.client, new URL('./', location.href));
  auth.client.auth.onAuthStateChange((_event, session) => {
    if (!session || session.user.id !== auth.session.user.id) stop();
  });
  controls();
}
