const dismissalKey = 'dm:install-dismissed-at';
const snooze = 7 * 24 * 60 * 60 * 1000;
export function installHelp(navigator) {
  const ua = navigator.userAgent || '';
  const ios =
    /iPhone|iPad|iPod/i.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (/FBAN|FBAV|Instagram|Line\//i.test(ua))
    return [
      'เปิดเว็บนี้ในเบราว์เซอร์หลัก',
      `ใช้เมนูของแอปที่เปิดลิงก์ แล้วเลือกเปิดใน ${ios ? 'Safari' : 'Chrome หรือเบราว์เซอร์ประจำเครื่อง'} จากนั้นเลือกเพิ่มไปยังหน้าจอหลัก`,
    ];
  if (ios)
    return [
      'เพิ่มจัดหนี้ไปยังหน้าจอหลัก',
      'เปิดเว็บนี้ใน Safari',
      'กดปุ่มแชร์ แล้วเลือก “เพิ่มไปยังหน้าจอโฮม”',
      'หากมีตัวเลือก “เปิดเป็นเว็บแอป” ให้เปิดไว้ แล้วกด “เพิ่ม”',
    ];
  if (/Android/i.test(ua))
    return [
      'เพิ่มจัดหนี้ไว้บนเครื่อง',
      'เปิดเมนู ⋮ ของเบราว์เซอร์',
      'เลือก “ติดตั้งแอป” หรือ “เพิ่มลงในหน้าจอหลัก” แล้วทำตามขั้นตอนบนหน้าจอ',
      'หากไม่พบตัวเลือก ให้เปิดเว็บนี้ใน Chrome แล้วลองอีกครั้ง',
    ];
  return [
    'เปิดจัดหนี้เหมือนแอปบนคอมพิวเตอร์',
    'มองหาไอคอนติดตั้งที่แถบที่อยู่ หรือเปิดเมนูของ Chrome / Microsoft Edge',
    'เลือกติดตั้งเว็บไซต์นี้เป็นแอป แล้วทำตามขั้นตอนบนหน้าจอ',
    'หากติดตั้งไว้แล้ว ให้เปิดจัดหนี้จากไอคอนบนเครื่องได้เลย',
  ];
}
export function connectInstallUI() {
  const state = (globalThis.dmInstallation ||= { prompt: null, installed: false });
  const buttons = [...document.querySelectorAll('#install-app, [data-install-app]')];
  const banner = document.querySelector('#install-banner');
  const status = document.querySelector('#install-status');
  const standalone = matchMedia('(display-mode: standalone)');
  let busy = false,
    dismissedHere = false,
    dialog;
  const installed = () => state.installed || standalone.matches || navigator.standalone === true;
  function rememberDismissal() {
    dismissedHere = true;
    try {
      localStorage.setItem(dismissalKey, String(Date.now()));
    } catch {
      /* Visual preference only. */
    }
  }
  function hiddenByPreference() {
    try {
      const value = Number(localStorage.getItem(dismissalKey));
      return dismissedHere || (value > 0 && Date.now() - value >= 0 && Date.now() - value < snooze);
    } catch {
      return dismissedHere;
    }
  }
  function render() {
    const isInstalled = installed();
    if (banner) banner.hidden = isInstalled || hiddenByPreference();
    const compact = document.querySelector('#install-compact');
    if (compact) compact.hidden = isInstalled || hiddenByPreference();
    for (const button of buttons) {
      button.disabled = busy || isInstalled;
      button.setAttribute('aria-busy', String(busy));
      const title = button.querySelector('strong');
      if (title) title.textContent = isInstalled ? 'ติดตั้งแอปแล้ว' : 'ติดตั้งแอป';
    }
    if (status && isInstalled)
      status.textContent = 'คุณเปิดจัดหนี้เป็นแอปแล้ว ใช้ไอคอนบนเครื่องเพื่อเปิดครั้งถัดไปได้เลย';
  }
  function showHelp(failed = false) {
    if (dialog?.open) return;
    dialog?.remove();
    dialog = document.createElement('dialog');
    dialog.className = 'install-dialog';
    dialog.setAttribute('aria-labelledby', 'install-help-title');
    const [title, ...steps] = installHelp(navigator);
    const heading = document.createElement('h2');
    heading.id = 'install-help-title';
    heading.textContent = title;
    const intro = document.createElement('p');
    intro.textContent = failed
      ? 'ยังเปิดหน้าติดตั้งอัตโนมัติไม่ได้ เพิ่มแอปผ่านเมนูของเบราว์เซอร์ได้ตามนี้'
      : 'เพิ่มไอคอนจัดหนี้ไว้บนเครื่องได้ตามขั้นตอนนี้';
    const list = document.createElement('ol');
    for (const text of steps) {
      const item = document.createElement('li');
      item.textContent = text;
      list.append(item);
    }
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'primary';
    close.textContent = 'เข้าใจแล้ว';
    close.addEventListener('click', () => dialog.close());
    dialog.append(heading, intro, list, close);
    document.body.append(dialog);
    dialog.showModal();
    close.focus();
  }
  async function install() {
    if (busy || installed()) return;
    const prompt = state.prompt;
    if (!prompt) {
      showHelp();
      return;
    }
    state.prompt = null;
    busy = true;
    render();
    try {
      // prompt() must run directly in the click gesture, before any awaited work.
      const result = await prompt.prompt();
      const choice = prompt.userChoice ? await prompt.userChoice : result;
      rememberDismissal();
      if (status)
        status.textContent =
          choice?.outcome === 'accepted'
            ? 'ส่งคำขอติดตั้งแล้ว เมื่อเสร็จให้เปิดจัดหนี้จากไอคอนบนเครื่อง'
            : 'ยกเลิกการติดตั้งแล้ว';
    } catch {
      showHelp(true);
    } finally {
      busy = false;
      render();
    }
  }
  for (const button of buttons) button.addEventListener('click', install);
  document.querySelector('#install-later')?.addEventListener('click', () => {
    rememberDismissal();
    render();
  });
  document.addEventListener('dm:install-state', () => {
    if (state.installed) rememberDismissal();
    render();
  });
  standalone.addEventListener?.('change', render);
  if (state.installed) rememberDismissal();
  render();
}
