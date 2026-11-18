// Runs before styles paint. Store only a visual preference, never account data.
(() => {
  // Capture before deferred modules/data load; browsers may fire the install event early.
  const installation = (globalThis.dmInstallation = { prompt: null, installed: false });
  addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installation.prompt = event;
    installation.installed = false;
    document.dispatchEvent(new Event('dm:install-state'));
  });
  addEventListener('appinstalled', () => {
    installation.prompt = null;
    installation.installed = true;
    document.dispatchEvent(new Event('dm:install-state'));
  });
  let theme = 'system';
  try {
    theme = localStorage.getItem('dm:theme') || theme;
  } catch {
    /* Storage may be unavailable. */
  }
  const dark =
    theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('theme-dark', dark);
  let active;
  addEventListener('pagereveal', (event) => {
    active = event.viewTransition;
    active?.finished.then(() => {
      if (active === event.viewTransition) active = null;
    });
  });
  document.addEventListener('dm:clear-private-view', () => active?.skipTransition());
})();
