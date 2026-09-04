import assert from 'node:assert/strict';
import test from 'node:test';
import { createStats, onStatChange, type GameStatChange } from './stats.js';

test('stat change hints verify host, bound payloads, deduplicate and unsubscribe', () => {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const parent = {};
  const listeners = new Set<(event: unknown) => void>();
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { referrer: 'https://inkwell.ing/games/test/play' } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    parent, addEventListener: (_type: string, listener: (event: unknown) => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: (event: unknown) => void) => listeners.delete(listener),
  } });
  const seen: GameStatChange[] = [];
  const stop = createStats().onChange((change) => seen.push(change));
  const emit = (payload: unknown, source = parent, origin = 'https://inkwell.ing') => {
    for (const listener of listeners) listener({ source, origin, data: { source: 'inkwell-platform', version: 1, type: 'stats.event', payload } });
  };
  try {
    const change = { id: 'one', kind: 'updated', names: ['coins'] };
    emit(change, {}); emit(change, parent, 'https://game.example');
    emit({ ...change, names: ['../private'] }); emit({ ...change, names: Array(101).fill('coins') });
    emit({ ...change, kind: 'dm' });
    assert.equal(seen.length, 0);
    emit(change); emit(change);
    emit({ id: 'two', kind: 'reset', names: [] });
    emit({ id: 'three', kind: 'refresh', names: [] });
    assert.deepEqual(seen.map((value) => value.kind), ['updated', 'reset', 'refresh']);
    assert.equal(seen[0].names[0], 'coins');
    stop(); emit({ ...change, id: 'four' }); assert.equal(seen.length, 3);
    assert.equal(listeners.size, 0);
  } finally {
    stop();
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow); else Reflect.deleteProperty(globalThis, 'window');
    if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else Reflect.deleteProperty(globalThis, 'document');
  }
});

test('stat subscriptions are harmless in a backend runtime without a browser', () => {
  assert.doesNotThrow(() => onStatChange(() => assert.fail('no browser event'))());
});
