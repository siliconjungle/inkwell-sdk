import { requestGameService, type GameServiceRequest } from "./game-services.js";
import { parentOrigin } from './protocol.js';
import type { CachedGameRead, QueuedGameWrite } from './offline.js';

export type AchievementNotification = {
  id: string; kind: 'unlocked' | 'progress'; name: string; title: string;
  description: string; iconUrl: string | null; current?: number; max?: number;
};

export type AchievementChange = {
  id: string;
  kind: 'updated' | 'reset' | 'refresh';
  names: string[];
};

/** Browser hint to re-read achievements after backend changes or reconnect. */
export function onAchievementChange(listener: (change: AchievementChange) => void) {
  const origin = parentOrigin();
  if (typeof window === 'undefined' || !origin) return () => {};
  const seen = new Set<string>();
  const receive = (event: MessageEvent) => {
    if (event.source !== window.parent || event.origin !== origin) return;
    const message = event.data;
    const change = message?.payload;
    if (message?.source !== 'inkwell-platform' || message.version !== 1 || message.type !== 'achievements.changed' ||
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

export function onAchievementNotification(listener: (notice: AchievementNotification) => void) {
  const origin = parentOrigin();
  if (typeof window === 'undefined' || !origin) return () => {};
  const seen = new Set<string>();
  const receive = (event: MessageEvent) => {
    if (event.source !== window.parent || event.origin !== origin) return;
    const message = event.data;
    const notice = message?.payload;
    if (message?.source !== 'inkwell-platform' || message.version !== 1 || message.type !== 'achievement.event' ||
      !notice || typeof notice.id !== 'string' || notice.id.length > 240 ||
      !['unlocked', 'progress'].includes(notice.kind) || typeof notice.name !== 'string' || notice.name.length > 128 ||
      typeof notice.title !== 'string' || notice.title.length > 160 ||
      typeof notice.description !== 'string' || notice.description.length > 1000 ||
      (notice.iconUrl !== null && (typeof notice.iconUrl !== 'string' || notice.iconUrl.length > 2048)) ||
      seen.has(notice.id)) return;
    if (notice.kind === 'progress' && (!Number.isInteger(notice.current) || !Number.isInteger(notice.max) || notice.current < 0 || notice.max <= 0 || notice.max > 2147483647 || notice.current > notice.max)) return;
    seen.add(notice.id);
    if (seen.size > 100) seen.delete(seen.values().next().value!);
    listener(notice);
  };
  window.addEventListener('message', receive);
  return () => window.removeEventListener('message', receive);
}

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
  queued?: false;
  name: string;
  unlocked: true;
  newlyUnlocked: boolean;
  unlockedAt: string;
};
export type AchievementPercentage = {
  name: string;
  percent: number;
  unlockedPlayers: number;
  unlocked: boolean;
};

export function createAchievements(request: GameServiceRequest = requestGameService) {
  return Object.freeze({
    onChange: onAchievementChange,
    games: (options: { after?: string; query?: string } = {}) =>
      request<{ games: { slug: string; title: string; publisherUsername: string; achievementCount: number }[]; nextCursor: string | null }>('achievements', { ...options, operation: 'games' }),
    summary: (options: Pick<AchievementQuery, 'game' | 'username'> = {}) =>
      request<{ total: number; unlocked: number }>('achievements', { ...options, operation: 'summary' }),
    async count(options: Pick<AchievementQuery, 'game'> = {}) {
      return (await request<{ total: number }>('achievements', { ...options, operation: 'summary' })).total;
    },
    onNotification: onAchievementNotification,
    indicateProgress: (name: string, current: number, max: number, options: { locale?: string } = {}) =>
      request<{ displayed: boolean }>('achievements', { ...options, operation: 'progress', name, current, max }),
    list: (options: AchievementQuery = {}) =>
      request<{ achievements: Achievement[]; nextOffset: number | null } & CachedGameRead>("achievements", {
        ...options,
        operation: "list",
      }),
    async get(name: string, options: AchievementQuery = {}) {
      const result = await request<{ achievements: Achievement[] } & CachedGameRead>("achievements", {
        ...options,
        operation: "get",
        name,
      });
      const achievement = result.achievements[0];
      return achievement ? { ...achievement, offline: result.offline, cachedAt: result.cachedAt, pendingWrites: result.pendingWrites } : null;
    },
    unlock: (name: string) =>
      request<AchievementUnlock | QueuedGameWrite>("achievements", { operation: "unlock", name }),
    clear: (name: string) =>
      request<{ success: true }>("achievements", { operation: "clear", name }),
    async percentage(name: string, options: { game?: string } = {}) {
      const result = await request<{ achievements: AchievementPercentage[] }>(
        'achievements', { ...options, operation: 'percentages', name },
      );
      return result.achievements.find((achievement) => achievement.name === name) ?? null;
    },
    percentages: (options: { game?: string; offset?: number } = {}) =>
      request<{
        achievements: AchievementPercentage[];
        nextOffset: number | null;
      }>("achievements", { ...options, operation: "percentages" }),
  });
}
export function createServerAchievements(request: GameServiceRequest) {
  return Object.freeze({
    ...createAchievements(request),
    indicateProgressFor: (username: string, name: string, current: number, max: number, options: { locale?: string } = {}) =>
      request<{ displayed: boolean }>('achievements', { ...options, operation: 'progress', username, name, current, max }),
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
