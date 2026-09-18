// In-call messages, including private messages to one person.

import { $, h, clear, iconHtml, formatClock, toast } from './ui.js';

const URL_RE = /(https?:\/\/[^\s<>"']+)/;
const GROUP_WINDOW_MS = 120000;

export class ChatPanel {
  constructor({ call, onUnread }) {
    this.call = call;
    this.onUnread = onUnread;
    this.panel = $('#chatPanel');
    this.list = $('#chatMessages');
    this.form = $('#chatForm');
    this.input = $('#chatInput');
    this.select = $('#chatTo');
    this.notice = $('#chatNotice');
    this.seen = new Set();
    this.lastGroupKey = null;
    this.lastTs = 0;
    this.unread = 0;
  }

  init() {
    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      this.send();
    });
    this.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        this.send();
      }
    });
    this.input.addEventListener('input', () => this.autoGrow());
    this.select.addEventListener('change', () => this.updatePlaceholder());

    this.call.on('chat', (message) => this.addMessage(message));
    this.call.on('chat-history', (messages) => messages.forEach((message) => this.addMessage(message, { silent: true })));
    this.call.on('participants', () => this.updateRecipients());
    this.call.on('settings', () => this.updateRecipients());
    this.renderEmpty();
  }

  get isOpen() {
    return !this.panel.hidden;
  }

  autoGrow() {
    this.input.style.height = 'auto';
    this.input.style.height = `${Math.min(120, this.input.scrollHeight)}px`;
  }

  renderEmpty() {
    if (this.list.childElementCount) return;
    this.list.append(
      h('p', { class: 'chat-empty', text: 'Messages are only visible to people in the call and disappear when it ends.' })
    );
  }

  updateRecipients() {
    const previous = this.select.value;
    const canDm = this.call.settings.privateChat || this.call.isHost();
    clear(this.select);
    this.select.append(h('option', { value: '', text: 'Everyone' }));
    for (const participant of this.call.allParticipants()) {
      if (participant.isSelf) continue;
      this.select.append(h('option', { value: participant.pid, text: `${participant.name} (privately)` }));
    }
    this.select.value = [...this.select.options].some((option) => option.value === previous) ? previous : '';
    this.select.disabled = !canDm;
    if (!canDm && this.select.value) this.select.value = '';
    this.notice.textContent = canDm
      ? 'Messages stay in this meeting. Private messages are never included in AI notes.'
      : 'The host turned off private messages. Everyone in the meeting sees what you send.';
    this.updatePlaceholder();
  }

  updatePlaceholder() {
    const pid = this.select.value;
    const target = pid ? this.call.participant(pid) : null;
    this.input.placeholder = target ? `Message ${target.name} privately` : 'Send a message to everyone';
    this.form.classList.toggle('is-private', Boolean(pid));
  }

  setRecipient(pid) {
    if ([...this.select.options].some((option) => option.value === pid)) {
      this.select.value = pid;
      this.updatePlaceholder();
    }
    this.input.focus();
  }

  async send() {
    const text = this.input.value.trim();
    if (!text) return;
    const to = this.select.value || undefined;
    this.input.value = '';
    this.autoGrow();
    const result = await this.call.sendChat(text, to);
    if (!result.ok) {
      toast(result.error || 'Message not sent.', { tone: 'error' });
      if (!this.input.value) {
        this.input.value = text;
        this.autoGrow();
      }
    }
  }

  renderBody(text) {
    const body = h('div', { class: 'chat-msg-text' });
    // Links become anchors via DOM nodes; message text is never HTML.
    for (const part of text.split(new RegExp(URL_RE.source, 'g'))) {
      if (!part) continue;
      if (URL_RE.test(part) && part.startsWith('http')) {
        body.append(h('a', { href: part, text: part, target: '_blank', rel: 'noopener noreferrer' }));
      } else {
        body.append(document.createTextNode(part));
      }
    }
    return body;
  }

  addMessage(message, { silent = false } = {}) {
    if (message.id !== undefined) {
      if (this.seen.has(message.id)) return;
      this.seen.add(message.id);
    }
    this.list.querySelector('.chat-empty')?.remove();

    const isSelf = message.from === this.call.self.pid;
    const isPrivate = Boolean(message.to);
    const groupKey = `${message.from}:${message.to || ''}`;
    const grouped = this.lastGroupKey === groupKey && message.ts - this.lastTs < GROUP_WINDOW_MS;
    this.lastGroupKey = groupKey;
    this.lastTs = message.ts;

    const wrap = h('div', {
      class: `chat-msg${isSelf ? ' is-self' : ''}${isPrivate ? ' is-private' : ''}${grouped ? ' is-grouped' : ''}`
    });
    if (!grouped) {
      const meta = h(
        'div',
        { class: 'chat-msg-meta' },
        h('span', { class: 'who', text: isSelf ? 'You' : message.name }),
        h('time', { class: 'when', text: formatClock(message.ts) })
      );
      if (isPrivate) {
        meta.append(
          h('span', {
            class: 'chat-private-tag',
            html: iconHtml('lock', 11),
            title: 'Private message'
          }),
          h('span', { class: 'chat-private-text', text: isSelf ? `only to ${message.toName}` : 'only to you' })
        );
      }
      wrap.append(meta);
    }
    wrap.append(this.renderBody(message.text));
    if (!isSelf && (this.call.settings.privateChat || this.call.isHost())) {
      wrap.append(
        h('button', {
          class: 'chat-reply',
          type: 'button',
          text: 'Reply privately',
          onClick: () => this.setRecipient(message.from)
        })
      );
    }

    const atBottom = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 80;
    this.list.append(wrap);
    if (atBottom || isSelf) this.list.scrollTop = this.list.scrollHeight;

    if (!silent && !isSelf && !this.isOpen) {
      this.unread += 1;
      this.onUnread?.(this.unread);
      if (isPrivate) {
        toast(`Private message from ${message.name}`, {
          id: `dm-${message.from}`,
          actions: [{ label: 'Reply', primary: true, onSelect: () => this.open(message.from) }]
        });
      }
    }
  }

  open(recipientPid) {
    this.onUnread?.(0);
    this.unread = 0;
    this.list.scrollTop = this.list.scrollHeight;
    if (recipientPid) this.setRecipient(recipientPid);
  }

  markRead() {
    this.unread = 0;
    this.onUnread?.(0);
  }
}
