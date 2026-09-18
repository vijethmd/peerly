// Thin wrapper over the Socket.IO client: one place for timeouts, acks and
// connection state.

export class Connection {
  constructor({ onConnect, onDisconnect, onEvent, onConnectError }) {
    this.onConnect = onConnect;
    this.onDisconnect = onDisconnect;
    this.onEvent = onEvent;
    this.onConnectError = onConnectError;
    this.socket = null;
    this.closed = false;
  }

  open() {
    if (this.socket) return;
    this.socket = io({
      autoConnect: false,
      reconnectionDelay: 400,
      reconnectionDelayMax: 5000,
      randomizationFactor: 0.5,
      timeout: 10000
    });
    this.socket.on('connect', () => this.onConnect?.());
    this.socket.on('disconnect', (reason) => this.onDisconnect?.(reason));
    this.socket.on('connect_error', (err) => this.onConnectError?.(err));
    this.socket.onAny((event, payload) => this.onEvent?.(event, payload));
    this.socket.connect();
  }

  get connected() {
    return Boolean(this.socket && this.socket.connected);
  }

  get id() {
    return this.socket ? this.socket.id : null;
  }

  /** Fire-and-forget; dropped while offline (state is re-synced on rejoin). */
  send(event, payload) {
    if (this.connected) this.socket.emit(event, payload);
  }

  async request(event, payload = {}, timeout = 8000) {
    if (!this.connected) return { ok: false, code: 'offline', error: 'You’re offline. Reconnecting…' };
    try {
      return await this.socket.timeout(timeout).emitWithAck(event, payload);
    } catch {
      return { ok: false, code: 'timeout', error: 'The server didn’t respond. Please try again.' };
    }
  }

  reconnect() {
    if (this.socket && !this.socket.connected && !this.closed) this.socket.connect();
  }

  close() {
    this.closed = true;
    this.socket?.disconnect();
  }
}
