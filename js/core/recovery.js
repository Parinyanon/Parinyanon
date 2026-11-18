// This page contains no account data. Probe the HTML server, not Supabase or cached navigation.
export function recoveryTarget(href) {
  const current = new URL(href);
  const name = current.pathname.split('/').at(-1);
  if (!name || name === 'offline.html') return new URL('overview.html', current);
  return current;
}
export async function probePage(target, request = fetch) {
  const probe = new URL(target.pathname, target.origin);
  probe.searchParams.set('connection_check', String(Date.now()));
  const response = await request(probe.href, {
    cache: 'no-store',
    credentials: 'same-origin',
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
  if (
    !response.ok ||
    response.headers.get('X-Jadnee-Offline') === '1' ||
    !response.headers.get('Content-Type')?.includes('text/html')
  )
    throw new Error('Page server unavailable');
  const html = await response.text();
  if (!/<html\b/i.test(html) || /data-offline-fallback|class=["']offline-page/.test(html))
    throw new Error('Received fallback instead of app');
}
export function initializeRecovery(doc = document, win = window, request = fetch) {
  const link = doc.querySelector('.offline-retry'),
    status = doc.querySelector('#recovery-status');
  if (!link || !status) return;
  const target = recoveryTarget(win.location.href);
  link.href = target.href;
  let busy = false;
  const retry = async () => {
    if (busy) return;
    busy = true;
    link.setAttribute('aria-busy', 'true');
    link.setAttribute('aria-disabled', 'true');
    status.dataset.error = 'false';
    status.textContent = 'กำลังตรวจการเชื่อมต่อเว็บไซต์…';
    try {
      await probePage(target, request);
      status.textContent = 'เชื่อมต่อได้แล้ว กำลังกลับเข้าหน้าเดิม…';
      win.location.replace(target.href);
    } catch {
      status.dataset.error = 'true';
      status.textContent = 'ยังเชื่อมต่อไม่ได้ ลองตรวจอินเทอร์เน็ตแล้วกด “ลองอีกครั้ง”';
    } finally {
      busy = false;
      link.removeAttribute('aria-busy');
      link.removeAttribute('aria-disabled');
    }
  };
  link.addEventListener('click', (event) => {
    event.preventDefault();
    retry();
  });
  win.addEventListener('online', retry);
  // Recover a transient failure automatically. Explicit offline.html previews stay put.
  if (new URL(win.location.href).pathname.split('/').at(-1) !== 'offline.html') retry();
}
if (typeof document !== 'undefined') initializeRecovery();
