import assert from 'node:assert/strict';
import test from 'node:test';
import { loading } from './loading.js';
import { ready } from './core.js';

test('startup validates progress, emits bounded messages, and ends at readiness', () => {
  const messages: any[] = [];
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { parent: { postMessage: (...args: unknown[]) => messages.push(args) } } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { referrer: 'https://inkwell.ing/games/test/play' } });
  try {
    for (const ratio of [-1, 2, NaN, Infinity]) assert.throws(() => loading.progress(ratio));
    assert.throws(() => loading.fail(''));
    assert.throws(() => loading.fail('x'.repeat(501)));
    assert.equal(loading.progress(null), true);
    assert.equal(loading.progress(0.8), true);
    assert.equal(ready(), true);
    assert.equal(ready(), false);
    assert.equal(loading.progress(1), false);
    assert.equal(loading.fail('too late'), false);
    assert.deepEqual(messages.map(([message]) => message.type), ['loading.progress', 'loading.progress', 'ready']);
    assert.deepEqual(messages.map(([, origin]) => origin), Array(3).fill('https://inkwell.ing'));
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window');
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument); else Reflect.deleteProperty(globalThis, 'document');
  }
});
