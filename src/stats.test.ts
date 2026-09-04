import assert from 'node:assert/strict';
import test from 'node:test';
import { createStats, createServerStats, type AggregateGameStat } from './stats.js';
import type { GameServiceRequest } from './game-services.js';

test('browser and backend aggregates retain exact decimal strings and history order', async () => {
  const calls: unknown[] = [];
  const stat: AggregateGameStat = {
    name: 'coins', total: 9007199254740992, totalExact: '9007199254740993',
    history: [
      { day: '2026-09-04', delta: 9007199254740992, deltaExact: '9007199254740993' },
      { day: '2026-09-03', delta: 0, deltaExact: '0' },
    ],
  };
  const request: GameServiceRequest = async <T>(service: string, body: Record<string, unknown>) => {
    calls.push({ service, ...body });
    return JSON.parse(JSON.stringify({ stats: [stat], nextOffset: 100 })) as T;
  };
  for (const stats of [createStats(request), createServerStats(request)]) {
    const result = await stats.aggregate({ historyDays: 2, offset: 0 });
    assert.deepEqual(result.stats, [stat]);
    assert.equal(BigInt(result.stats[0].totalExact), 9007199254740993n);
    assert.equal(result.nextOffset, 100);
  }
  assert.deepEqual(calls, Array(2).fill({ service: 'stats', operation: 'aggregate', historyDays: 2, offset: 0 }));
});
