// Participants panel: who's here, the waiting room, and host controls.

import { $, h, clear, iconHtml, openMenu, confirmDialog, paintAvatar, toast, pluralize } from './ui.js';

export class PeoplePanel {
  constructor({ call, onMessagePrivately, onPin, isPinned }) {
    this.call = call;
    this.onMessagePrivately = onMessagePrivately;
    this.onPin = onPin;
    this.isPinned = isPinned;
    this.panel = $('#peoplePanel');
    this.list = $('#peopleList');
    this.count = $('#peopleCount');
    this.waitingSection = $('#waitingSection');
    this.waitingList = $('#waitingList');
    this.hostControls = $('#hostControls');
  }

  init() {
    const rerender = () => this.render();
    this.call.on('participants', rerender);
    this.call.on('self-updated', rerender);
    this.call.on('host-changed', rerender);
    this.call.on('settings', rerender);
    this.call.on('waiting', () => this.renderWaiting());

    $('#admitAllBtn').addEventListener('click', () => this.call.admitAllWaiting());
    $('#muteAllBtn').addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'Mute everyone?',
        body: 'Everyone else will be muted. They can unmute themselves again.',
        confirmLabel: 'Mute everyone'
      });
      if (ok) {
        await this.call.hostAction('mute-all');
        toast('Everyone was muted');
      }
    });
    $('#lowerHandsBtn').addEventListener('click', () => this.call.hostAction('lower-all-hands'));
    $('#endForAllBtn').addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'End the meeting for everyone?',
        body: 'Everyone will be removed from the call. If the transcript is on, the notes are written now.',
        confirmLabel: 'End meeting',
        danger: true
      });
      if (ok) this.call.hostAction('end-meeting');
    });

    $('#lockToggle').addEventListener('change', (event) => {
      this.call.hostAction(event.target.checked ? 'lock' : 'unlock');
    });
    $('#privateChatToggle').addEventListener('change', (event) => {
      this.call.hostAction('settings', { privateChat: event.target.checked });
    });
    $('#shareApprovalToggle').addEventListener('change', (event) => {
      this.call.hostAction('settings', { shareRequiresApproval: event.target.checked });
    });
    this.render();
  }

  render() {
    const call = this.call;
    const participants = call.allParticipants();
    const handQueue = call.handQueue();
    this.count.textContent = `(${participants.length})`;

    const isHost = call.isHost();
    this.hostControls.hidden = !isHost;
    if (isHost) {
      $('#lockToggle').checked = call.settings.locked;
      $('#privateChatToggle').checked = call.settings.privateChat;
      $('#shareApprovalToggle').checked = call.settings.shareRequiresApproval;
      $('#lowerHandsBtn').hidden = handQueue.length === 0;
    }

    const sorted = participants.sort((a, b) => {
      const handA = handQueue.indexOf(a.pid);
      const handB = handQueue.indexOf(b.pid);
      if (handA !== handB) return (handA < 0 ? 99 : handA) - (handB < 0 ? 99 : handB);
      if ((a.pid === call.hostPid) !== (b.pid === call.hostPid)) return a.pid === call.hostPid ? -1 : 1;
      return String(a.name).localeCompare(String(b.name));
    });

    clear(this.list);
    for (const participant of sorted) this.list.append(this.renderRow(participant, { handQueue }));
    this.renderWaiting();
  }

  renderRow(participant, { handQueue }) {
    const call = this.call;
    const isSelf = Boolean(participant.isSelf);
    const avatar = h('div', { class: 'avatar' });
    paintAvatar(avatar, participant.name);

    const tags = [];
    if (isSelf) tags.push('you');
    if (participant.pid === call.hostPid) tags.push('host');
    if (participant.connected === false) tags.push('reconnecting');

    const name = h('div', { class: 'people-name' }, h('span', { class: 'people-name-text', text: participant.name }));
    if (tags.length) name.append(h('span', { class: 'people-tag', text: ` (${tags.join(', ')})` }));

    const flags = h('div', { class: 'people-flags' });
    const handIndex = handQueue.indexOf(participant.pid);
    if (handIndex >= 0) {
      flags.append(h('span', { class: 'flag flag-hand', title: `Hand raised (#${handIndex + 1})`, html: iconHtml('hand', 15) }));
    }
    if (participant.sharing) flags.append(h('span', { class: 'flag flag-share', title: 'Presenting', html: iconHtml('share', 15) }));
    if (participant.recording) flags.append(h('span', { class: 'flag flag-rec', title: 'Recording locally', html: iconHtml('record', 15) }));
    if (!participant.micOn) flags.append(h('span', { class: 'flag flag-mic', title: 'Muted', html: iconHtml('micOff', 15) }));
    if (!participant.camOn) flags.append(h('span', { class: 'flag flag-cam', title: 'Camera off', html: iconHtml('camOff', 15) }));

    const menuBtn = h('button', {
      class: 'icon-btn people-menu',
      type: 'button',
      'aria-label': `Options for ${participant.name}`,
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
      html: iconHtml('more', 18),
      onClick: (event) => this.openMenu(event.currentTarget, participant)
    });

    return h('li', { class: `people-row${participant.connected === false ? ' is-away' : ''}` }, avatar, h('div', { class: 'people-mid' }, name), flags, menuBtn);
  }

  openMenu(anchor, participant) {
    const call = this.call;
    const isSelf = Boolean(participant.isSelf);
    const isHost = call.isHost();
    const canDm = call.settings.privateChat || isHost;
    const items = [];

    const pinned = Boolean(this.isPinned?.(participant.pid));
    items.push({ label: pinned ? 'Unpin' : 'Pin to the main view', icon: pinned ? 'pinOff' : 'pin', onSelect: () => this.onPin?.(participant.pid) });
    if (!isSelf && canDm) {
      items.push({ label: 'Send a private message', icon: 'chat', onSelect: () => this.onMessagePrivately?.(participant.pid) });
    }

    if (isHost && !isSelf) {
      items.push('separator');
      items.push({
        label: 'Mute microphone',
        icon: 'muteOthers',
        disabled: !participant.micOn,
        onSelect: () => call.hostAction('mute', { pid: participant.pid })
      });
      items.push({
        label: 'Turn off camera',
        icon: 'camOff',
        disabled: !participant.camOn,
        onSelect: () => call.hostAction('stop-video', { pid: participant.pid })
      });
      if (participant.handRaised) {
        items.push({ label: 'Lower hand', icon: 'hand', onSelect: () => call.hostAction('lower-hand', { pid: participant.pid }) });
      }
      if (call.settings.shareRequiresApproval) {
        items.push({
          label: participant.canShare ? 'Stop allowing presenting' : 'Allow presenting',
          icon: 'share',
          onSelect: () => call.setSharePermission(participant.pid, !participant.canShare)
        });
      }
      items.push({
        label: 'Make host',
        icon: 'star',
        onSelect: async () => {
          const ok = await confirmDialog({
            title: `Make ${participant.name} the host?`,
            body: 'They will get the host controls and you will lose them.',
            confirmLabel: 'Make host'
          });
          if (ok) call.transferHost(participant.pid);
        }
      });
      items.push({
        label: 'Remove from meeting',
        icon: 'userMinus',
        danger: true,
        onSelect: async () => {
          const ok = await confirmDialog({
            title: `Remove ${participant.name}?`,
            body: 'They will be removed from this meeting and won’t be able to rejoin from the same browser.',
            confirmLabel: 'Remove',
            danger: true
          });
          if (ok) call.hostAction('remove', { pid: participant.pid });
        }
      });
    }
    openMenu(anchor, items);
  }

  renderWaiting() {
    const waiting = this.call.waiting || [];
    const show = this.call.isHost() && waiting.length > 0;
    this.waitingSection.hidden = !show;
    if (!show) return;
    $('#waitingCount').textContent = pluralize(waiting.length, 'person', 'people');
    clear(this.waitingList);
    for (const entry of waiting) {
      const avatar = h('div', { class: 'avatar' });
      paintAvatar(avatar, entry.name);
      this.waitingList.append(
        h(
          'li',
          { class: 'people-row' },
          avatar,
          h('div', { class: 'people-mid' }, h('div', { class: 'people-name', text: entry.name })),
          h(
            'div',
            { class: 'waiting-actions' },
            h('button', {
              class: 'mini-btn',
              type: 'button',
              text: 'Deny',
              onClick: () => this.call.respondToKnock(entry.requestId, false)
            }),
            h('button', {
              class: 'mini-btn mini-btn-primary',
              type: 'button',
              text: 'Admit',
              onClick: () => this.call.respondToKnock(entry.requestId, true)
            })
          )
        )
      );
    }
  }
}
