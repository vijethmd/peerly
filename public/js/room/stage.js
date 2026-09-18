// The video stage: participant tiles, the auto-fitting grid, spotlight view,
// and the per-tile status a viewer needs (muted, hand, connection quality).

import { Emitter, h, clear, iconHtml, paintAvatar } from './ui.js';

const KEY = (pid, source) => `${pid}:${source}`;
const HIDDEN_GRACE_MS = 10000;

export class Stage extends Emitter {
  constructor({ grid, getParticipant, selfPid }) {
    super();
    this.grid = grid;
    this.getParticipant = getParticipant;
    this.selfPid = selfPid;
    this.tiles = new Map();
    this.focusedKey = null;
    this.focusAuto = false;
    this.filmstrip = null;
    this.dataSaver = false;
    this.pageHidden = false;
    this.sinkId = '';

    new ResizeObserver(() => this.layout()).observe(grid);
    window.addEventListener('resize', () => this.layout());
    document.addEventListener('visibilitychange', () => this.onVisibilityChange());
  }

  onVisibilityChange() {
    clearTimeout(this.hiddenTimer);
    if (document.hidden) {
      // Stop asking for video only if the tab stays hidden for a while.
      this.hiddenTimer = setTimeout(() => {
        this.pageHidden = true;
        this.updateViews();
      }, HIDDEN_GRACE_MS);
    } else if (this.pageHidden) {
      this.pageHidden = false;
      this.updateViews();
    }
  }

  // ------------------------------------------------------------------ tiles
  ensure(pid, source) {
    if (!pid) return null;
    const key = KEY(pid, source);
    const existing = this.tiles.get(key);
    if (existing) return existing;

    const isSelf = pid === this.selfPid();
    const participant = this.getParticipant(pid) || { name: '' };
    const video = h('video', { autoplay: true, playsinline: true, muted: isSelf });
    video.muted = isSelf;
    const avatar = h('div', { class: 'avatar' });
    paintAvatar(avatar, participant.name);

    const tile = h(
      'div',
      {
        class: `tile${isSelf ? ' tile-self' : ''}${source === 'screen' ? ' tile-screen' : ''}`,
        dataset: { pid, source, key },
        tabindex: '0',
        role: 'group',
        'aria-label': `${participant.name}${source === 'screen' ? ' presentation' : ''}`
      },
      video,
      h('div', { class: 'tile-avatar' }, avatar),
      h('div', { class: 'tile-placeholder', hidden: true }),
      h('div', { class: 'tile-top' },
        h('span', { class: 'tile-hand', hidden: true, title: 'Hand raised', html: `${iconHtml('hand', 13)}<b></b>` }),
        h('span', { class: 'tile-rec', hidden: true, title: 'Recording' }, h('i', { class: 'dot' }), 'REC')),
      h('div', { class: 'tile-top-right' },
        h('span', { class: 'tile-status', hidden: true }),
        h('span', { class: 'tile-net', hidden: true, title: 'Connection quality' }, h('i'), h('i'), h('i'))),
      h('div', { class: 'tile-label' },
        h('span', { class: 'tile-speaking', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
        h('span', { class: 'tile-mic', hidden: true, html: iconHtml('micOff', 13) }),
        h('span', { class: 'tile-name', text: participant.name })),
      h('div', { class: 'tile-actions' },
        h('button', {
          class: 'tile-btn',
          type: 'button',
          title: 'Pin to the main view',
          'aria-label': 'Pin to the main view',
          html: iconHtml('pin', 16),
          onClick: (event) => {
            event.stopPropagation();
            this.togglePin(key);
          }
        }),
        h('button', {
          class: 'tile-btn',
          type: 'button',
          title: 'More options',
          'aria-label': `More options for ${participant.name}`,
          'aria-haspopup': 'menu',
          html: iconHtml('more', 16),
          onClick: (event) => {
            event.stopPropagation();
            this.emit('menu', { pid, anchor: event.currentTarget });
          }
        })),
      h('div', { class: 'tile-reaction', 'aria-hidden': 'true' })
    );

    tile.addEventListener('dblclick', () => this.togglePin(key));
    tile.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        this.togglePin(key);
      }
    });

    const record = { key, pid, source, isSelf, el: tile, video, avatar };
    this.tiles.set(key, record);
    (this.focusedKey && this.filmstrip ? this.filmstrip : this.grid).append(tile);
    this.layout();
    this.updateViews();
    return record;
  }

  remove(key) {
    const record = this.tiles.get(key);
    if (!record) return;
    if (this.focusedKey === key) this.unfocus();
    record.video.srcObject = null;
    record.el.remove();
    this.tiles.delete(key);
    this.layout();
  }

  removeParticipant(pid) {
    for (const source of ['camera', 'screen']) this.remove(KEY(pid, source));
  }

  async bindStream(pid, source, stream) {
    const record = this.tiles.get(KEY(pid, source));
    if (!record) return;
    if (record.video.srcObject !== stream) record.video.srcObject = stream;
    if (this.sinkId && typeof record.video.setSinkId === 'function') {
      record.video.setSinkId(this.sinkId).catch(() => {});
    }
    try {
      await record.video.play();
    } catch (err) {
      // Autoplay with sound can be blocked until the person interacts.
      if (err && err.name === 'NotAllowedError') this.emit('autoplay-blocked');
    }
  }

  retryPlayback() {
    for (const record of this.tiles.values()) record.video.play().catch(() => {});
  }

  setSinkId(deviceId) {
    this.sinkId = deviceId || '';
    if (!this.sinkId) return;
    for (const record of this.tiles.values()) {
      if (typeof record.video.setSinkId === 'function') record.video.setSinkId(this.sinkId).catch(() => {});
    }
  }

  // ------------------------------------------------------------ tile state
  syncParticipant(participant, { hostPid, handQueue = [] } = {}) {
    if (!participant || !participant.pid) return;
    const isSelf = participant.pid === this.selfPid();
    const camera = this.ensure(participant.pid, 'camera');
    if (participant.sharing) this.ensure(participant.pid, 'screen');
    else this.remove(KEY(participant.pid, 'screen'));

    const screen = this.tiles.get(KEY(participant.pid, 'screen'));
    for (const record of [camera, screen]) {
      if (!record) continue;
      const el = record.el;
      const showVideo = record.source === 'screen' ? participant.sharing : participant.camOn;
      el.classList.toggle('cam-off', !showVideo);
      el.classList.toggle('mirrored', isSelf && record.source === 'camera');
      el.classList.toggle('is-host', participant.pid === hostPid);
      el.classList.toggle('reconnecting', participant.connected === false);

      const handIndex = handQueue.indexOf(participant.pid);
      const hand = el.querySelector('.tile-hand');
      hand.hidden = !participant.handRaised || record.source === 'screen';
      hand.querySelector('b').textContent = handIndex >= 0 ? String(handIndex + 1) : '';

      el.querySelector('.tile-rec').hidden = !participant.recording || record.source === 'screen';
      el.querySelector('.tile-mic').hidden = participant.micOn || record.source === 'screen';
      paintAvatar(record.avatar, participant.name);

      const suffix = record.source === 'screen' ? (isSelf ? ' — your presentation' : '’s presentation') : '';
      const label = isSelf && record.source === 'camera' ? `${participant.name} (you)` : `${participant.name}${suffix}`;
      el.querySelector('.tile-name').textContent = label;
      el.setAttribute('aria-label', label);

      if (participant.connected === false) this.setStatus(record.key, 'Reconnecting…');
      else if (el.dataset.statusReason === 'reconnecting') this.setStatus(record.key, null);
    }

    // Presenting your own screen: show a placeholder instead of a mirror.
    if (screen && isSelf) {
      screen.el.classList.add('tile-self-screen');
      const placeholder = screen.el.querySelector('.tile-placeholder');
      placeholder.hidden = false;
      if (!placeholder.dataset.ready) {
        placeholder.dataset.ready = '1';
        placeholder.append(
          h('p', { class: 'tile-placeholder-title', text: 'You’re presenting to everyone' }),
          h('button', {
            class: 'btn btn-ghost btn-sm',
            type: 'button',
            text: 'Stop presenting',
            onClick: () => this.emit('stop-presenting')
          })
        );
      }
    }

    if (participant.sharing && !isSelf && this.focusedKey === null) this.focus(KEY(participant.pid, 'screen'), true);
    if (!participant.sharing && this.focusAuto && this.focusedKey === KEY(participant.pid, 'screen')) this.unfocus();
  }

  setStatus(key, text, reason = '') {
    const record = this.tiles.get(key);
    if (!record) return;
    const status = record.el.querySelector('.tile-status');
    status.hidden = !text;
    status.textContent = text || '';
    record.el.dataset.statusReason = text ? reason || 'status' : '';
  }

  setLinkState(pid, state) {
    const key = KEY(pid, 'camera');
    const participant = this.getParticipant(pid);
    if (participant && participant.connected === false) return; // signaling status wins
    if (state === 'connected') this.setStatus(key, null);
    else if (state === 'connecting' || state === 'new') this.setStatus(key, 'Connecting…', 'link');
    else if (state === 'disconnected' || state === 'failed') this.setStatus(key, 'Reconnecting…', 'link');
  }

  setFrozen(pid, source, frozen) {
    const key = KEY(pid, source);
    if (frozen) this.setStatus(key, 'Video paused — poor connection', 'frozen');
    else if (this.tiles.get(key)?.el.dataset.statusReason === 'frozen') this.setStatus(key, null);
  }

  setQuality(pid, { quality, rttMs, loss, relay }) {
    for (const source of ['camera', 'screen']) {
      const record = this.tiles.get(KEY(pid, source));
      if (!record) continue;
      const net = record.el.querySelector('.tile-net');
      net.hidden = quality === 'good' || quality === 'unknown';
      net.dataset.level = quality;
      net.title = `Connection: ${quality} · ${rttMs} ms round trip · ${Math.round(loss * 100)}% packet loss${relay ? ' · relayed' : ''}`;
    }
  }

  setSpeaking(pid, speaking) {
    const record = this.tiles.get(KEY(pid, 'camera'));
    if (record) record.el.classList.toggle('speaking', Boolean(speaking));
  }

  setLevel(pid, level) {
    const record = this.tiles.get(KEY(pid, 'camera'));
    if (record) record.el.style.setProperty('--level', Math.min(1, level * 12).toFixed(2));
  }

  flashReaction(pid, emoji) {
    const record = this.tiles.get(KEY(pid, 'camera'));
    if (!record) return;
    const slot = record.el.querySelector('.tile-reaction');
    slot.textContent = emoji;
    slot.classList.remove('pop');
    void slot.offsetWidth; // restart the animation
    slot.classList.add('pop');
    clearTimeout(record.reactionTimer);
    record.reactionTimer = setTimeout(() => {
      slot.textContent = '';
      slot.classList.remove('pop');
    }, 3000);
  }

  // -------------------------------------------------------------- spotlight
  togglePin(key) {
    if (this.focusedKey === key) this.unfocus();
    else this.focus(key, false);
  }

  focus(key, auto = false) {
    const record = this.tiles.get(key);
    if (!record) return;
    if (!this.filmstrip) this.filmstrip = h('div', { class: 'filmstrip' });
    this.focusedKey = key;
    this.focusAuto = auto;
    this.grid.classList.add('focus-mode');
    for (const tile of this.tiles.values()) {
      tile.el.classList.toggle('focused', tile.key === key);
      if (tile.key === key) this.grid.prepend(tile.el);
      else this.filmstrip.append(tile.el);
    }
    this.grid.append(this.filmstrip);
    this.grid.style.removeProperty('--tile-w');
    this.updateViews();
    this.emit('focus-changed', key);
  }

  unfocus() {
    if (!this.focusedKey) return;
    this.focusedKey = null;
    this.focusAuto = false;
    this.grid.classList.remove('focus-mode');
    for (const tile of this.tiles.values()) tile.el.classList.remove('focused');
    if (this.filmstrip) {
      for (const child of Array.from(this.filmstrip.children)) this.grid.append(child);
      this.filmstrip.remove();
    }
    this.layout();
    this.updateViews();
    this.emit('focus-changed', null);
  }

  /** Largest 16:9 tiles that fit everyone, like a meeting grid should. */
  layout() {
    if (this.focusedKey) return; // spotlight layout is pure CSS
    const count = this.grid.children.length;
    if (!count) return;
    const width = this.grid.clientWidth;
    const height = this.grid.clientHeight;
    const gap = 10;
    let best = 160;
    for (let columns = 1; columns <= count; columns++) {
      const rows = Math.ceil(count / columns);
      let w = (width - gap * (columns - 1)) / columns;
      let h = (w * 9) / 16;
      const maxHeight = (height - gap * (rows - 1)) / rows;
      if (h > maxHeight) {
        h = maxHeight;
        w = (h * 16) / 9;
      }
      if (w > best) best = w;
    }
    this.grid.style.setProperty('--tile-w', `${Math.floor(best)}px`);
  }

  // ------------------------------------------------------------------ views
  setDataSaver(on) {
    this.dataSaver = on;
    this.updateViews();
  }

  viewFor(key) {
    if (this.pageHidden) return 'hidden';
    if (this.focusedKey === key) return 'focused';
    if (this.focusedKey) return 'thumb';
    if (this.dataSaver) return 'thumb';
    return 'normal';
  }

  /** Tells senders how prominently we show them, so they can scale. */
  updateViews() {
    for (const record of this.tiles.values()) {
      if (record.isSelf) continue;
      this.emit('view', { pid: record.pid, source: record.source, view: this.viewFor(record.key) });
    }
  }

  resendViews(pid) {
    for (const source of ['camera', 'screen']) {
      const record = this.tiles.get(KEY(pid, source));
      if (record) this.emit('view', { pid, source, view: this.viewFor(record.key), force: true });
    }
  }

  clearAll() {
    for (const key of [...this.tiles.keys()]) this.remove(key);
    clear(this.grid);
    this.filmstrip = null;
    this.focusedKey = null;
  }
}
