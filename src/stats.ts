import { requestGameService, type GameServiceRequest } from "./game-services.js";
import type { CachedGameRead, QueuedGameWrite } from './offline.js';

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
export type StatUpdate = { name: string; value: number; unlocked: string[]; queued?: false };
export type AggregateGameStat = {
  name: string;
  /** Approximate JavaScript number. Use totalExact when precision matters. */
  total: number;
  /** Decimal sum of stored player values, without aggregate rounding. */
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
