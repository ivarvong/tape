// apps/playground/site.ts: run before the first paint by both pages (a classic script in <head>, so nothing flashes
// or moves): the light or dark choice, the `js` class that tells the stylesheet script runs (tab panels then show
// one at a time; without script they show stacked), and the behaviour of every [data-tabs] tab list: click, and the
// arrow, Home and End keys, as the ARIA tabs pattern has it. The choice of theme is kept under one localStorage key.
// build.ts strips its types and publishes it as a/site.<hash>.js; it imports nothing and exports nothing.
(() => {
  const root = document.documentElement;
  root.classList.add('js');
  const get = (): string | null => {
    try {
      return localStorage.getItem('theme');
    } catch {
      return null;
    }
  };
  const t = get();
  if (t === 'light' || t === 'dark') root.dataset['theme'] = t;

  const select = (tab: HTMLElement, focus: boolean): void => {
    const list = tab.closest('[role="tablist"]');
    if (!list) return;
    for (const each of list.querySelectorAll<HTMLElement>('[role="tab"]')) {
      const on = each === tab;
      each.setAttribute('aria-selected', String(on));
      each.tabIndex = on ? 0 : -1;
      const id = each.getAttribute('aria-controls');
      const panel = id === null ? null : document.querySelector(`#${id}`);
      if (panel) panel.classList.toggle('on', on);
    }
    if (focus) tab.focus();
    const name = tab.dataset['tab'];
    list.dispatchEvent(
      new CustomEvent('tabchange', {
        bubbles: true,
        detail: { tab: name === undefined || name === '' ? tab.id : name },
      }),
    );
  };

  document.addEventListener('DOMContentLoaded', () => {
    const b = document.querySelector('#theme');
    if (b)
      b.addEventListener('click', () => {
        const chosen = root.dataset['theme'];
        const now =
          chosen === undefined || chosen === ''
            ? matchMedia('(prefers-color-scheme: dark)').matches
              ? 'dark'
              : 'light'
            : chosen;
        const next = now === 'dark' ? 'light' : 'dark';
        root.dataset['theme'] = next;
        try {
          localStorage.setItem('theme', next);
        } catch {
          /* private mode: the choice lasts this visit */
        }
      });
    for (const list of document.querySelectorAll<HTMLElement>('[data-tabs]')) {
      list.addEventListener('click', e => {
        const tab = e.target instanceof Element ? e.target.closest<HTMLElement>('[role="tab"]') : null;
        if (tab) select(tab, false);
      });
      list.addEventListener('keydown', e => {
        const tabs = [...list.querySelectorAll<HTMLElement>('[role="tab"]')];
        const active = document.activeElement;
        const at = active instanceof HTMLElement ? tabs.indexOf(active) : -1;
        if (at < 0) return;
        const to =
          e.key === 'ArrowRight'
            ? (at + 1) % tabs.length
            : e.key === 'ArrowLeft'
              ? (at - 1 + tabs.length) % tabs.length
              : e.key === 'Home'
                ? 0
                : e.key === 'End'
                  ? tabs.length - 1
                  : -1;
        const next = tabs[to];
        if (!next) return;
        e.preventDefault();
        select(next, true);
      });
    }
  });
})();
