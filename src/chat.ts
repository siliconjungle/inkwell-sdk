import { GameServiceError, requestGameService, type GameServiceRequest } from './game-services.js';

/** Displayed authors are supplied by the game, not verified platform identities. */
export type ChatAuthor = { displayName: string; id?: string; avatarUrl?: string | null };
export type ChatMessage = {
  id: string; sequence: number; channel: string; senderId: string; author: ChatAuthor;
  body: string; recipients: string[]; createdAt: string;
};
export type ChatSendOptions = { id?: string; author?: ChatAuthor; recipients?: string[] };
export type ChatReceipt = { message: ChatMessage; duplicate: boolean };
export type ChatHistory = { messages: ChatMessage[]; nextCursor: number; hasMore: boolean; retentionHours: number; removedIds: string[]; retainedFrom: number; senderIds?: string[]; blockedSenderIds?: string[] };
export type ChatState = 'connecting' | 'connected' | 'reconnecting' | 'closed';
export type ChatModerationEvent = { type: 'chat.removed' | 'chat.cleared' | 'chat.channel-deleted' | 'chat.visibility'; channel: string; id?: string; throughSequence?: number; senderIds?: string[]; blockedSenderIds?: string[] };
type Ticket = { url: string; playerId: string; channel: string; expiresAt: number };
type SocketFactory = (url: string) => WebSocket;
export type ChatConnectOptions = {
  onMessage?: (message: ChatMessage) => void;
  onState?: (state: ChatState) => void;
  onModeration?: (event: ChatModerationEvent) => void;
};

function channelName(name: string) {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_.:-]{0,63}$/.test(name)) throw new TypeError('Invalid chat channel name.');
  return name;
}
function notify<T>(listeners: Set<(value: T) => void>, value: T) {
  // A game's UI handler must not prevent acknowledgements or reconnect cleanup.
  for (const listener of listeners) { try { listener(value); } catch { /* Game-owned callback. */ } }
}

export class ChatConnection {
  private socket: WebSocket | null = null;
  private stopped = false;
  private generation = 0;
  private attempts = 0;
  private cursor = 0;
  private syncing = false;
  private buffered: ChatMessage[] = [];
  private retained = new Map<string, ChatMessage>();
  private removedIds = new Set<string>();
  private blockedSenders = new Set<string>();
  private visibilityVersion = 0;
  private clearedThrough = 0;
  private pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private messageListeners = new Set<(message: ChatMessage) => void>();
  private stateListeners = new Set<(state: ChatState) => void>();
  private moderationListeners = new Set<(event: ChatModerationEvent) => void>();
  private retryTimer?: ReturnType<typeof setTimeout>;
  private renewalTimer?: ReturnType<typeof setTimeout>;
  private handshakeTimer?: ReturnType<typeof setTimeout>;
  private pingTimer?: ReturnType<typeof setInterval>;
  private firstResolve!: (connection: ChatConnection) => void;
  private firstReject!: (error: Error) => void;
  private connectedOnce = false;
  private currentState: ChatState = 'connecting';
  private currentPlayerId = '';
  readonly ready: Promise<ChatConnection>;

  constructor(
    readonly channel: string,
    private request: GameServiceRequest,
    options: ChatConnectOptions = {},
    private socketFactory: SocketFactory = url => new WebSocket(url),
  ) {
    channelName(channel);
    if (options.onMessage) this.messageListeners.add(options.onMessage);
    if (options.onState) this.stateListeners.add(options.onState);
    if (options.onModeration) this.moderationListeners.add(options.onModeration);
    this.ready = new Promise((resolve, reject) => { this.firstResolve = resolve; this.firstReject = reject; });
    void this.open();
  }
  get state() { return this.currentState; }
  get playerId() { return this.currentPlayerId; }
  get messages(): readonly ChatMessage[] { return [...this.retained.values()].sort((a, b) => a.sequence - b.sequence); }
  onMessage(listener: (message: ChatMessage) => void) { this.messageListeners.add(listener); return () => { this.messageListeners.delete(listener); }; }
  onState(listener: (state: ChatState) => void) { this.stateListeners.add(listener); return () => { this.stateListeners.delete(listener); }; }
  onModeration(listener: (event: ChatModerationEvent) => void) { this.moderationListeners.add(listener); return () => { this.moderationListeners.delete(listener); }; }
  private setState(state: ChatState) { this.currentState = state; notify(this.stateListeners, state); }
  private receiveMessage(message: ChatMessage) {
    if (message.channel !== this.channel || this.blockedSenders.has(message.senderId) || this.retained.has(message.id) || this.removedIds.has(message.id) || message.sequence <= this.clearedThrough) return;
    this.retained.set(message.id, message);
    if (this.retained.size > 1000) this.retained.delete(this.retained.keys().next().value!);
    this.cursor = Math.max(this.cursor, message.sequence);
    notify(this.messageListeners, message);
  }
  private updateVisibility(senderIds: string[], blockedSenderIds: string[]) {
    if (!Array.isArray(senderIds) || senderIds.length > 1000 || senderIds.some(id => typeof id !== 'string') || !Array.isArray(blockedSenderIds) || blockedSenderIds.some(id => !senderIds.includes(id))) throw new Error('Invalid chat visibility.');
    ++this.visibilityVersion;
    for (const id of senderIds) this.blockedSenders.delete(id);
    for (const id of blockedSenderIds) this.blockedSenders.add(id);
    while (this.blockedSenders.size > 1000) this.blockedSenders.delete(this.blockedSenders.keys().next().value!);
    for (const [id, message] of this.retained) if (this.blockedSenders.has(message.senderId)) this.retained.delete(id);
    this.buffered = this.buffered.filter(message => !this.blockedSenders.has(message.senderId));
    notify(this.moderationListeners, { type: 'chat.visibility', channel: this.channel, senderIds, blockedSenderIds });
  }
  private async open() {
    const generation = ++this.generation;
    this.setState(this.connectedOnce ? 'reconnecting' : 'connecting');
    try {
      const ticket = await this.request<Ticket>('chat', { operation: 'connect', channel: this.channel });
      if (this.stopped || generation !== this.generation) return;
      const url = new URL(ticket.url);
      if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new GameServiceError('Chat requires a secure WebSocket.', 400);
      if (this.currentPlayerId && this.currentPlayerId !== ticket.playerId) {
        this.retained.clear(); this.buffered = []; this.removedIds.clear(); this.blockedSenders.clear(); this.cursor = 0; this.clearedThrough = 0;
        this.currentPlayerId = '';
        notify(this.moderationListeners, { type: 'chat.cleared', channel: this.channel });
        throw new GameServiceError('The active player changed. Open a new chat connection.', 403, 'player_changed');
      }
      this.currentPlayerId = ticket.playerId;
      this.syncing = true;
      this.buffered = [];
      const socket = this.socketFactory(ticket.url);
      this.socket = socket;
      this.handshakeTimer = setTimeout(() => socket.close(), 20000);
      socket.onmessage = event => {
        if (generation !== this.generation || this.stopped || event.data === 'pong') return;
        try {
          const message = JSON.parse(String(event.data));
          if (message.type === 'chat.result') {
            const pending = this.pending.get(message.requestId);
            if (!pending) return;
            clearTimeout(pending.timer); this.pending.delete(message.requestId);
            if (message.error) pending.reject(new GameServiceError(message.error, message.status));
            else pending.resolve(message.result);
          } else if (message.type === 'chat.connected') {
            clearTimeout(this.handshakeTimer);
            this.renewalTimer = setTimeout(() => socket.close(4001, 'Renewing chat access.'), Math.max(1000, ticket.expiresAt - Date.now() - 5000));
            this.pingTimer = setInterval(() => { if (socket.readyState === 1) socket.send('ping'); }, 30000);
            void this.catchUp(generation).catch(() => socket.close());
          } else if (message.type === 'chat.visibility' && message.channel === this.channel) {
            this.updateVisibility(message.senderIds, message.blockedSenderIds);
          } else if (message.type === 'chat.message' && message.message) {
            if (this.syncing) {
              if (this.buffered.length >= 1000) socket.close(1008, 'Chat catch-up buffer full.');
              else this.buffered.push(message.message);
            } else this.receiveMessage(message.message);
          } else if (['chat.removed', 'chat.cleared', 'chat.channel-deleted'].includes(message.type) && message.channel === this.channel) {
            if (message.type === 'chat.removed') {
              this.rememberRemoved(message.id);
              this.retained.delete(message.id);
              this.buffered = this.buffered.filter(item => item.id !== message.id);
            } else {
              this.clearedThrough = Math.max(this.clearedThrough, Number(message.throughSequence) || 0);
              this.retained.clear(); this.buffered = [];
            }
            notify(this.moderationListeners, message);
            if (message.type === 'chat.channel-deleted') this.close();
          }
        } catch { socket.close(1002, 'Invalid chat response.'); }
      };
      socket.onclose = event => {
        if (generation !== this.generation || this.stopped) return;
        this.clearConnectionTimers();
        this.rejectPending(new GameServiceError('Chat disconnected. Retry sends with the same message id.', 503));
        this.socket = null;
        if (event.code === 4004 || !this.connectedOnce) { this.close(new GameServiceError('Could not join this chat channel.', 503)); return; }
        this.scheduleReconnect();
      };
      socket.onerror = () => { /* onclose owns retry and pending-command cleanup. */ };
    } catch (error) {
      if (this.stopped || generation !== this.generation) return;
      if (!this.connectedOnce || (error instanceof GameServiceError && [400, 401, 403, 404].includes(error.status))) this.close(error instanceof Error ? error : new Error('Chat connection failed.'));
      else this.scheduleReconnect();
    }
  }
  private async catchUp(generation: number) {
    let hasMore = true;
    while (hasMore && !this.stopped && generation === this.generation) {
      const visibilityVersion = this.visibilityVersion;
      const page = await this.command<ChatHistory>({ operation: 'history', after: this.cursor });
      if (this.stopped || generation !== this.generation) return;
      if (visibilityVersion === this.visibilityVersion && page.senderIds && page.blockedSenderIds) this.updateVisibility(page.senderIds, page.blockedSenderIds);
      for (const id of page.removedIds ?? []) this.rememberRemoved(id);
      for (const [id, message] of this.retained) {
        if (this.removedIds.has(id) || message.sequence < page.retainedFrom) {
          this.retained.delete(id);
          notify(this.moderationListeners, { type: 'chat.removed', channel: this.channel, id });
        }
      }
      for (const message of page.messages) this.receiveMessage(message);
      this.cursor = Math.max(this.cursor, page.nextCursor);
      hasMore = page.hasMore;
    }
    if (this.stopped || generation !== this.generation) return;
    for (const message of this.buffered.sort((a, b) => a.sequence - b.sequence)) this.receiveMessage(message);
    this.buffered = []; this.syncing = false; this.attempts = 0;
    this.connectedOnce = true;
    this.setState('connected'); this.firstResolve(this);
  }
  private scheduleReconnect() {
    if (this.stopped) return;
    this.setState('reconnecting');
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.attempts++, 5)) + Math.random() * 500;
    this.retryTimer = setTimeout(() => { void this.open(); }, delay);
  }
  private rememberRemoved(id: string) {
    this.removedIds.add(id);
    if (this.removedIds.size > 1000) this.removedIds.delete(this.removedIds.keys().next().value!);
  }
  private command<T>(command: Record<string, unknown>): Promise<T> {
    if (this.stopped || this.socket?.readyState !== 1) return Promise.reject(new GameServiceError('Chat is not connected.', 503));
    if (this.pending.size >= 32) return Promise.reject(new GameServiceError('Too many pending chat requests.', 429));
    const requestId = crypto.randomUUID();
    const encoded = JSON.stringify({ ...command, requestId });
    if (new TextEncoder().encode(encoded).length > 16384) return Promise.reject(new GameServiceError('Chat request too large.', 413));
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new GameServiceError('Chat request timed out. Retry with the same message id.', 504)); }, 15000);
      this.pending.set(requestId, { resolve: result => resolve(result as T), reject, timer });
      try { this.socket!.send(encoded); } catch (error) { clearTimeout(timer); this.pending.delete(requestId); reject(error); }
    });
  }
  send(body: string, options: ChatSendOptions = {}) {
    return this.command<ChatReceipt>({ ...options, operation: 'send', body, id: options.id ?? crypto.randomUUID() });
  }
  history(after = 0) { return this.command<ChatHistory>({ operation: 'history', after }); }
  private rejectPending(error: Error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
  private clearConnectionTimers() { clearTimeout(this.renewalTimer); clearTimeout(this.handshakeTimer); clearInterval(this.pingTimer); }
  close(error: Error = new GameServiceError('Chat closed.', 499)) {
    if (this.stopped) return;
    this.stopped = true; this.generation++;
    this.clearConnectionTimers(); clearTimeout(this.retryTimer);
    this.socket?.close(); this.socket = null;
    this.rejectPending(error);
    if (!this.connectedOnce) this.firstReject(error);
    this.setState('closed');
    this.messageListeners.clear(); this.stateListeners.clear(); this.moderationListeners.clear();
  }
}

export function createChat(request: GameServiceRequest = requestGameService, socketFactory?: SocketFactory) {
  return Object.freeze({
    connect: (channel = 'game', options: ChatConnectOptions = {}) => new ChatConnection(channel, request, options, socketFactory).ready,
    list: () => request<{ channels: { name: string; serverWritesOnly: boolean }[] }>('chat', { operation: 'list' }),
  });
}
export function createServerChat(request: GameServiceRequest, socketFactory?: SocketFactory) {
  return Object.freeze({
    ...createChat(request, socketFactory),
    define: (name: string, options: { serverWritesOnly?: boolean } = {}) => request<{ name: string; serverWritesOnly: boolean }>('chat', { ...options, operation: 'define', name: channelName(name) }),
    channel(name = 'game') {
      const channel = channelName(name);
      return Object.freeze({
        send: (body: string, options: ChatSendOptions = {}) => request<ChatReceipt>('chat', { ...options, operation: 'send', channel, body, id: options.id ?? crypto.randomUUID() }),
        history: (after = 0) => request<ChatHistory>('chat', { operation: 'history', channel, after }),
        remove: (id: string) => request<{ success: true }>('chat', { operation: 'remove', channel, id }),
        clear: () => request<{ success: true }>('chat', { operation: 'clear', channel }),
        delete: () => request<{ success: true }>('chat', { operation: 'deleteChannel', channel }),
      });
    },
  });
}
export const chat = createChat();
