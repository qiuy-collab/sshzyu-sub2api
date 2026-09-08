(() => {
  'use strict';
  const root = document.documentElement;
  const themeButton = document.querySelector('.theme-toggle');
  const systemTheme = matchMedia('(prefers-color-scheme: dark)');
  const smallScreen = matchMedia('(max-width: 900px)');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const sidebar = document.getElementById('sidebar');
  const menuButton = document.querySelector('.mobile-menu');
  const overlay = document.querySelector('.menu-overlay');
  const status = document.querySelector('.docs-status');
  const defaultLogo = document.querySelector('[data-default-logo]').dataset.defaultLogo;
  let statusTimer;
  let menuOpen = false;

  function savedTheme() { try { return localStorage.getItem('theme'); } catch { return null; } }
  function applyTheme(value) {
    const dark = value === 'dark' || (value !== 'light' && systemTheme.matches);
    root.dataset.theme = dark ? 'dark' : 'light';
    const label = dark ? '切换浅色模式' : '切换深色模式';
    themeButton.setAttribute('aria-label', label);
    themeButton.title = label;
  }
  applyTheme(savedTheme());
  themeButton.addEventListener('click', () => {
    const theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('theme', theme); } catch { /* The current tab can still switch themes. */ }
    applyTheme(theme);
  });
  systemTheme.addEventListener('change', () => applyTheme(savedTheme()));
  window.addEventListener('storage', event => { if (event.key === 'theme') applyTheme(event.newValue); });

  function announce(message) { clearTimeout(statusTimer); status.textContent = message; statusTimer = setTimeout(() => { status.textContent = ''; }, 3200); }
  function setMenu(open, returnFocus = false) {
    menuOpen = Boolean(open && smallScreen.matches);
    sidebar.classList.toggle('is-open', menuOpen);
    sidebar.inert = smallScreen.matches && !menuOpen;
    if (smallScreen.matches && !menuOpen) sidebar.setAttribute('aria-hidden', 'true');
    else sidebar.removeAttribute('aria-hidden');
    menuButton.setAttribute('aria-expanded', String(menuOpen));
    menuButton.setAttribute('aria-label', menuOpen ? '关闭文档目录' : '打开文档目录');
    document.body.classList.toggle('menu-open', menuOpen);
    overlay.hidden = !menuOpen;
    if (menuOpen) requestAnimationFrame(() => {
      if (menuOpen && smallScreen.matches) sidebar.querySelector('.toc-link').focus({ preventScroll: true });
    });
    else if (returnFocus) menuButton.focus();
  }
  setMenu(false);
  menuButton.addEventListener('click', () => setMenu(!menuOpen, menuOpen));
  document.querySelector('.sidebar-close').addEventListener('click', () => setMenu(false, true));
  overlay.addEventListener('click', () => setMenu(false, true));
  smallScreen.addEventListener('change', () => setMenu(false));
  document.addEventListener('keydown', event => {
    if (!menuOpen) return;
    if (event.key === 'Escape') { event.preventDefault(); setMenu(false, true); }
    if (event.key === 'Tab') {
      const elements = [...sidebar.querySelectorAll('a[href],button:not([disabled])')];
      const first = elements[0], last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });

  document.querySelectorAll('.copy').forEach(button => {
    button.setAttribute('aria-label', '复制这段代码');
    button.addEventListener('click', async () => {
      const code = button.closest('.code-wrap').querySelector('code');
      button.disabled = true;
      try {
        await navigator.clipboard.writeText(code.textContent);
        button.textContent = '已复制'; button.dataset.copied = 'true';
        announce('代码已复制');
        setTimeout(() => { button.textContent = '复制'; delete button.dataset.copied; }, 1600);
      } catch {
        const range = document.createRange(); range.selectNodeContents(code);
        const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
        announce('浏览器未允许自动复制，代码已选中，可手动复制。');
      } finally { button.disabled = false; }
    });
  });

  const headings = [...document.querySelectorAll('.doc-section > h2')];
  const links = [...document.querySelectorAll('.toc-link,.chapter-map a')];
  function targetForLink(link) { try { return document.getElementById(decodeURIComponent(link.hash.slice(1))); } catch { return null; } }
  [...links, document.querySelector('.sidebar .back-top')].forEach(link => link.addEventListener('click', event => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target = targetForLink(link);
    if (!target) return;
    event.preventDefault();
    setMenu(false);
    if (location.hash !== link.hash) history.pushState(null, '', link.hash);
    target.setAttribute('tabindex', '-1'); target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'start', behavior: reducedMotion.matches ? 'instant' : 'smooth' });
  }));
  let scrollFrame = 0;
  function updateReadingPosition() {
    scrollFrame = 0;
    let current = headings[0];
    for (const heading of headings) if (heading.getBoundingClientRect().top <= 150) current = heading;
    if (window.scrollY + innerHeight >= root.scrollHeight - 4) current = headings[headings.length - 1];
    links.forEach(link => {
      const active = current && targetForLink(link) === current;
      link.classList.toggle('active', Boolean(active));
      if (active) link.setAttribute('aria-current', 'location'); else link.removeAttribute('aria-current');
    });
    const scrollable = Math.max(1, root.scrollHeight - innerHeight);
    document.querySelector('.reading-progress span').style.transform = `scaleX(${Math.max(0, Math.min(1, scrollY / scrollable))})`;
  }
  const scheduleReadingPosition = () => { if (!scrollFrame) scrollFrame = requestAnimationFrame(updateReadingPosition); };
  window.addEventListener('scroll', scheduleReadingPosition, { passive: true });
  window.addEventListener('resize', scheduleReadingPosition, { passive: true });
  window.addEventListener('hashchange', scheduleReadingPosition);
  document.querySelectorAll('img').forEach(img => img.addEventListener('load', scheduleReadingPosition));
  updateReadingPosition();

  const dialog = document.querySelector('.image-dialog');
  const enlargedImage = dialog.querySelector('img');
  let imageTrigger;
  document.querySelectorAll('.image-zoom').forEach(button => button.addEventListener('click', () => {
    const original = button.querySelector('img');
    imageTrigger = button;
    enlargedImage.src = original.currentSrc || original.src;
    enlargedImage.alt = original.alt;
    document.getElementById('image-dialog-title').textContent = original.alt || '教程截图';
    dialog.showModal();
  }));
  dialog.querySelector('.image-dialog-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => { enlargedImage.removeAttribute('src'); imageTrigger?.focus({ preventScroll: true }); });

  function safeLogo(value) {
    if (typeof value !== 'string' || !value.trim()) return '';
    const trimmed = value.trim();
    if (/^data:image\/(?:png|jpe?g|gif|webp|avif|svg\+xml|x-icon|vnd\.microsoft\.icon)(?:;[^,]*)?,/i.test(trimmed)) return trimmed;
    try { const url = new URL(trimmed, location.origin); return !url.username && !url.password && (url.protocol === 'https:' || url.protocol === 'http:') ? url.href : ''; } catch { return ''; }
  }
  fetch('/api/v1/settings/public', { credentials: 'same-origin' }).then(response => response.ok ? response.json() : null).then(payload => {
    const settings = payload?.data;
    if (!settings) return;
    const configuredName = typeof settings.site_name === 'string' ? settings.site_name.trim() : '';
    const name = !configuredName || configuredName === 'Sub2API' ? 'SSHZYU' : configuredName;
    document.querySelectorAll('[data-brand-name]').forEach(el => { el.textContent = name; });
    document.querySelector('[data-brand-link]').setAttribute('aria-label', `${name} 首页`);
    document.title = `接入指南 · ${name}`;
    const logo = safeLogo(settings.site_logo) || defaultLogo;
    document.querySelectorAll('[data-brand-logo]').forEach(img => {
      img.alt = name;
      img.addEventListener('error', () => { if (img.getAttribute('src') !== defaultLogo) img.src = defaultLogo; }, { once: true });
      img.src = logo;
    });
    const icon = document.querySelector('[data-brand-icon]'); icon.href = logo;
    if (logo !== defaultLogo) icon.removeAttribute('type');
  }).catch(() => { /* The complete static document and default brand remain available offline. */ });
})();
