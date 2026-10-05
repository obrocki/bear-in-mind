export function resolveColorMode(preference, hostMode, systemDark) {
  if (preference === 'light' || preference === 'dark') return preference;
  if (hostMode === 'light' || hostMode === 'dark') return hostMode;
  return systemDark ? 'dark' : 'light';
}

export function initializeTheme({
  document = globalThis.document,
  media = globalThis.matchMedia('(prefers-color-scheme: dark)'),
  Observer = globalThis.MutationObserver,
} = {}) {
  const root = document.documentElement;
  const control = document.getElementById('theme');
  const update = () => {
    const hostMode = [root.dataset.colorMode, document.body.dataset.colorMode]
      .find((value) => value === 'light' || value === 'dark');
    root.dataset.canvasTheme = control.value;
    root.dataset.canvasColorMode = resolveColorMode(control.value, hostMode, media.matches);
  };
  const observer = new Observer(update);
  for (const element of [root, document.body]) {
    observer.observe(element, { attributes: true, attributeFilter: ['data-color-mode'] });
  }
  control.addEventListener('change', update);
  media.addEventListener('change', update);
  update();
  return () => {
    observer.disconnect();
    control.removeEventListener('change', update);
    media.removeEventListener('change', update);
  };
}
