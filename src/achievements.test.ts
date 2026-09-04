import assert from "node:assert/strict";
import test from "node:test";
import { createAchievements, createServerAchievements, onAchievementNotification } from "./achievements.js";
import { createStats, createServerStats } from "./stats.js";
import type { GameServiceRequest } from "./game-services.js";

test('individual achievement percentages select the requested name and preserve cross-game scope', async () => {
  const calls: Record<string, unknown>[] = [];
  const request: GameServiceRequest = async <T>(_service: string, body: Record<string, unknown>) => {
    calls.push(body);
    return { achievements: [{ name: 'winner', percent: 25, unlockedPlayers: 1, unlocked: true }] } as T;
  };
  const api = createAchievements(request);
  assert.equal((await api.percentage('winner', { game: 'other-game' }))?.percent, 25);
  assert.equal(await api.percentage('secret'), null);
  assert.deepEqual(calls[0], { operation: 'percentages', name: 'winner', game: 'other-game' });
  assert.equal((await createServerAchievements(request).percentage('winner'))?.unlockedPlayers, 1);
});

test('achievement discovery/summary and direct stat reads preserve read selectors', async () => {
  const calls: Record<string, unknown>[] = [];
  const request: GameServiceRequest = async <T>(service: string, body: Record<string, unknown>) => {
    calls.push({ service, ...body });
    if (service === 'stats') return { stats: [{ name: 'coins', value: 7 }], offline: true, cachedAt: 123, pendingWrites: 1 } as T;
    if (body.operation === 'games') return { games: [{ slug: 'other-game', achievementCount: 3 }], nextCursor: 'other-game' } as T;
    return { total: 3, unlocked: 1 } as T;
  };
  const achievements = createAchievements(request);
  assert.equal((await achievements.games({ after: 'a', query: 'other' })).games[0].slug, 'other-game');
  assert.deepEqual(await achievements.summary({ game: 'other-game', username: 'jungle' }), { total: 3, unlocked: 1 });
  assert.equal(await achievements.count({ game: 'other-game' }), 3);
  const value = await createStats(request).get('coins');
  assert.equal(value?.value, 7); assert.equal(value?.offline, true); assert.equal(value?.pendingWrites, 1);
  await createServerStats(request).forPlayer('jungle').get('coins');
  assert.deepEqual(calls[0], { service: 'achievements', operation: 'games', after: 'a', query: 'other' });
  assert.deepEqual(calls.at(-1), { service: 'stats', operation: 'get', name: 'coins', username: 'jungle' });
});

test("achievements allow cross-game reads, while unlock remains current-game scoped", async () => {
  const calls: Record<string, unknown>[] = [];
  const request: GameServiceRequest = async <T>(
    _service: string,
    body: Record<string, unknown>,
  ) => {
    calls.push(body);
    return { achievements: [{ name: "winner", unlocked: true }] } as T;
  };
  const achievements = createAchievements(request);
  assert.equal((await achievements.get("winner", { game: "other-game" }))?.unlocked, true);
  await achievements.unlock("visitor");
  await createServerAchievements(request).unlockFor("jungle", "winner");
  await achievements.indicateProgress('collector', 3, 10, { locale: 'fr' });
  await createServerAchievements(request).indicateProgressFor('jungle', 'collector', 5, 10);
  assert.equal(calls[0].game, "other-game");
  assert.equal(calls[1].game, undefined);
  assert.equal(calls[2].username, "jungle");
  assert.deepEqual(calls[3], { operation: 'progress', name: 'collector', current: 3, max: 10, locale: 'fr' });
  assert.equal(calls[4].username, 'jungle');
});

test('achievement notifications verify host source and origin, deduplicate, and unsubscribe', () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const listeners = new Set<(event: unknown) => void>();
  const parent = {};
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { referrer: 'https://inkwell.ing/games/test/play' } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { parent, addEventListener: (_type: string, listener: (event: unknown) => void) => listeners.add(listener), removeEventListener: (_type: string, listener: (event: unknown) => void) => listeners.delete(listener) } });
  try {
    const received: string[] = [];
    const stop = onAchievementNotification(notice => received.push(notice.name));
    const data = { source: 'inkwell-platform', version: 1, type: 'achievement.event', payload: { id: 'unlock:winner:date', kind: 'unlocked', name: 'winner', title: 'Winner', description: 'Win once', iconUrl: null } };
    const emit = (source: unknown, origin: string) => { for (const listener of listeners) listener({ source, origin, data }); };
    emit({}, 'https://inkwell.ing'); emit(parent, 'https://evil.example');
    assert.deepEqual(received, []);
    emit(parent, 'https://inkwell.ing'); emit(parent, 'https://inkwell.ing');
    assert.deepEqual(received, ['winner']);
    stop(); assert.equal(listeners.size, 0);
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else Reflect.deleteProperty(globalThis, 'window');
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else Reflect.deleteProperty(globalThis, 'document');
  }
});
test("stat SDK sends stable retry IDs and server player context", async () => {
  const calls: Record<string, unknown>[] = [];
  const request: GameServiceRequest = async <T>(
    _service: string,
    body: Record<string, unknown>,
  ) => {
    calls.push(body);
    return {} as T;
  };
  const stats = createStats(request);
  const requestId = crypto.randomUUID();
  await stats.increment("coins", 3, { requestId });
  await stats.increment("coins", 3, { requestId });
  await createServerStats(request).forPlayer("jungle").updateAverage("speed", 100, 10);
  await createServerStats(request).definitions(100);
  assert.equal(calls[0].requestId, calls[1].requestId);
  assert.equal(calls[2].username, "jungle");
  assert.equal(calls[2].seconds, 10);
  assert.deepEqual(calls[3], { operation: 'definitions', offset: 100 });
  assert.throws(() => stats.updateAverage("speed", 10, 0));
  assert.throws(() => stats.set("coins", Infinity));
});
