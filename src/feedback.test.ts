import assert from 'node:assert/strict';
import test from 'node:test';
import { game } from './game.js';
import { feedback } from './feedback.js';

test('game metadata and feedback use scoped host requests and authenticate responses', async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const listeners = new Set<(event: unknown) => void>();
  const sent: { payload: { requestId: string; service: string; request: unknown } }[] = [];
  const parent = { postMessage(message: typeof sent[number], origin: string) { assert.equal(origin, 'https://inkwell.ing'); sent.push(message); } };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { parent, addEventListener: (_: string, fn: (event: unknown) => void) => listeners.add(fn), removeEventListener: (_: string, fn: (event: unknown) => void) => listeners.delete(fn) } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { referrer: 'https://inkwell.ing/games/test/play' } });
  const emit = (payload: Record<string, unknown>, source: unknown = parent, origin = 'https://inkwell.ing') => { for (const fn of [...listeners]) fn({ source, origin, data: { source: 'inkwell-platform', version: 1, type: 'game-service.result', payload } }); };
  try {
    const pending = game.get();
    assert.equal(sent.at(-1)?.payload.service, 'game');
    assert.deepEqual(sent.at(-1)?.payload.request, { operation: 'get' });
    const requestId = sent.at(-1)!.payload.requestId;
    emit({ requestId, result: {} }, {});
    emit({ requestId, result: {} }, parent, 'https://evil.test');
    emit({ requestId: 'stale', result: {} });
    assert.equal(listeners.size, 1);
    const info = { slug: 'test', title: 'Test', websiteUrl: 'https://example.com/', discordUrl: null };
    emit({ requestId, result: info });
    assert.deepEqual(await pending, info);
    const opened = feedback.open();
    assert.equal(sent.at(-1)?.payload.service, 'feedback');
    assert.deepEqual(sent.at(-1)?.payload.request, { operation: 'open' });
    emit({ requestId: sent.at(-1)!.payload.requestId, result: { opened: true } });
    assert.deepEqual(await opened, { opened: true });
    const rejected = feedback.open();
    emit({ requestId: sent.at(-1)!.payload.requestId, error: 'Unavailable', status: 503 });
    await assert.rejects(rejected, /Unavailable/);
    assert.equal(listeners.size, 0);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window');
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument); else Reflect.deleteProperty(globalThis, 'document');
  }
});
