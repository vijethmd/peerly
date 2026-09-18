// Small DOM, formatting and overlay helpers shared across the room UI.

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

/**
 * Creates an element. `html` is only ever used with our own icon markup;
 * anything from a person goes through `text` so it can never be markup.
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key === 'html') el.innerHTML = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'hidden') el.hidden = Boolean(value);
    else if (key === 'disabled') el.disabled = Boolean(value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

const PATHS = {
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v1a7 7 0 0 0 14 0v-1M12 18v4"/>',
  micOff:
    '<path d="M9 5a3 3 0 0 1 6 0v6c0 .5-.12.97-.34 1.38M9 9v2a3 3 0 0 0 4.68 2.48"/><path d="M5 10v1a7 7 0 0 0 11.36 5.47M19 10v1c0 .93-.18 1.82-.51 2.63M12 18v4"/><path d="M3 3l18 18"/>',
  cam: '<path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/>',
  camOff: '<path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m5 0h4a2 2 0 0 1 2 2v4l7-5v12"/><path d="M1 1l22 22"/>',
  share: '<rect x="2" y="4" width="20" height="14" rx="2"/><path d="M12 14V8m0 0l-3 3m3-3l3 3"/>',
  stopShare: '<rect x="2" y="4" width="20" height="14" rx="2"/><path d="M9.5 8.5l5 5m0-5l-5 5"/>',
  hand: '<path d="M18 11V6.5a1.5 1.5 0 0 0-3 0V11m0-1V4.5a1.5 1.5 0 0 0-3 0V10m0 .5v-6a1.5 1.5 0 0 0-3 0V12m9-1.5v2a7.5 7.5 0 0 1-7.5 7.5h-.36a6 6 0 0 1-5.06-2.78L3.5 13.5a1.63 1.63 0 0 1 2.6-1.95L7.5 13"/>',
  smile: '<circle cx="12" cy="12" r="9.5"/><path d="M8.5 14.5s1.3 1.8 3.5 1.8 3.5-1.8 3.5-1.8"/><path d="M9 9.5v.01M15 9.5v.01"/>',
  captions: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M10.6 10.3a2.6 2.6 0 1 0 0 3.4M17.6 10.3a2.6 2.6 0 1 0 0 3.4"/>',
  more: '<circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="19" r="1.4"/>',
  leave:
    '<path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11l-1.27 1.27"/><path d="M22 2L2 22"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  people: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  sparkles: '<path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9z"/><path d="M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
  close: '<path d="M18 6L6 18M6 6l12 12"/>',
  send: '<path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  pin: '<path d="M9 3h6l-1 7 3.2 3.4H6.8L10 10z"/><path d="M12 13.4V21"/>',
  record: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/>',
  settings: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  effects: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="12" cy="10" r="3"/><path d="M6.5 20a5.5 5.5 0 0 1 11 0"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
  refresh: '<path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  alert: '<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  muteOthers: '<path d="M11 5L6 9H2v6h4l5 4z"/><path d="M23 9l-6 6M17 9l6 6"/>',
  speaker: '<path d="M11 5L6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>',
  userMinus: '<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><path d="M23 11h-6"/>',
  star: '<path d="M12 2.5l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.4 6.2 20.4l1.1-6.5L2.6 9.3l6.5-.9z"/>',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  leaf: '<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.5 19 2c1 2 2 4.2 2 8 0 5.5-4.8 10-10 10z"/><path d="M2 21c0-3 1.9-5.4 5.2-6"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>',
  blur: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="7" stroke-dasharray="2 3"/><circle cx="12" cy="12" r="10.5" stroke-dasharray="1 4"/>',
  none: '<circle cx="12" cy="12" r="9.5"/><path d="M5.3 5.3l13.4 13.4"/>',
  expand: '<path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/>',
  chevron: '<path d="M6 9l6 6 6-6"/>'
};

/** Trusted, static SVG markup for our own icon set. */
export function iconHtml(name, size = 20) {
  const path = PATHS[name] || '';
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${path}</svg>`;
}

export function iconEl(name, size = 20) {
  const span = document.createElement('span');
  span.className = 'icon';
  span.innerHTML = iconHtml(name, size);
  return span;
}

export function setIcon(el, name, size = 20) {
  el.innerHTML = iconHtml(name, size);
}

// ---------------------------------------------------------------- text bits

export function initials(name) {
  const parts = String(name || '').split(/\s+/).filter(Boolean).slice(0, 2);
  return parts.map((word) => [...word][0]).join('').toUpperCase() || '?';
}

export function hueFor(name) {
  let hash = 0;
  for (const char of String(name || '')) hash = (hash * 31 + char.codePointAt(0)) % 360;
  return hash;
}

export function paintAvatar(el, name) {
  el.textContent = initials(name);
  el.style.setProperty('--avatar-hue', String(hueFor(name)));
}

export const formatClock = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${m}:${s}` : `${m}:${s}`;
}

export function formatRelative(ts) {
  const seconds = Math.round((Date.now() - ts) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)} h ago`;
}

export function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// ------------------------------------------------------------------ toasts

let toastRoot = null;

export function toast(message, { tone = 'info', timeout = 4500, actions = [], id } = {}) {
  toastRoot ||= $('#toasts');
  if (!toastRoot) return { close() {} };
  if (id) toastRoot.querySelector(`[data-toast-id="${CSS.escape(id)}"]`)?.remove();

  const el = h('div', {
    class: `toast toast-${tone}${actions.length ? ' toast-action' : ''}`,
    role: tone === 'error' ? 'alert' : 'status',
    ...(id ? { dataset: { toastId: id } } : {})
  });
  el.append(h('span', { class: 'toast-text', text: message }));

  let timer;
  const close = () => {
    clearTimeout(timer);
    el.classList.add('toast-leaving');
    setTimeout(() => el.remove(), 200);
  };
  for (const action of actions) {
    el.append(
      h('button', {
        class: `toast-btn${action.primary ? ' toast-btn-primary' : ''}`,
        type: 'button',
        text: action.label,
        onClick: () => {
          close();
          action.onSelect?.();
        }
      })
    );
  }
  el.append(h('button', { class: 'toast-close', type: 'button', 'aria-label': 'Dismiss', html: iconHtml('close', 14), onClick: close }));

  toastRoot.append(el);
  while (toastRoot.children.length > 4) toastRoot.firstElementChild.remove();
  if (timeout) timer = setTimeout(close, timeout);
  return { close, el };
}

/** Drops every toast, e.g. join requests that no longer apply once the call is over. */
export function clearToasts() {
  toastRoot ||= $('#toasts');
  toastRoot?.replaceChildren();
}

export function announce(message) {
  const region = $('#srAnnouncer');
  if (!region) return;
  region.textContent = '';
  setTimeout(() => {
    region.textContent = message;
  }, 50);
}

// ------------------------------------------------------------------- menus

let currentMenu = null;

export function closeMenu() {
  if (!currentMenu) return;
  const { menu, anchor, onDocPointer, onKey } = currentMenu;
  currentMenu = null;
  document.removeEventListener('pointerdown', onDocPointer, true);
  document.removeEventListener('keydown', onKey, true);
  window.removeEventListener('resize', closeMenu);
  menu.remove();
  anchor?.setAttribute('aria-expanded', 'false');
}

/** Lightweight popup menu: `items` are {label, icon?, hint?, checked?, danger?, disabled?, onSelect} or 'separator'. */
export function openMenu(anchor, items, { align = 'end' } = {}) {
  const wasOpen = currentMenu && currentMenu.anchor === anchor;
  closeMenu();
  if (wasOpen) return;

  const menu = h('div', { class: 'menu', role: 'menu' });
  for (const item of items.filter(Boolean)) {
    if (item === 'separator') {
      menu.append(h('div', { class: 'menu-sep', role: 'separator' }));
      continue;
    }
    const button = h(
      'button',
      {
        class: `menu-item${item.danger ? ' menu-item-danger' : ''}`,
        type: 'button',
        role: item.checked === undefined ? 'menuitem' : 'menuitemcheckbox',
        'aria-checked': item.checked === undefined ? undefined : String(Boolean(item.checked)),
        disabled: item.disabled,
        onClick: () => {
          closeMenu();
          item.onSelect?.();
        }
      },
      item.icon ? h('span', { class: 'menu-icon', html: iconHtml(item.icon, 18) }) : h('span', { class: 'menu-icon' }),
      h('span', { class: 'menu-label', text: item.label }),
      item.checked ? h('span', { class: 'menu-check', html: iconHtml('check', 16) }) : null,
      item.hint ? h('kbd', { class: 'menu-hint', text: item.hint }) : null
    );
    menu.append(button);
  }

  document.body.append(menu);
  const rect = anchor.getBoundingClientRect();
  const { width, height } = menu.getBoundingClientRect();
  let left = align === 'end' ? rect.right - width : rect.left;
  left = Math.min(Math.max(8, left), window.innerWidth - width - 8);
  const above = rect.top > height + 16 && rect.bottom + height + 16 > window.innerHeight;
  const top = above ? rect.top - height - 8 : rect.bottom + 8;
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(Math.min(Math.max(8, top), window.innerHeight - height - 8))}px`;

  const entries = () => $$('.menu-item:not([disabled])', menu);
  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      closeMenu();
      anchor.focus();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const list = entries();
      const index = list.indexOf(document.activeElement);
      const next = event.key === 'ArrowDown' ? index + 1 : index - 1;
      list[(next + list.length) % list.length]?.focus();
    } else if (event.key === 'Tab') {
      closeMenu();
    }
  };
  const onDocPointer = (event) => {
    if (!menu.contains(event.target) && !anchor.contains(event.target)) closeMenu();
  };
  document.addEventListener('pointerdown', onDocPointer, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', closeMenu);
  anchor.setAttribute('aria-expanded', 'true');
  currentMenu = { menu, anchor, onDocPointer, onKey };
  entries()[0]?.focus();
}

// ------------------------------------------------------------------ dialogs

export function openDialog(dialog) {
  if (!dialog) return;
  if (typeof dialog.showModal === 'function') {
    if (!dialog.open) dialog.showModal();
  } else {
    dialog.setAttribute('open', '');
  }
}

export function closeDialog(dialog) {
  if (!dialog) return;
  if (typeof dialog.close === 'function' && dialog.open) dialog.close();
  else dialog.removeAttribute('open');
}

export function confirmDialog({ title, body, confirmLabel = 'Confirm', danger = false }) {
  const dialog = $('#confirmDialog');
  $('#confirmTitle', dialog).textContent = title;
  $('#confirmBody', dialog).textContent = body;
  const ok = $('#confirmOk', dialog);
  ok.textContent = confirmLabel;
  ok.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
  openDialog(dialog);
  return new Promise((resolve) => {
    const finish = (value) => {
      ok.removeEventListener('click', onOk);
      dialog.removeEventListener('close', onClose);
      closeDialog(dialog);
      resolve(value);
    };
    const onOk = () => finish(true);
    const onClose = () => finish(false);
    ok.addEventListener('click', onOk);
    dialog.addEventListener('close', onClose);
  });
}

/** Minimal event emitter used between modules. */
export class Emitter {
  constructor() {
    this.handlers = new Map();
  }

  on(type, handler) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(handler);
    return () => this.off(type, handler);
  }

  off(type, handler) {
    this.handlers.get(type)?.delete(handler);
  }

  emit(type, payload) {
    for (const handler of this.handlers.get(type) || []) {
      try {
        handler(payload);
      } catch (err) {
        console.error(`handler for "${type}" failed`, err);
      }
    }
  }
}
