import type { AnyBackendProtocol, BackendProtocol } from "./backend.js";
import {
  BACKEND_PROTOCOL_VERSION,
  BackendProtocolError,
  decodeFrame,
  encodeFrame,
  type Delivery,
} from "./wire.js";
import type { InkwellDatabase, InkwellObjectStorage } from "./storage.js";
import type { createServerLeaderboards } from "./leaderboards.js";
import type { createServerAchievements } from "./achievements.js";
import type { createServerStats } from "./stats.js";

export type BackendIdentity = Readonly<{
  playerId: string;
  username: string | null;
  displayName: string;
  avatarUrl: string | null;
  isGuest: boolean;
}>;

export type BackendRuntimeServices = Readonly<{
  achievements: ReturnType<typeof createServerAchievements>;
  stats: ReturnType<typeof createServerStats>;
  leaderboards: ReturnType<typeof createServerLeaderboards>;
  database: InkwellDatabase;
  storage: InkwellObjectStorage;
  fetch: typeof fetch;
  region: string;
}>;

export type BackendPeer = {
  id: string;
  identity: BackendIdentity;
  sendReliable(frame: Uint8Array): Promise<void>;
  sendUnreliable(frame: Uint8Array): boolean;
  close(code?: number, reason?: string): void;
};

type EventName<T> = Extract<keyof T, string>;
type ActionInput<T> = T extends { input: infer Input } ? Input : never;
type ActionOutput<T> = T extends { output: infer Output } ? Output : never;

export class BackendActionFailure extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BackendActionFailure";
  }
}

export class ServerConnection<Protocol extends BackendProtocol = AnyBackendProtocol> {
  constructor(private readonly peer: BackendPeer) {}

  get id() {
    return this.peer.id;
  }

  get identity() {
    return this.peer.identity;
  }

  sendReliable<Name extends EventName<Protocol["serverEvents"]>>(
    name: Name,
    payload: Protocol["serverEvents"][Name],
  ) {
    return this.peer.sendReliable(
      encodeFrame({
        version: BACKEND_PROTOCOL_VERSION,
        kind: "event",
        name: String(name),
        payload,
      }),
    );
  }

  sendUnreliable<Name extends EventName<Protocol["serverEvents"]>>(
    name: Name,
    payload: Protocol["serverEvents"][Name],
  ) {
    return this.peer.sendUnreliable(
      encodeFrame(
        {
          version: BACKEND_PROTOCOL_VERSION,
          kind: "event",
          name: String(name),
          payload,
        },
        "unreliable",
      ),
    );
  }

  close(code = 1000, reason = "Server closed") {
    this.peer.close(code, reason.slice(0, 123));
  }
}

export type BackendContext<Protocol extends BackendProtocol = AnyBackendProtocol> = Readonly<{
  achievements: ReturnType<typeof createServerAchievements>;
  stats: ReturnType<typeof createServerStats>;
  leaderboards: ReturnType<typeof createServerLeaderboards>;
  database: InkwellDatabase;
  storage: InkwellObjectStorage;
  fetch: typeof fetch;
  region: string;
  connections: readonly ServerConnection<Protocol>[];
  broadcastReliable<Name extends EventName<Protocol["serverEvents"]>>(
    name: Name,
    payload: Protocol["serverEvents"][Name],
    options?: { except?: string | readonly string[] },
  ): Promise<void>;
  broadcastUnreliable<Name extends EventName<Protocol["serverEvents"]>>(
    name: Name,
    payload: Protocol["serverEvents"][Name],
    options?: { except?: string | readonly string[] },
  ): number;
}>;

export type BackendDefinition<Protocol extends BackendProtocol = AnyBackendProtocol> = Readonly<{
  __inkwellBackend: 1;
  start?: (context: BackendContext<Protocol>) => void | Promise<void>;
  connect?: (
    connection: ServerConnection<Protocol>,
    context: BackendContext<Protocol>,
  ) => void | Promise<void>;
  disconnect?: (
    connection: ServerConnection<Protocol>,
    context: BackendContext<Protocol>,
  ) => void | Promise<void>;
  messages?: {
    [Name in EventName<Protocol["clientEvents"]>]?: (
      payload: Protocol["clientEvents"][Name],
      connection: ServerConnection<Protocol>,
      context: BackendContext<Protocol>,
      delivery: Delivery,
    ) => void | Promise<void>;
  };
  actions?: {
    [Name in EventName<Protocol["actions"]>]?: (
      payload: ActionInput<Protocol["actions"][Name]>,
      connection: ServerConnection<Protocol>,
      context: BackendContext<Protocol>,
    ) => ActionOutput<Protocol["actions"][Name]> | Promise<ActionOutput<Protocol["actions"][Name]>>;
  };
  fetch?: (
    request: Request,
    context: BackendContext<Protocol>,
    identity: BackendIdentity,
  ) => Response | Promise<Response>;
  shutdown?: (context: BackendContext<Protocol>) => void | Promise<void>;
}>;

type BackendDefinitionInput<Protocol extends BackendProtocol> = Omit<
  BackendDefinition<Protocol>,
  "__inkwellBackend"
>;

export function defineBackend<Protocol extends BackendProtocol = AnyBackendProtocol>(
  definition: BackendDefinitionInput<Protocol>,
): BackendDefinition<Protocol> {
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
    throw new TypeError("Backend definition must be an object.");
  }
  return Object.freeze({ ...definition, __inkwellBackend: 1 as const });
}

const MAX_ACTIVE_ACTIONS_PER_CONNECTION = 32;

export class BackendServer<Protocol extends BackendProtocol = AnyBackendProtocol> {
  private readonly connectionsById = new Map<string, ServerConnection<Protocol>>();
  private readonly peersById = new Map<string, BackendPeer>();
  private readonly activeActions = new Map<string, Set<string>>();
  private readonly context: BackendContext<Protocol>;
  private startPromise: Promise<void> | null = null;
  private shuttingDown = false;

  constructor(
    private readonly definition: BackendDefinition<Protocol>,
    services: BackendRuntimeServices,
  ) {
    const owner = this;
    this.context = Object.freeze({
      leaderboards: services.leaderboards,
      achievements: services.achievements,
      stats: services.stats,
      database: services.database,
      storage: services.storage,
      fetch: services.fetch,
      region: services.region,
      get connections() {
        return owner.connections;
      },
      broadcastReliable<Name extends EventName<Protocol["serverEvents"]>>(
        name: Name,
        payload: Protocol["serverEvents"][Name],
        options: { except?: string | readonly string[] } = {},
      ) {
        return owner.broadcastReliable(name, payload, options);
      },
      broadcastUnreliable<Name extends EventName<Protocol["serverEvents"]>>(
        name: Name,
        payload: Protocol["serverEvents"][Name],
        options: { except?: string | readonly string[] } = {},
      ) {
        return owner.broadcastUnreliable(name, payload, options);
      },
    });
  }

  get connections() {
    return [...this.connectionsById.values()];
  }

  get connectionCount() {
    return this.connectionsById.size;
  }

  start() {
    if (!this.startPromise) {
      this.startPromise = Promise.resolve(this.definition.start?.(this.context)).catch(
        (error: unknown) => {
          this.startPromise = null;
          throw error;
        },
      );
    }
    return this.startPromise;
  }

  async accept(peer: BackendPeer) {
    await this.start();
    if (this.shuttingDown) {
      peer.close(1013, "Server is shutting down");
      return null;
    }
    if (this.peersById.has(peer.id)) {
      peer.close(1008, "Duplicate connection");
      return null;
    }
    const connection = new ServerConnection<Protocol>(peer);
    this.peersById.set(peer.id, peer);
    this.connectionsById.set(peer.id, connection);
    try {
      await this.definition.connect?.(connection, this.context);
    } catch (error) {
      await this.remove(peer.id);
      peer.close(1011, "Connection setup failed");
      throw error;
    }
    return connection;
  }

  async receive(peerId: string, bytes: Uint8Array, delivery: Delivery) {
    const peer = this.peersById.get(peerId);
    const connection = this.connectionsById.get(peerId);
    if (!peer || !connection || this.shuttingDown) return;
    let frame;
    try {
      frame = decodeFrame(bytes, delivery);
    } catch (error) {
      if (error instanceof BackendProtocolError) {
        peer.close(1008, "Invalid backend message");
        await this.remove(peerId);
        return;
      }
      throw error;
    }
    if (frame.kind === "event") {
      const handler = this.definition.messages?.[frame.name];
      if (handler) {
        await handler(frame.payload as never, connection, this.context, delivery);
      }
      return;
    }
    if (frame.kind !== "action.request") return;
    if (delivery !== "reliable") {
      peer.close(1008, "Actions require reliable delivery");
      await this.remove(peerId);
      return;
    }
    const active = this.activeActions.get(peerId) ?? new Set<string>();
    if (active.has(frame.id)) {
      await this.sendActionError(
        peer,
        frame.id,
        "duplicate_action",
        "An action with this identifier is already in progress.",
      );
      return;
    }
    if (active.size >= MAX_ACTIVE_ACTIONS_PER_CONNECTION) {
      await this.sendActionError(
        peer,
        frame.id,
        "too_many_actions",
        "Too many actions are in progress.",
      );
      return;
    }
    const handler = this.definition.actions?.[frame.name];
    if (!handler) {
      await this.sendActionError(peer, frame.id, "unknown_action", "Unknown action.");
      return;
    }
    active.add(frame.id);
    this.activeActions.set(peerId, active);
    try {
      const payload = await handler(frame.payload as never, connection, this.context);
      await peer.sendReliable(
        encodeFrame({
          version: BACKEND_PROTOCOL_VERSION,
          kind: "action.result",
          id: frame.id,
          payload,
        }),
      );
    } catch (error) {
      const failure =
        error instanceof BackendActionFailure
          ? error
          : new BackendActionFailure("internal_error", "The action failed.");
      await this.sendActionError(peer, frame.id, failure.code, failure.message);
    } finally {
      active.delete(frame.id);
      if (!active.size) this.activeActions.delete(peerId);
    }
  }

  async remove(peerId: string) {
    const connection = this.connectionsById.get(peerId);
    if (!connection) return;
    this.connectionsById.delete(peerId);
    this.peersById.delete(peerId);
    this.activeActions.delete(peerId);
    await this.definition.disconnect?.(connection, this.context);
  }

  async handleFetch(request: Request, identity: BackendIdentity) {
    await this.start();
    if (this.shuttingDown) {
      return new Response("Backend is shutting down.", { status: 503 });
    }
    if (!this.definition.fetch) {
      return new Response("Not found.", { status: 404 });
    }
    return this.definition.fetch(request, this.context, identity);
  }

  async shutdown() {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    await this.startPromise;
    await this.definition.shutdown?.(this.context);
    for (const peer of this.peersById.values()) {
      peer.close(1012, "Server restarting");
    }
    this.peersById.clear();
    this.connectionsById.clear();
    this.activeActions.clear();
  }

  private async broadcastReliable<Name extends EventName<Protocol["serverEvents"]>>(
    name: Name,
    payload: Protocol["serverEvents"][Name],
    options: { except?: string | readonly string[] } = {},
  ) {
    const excluded = exclusionSet(options.except);
    await Promise.all(
      this.connections
        .filter((connection) => !excluded.has(connection.id))
        .map((connection) => connection.sendReliable(name, payload)),
    );
  }

  private broadcastUnreliable<Name extends EventName<Protocol["serverEvents"]>>(
    name: Name,
    payload: Protocol["serverEvents"][Name],
    options: { except?: string | readonly string[] } = {},
  ) {
    const excluded = exclusionSet(options.except);
    let sent = 0;
    for (const connection of this.connections) {
      if (!excluded.has(connection.id) && connection.sendUnreliable(name, payload)) {
        sent += 1;
      }
    }
    return sent;
  }

  private sendActionError(peer: BackendPeer, id: string, code: string, message: string) {
    return peer.sendReliable(
      encodeFrame({
        version: BACKEND_PROTOCOL_VERSION,
        kind: "action.error",
        id,
        error: {
          code: code.slice(0, 80),
          message: message.slice(0, 500),
        },
      }),
    );
  }
}

function exclusionSet(value?: string | readonly string[]) {
  return new Set(typeof value === "string" ? [value] : (value ?? []));
}

export function createBackendServer<Protocol extends BackendProtocol = AnyBackendProtocol>(
  definition: BackendDefinition<Protocol>,
  services: BackendRuntimeServices,
) {
  return new BackendServer(definition, services);
}
