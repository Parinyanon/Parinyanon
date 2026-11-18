import { ratePercent } from '../data/debt-service.js';
import { money, dateText } from './format.js';
import { cents, fromCents } from '../data/schedule-service.js';
import { connectInstallUI } from './installation.js';

// ตัวอย่างเพื่ออธิบายเท่านั้น ยอดจริงและการเปลี่ยนอัตราให้ Supabase คำนวณ
export function interestExample(principal, rate, period) {
  if (!/^\d+(?:\.\d{1,2})?$/.test(String(principal))) return null;
  const normalized = ratePercent(rate);
  const [whole, fraction = ''] = String(principal).split('.');
  const principalCents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  const [percent, decimals = ''] = normalized.split('.');
  const scaled = BigInt(percent) * 1000000n + BigInt(decimals.padEnd(6, '0'));
  const base = { day: 1n, month: 30n, year: 365n }[period];
  if (!base) return null;
  const divisor = 100000000n * base;
  const amount = (days) => {
    const numerator = principalCents * scaled * BigInt(days);
    const cents = (numerator + divisor / 2n) / divisor;
    return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
  };
  return { day: amount(1), month: amount(30), year: amount(365) };
}
let themeRevision = 0;
export function applyTheme(theme) {
  themeRevision++;
  const dark =
    theme === 'dark' ||
    (theme === 'system' && globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('theme-dark', Boolean(dark));
}
const navigation = [
  ['overview.html', '◉', 'ภาพรวม'],
  ['index.html', '▤', 'รายการหนี้'],
  ['reminders.html', '♧', 'แจ้งเตือน'],
  ['export.html', '↓', 'ดาวน์โหลด'],
  ['settings.html', '⚙', 'ตั้งค่า'],
];
function navLinks(container) {
  const page = location.pathname.split('/').at(-1) || 'index.html';
  for (const [href, icon, label] of navigation) {
    const link = document.createElement('a');
    link.href = href;
    const mark = document.createElement('span');
    mark.className = 'rail-icon';
    mark.setAttribute('aria-hidden', 'true');
    const paths = {
      'overview.html': 'M3 12h7V3H3z M14 21h7V12h-7z M3 21h7v-5H3z M14 8h7V3h-7z',
      'index.html': 'M5 3h14v18H5z M9 8h6 M9 12h6 M9 16h4',
      'reminders.html': 'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9 M9 21h6',
      'export.html': 'M12 3v12 M7 10l5 5 5-5 M4 16v5h16v-5',
      'settings.html': 'M4 6h16 M4 12h16 M4 18h16 M8 3v6 M16 9v6 M10 15v6',
    };
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '21');
    svg.setAttribute('height', '21');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.6');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    shape.setAttribute('d', paths[href]);
    svg.append(shape);
    mark.append(svg);
    link.append(mark, document.createTextNode(label));
    if (href === 'reminders.html') {
      const badge = document.createElement('span');
      badge.dataset.reminderBadge = '';
      badge.className = 'badge';
      badge.hidden = true;
      link.append(badge);
    }
    const activePage =
      page === 'installments.html'
        ? 'overview.html'
        : ['categories.html', 'privacy.html', 'change-password.html'].includes(page)
          ? 'settings.html'
          : navigation.some((row) => row[0] === page)
            ? page
            : 'index.html';
    const active = href === activePage;
    if (active) link.setAttribute('aria-current', 'page');
    container.append(link);
  }
}
const reminderBadgeVersions = new WeakMap();
export async function refreshReminderBadges(client, userId, isCurrent, knownPreference) {
  const revision = (reminderBadgeVersions.get(client) || 0) + 1;
  reminderBadgeVersions.set(client, revision);
  try {
    const preference =
      knownPreference === undefined
        ? await client
            .from('user_settings')
            .select('in_app_notifications')
            .eq('user_id', userId)
            .maybeSingle()
        : { data: knownPreference };
    if (!isCurrent() || reminderBadgeVersions.get(client) !== revision || preference.error) return;
    if (preference.data?.in_app_notifications === false) {
      for (const badge of document.querySelectorAll('[data-reminder-badge]')) {
        badge.hidden = true;
        badge.textContent = '';
      }
      return;
    }
    if (preference.data?.in_app_notifications !== true) return;
    const due = await client
      .from('due_reminders')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId);
    if (
      !isCurrent() ||
      reminderBadgeVersions.get(client) !== revision ||
      due.error ||
      !Number.isSafeInteger(due.count) ||
      due.count < 0
    )
      return;
    for (const badge of document.querySelectorAll('[data-reminder-badge]')) {
      badge.hidden = due.count === 0;
      badge.textContent = due.count > 99 ? '99+' : String(due.count || '');
    }
  } catch {
    /* Keep the last confirmed count when offline. */
  }
}
export async function hydratePreferences(client, userId, isCurrent) {
  const revision = themeRevision;
  try {
    const result = await client
      .from('user_settings')
      .select('theme,in_app_notifications')
      .eq('user_id', userId)
      .maybeSingle();
    if (!isCurrent() || result.error || !result.data) return;
    if (revision === themeRevision) {
      applyTheme(result.data.theme);
      try {
        localStorage.setItem('dm:theme', result.data.theme);
      } catch {}
    }
    await refreshReminderBadges(client, userId, isCurrent, result.data);
  } catch {
    /* preference loading does not block the user's task */
  }
}
function previewInterest() {
  const output = document.querySelector('#interest-example');
  if (!output) return;
  const principal =
    document.querySelector('#principal')?.value || output.dataset.principal || '10000';
  const rate =
    document.querySelector('#initial-rate')?.value ?? document.querySelector('#new-rate')?.value;
  const period =
    document.querySelector('#initial-period')?.value ??
    document.querySelector('#new-period')?.value;
  try {
    const example = interestExample(principal, rate, period);
    if (!example) throw new Error();
    output.hidden = false;
    for (const term of ['day', 'month', 'year']) {
      const node = output.querySelector(`[data-estimate="${term}"]`);
      if (node) node.textContent = money(example[term]);
    }
    const title = output.querySelector('[data-example-title]');
    if (title) title.textContent = `ถ้าเงินต้นคงเหลือ ${money(principal)}`;
  } catch {
    output.hidden = true;
  }
}
function wizard() {
  const form = document.querySelector('[data-wizard]');
  if (!form) return;
  const steps = [...form.querySelectorAll('[data-wizard-step]')];
  const next = document.querySelector('#wizard-next'),
    back = document.querySelector('#wizard-back'),
    save = document.querySelector('#save-debt');
  let step = 0;
  form.noValidate = true;
  const paint = () => {
    steps.forEach((node, index) => {
      node.hidden = index !== step;
    });
    document.querySelectorAll('[data-step-indicator]').forEach((node, index) => {
      if (index === step) node.setAttribute('aria-current', 'step');
      else node.removeAttribute('aria-current');
    });
    next.hidden = step === steps.length - 1;
    save.hidden = step !== steps.length - 1;
    back.hidden = step === 0;
    const caption = document.querySelector('#wizard-caption');
    if (caption) caption.textContent = `ขั้นที่ ${step + 1} จาก ${steps.length}`;
    const values = new FormData(form);
    for (const [key, value] of [
      ['title', values.get('title') || 'ยังไม่ได้ระบุ'],
      ['principal', money(values.get('principal'))],
      [
        'interest',
        values.get('interest_method') === 'simple_daily'
          ? `${values.get('rate_percent') || '0'}% ต่อ${{ year: 'ปี', month: 'เดือน', day: 'วัน' }[values.get('rate_period')]}`
          : 'ไม่คิดดอกเบี้ย',
      ],
    ]) {
      const node = document.querySelector(`[data-review="${key}"]`);
      if (node) node.textContent = value;
    }
  };
  const validate = (panel) => {
    const invalid = [...panel.querySelectorAll('input,select,textarea')].find(
      (node) => !node.disabled && !node.checkValidity(),
    );
    if (invalid) {
      const details = invalid.closest('details');
      if (details) details.open = true;
      invalid.reportValidity();
      invalid.focus();
      return false;
    }
    return true;
  };
  next.addEventListener('click', () => {
    if (validate(steps[step])) {
      step++;
      paint();
      form.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  });
  back.addEventListener('click', () => {
    step = Math.max(0, step - 1);
    paint();
  });
  form.addEventListener(
    'submit',
    (event) => {
      const invalidStep = steps.findIndex((panel) =>
        [...panel.querySelectorAll('input,select,textarea')].some(
          (node) => !node.disabled && !node.checkValidity(),
        ),
      );
      if (invalidStep >= 0) {
        event.preventDefault();
        event.stopImmediatePropagation();
        step = invalidStep;
        paint();
        validate(steps[step]);
      }
    },
    true,
  );
  form.addEventListener('input', () => {
    if (step === steps.length - 1) paint();
  });
  const fieldset = document.querySelector('#debt-fields');
  const lock = () => {
    next.disabled = fieldset.disabled;
    back.disabled = fieldset.disabled;
  };
  new MutationObserver(lock).observe(fieldset, { attributes: true, attributeFilter: ['disabled'] });
  lock();
  paint();
}
function enhance() {
  try {
    applyTheme(localStorage.getItem('dm:theme') || 'system');
  } catch {
    applyTheme('system');
  }
  for (const input of document.querySelectorAll('input[type="password"]')) {
    const field = document.createElement('div');
    field.className = 'password-field';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'password-toggle';
    toggle.textContent = 'แสดง';
    toggle.setAttribute('aria-controls', input.id);
    toggle.setAttribute('aria-pressed', 'false');
    toggle.setAttribute('aria-label', 'แสดงรหัสผ่าน');
    input.before(field);
    field.append(input, toggle);
    toggle.addEventListener('click', () => {
      const reveal = input.type === 'password';
      input.type = reveal ? 'text' : 'password';
      toggle.textContent = reveal ? 'ซ่อน' : 'แสดง';
      toggle.setAttribute('aria-pressed', String(reveal));
      toggle.setAttribute('aria-label', reveal ? 'ซ่อนรหัสผ่าน' : 'แสดงรหัสผ่าน');
    });
  }
  if (document.body.dataset.page !== 'dashboard') return;
  connectInstallUI();
  for (const button of document.querySelectorAll('.page-heading > button[id^="refresh-"]')) {
    button.classList.add('icon-button', 'refresh-button');
    button.classList.remove('plain-button');
    button.setAttribute('aria-label', 'อัปเดตข้อมูล');
    button.title = 'อัปเดตข้อมูล';
    const icon = document.querySelector('#logout svg')?.cloneNode(true);
    if (icon) {
      icon
        .querySelector('path')
        .setAttribute(
          'd',
          'M20 7v5h-5 M4 17v-5h5 M6.1 6.1A8 8 0 0 1 19.7 10 M4.3 14A8 8 0 0 0 17.9 17.9',
        );
      button.replaceChildren(icon);
    }
  }
  const rail = document.createElement('aside');
  rail.className = 'app-rail';
  rail.hidden = true;
  const brand = document.createElement('a');
  brand.className = 'rail-brand';
  brand.href = 'overview.html';
  brand.textContent = 'จัดหนี้';
  const caption = document.createElement('small');
  caption.textContent = 'ระบบจัดการหนี้ส่วนบุคคล';
  brand.append(caption);
  rail.append(brand);
  const menu = document.createElement('nav');
  menu.setAttribute('aria-label', 'เมนูหลัก');
  navLinks(menu);
  rail.append(menu);
  const bottom = document.createElement('div');
  bottom.className = 'rail-bottom';
  bottom.textContent = 'สกุลเงิน THB';
  rail.append(bottom);
  document.body.prepend(rail);
  const mobile = document.createElement('nav');
  mobile.className = 'app-mobile-nav';
  mobile.hidden = true;
  mobile.setAttribute('aria-label', 'เมนูหลักสำหรับมือถือ');
  navLinks(mobile);
  document.body.append(mobile);
  const root = document.querySelector('#private-content');
  const reveal = () => {
    rail.hidden = root.hidden;
    mobile.hidden = root.hidden;
    if (root.hidden) document.querySelectorAll('.toast').forEach((node) => node.remove());
  };
  new MutationObserver(reveal).observe(root, { attributes: true, attributeFilter: ['hidden'] });
  reveal();
  const offline = document.createElement('div');
  offline.className = 'app-offline';
  offline.setAttribute('role', 'status');
  offline.textContent = 'ขณะนี้ออฟไลน์ ข้อมูลอาจไม่เป็นปัจจุบัน กรุณาเชื่อมต่อก่อนบันทึก';
  document.body.prepend(offline);
  const network = () => {
    offline.hidden = navigator.onLine;
  };
  addEventListener('online', network);
  addEventListener('offline', network);
  network();
  for (const button of document.querySelectorAll(
    'form:not(#filters) button[type="submit"].primary, form:not(#filters) button[type="submit"][data-fixed-action]',
  )) {
    if (button.closest('.action-bar') || button.hasAttribute('data-inline-action')) continue;
    const bar = document.createElement('div');
    bar.className = 'action-bar';
    button.before(bar);
    bar.append(button);
    document.body.classList.add('has-fixed-action');
  }
  if (document.querySelector('.action-bar')) document.body.classList.add('has-fixed-action');
  document.querySelectorAll('[data-interest-choice]').forEach((button) =>
    button.addEventListener('click', () => {
      const select = document.querySelector('#interest-method');
      select.value = button.dataset.interestChoice;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      document
        .querySelectorAll('[data-interest-choice]')
        .forEach((choice) => choice.setAttribute('aria-pressed', String(choice === button)));
      previewInterest();
    }),
  );
  document.addEventListener('input', (event) => {
    if (
      ['principal', 'initial-rate', 'initial-period', 'new-rate', 'new-period'].includes(
        event.target.id,
      )
    )
      previewInterest();
  });
  document.addEventListener('change', (event) => {
    if (['initial-period', 'new-period'].includes(event.target.id)) previewInterest();
  });
  document.querySelectorAll('[data-fill-amount]').forEach((button) =>
    button.addEventListener('click', () => {
      const input = document.querySelector(button.dataset.target || '#payment-amount');
      if (input) {
        input.value = button.dataset.fillAmount;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.focus();
      }
    }),
  );
  wizard();
  previewInterest();
  const scheduleForm = document.querySelector('#schedule-form');
  if (scheduleForm) {
    const preview = document.createElement('p');
    preview.className = 'schedule-preview';
    preview.setAttribute('role', 'status');
    preview.hidden = true;
    document.querySelector('#schedule-fields').after(preview);
    const update = () => {
      try {
        const amount = cents(document.querySelector('#installment-amount').value),
          count = Number(document.querySelector('#installment-count').value);
        if (amount <= 0n || !Number.isInteger(count) || count < 1 || count > 360) throw new Error();
        preview.textContent = `${count} งวด × ${money(fromCents(amount))} · ยอดตามแผนรวม ${money(fromCents(amount * BigInt(count)))}`;
        preview.hidden = false;
      } catch {
        preview.hidden = true;
        preview.textContent = '';
      }
    };
    scheduleForm.addEventListener('input', update);
    scheduleForm.addEventListener('reset', () => setTimeout(update, 0));
    update();
  }
  for (const id of [
    'create-status',
    'mutation-status',
    'schedule-mutation-status',
    'workspace-status',
    'manage-status',
  ]) {
    const node = document.getElementById(id);
    if (!node) continue;
    let last = '';
    new MutationObserver(() => {
      const value = node.textContent.trim();
      if (!value || value === last || root.hidden) return;
      last = value;
      if (node.dataset.error === 'true') {
        node.scrollIntoView({ block: 'center', behavior: 'smooth' });
        return;
      }
      if (/สำเร็จ|บันทึก.*แล้ว|ดาวน์โหลด.*แล้ว|เพิ่ม.*แล้ว/.test(value)) {
        document.querySelectorAll('.toast').forEach((item) => item.remove());
        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.setAttribute('role', 'status');
        toast.textContent = value;
        document.body.append(toast);
        setTimeout(() => toast.remove(), 4500);
      }
    }).observe(node, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-error'],
    });
  }
  document.querySelectorAll('input[type="date"]').forEach((input) => {
    const label = document.createElement('p');
    label.className = 'hint date-readable';
    input.after(label);
    const update = () => {
      label.textContent = input.value ? dateText(input.value) : '';
    };
    input.addEventListener('change', update);
    new MutationObserver(update).observe(input, { attributes: true, attributeFilter: ['value'] });
    setTimeout(update, 700);
  });
  if ('serviceWorker' in navigator && location.protocol !== 'file:')
    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).catch(() => {});
}
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', enhance, { once: true });
  else enhance();
}
