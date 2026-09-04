import { requestGameService, type GameServiceRequest } from "./game-services.js";

export type AchievementDefinition = {
  name: string;
  title: string;
  description: string;
  iconUrl?: string | null;
  lockedIconUrl?: string | null;
  hidden?: boolean;
  serverWritesOnly?: boolean;
  enabled?: boolean;
  translations?: Record<string, { title: string; description: string }>;
  progressStat?: string | null;
  progressMin?: number;
  progressTarget?: number | null;
};
export type Achievement = {
  name: string;
  title: string;
  description: string;
  iconUrl: string | null;
  hidden: boolean;
  unlocked: boolean;
  unlockedAt: string | null;
  progress: { current: number; min: number; target: number; percent: number } | null;
};
export type AchievementQuery = {
  game?: string;
  username?: string;
  offset?: number;
  locale?: string;
};
export type AchievementUnlock = {
  name: string;
  unlocked: true;
  newlyUnlocked: boolean;
  unlockedAt: string;
};

export function createAchievements(request: GameServiceRequest = requestGameService) {
  return Object.freeze({
    list: (options: AchievementQuery = {}) =>
      request<{ achievements: Achievement[]; nextOffset: number | null }>("achievements", {
        ...options,
        operation: "list",
      }),
    async get(name: string, options: AchievementQuery = {}) {
      const result = await request<{ achievements: Achievement[] }>("achievements", {
        ...options,
        operation: "get",
        name,
      });
      return result.achievements[0] ?? null;
    },
    unlock: (name: string) =>
      request<AchievementUnlock>("achievements", { operation: "unlock", name }),
    clear: (name: string) =>
      request<{ success: true }>("achievements", { operation: "clear", name }),
    percentages: (options: { game?: string; offset?: number } = {}) =>
      request<{
        achievements: { name: string; percent: number; unlockedPlayers: number }[];
        nextOffset: number | null;
      }>("achievements", { ...options, operation: "percentages" }),
  });
}
export function createServerAchievements(request: GameServiceRequest) {
  return Object.freeze({
    ...createAchievements(request),
    definitions: (offset = 0) =>
      request<{ achievements: (Achievement & AchievementDefinition)[]; nextOffset: number | null }>(
        "achievements",
        { operation: "list", manage: true, offset },
      ),
    define: (definition: AchievementDefinition) =>
      request<{ achievement: AchievementDefinition }>("achievements", {
        operation: "define",
        name: definition.name,
        definition,
      }),
    update: (definition: AchievementDefinition) =>
      request<{ achievement: AchievementDefinition }>("achievements", {
        operation: "update",
        name: definition.name,
        definition,
      }),
    delete: (name: string) =>
      request<{ success: true }>("achievements", { operation: "delete", name }),
    unlockFor: (username: string, name: string) =>
      request<AchievementUnlock>("achievements", { operation: "unlock", username, name }),
    clearFor: (username: string, name: string) =>
      request<{ success: true }>("achievements", { operation: "clear", username, name }),
  });
}
export const achievements = createAchievements();
