import { requestGameService, type GameServiceRequest } from "./game-services.js";

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
export type StatUpdate = { name: string; value: number; unlocked: string[] };
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
    return request<StatUpdate>("stats", {
      operation: "write",
      name,
      mode,
      value,
      seconds,
      requestId: options.requestId ?? crypto.randomUUID(),
    });
  };
  return Object.freeze({
    reset: (options: { achievements?: boolean } = {}) =>
      request<{ statsCleared: number; achievementsCleared: number }>("stats", {
        ...options,
        operation: "reset",
      }),
    list: (options: { username?: string; offset?: number } = {}) =>
      request<{ stats: GameStat[]; nextOffset: number | null }>("stats", {
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
        stats: { name: string; total: number; history: { day: string; delta: number }[] }[];
        nextOffset: number | null;
      }>("stats", { ...options, operation: "aggregate" }),
  });
}
export function createServerStats(request: GameServiceRequest) {
  return Object.freeze({
    ...createStats(request),
    definitions: () =>
      request<{ stats: GameStatDefinition[] }>("stats", { operation: "definitions" }),
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
