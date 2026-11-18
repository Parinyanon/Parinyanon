import { getClient } from '../data/supabase-client.js';
import { createAuthService } from './auth-service.js';
import { safeReturnPath } from '../core/navigation.js';
import { hydratePreferences } from '../core/experience.js';

const mode = document.body.dataset.page;
const afterLogin = safeReturnPath(
  new URLSearchParams(location.search).get('next') || 'overview.html',
);
const form = mode === 'dashboard' ? null : document.querySelector('form');
const message = document.querySelector('#message');
const submit = form?.querySelector('button[type="submit"]');
let service;
let client;
let accountId;
let signedOut = false;
let resetSessionExpired = false;
let viewRevision = 0,
  disposed = false;
let observedUser;

function status(text, error = false) {
  message.textContent = text;
  message.dataset.error = String(error);
  message.setAttribute('role', error ? 'alert' : 'status');
}
function busy(value) {
  if (submit) submit.disabled = value;
  form?.setAttribute('aria-busy', String(value));
}
function explain(error) {
  const codes = {
    invalid_credentials: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง',
    email_not_confirmed: 'กรุณายืนยันอีเมลก่อนเข้าสู่ระบบ',
    over_email_send_rate_limit: 'ส่งอีเมลบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่',
    weak_password: 'รหัสผ่านไม่ผ่านข้อกำหนดของระบบ กรุณาใช้รหัสผ่านที่ยาวและคาดเดายากขึ้น',
    same_password: 'กรุณาใช้รหัสผ่านใหม่ที่ต่างจากรหัสผ่านเดิม',
    otp_expired: 'ลิงก์หมดอายุแล้ว กรุณาขอลิงก์ใหม่',
  };
  if (codes[error.code]) return codes[error.code];
  if (error.status === 429) return 'มีคำขอมากเกินไป กรุณารอสักครู่แล้วลองใหม่';
  // ไม่แสดง response ดิบที่อาจมีรายละเอียดบัญชี
  return 'ดำเนินการไม่สำเร็จ กรุณาตรวจอินเทอร์เน็ตแล้วลองใหม่ หากยังไม่ได้ให้ติดต่อผู้ดูแล';
}

function clearPrivateView(clearTheme = true) {
  viewRevision++;
  if (clearTheme) document.dispatchEvent?.(new Event('dm:clear-private-view'));
  accountId = null;
  document.querySelector('#private-content')?.setAttribute('hidden', '');
  const identity = document.querySelector('#identity');
  if (identity) identity.textContent = '';
  form?.reset();
  if (clearTheme)
    try {
      localStorage.removeItem('dm:theme');
    } catch {
      /* Theme preference only. */
    }
}

async function initialize() {
  const current = viewRevision;
  busy(true);
  try {
    client = await getClient();
    if (disposed || current !== viewRevision) return;
    service = createAuthService(client, new URL('./', location.href));
    // callback เป็น synchronous เพื่อไม่เรียก Auth API ซ้อนขณะ Supabase ล็อก session
    client.auth.onAuthStateChange((event, session) => {
      if (
        [
          'INITIAL_SESSION',
          'SIGNED_IN',
          'SIGNED_OUT',
          'TOKEN_REFRESHED',
          'PASSWORD_RECOVERY',
        ].includes(event)
      )
        observedUser = session?.user?.id ?? null;
      if (event === 'PASSWORD_RECOVERY' && mode !== 'reset') {
        clearPrivateView();
        location.replace('reset-password.html');
        return;
      }
      if (event === 'SIGNED_OUT' || (accountId && session?.user?.id !== accountId)) {
        clearPrivateView();
        if (mode === 'dashboard') location.replace('login.html');
        if (mode === 'reset') {
          resetSessionExpired = true;
          busy(true);
          status('เซสชันสิ้นสุดแล้ว กรุณาขอลิงก์ตั้งรหัสผ่านใหม่', true);
        }
      }
    });
    const session = await service.session();
    if (disposed || current !== viewRevision) return;
    if (observedUser !== undefined && observedUser !== (session?.user?.id ?? null)) {
      clearPrivateView();
      if (mode === 'dashboard') location.replace('login.html');
      else if (mode === 'reset') {
        resetSessionExpired = true;
        status('เซสชันเปลี่ยนแล้ว กรุณาขอลิงก์ตั้งรหัสผ่านใหม่', true);
      }
      return;
    }
    if (mode === 'dashboard') {
      if (!session) {
        const requested = safeReturnPath(
          `${location.pathname.split('/').at(-1)}${location.search}`,
        );
        location.replace(`login.html?next=${encodeURIComponent(requested)}`);
        return;
      }
      accountId = session.user.id;
      await client.privateTextVault?.prepare(accountId);
      if (disposed || current !== viewRevision || accountId !== session.user.id) return;
      document.querySelector('#identity').textContent = session.user.email ?? 'สมาชิก';
      document.querySelector('#private-content').hidden = false;
      status('');
      hydratePreferences(
        client,
        accountId,
        () => accountId === session.user.id && !document.querySelector('#private-content').hidden,
      );
    } else if (mode === 'reset') {
      if (!session || new URLSearchParams(location.search).has('error')) {
        status('ลิงก์ไม่ถูกต้องหรือหมดอายุ กรุณาขอลิงก์ตั้งรหัสผ่านใหม่', true);
        return;
      }
      status('ตั้งรหัสผ่านใหม่สำหรับบัญชีของคุณ');
    } else {
      status('');
      if (mode === 'login' && session) {
        location.replace(afterLogin);
        return;
      }
    }
    busy(false);
    return { client, session };
  } catch (error) {
    if (!disposed && current === viewRevision) status(explain(error), true);
  }
}

form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!service || submit.disabled || !form.reportValidity()) return;
  const fields = new FormData(form);
  const email = String(fields.get('email') ?? '').trim();
  const password = String(fields.get('password') ?? '');
  if (fields.has('confirm-password') && password !== fields.get('confirm-password')) {
    status('รหัสผ่านทั้งสองช่องไม่ตรงกัน', true);
    return;
  }
  busy(true);
  status('กำลังดำเนินการ…');
  try {
    if (mode === 'login') {
      const data = await service.login(email, password);
      if (!data.session) throw new Error('No session');
      form.reset();
      location.replace(afterLogin);
      return;
    }
    if (mode === 'register') {
      const data = await service.register(email, password, String(fields.get('name')).trim());
      form.reset();
      if (data.session) {
        location.replace('overview.html');
        return;
      }
      status('รับคำขอสมัครแล้ว หากอีเมลนี้ใช้งานได้ ระบบจะส่งลิงก์ยืนยันให้ กรุณาตรวจกล่องจดหมายและสแปม');
    }
    if (mode === 'forgot') {
      await service.forgot(email);
      form.reset();
      status('หากมีบัญชีนี้อยู่ ระบบจะส่งลิงก์ตั้งรหัสผ่านใหม่ให้ กรุณาเปิดลิงก์ในเบราว์เซอร์และอุปกรณ์ที่ใช้ขอ');
    }
    if (mode === 'reset') {
      await service.reset(password);
      form.reset();
      status('บันทึกรหัสผ่านใหม่แล้ว กำลังออกจากระบบ…');
      await service.logout();
      signedOut = true;
      location.replace('login.html');
      return;
    }
  } catch (error) {
    status(explain(error), true);
  } finally {
    if (!signedOut && !resetSessionExpired) busy(false);
  }
});

document.querySelector('#logout')?.addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await service.logout();
    clearPrivateView();
    location.replace('login.html');
  } catch (error) {
    status(explain(error), true);
    button.disabled = false;
  }
});

// เมื่อย้อนกลับจาก browser cache ให้ตรวจ session ใหม่ก่อนแสดงข้อมูลบัญชี
addEventListener('pagehide', () => {
  disposed = true;
  clearPrivateView(false);
});
addEventListener('pageshow', (event) => {
  if (event.persisted) location.reload();
});
export const authReady = initialize();
