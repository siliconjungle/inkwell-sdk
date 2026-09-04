import { requestGameService, type GameServiceRequest } from "./game-services.js";
import type { CachedGameRead, QueuedGameWrite } from './offline.js';
import { parentOrigin } from './protocol.js';

export type GameStatChange = {
  id: string;
  kind: 'updated' | 'reset' | 'refresh';
  names: string[];
};

/** Browser invalidation hint, not a persisted value or a reliable event log. */
export function onStatChange(listener: (change: GameStatChange) => void) {
  const origin = parentOrigin();
  if (typeof window === 'undefined' || !origin) return () => {};
  const seen = new Set<string>();
  const receive = (event: MessageEvent) => {
    if (event.source !== window.parent || event.origin !== origin) return;
    const message = event.data;
    const change = message?.payload;
    if (message?.source !== 'inkwell-platform' || message.version !== 1 || message.type !== 'stats.event' ||
      !change || typeof change.id !== 'string' || !change.id || change.id.length > 100 ||
      !['updated', 'reset', 'refresh'].includes(change.kind) ||
      !Array.isArray(change.names) || change.names.length > 100 ||
      !change.names.every((name: unknown) => typeof name === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(name)) || seen.has(change.id)) return;
    seen.add(change.id);
    if (seen.size > 100) seen.delete(seen.values().next().value!);
    listener({ id: change.id, kind: change.kind, names: [...change.names] });
  };
  window.addEventListener('message', receive);
  return () => window.removeEventListener('message', receive);
}

export type GameStatDefinition = {
  name: string;
  title?: string;
  kind?: "int" | "float" | "avgrate";
  defaultValue?: number;
  minValue?: number;
  maxValue?: number;
  maxChange?: number | null;
  incrementOnly?: boolean;
  serverWritesOnly?: boolean;
  publicRead?: boolean;
  aggregated?: boolean;
  windowSeconds?: number;
};
export type GameStat = {
  name: string;
  title: string;
  kind: "int" | "float" | "avgrate";
  value: number;
  updatedAt: string | null;
};
/** Read-only definition metadata. publicRead governs values, not this schema. */
export type GameStatSchema = Required<Omit<GameStatDefinition, 'windowSeconds'>> & {
  windowSeconds: number | null;
};
export type StatUpdate = { name: string; value: number; unlocked: string[]; queued?: false };
export type AggregateGameStat = {
  name: string;
  /** Approximate JavaScript number. Use totalExact when precision matters. */
  total: number;
  /** Exact sum of recorded player contributions, capped per upload by maxChange. */
  totalExact: string;
  /** UTC days, today first, including days with no activity. */
  history: {
    day: string;
    /** Approximate JavaScript number. */
    delta: number;
    /** Exact decimal change for this UTC day. */
    deltaExact: string;
  }[];
};
type RetryOptions = { requestId?: string };

export function createStats(request: GameServiceRequest = requestGameService) {
  const write = (
    name: string,
    value: number,
    mode: "set" | "increment" | "average",
    options: RetryOptions = {},
    seconds?: number,
  ) => {
    if (
      !Number.isFinite(value) ||
      (mode === "average" && (!Number.isFinite(seconds) || seconds! <= 0))
    )
      throw new TypeError("Stat updates require finite values and positive durations.");
    return request<StatUpdate | QueuedGameWrite>("stats", {
      operation: "write",
      name,
      mode,
      value,
      seconds,
      requestId: options.requestId ?? crypto.randomUUID(),
    });
  };
  return Object.freeze({
    onChange: onStatChange,
    schema: (options: { name?: string; offset?: number } = {}) =>
      request<{ stats: GameStatSchema[]; nextOffset: number | null }>('stats', { ...options, operation: 'schema' }),
    async get(name: string, options: { username?: string } = {}) {
      const result = await request<{ stats: GameStat[] } & CachedGameRead>('stats', { ...options, operation: 'get', name });
      const stat = result.stats[0];
      return stat ? { ...stat, offline: result.offline, cachedAt: result.cachedAt, pendingWrites: result.pendingWrites } : null;
    },
    reset: (options: { achievements?: boolean } = {}) =>
      request<{ statsCleared: number; achievementsCleared: number }>("stats", {
        ...options,
        operation: "reset",
      }),
    list: (options: { username?: string; offset?: number } = {}) =>
      request<{ stats: GameStat[]; nextOffset: number | null } & CachedGameRead>("stats", {
        ...options,
        operation: "list",
      }),
    set: (name: string, value: number, options?: RetryOptions) =>
      write(name, value, "set", options),
    increment: (name: string, amount = 1, options?: RetryOptions) =>
      write(name, amount, "increment", options),
    updateAverage: (name: string, count: number, seconds: number, options?: RetryOptions) =>
      write(name, count, "average", options, seconds),
    aggregate: (options: { historyDays?: number; offset?: number } = {}) =>
      request<{
        stats: AggregateGameStat[];
        nextOffset: number | null;
      }>("stats", { ...options, operation: "aggregate" }),
  });
}
export function createServerStats(request: GameServiceRequest) {
  return Object.freeze({
    ...createStats(request),
    definitions: (offset = 0) =>
      request<{ stats: GameStatDefinition[]; nextOffset: number | null }>("stats", { operation: "definitions", offset }),
    define: (definition: GameStatDefinition) =>
      request<{ stat: GameStatDefinition }>("stats", {
        operation: "define",
        name: definition.name,
        definition,
      }),
    update: (definition: GameStatDefinition) =>
      request<{ stat: GameStatDefinition }>("stats", {
        operation: "update",
        name: definition.name,
        definition,
      }),
    forPlayer: (username: string) =>
      createStats(<T>(service: string, body: Record<string, unknown>) =>
        request<T>(service, { ...body, username }),
      ),
  });
}
export const stats = createStats();
