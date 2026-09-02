export const SDK_SOURCE = "inkwell-sdk" as const;
export const SDK_VERSION = 1 as const;

export type InkwellMessageType =
  | "ready"
  | "session.complete"
  | "analytics.track"
  | "assets.progress"
  | "player.get"
  | "presence.get"
  | "performance.sample";

export type InkwellMessage = {
  source: typeof SDK_SOURCE;
  version: typeof SDK_VERSION;
  type: InkwellMessageType;
  payload?: Record<string, unknown>;
  sentAt: number;
};

export function parentOrigin() {
  if (typeof document === "undefined" || !document.referrer) return "*";
  try {
    const origin = new URL(document.referrer).origin;
    return origin === "https://inkwell.ing" ||
      origin === "https://www.inkwell.ing" ||
      origin.startsWith("http://localhost:")
      ? origin
      : "*";
  } catch {
    return "*";
  }
}

export function requestId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function emit(type: InkwellMessageType, payload?: Record<string, unknown>) {
  if (typeof window === "undefined" || window.parent === window) return false;
  const message: InkwellMessage = {
    source: SDK_SOURCE,
    version: SDK_VERSION,
    type,
    payload,
    sentAt: Date.now(),
  };
  window.parent.postMessage(message, parentOrigin());
  return true;
}
