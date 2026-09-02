import { parentOrigin, requestId } from './protocol.js';

export type Player = {
  displayName: string;
  avatarUrl: string | null;
  isGuest: boolean;
};

const GUEST: Player = Object.freeze({
  displayName: 'Guest',
  avatarUrl: null,
  isGuest: true,
});

/** Returns the safe public identity supplied by the trusted Inkwell player. */
export function get(): Promise<Player> {
  if (typeof window === 'undefined' || window.parent === window)
    return Promise.resolve(GUEST);

  const id = requestId();
  const expectedOrigin = parentOrigin();
  if (!expectedOrigin) return Promise.resolve(GUEST);
  return new Promise((resolve) => {
    const finish = (value: Player) => {
      window.clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      resolve(value);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent) return;
      if (event.origin !== expectedOrigin) return;
      const message = event.data as {
        source?: unknown;
        version?: unknown;
        type?: unknown;
        payload?: { requestId?: unknown; player?: unknown };
      };
      if (
        message?.source !== 'inkwell-platform' ||
        message.version !== 1 ||
        message.type !== 'player.result' ||
        message.payload?.requestId !== id
      )
        return;
      const value = message.payload.player as Partial<Player> | undefined;
      if (
        !value ||
        typeof value.displayName !== 'string' ||
        typeof value.isGuest !== 'boolean' ||
        (value.avatarUrl !== null && typeof value.avatarUrl !== 'string')
      )
        return finish(GUEST);
      finish({
        displayName: value.displayName.slice(0, 100),
        avatarUrl: value.avatarUrl,
        isGuest: value.isGuest,
      });
    };
    const timer = window.setTimeout(() => finish(GUEST), 5_000);
    window.addEventListener('message', onMessage);
    window.parent.postMessage(
      {
        source: 'inkwell-sdk',
        version: 1,
        type: 'player.get',
        payload: { requestId: id },
        sentAt: Date.now(),
      },
      expectedOrigin,
    );
  });
}

export const player = Object.freeze({ get });
