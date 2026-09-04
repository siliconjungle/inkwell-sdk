import { parentOrigin, requestId } from './protocol.js';

export type InviteValue = null | boolean | number | string | InviteValue[] | { [key: string]: InviteValue };
export type InviteContext = Record<string, InviteValue>;
export type AcceptedGameInvite = {
  id: string;
  gameSlug: string;
  from: { username: string; playerId: string };
  context: InviteContext;
  createdAt: string;
  acceptedAt: string;
  expiresAt: string;
};
export class InviteError extends Error {
  constructor(message: string, public readonly code = 'invite_unavailable') {
    super(message);
    this.name = 'InviteError';
  }
}

/** Defensive JSON copy; invite data never grants room/world authorization. */
export function validateInviteContext(value: unknown): InviteContext {
  let nodes = 0;
  const active = new Set<object>();
  function copy(item: unknown, depth: number): InviteValue {
    if (++nodes > 2048 || depth > 8) throw new InviteError('Invite context is too complex.', 'invalid_context');
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (!item || typeof item !== 'object' || (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item)))) throw new InviteError('Invite context must contain JSON values.', 'invalid_context');
    if (active.has(item)) throw new InviteError('Invite context cannot contain cycles.', 'invalid_context');
    active.add(item);
    let result: InviteValue;
    if (Array.isArray(item)) result = item.map((child) => copy(child, depth + 1));
    else {
      const object: InviteContext = {};
      for (const [key, child] of Object.entries(item)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new InviteError('Reserved context property.', 'invalid_context');
        object[key] = copy(child, depth + 1);
      }
      result = object;
    }
    active.delete(item);
    return result;
  }
  const result = copy(value ?? {}, 0);
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new InviteError('Invite context must be an object.', 'invalid_context');
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 4096) throw new InviteError('Invite context exceeds 4 KiB.', 'invalid_context');
  return result;
}

function host() {
  const origin = parentOrigin();
  if (!origin || typeof window === 'undefined' || window.parent === window) throw new InviteError('Invitations require an Inkwell game frame.');
  return { origin, parent: window.parent };
}
function post(parent: Window, origin: string, type: string, payload: Record<string, unknown>) {
  parent.postMessage({ source: 'inkwell-sdk', version: 1, type, payload }, origin);
}
let clearProvider: (() => void) | undefined;

/** Supply fresh context when the player presses the platform's Invite button. */
export function setContextProvider(provider: () => InviteContext | Promise<InviteContext>): () => void {
  if (typeof provider !== 'function') throw new TypeError('An invite context provider must be a function.');
  const { parent, origin } = host();
  clearProvider?.();
  let disposed = false;
  let pending = 0;
  const announce = () => post(parent, origin, 'invites.context.subscribe', { enabled: true });
  const receive = (event: MessageEvent) => {
    if (disposed || event.source !== parent || event.origin !== origin) return;
    const message = event.data;
    if (message?.source !== 'inkwell-platform' || message.version !== 1) return;
    if (message.type === 'invites.host.ready') { announce(); return; }
    if (message.type !== 'invites.context.request') return;
    const id = message.payload?.requestId;
    if (typeof id !== 'string' || id.length > 128) return;
    if (pending >= 4) {
      post(parent, origin, 'invites.context.result', { requestId: id, error: 'Game invite preparation is busy.' });
      return;
    }
    ++pending;
    void Promise.resolve().then(provider).then((value) => {
      if (!disposed) post(parent, origin, 'invites.context.result', { requestId: id, context: validateInviteContext(value) });
    }).catch(() => {
      if (!disposed) post(parent, origin, 'invites.context.result', { requestId: id, error: 'Game invite preparation failed.' });
    }).finally(() => { --pending; });
  };
  window.addEventListener('message', receive);
  const clear = () => {
    if (disposed) return;
    disposed = true;
    window.removeEventListener('message', receive);
    if (clearProvider === clear) {
      clearProvider = undefined;
      post(parent, origin, 'invites.context.subscribe', { enabled: false });
    }
  };
  clearProvider = clear;
  try { announce(); } catch (error) { clear(); throw error; }
  return clear;
}

/** Read the recipient-only invitation accepted by the host for this launch. */
export async function getAccepted(options: { signal?: AbortSignal } = {}): Promise<AcceptedGameInvite | null> {
  const { parent, origin } = host();
  if (options.signal?.aborted) throw new InviteError('Invitation request cancelled.', 'cancelled');
  const id = requestId();
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); window.removeEventListener('message', receive); options.signal?.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); reject(new InviteError('Invitation request cancelled.', 'cancelled')); };
    const receive = (event: MessageEvent) => {
      if (event.source !== parent || event.origin !== origin) return;
      const message = event.data;
      if (message?.source !== 'inkwell-platform' || message.version !== 1 || message.type !== 'invites.accepted.result' || message.payload?.requestId !== id) return;
      cleanup();
      if (message.payload.error) { reject(new InviteError(String(message.payload.error))); return; }
      const value = message.payload.invitation;
      if (value === null) { resolve(null); return; }
      try {
        if (!value || !/^[a-f0-9]{32}$/.test(value.id) || typeof value.gameSlug !== 'string' || typeof value.from?.username !== 'string' || typeof value.from?.playerId !== 'string' || !['createdAt', 'acceptedAt', 'expiresAt'].every((key) => typeof value[key] === 'string' && Number.isFinite(Date.parse(value[key])))) throw new InviteError('Invalid accepted invitation.');
        resolve({ id: value.id, gameSlug: value.gameSlug, from: { username: value.from.username, playerId: value.from.playerId }, context: validateInviteContext(value.context), createdAt: value.createdAt, acceptedAt: value.acceptedAt, expiresAt: value.expiresAt });
      } catch (error) { reject(error); }
    };
    const timer = setTimeout(() => { cleanup(); reject(new InviteError('Invitation request timed out.', 'timeout')); }, 20000);
    window.addEventListener('message', receive);
    options.signal?.addEventListener('abort', abort, { once: true });
    try { post(parent, origin, 'invites.accepted.get', { requestId: id }); }
    catch (error) { cleanup(); reject(error); }
  });
}

/** Late registration works; each subscription receives at most this launch's invite. */
export function onAccepted(handler: (invite: AcceptedGameInvite) => void | Promise<void>, onError?: (error: unknown) => void): () => void {
  let active = true;
  const controller = new AbortController();
  void getAccepted({ signal: controller.signal }).then(async (invite) => { if (active && invite) await handler(invite); }).catch((error) => {
    if (active && onError) { try { onError(error); } catch { /* Creator callback. */ } }
  });
  return () => { active = false; controller.abort(); };
}
export const invites = Object.freeze({ setContextProvider, getAccepted, onAccepted });
