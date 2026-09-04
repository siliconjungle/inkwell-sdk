import assert from 'node:assert/strict';
import test from 'node:test';
import { createOffline } from './offline.js';
import { createStats } from './stats.js';
import { createAchievements } from './achievements.js';
import type { GameServiceRequest } from './game-services.js';

test('offline controls use only the host offline service and preserve queued receipts', async () => {
  const calls: { service: string; operation: unknown }[] = [];
  const request: GameServiceRequest = async <T>(service: string, input: Record<string, unknown>) => {
    calls.push({ service, operation: input.operation });
    if (input.operation === 'write' || input.operation === 'unlock') return { queued: true, requestId: 'pending' } as T;
    return { enabled: true, pending: 1, failures: [] } as T;
  };
  const offline = createOffline(request);
  await offline.enable(); await offline.status(); await offline.flush(); await offline.disable();
  assert.deepEqual(calls, ['enable', 'status', 'flush', 'disable'].map(operation => ({ service: 'offline', operation })));
  assert.deepEqual(await createStats(request).increment('coins'), { queued: true, requestId: 'pending' });
  assert.deepEqual(await createAchievements(request).unlock('winner'), { queued: true, requestId: 'pending' });
});

test('achievement get preserves cached-read provenance without inventing an unlock', async () => {
  const request: GameServiceRequest = async <T>() => ({
    achievements: [{ name: 'winner', unlocked: false }], offline: true, cachedAt: 123, pendingWrites: 2,
  }) as T;
  const result = await createAchievements(request).get('winner');
  assert.equal(result?.unlocked, false);
  assert.equal(result?.offline, true);
  assert.equal(result?.cachedAt, 123);
  assert.equal(result?.pendingWrites, 2);
});
