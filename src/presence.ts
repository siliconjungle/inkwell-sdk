import { parentOrigin, requestId } from "./protocol.js";

export type PresentPlayer = {
  playerId: string;
  username: string | null;
  displayName: string;
  avatarUrl: string | null;
  isGuest: boolean;
};

export type Presence = {
  total: number;
  guestCount: number;
  players: PresentPlayer[];
};

const EMPTY: Presence = Object.freeze({
  total: 0,
  guestCount: 0,
  players: [],
});

/** Returns a current game-presence snapshot, capped at 50 safe player profiles. */
export function get(): Promise<Presence> {
  if (typeof window === "undefined" || window.parent === window) return Promise.resolve(EMPTY);
  const id = requestId();
  const expectedOrigin = parentOrigin();
  return new Promise((resolve) => {
    const finish = (value: Presence) => {
      window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      resolve(value);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent) return;
      if (expectedOrigin !== "*" && event.origin !== expectedOrigin) return;
      const message = event.data as {
        source?: unknown;
        version?: unknown;
        type?: unknown;
        payload?: {
          requestId?: unknown;
          presence?: {
            count?: unknown;
            guestCount?: unknown;
            players?: unknown;
          };
        };
      };
      if (
        message?.source !== "inkwell-platform" ||
        message.version !== 1 ||
        message.type !== "presence.result" ||
        message.payload?.requestId !== id
      )
        return;
      const snapshot = message.payload.presence;
      if (
        !snapshot ||
        typeof snapshot.count !== "number" ||
        typeof snapshot.guestCount !== "number" ||
        !Array.isArray(snapshot.players)
      )
        return finish(EMPTY);
      finish({
        total: snapshot.count,
        guestCount: snapshot.guestCount,
        players: snapshot.players.slice(0, 50) as PresentPlayer[],
      });
    };
    const timer = window.setTimeout(() => finish(EMPTY), 5_000);
    window.addEventListener("message", onMessage);
    window.parent.postMessage(
      {
        source: "inkwell-sdk",
        version: 1,
        type: "presence.get",
        payload: { requestId: id },
        sentAt: Date.now(),
      },
      expectedOrigin,
    );
  });
}

export const presence = Object.freeze({ get });
