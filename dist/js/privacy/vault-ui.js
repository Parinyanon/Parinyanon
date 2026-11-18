import { createKeyRecord, unlockKey, changePassphrase } from './crypto.js';
function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function field(form, title, type = 'password') {
  const label = node('label', title),
    input = node('input');
  input.type = type;
  input.required = true;
  input.autocomplete = type === 'password' ? 'off' : 'on';
  input.maxLength = 256;
  label.append(input);
  form.append(label);
  return input;
}
export function requestUnlock(vault, changePassword = false) {
  return new Promise((resolve, reject) => {
    const dialog = node('dialog', null, 'vault-dialog');
    dialog.setAttribute('aria-labelledby', 'vault-heading');
    const heading = node(
      'h2',
      changePassword ? 'ตั้งรหัสปลดล็อกใหม่' : vault.record ? 'ปลดล็อกข้อมูลส่วนตัว' : 'ปกป้องข้อความส่วนตัว',
    );
    heading.id = 'vault-heading';
    const description = node(
      'p',
      'ชื่อหนี้ เจ้าหนี้ และหมายเหตุจะถอดรหัสบนเครื่องนี้ ยอดเงิน วันที่ หมวดหมู่ และดอกเบี้ยยังใช้คำนวณบนเซิร์ฟเวอร์ได้',
      'small',
    );
    const form = node('form'),
      message = node('p', '', 'small');
    message.setAttribute('role', 'status');
    const setup = !vault.record;
    const secret = field(
      form,
      setup ? 'ตั้งรหัสปลดล็อก 16 ตัวอักษรขึ้นไป' : changePassword ? 'รหัสกู้คืนข้อมูล' : 'รหัสปลดล็อกข้อมูล',
    );
    secret.autocomplete = setup ? 'new-password' : 'off';
    const confirmation = setup ? field(form, 'ยืนยันรหัสปลดล็อก') : null;
    const nextPassword = changePassword ? field(form, 'รหัสปลดล็อกใหม่ 16 ตัวอักษรขึ้นไป') : null;
    const nextConfirmation = changePassword ? field(form, 'ยืนยันรหัสปลดล็อกใหม่') : null;
    const useRecovery = node('input');
    useRecovery.type = 'checkbox';
    if (!setup && !changePassword) {
      const label = node('label', null, 'vault-check');
      label.append(useRecovery, document.createTextNode('ใช้รหัสกู้คืนแทน'));
      form.append(label);
      useRecovery.addEventListener('change', () => {
        secret.value = '';
        secret.focus();
      });
    }
    const remember = node('input');
    remember.type = 'checkbox';
    const rememberLabel = node('label', null, 'vault-check');
    rememberLabel.append(
      remember,
      document.createTextNode('เปลี่ยนหน้าในแท็บนี้โดยไม่ถามรหัส 15 นาที (เฉพาะเครื่องส่วนตัว)'),
    );
    if (!changePassword) form.append(rememberLabel);
    const warning = node(
      'p',
      setup
        ? 'รหัสนี้แยกจากรหัสเข้าบัญชี เก็บรหัสกู้คืนไว้ด้วย หากลืมทั้งสองอย่างจะกู้ข้อความที่เข้ารหัสไม่ได้'
        : 'การเปลี่ยนรหัสเข้าบัญชีไม่เปลี่ยนรหัสปลดล็อกข้อมูล',
      'hint',
    );
    const submit = node(
      'button',
      setup ? 'สร้างรหัสกู้คืน' : changePassword ? 'เปลี่ยนรหัสปลดล็อก' : 'ปลดล็อก',
    );
    submit.className = 'primary';
    submit.type = 'submit';
    const cancel = node('button', changePassword ? 'ยกเลิก' : 'ออกจากระบบ', 'plain-button');
    cancel.type = 'button';
    const actions = node('div', null, 'vault-actions');
    actions.append(submit, cancel);
    const recoveryPanel = node('div');
    recoveryPanel.hidden = true;
    const recovery = node('textarea');
    recovery.readOnly = true;
    recovery.rows = 3;
    recovery.setAttribute('aria-label', 'รหัสกู้คืน เก็บไว้นอกเครื่องนี้');
    const saved = node('input');
    saved.type = 'checkbox';
    const savedLabel = node('label', null, 'vault-check');
    savedLabel.append(saved, document.createTextNode('ฉันเก็บรหัสกู้คืนไว้ในที่ปลอดภัยแล้ว'));
    recoveryPanel.append(
      node('strong', 'เก็บรหัสกู้คืนก่อนเปิดใช้งาน'),
      node('p', 'คัดลอกเก็บในตัวจัดการรหัสผ่านหรือจดไว้ ห้ามส่งในแชต เราจะแสดงรหัสนี้ครั้งเดียว', 'small'),
      recovery,
      savedLabel,
    );
    form.append(warning, recoveryPanel, message, actions);
    dialog.append(heading, description, form);
    document.body.append(dialog);
    let candidate = null,
      working = false;
    function close() {
      form.reset();
      recovery.value = '';
      candidate = null;
      dialog.close();
      dialog.remove();
    }
    cancel.addEventListener('click', async () => {
      if (working) return;
      if (changePassword) {
        close();
        resolve(false);
        return;
      }
      working = true;
      try {
        await vault.exit();
        close();
        reject(new Error('ยกเลิกการปลดล็อก'));
        location.replace('login.html');
      } catch (error) {
        message.textContent = error.message;
      } finally {
        working = false;
      }
    });
    dialog.addEventListener('cancel', (event) => event.preventDefault());
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (working) return;
      working = true;
      submit.disabled = true;
      cancel.disabled = true;
      message.textContent = 'กำลังดำเนินการในเครื่อง…';
      try {
        if (setup && !candidate) {
          if (secret.value !== confirmation.value) throw new Error('รหัสปลดล็อกทั้งสองช่องไม่ตรงกัน');
          candidate = await createKeyRecord(vault.owner, secret.value);
          secret.value = '';
          confirmation.value = '';
          secret.disabled = true;
          confirmation.disabled = true;
          recovery.value = candidate.recoveryCode;
          recoveryPanel.hidden = false;
          submit.textContent = 'เปิดการปกป้องข้อความ';
          message.textContent = 'ยังไม่บันทึกกุญแจ จนกว่าคุณจะยืนยันว่าเก็บรหัสกู้คืนแล้ว';
        } else if (setup) {
          if (!saved.checked) throw new Error('กรุณาเก็บรหัสกู้คืนและทำเครื่องหมายยืนยันก่อน');
          await vault.setup(candidate, remember.checked);
          close();
          resolve();
        } else if (changePassword) {
          if (nextPassword.value !== nextConfirmation.value) throw new Error('รหัสปลดล็อกใหม่ไม่ตรงกัน');
          const next = await changePassphrase(
            vault.owner,
            vault.record,
            secret.value,
            nextPassword.value,
          );
          await vault.replacePassword(next);
          close();
          resolve();
        } else {
          const key = await unlockKey(vault.owner, vault.record, secret.value, useRecovery.checked);
          await vault.accept(key, remember.checked);
          close();
          resolve();
        }
      } catch (error) {
        message.textContent =
          error.name === 'OperationError' ? 'รหัสไม่ถูกต้อง หรือกุญแจไม่ตรงกับบัญชีนี้' : error.message;
        message.setAttribute('role', 'alert');
      } finally {
        working = false;
        submit.disabled = false;
        cancel.disabled = false;
      }
    });
    dialog.showModal();
    secret.focus();
  });
}
