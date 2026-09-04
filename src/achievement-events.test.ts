import assert from 'node:assert/strict';
import test from 'node:test';
import { createAchievements, onAchievementChange, type AchievementChange } from './achievements.js';

test('achievement change hints verify host, bound payloads, deduplicate and unsubscribe', () => {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const parent = {};
  const listeners = new Set<(event: unknown) => void>();
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { referrer: 'https://inkwell.ing/games/test/play' } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    parent, addEventListener: (_type: string, listener: (event: unknown) => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: (event: unknown) => void) => listeners.delete(listener),
  } });
  const seen: AchievementChange[] = [];
  const stop = createAchievements().onChange((change) => seen.push(change));
  const emit = (payload: unknown, source = parent, origin = 'https://inkwell.ing', type = 'achievements.changed') => {
    for (const listener of listeners) listener({ source, origin, data: { source: 'inkwell-platform', version: 1, type, payload } });
  };
  try {
    const change = { id: 'one', kind: 'updated', names: ['collector'] };
    emit(change, {}); emit(change, parent, 'https://game.example');
    emit(change, parent, 'https://inkwell.ing', 'stats.event');
    emit({ ...change, names: ['../private'] }); emit({ ...change, names: Array(101).fill('collector') });
    emit({ ...change, kind: 'dm' }); emit({ ...change, id: '' }); emit({ ...change, id: 'a'.repeat(101) });
    assert.equal(seen.length, 0);
    emit(change); emit(change);
    change.names[0] = 'mutated';
    assert.equal(seen[0].names[0], 'collector', 'listeners receive an independent name array');
    emit({ id: 'two', kind: 'reset', names: [] });
    emit({ id: 'three', kind: 'refresh', names: [] });
    assert.deepEqual(seen.map((value) => value.kind), ['updated', 'reset', 'refresh']);
    for (let index = 0; index < 101; index++) emit({ ...change, id: `bounded-${index}` });
    emit(change);
    assert.equal(seen.length, 105, 'deduplication memory is bounded, not permanent history');
    stop(); emit({ ...change, id: 'four' }); assert.equal(seen.length, 105);
    assert.equal(listeners.size, 0);
  } finally {
    stop();
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow); else Reflect.deleteProperty(globalThis, 'window');
    if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else Reflect.deleteProperty(globalThis, 'document');
  }
});

test('achievement subscriptions are harmless in a backend runtime without a browser', () => {
  assert.doesNotThrow(() => onAchievementChange(() => assert.fail('no browser event'))());
});
