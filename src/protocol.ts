export const SDK_SOURCE = "inkwell-sdk" as const;
export const SDK_VERSION = 1 as const;

export type InkwellMessageType =
  | "ready"
  | "loading.progress"
  | "loading.error"
  | "session.complete"
  | "analytics.track"
  | "assets.progress"
  | "player.get"
  | "presence.get"
  | "performance.sample"
  | "backend.connect"
  | "backend.fetch";

export type InkwellMessage = {
  source: typeof SDK_SOURCE;
  version: typeof SDK_VERSION;
  type: InkwellMessageType;
  payload?: Record<string, unknown>;
  sentAt: number;
};

const PARENT_ORIGIN_KEY = 'inkwell:parent-origin:v1';
function allowedParentOrigin(value: string | null | undefined) {
  if (!value) return null;
  try {
    const origin = new URL(value).origin;
    return origin === "https://inkwell.ing" ||
      origin === "https://www.inkwell.ing" ||
      origin.startsWith("http://localhost:")
      ? origin
      : null;
  } catch {
    return null;
  }
}

export function parentOrigin() {
  if (typeof document === 'undefined') return null;
  // Reloading an iframe changes document.referrer to the game's own URL.
  // Chromium/WebKit expose the actual immediate parent's origin independently.
  const ancestor = typeof window === 'undefined' ? undefined : window.location?.ancestorOrigins?.[0];
  const origin = ancestor !== undefined ? allowedParentOrigin(ancestor) : allowedParentOrigin(document.referrer);
  if (origin) {
    try { window.sessionStorage.setItem(PARENT_ORIGIN_KEY, origin); } catch { /* Storage can be denied. */ }
    return origin;
  }
  // An observed foreign parent takes precedence over any prior cached host.
  if (ancestor !== undefined) return null;
  // Firefox has no ancestorOrigins. Retain only an allowlisted host origin in
  // this tab's game-origin storage; never a token or identity. Replies still
  // require both the actual window.parent and this exact origin.
  try { return allowedParentOrigin(window.sessionStorage.getItem(PARENT_ORIGIN_KEY)); } catch { return null; }
}

export function requestId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function emit(type: InkwellMessageType, payload?: Record<string, unknown>) {
  if (typeof window === "undefined" || window.parent === window) return false;
  const targetOrigin = parentOrigin();
  if (!targetOrigin) return false;
  const message: InkwellMessage = {
    source: SDK_SOURCE,
    version: SDK_VERSION,
    type,
    payload,
    sentAt: Date.now(),
  };
  window.parent.postMessage(message, targetOrigin);
  return true;
}
