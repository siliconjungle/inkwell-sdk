import { parentOrigin, requestId } from "./protocol.js";

export class GameServiceError extends Error {
  constructor(
    message: string,
    public readonly status = 500,
    public readonly code = "game_service_error",
  ) {
    super(message);
    this.name = "GameServiceError";
  }
}

export type GameServiceRequest = <T>(
  service: string,
  request: Record<string, unknown>,
) => Promise<T>;

export const requestGameService: GameServiceRequest = <T>(
  service: string,
  request: Record<string, unknown>,
) => {
  const origin = parentOrigin();
  if (typeof window === "undefined" || window.parent === window || !origin)
    return Promise.reject(new GameServiceError("This API requires an Inkwell game frame.", 400));
  const id = requestId();
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener("message", receive);
    };
    const receive = (event: MessageEvent) => {
      if (event.source !== window.parent || event.origin !== origin) return;
      const message = event.data;
      if (
        message?.source !== "inkwell-platform" ||
        message.version !== 1 ||
        message.type !== "game-service.result" ||
        message.payload?.requestId !== id
      )
        return;
      cleanup();
      if (message.payload.error)
        reject(
          new GameServiceError(
            String(message.payload.error),
            message.payload.status,
            message.payload.code,
          ),
        );
      else resolve(message.payload.result as T);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new GameServiceError("Game service request timed out.", 504));
    }, 25000);
    window.addEventListener("message", receive);
    try {
      window.parent.postMessage(
        {
          source: "inkwell-sdk",
          version: 1,
          type: "game-service.request",
          payload: { requestId: id, service, request },
        },
        origin,
      );
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
};

/** Server-only adapter. Credentials must never be bundled into browser games. */
export function createGameServiceRequest(options: {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
}): GameServiceRequest {
  const base = new URL(options.baseUrl);
  if (
    base.protocol !== "https:" &&
    !(base.protocol === "http:" && ["localhost", "127.0.0.1"].includes(base.hostname))
  )
    throw new TypeError("Game services require HTTPS.");
  if (base.username || base.password) throw new TypeError("URL credentials are not allowed.");
  return async <T>(service: string, request: Record<string, unknown>) => {
    if (!["leaderboards", "achievements", "stats", "chat"].includes(service))
      throw new TypeError("Unknown game service.");
    const response = await (options.fetch ?? fetch)(
      new URL(`/api/v1/game-services/${service}`, base),
      {
        method: "POST",
        headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(25000),
        redirect: "error",
      },
    );
    const body = await response.json();
    if (!response.ok)
      throw new GameServiceError(body.error ?? "Game service failed.", response.status, body.code);
    return body as T;
  };
}
