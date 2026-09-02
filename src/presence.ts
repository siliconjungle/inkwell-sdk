import { parentOrigin, requestId } from "./protocol.js";

export type PresentPlayer = {
  playerId: string;
  username: string | null;
  displayName: string;
  avatarUrl: string | null;
  isGuest: boolean;
};

export type PresentFriend = {
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
};

export type Presence = {
  total: number;
  guestCount: number;
  players: PresentPlayer[];
  /** Signed-in friends of the current player who are in this game. */
  friends: PresentFriend[];
};

const EMPTY: Presence = Object.freeze({
  total: 0,
  guestCount: 0,
  players: [],
  friends: [],
});

function presentPlayer(value: unknown): value is PresentPlayer {
  if (!value || typeof value !== "object") return false;
  const player = value as Partial<PresentPlayer>;
  return (
    typeof player.playerId === "string" &&
    (player.username === null || typeof player.username === "string") &&
    typeof player.displayName === "string" &&
    (player.avatarUrl === null || typeof player.avatarUrl === "string") &&
    typeof player.isGuest === "boolean"
  );
}

function presentFriend(value: unknown): value is PresentFriend {
  if (!value || typeof value !== "object") return false;
  const friend = value as Partial<PresentFriend>;
  return (
    typeof friend.username === "string" &&
    (friend.displayName === null || typeof friend.displayName === "string") &&
    (friend.avatarUrl === null || typeof friend.avatarUrl === "string")
  );
}

export function normalisePresence(value: unknown): Presence {
  if (!value || typeof value !== "object") return EMPTY;
  const snapshot = value as {
    count?: unknown;
    guestCount?: unknown;
    players?: unknown;
    friends?: unknown;
  };
  if (
    typeof snapshot.count !== "number" ||
    !Number.isFinite(snapshot.count) ||
    typeof snapshot.guestCount !== "number" ||
    !Number.isFinite(snapshot.guestCount) ||
    !Array.isArray(snapshot.players)
  )
    return EMPTY;
  return {
    total: Math.max(0, Math.floor(snapshot.count)),
    guestCount: Math.max(0, Math.floor(snapshot.guestCount)),
    players: snapshot.players.filter(presentPlayer).slice(0, 50),
    friends: Array.isArray(snapshot.friends)
      ? snapshot.friends.filter(presentFriend).slice(0, 10)
      : [],
  };
}

/** Returns a current game-presence snapshot, capped at 50 safe player profiles. */
export function get(): Promise<Presence> {
  if (typeof window === "undefined" || window.parent === window) return Promise.resolve(EMPTY);
  const id = requestId();
  const expectedOrigin = parentOrigin();
  if (!expectedOrigin) return Promise.resolve(EMPTY);
  return new Promise((resolve) => {
    const finish = (value: Presence) => {
      window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      resolve(value);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent) return;
      if (event.origin !== expectedOrigin) return;
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
            friends?: unknown;
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
      finish(normalisePresence(message.payload.presence));
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
